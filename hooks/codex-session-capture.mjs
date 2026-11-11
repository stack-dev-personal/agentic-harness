#!/usr/bin/env node
/** Capture a Codex SessionEnd transcript with the harness's vault note writer. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyseTranscript } from './lib/analyse.mjs';
import { isSubagentHead, readCodexHead, resolveCodexTranscript } from './lib/codex-head.mjs';
import { captureSession } from './lib/capture.mjs';
import { captureCodexSqliteSession } from './lib/codex-sqlite.mjs';
import { hostPathFlavor, joinHostPath } from './lib/host-paths.mjs';
import { sessionMemoryEligibility } from './lib/memory-policy.mjs';
import { queueIngest } from './lib/ingest-queue.mjs';
import { MAIN_TRANSCRIPT_MAX_BYTES, RESERVE_MS, RESUME_REASON, SESSIONS_DIR, STATUS_ACTIVE, STATUS_CONCLUDED, VAULT_ENV_VAR } from './lib/constants.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { createLogger } from './lib/logger.mjs';
import { loadMachineEnv, machineName } from './lib/machine-env.mjs';
import { noteId } from './lib/note.mjs';
import { vaultAvailable } from './lib/notes-io.mjs';
import { parseRagResult } from './lib/rag-result.mjs';
import { defaultStateDir, readSessionStartRecord } from './lib/session-start.mjs';
import { installExtraRulesFrom } from './lib/redact-extra.mjs';
import { extractRetrievals, retrievedLinks } from './lib/retrievals.mjs';
import { parseHookInput, readStdin } from './lib/stdin.mjs';
import { isoDate, toPosix } from './lib/text.mjs';
import { extractOutcome, extractPrompts, knownSecrets, readEntries } from './lib/transcript.mjs';

const BUDGET_MS = 2500; // Codex permits up to three seconds for SessionEnd.
const GENERATOR = 'codex-session-capture.mjs 1.0.0';

function textBlocks(content, type) {
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === type && typeof block.text === 'string')
    .map((block) => block.text).join('\n').trim();
}

/** User-role blocks Codex writes itself: machine context, AGENTS.md text, `!` shell runs. */
const INJECTED_USER_BLOCK = new RegExp(
  '^(?:<(?:environment_context|external_codex_apps_open_page|turn_aborted|system_reminder'
  + '|user_instructions|user_shell_command|INSTRUCTIONS)>|# AGENTS\\.md instructions for )',
);

export function humanPrompt(text) {
  if (!text) return '';
  if (INJECTED_USER_BLOCK.test(text)) return '';
  const reply = text.match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
  if (!reply) return text;
  try {
    const answers = JSON.parse(reply[1]);
    return Array.isArray(answers) ? answers.map((item) => item?.answer).filter((value) => typeof value === 'string' && value.trim()).join('\n') : '';
  } catch {
    return '';
  }
}

function toolArgs(payload) {
  if (payload?.arguments && typeof payload.arguments === 'string') {
    try { return JSON.parse(payload.arguments); } catch { return {}; }
  }
  return payload?.input && typeof payload.input === 'object' && !Array.isArray(payload.input) ? payload.input : {};
}

function literalField(source, key) {
  const match = new RegExp(`\\b${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(source);
  if (!match) return '';
  try { return JSON.parse(match[1]); } catch { return ''; }
}

function toolUse(id, name, input) {
  return { type: 'tool_use', id, name, input };
}

/** This platform's own rules: right for a session recorded where it is read. */
const nativeJoin = (cwd, raw) => (path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));

const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete|Move to) File: (.+)$/gm;

/** The files a decoded apply_patch body names, as `Write` uses; nothing else of the patch is kept. */
function patchFileUses(patch, idPrefix, cwd, startIndex, joinPath = nativeJoin) {
  const uses = [];
  for (const match of patch.matchAll(PATCH_FILE_LINE)) {
    const raw = match[1].trim();
    if (!raw) continue;
    uses.push(toolUse(`${idPrefix}:edit:${startIndex + uses.length}`, 'Write', {
      file_path: joinPath(cwd, raw),
    }));
  }
  return uses;
}

const STRING_LITERALS = {
  '"': /^"((?:\\.|[^"\\])*)"/s,
  "'": /^'((?:\\.|[^'\\])*)'/s,
  '`': /^`((?:\\.|[^`\\$])*)`/s,
};

/**
 * The first argument of a code-mode call, when it is a plain string literal;
 * `null` otherwise (a variable, a template with `${}`, anything unparseable).
 * Decoded with JSON.parse, never evaluated.
 */
export function literalArgument(source) {
  const quote = source[0];
  const pattern = STRING_LITERALS[quote];
  if (!pattern) return null;
  const match = pattern.exec(source);
  if (!match) return null;
  try {
    return JSON.parse(`"${toJsonBody(match[1])}"`);
  } catch {
    return null; // an escape JSON lacks (\x41, \v, …): unreadable, so no paths
  }
}

/** A JS string literal's body as a JSON string body: same escapes, quotes and raw newlines adjusted. */
function toJsonBody(body) {
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && index + 1 < body.length) {
      const next = body[index + 1];
      out += next === "'" || next === '`' ? next : `\\${next}`;
      index += 1;
    } else if (char === '"') out += '\\"';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else out += char;
  }
  return out;
}

/** Read only literal tool inputs from a Codex code-mode call. Never evaluate its JS. */
function nestedUses(script, callId, cwd, joinPath) {
  const uses = [];
  for (const match of script.matchAll(/tools\.exec_command\s*\(/g)) {
    const source = script.slice(match.index, match.index + 2000);
    const command = literalField(source, 'cmd');
    if (command) uses.push(toolUse(`${callId}:shell:${uses.length}`, 'PowerShell', {
      command, description: literalField(source, 'description'),
    }));
  }
  for (const match of script.matchAll(/tools\.apply_patch\s*\(\s*/g)) {
    // Only a literal patch can be read; its body never reaches the note.
    const patch = literalArgument(script.slice(match.index + match[0].length));
    if (patch) uses.push(...patchFileUses(patch, callId, cwd, uses.length, joinPath));
  }
  const rag = [...script.matchAll(/tools\.mcp__rag__(search_context|get_document)\s*\(/g)];
  if (rag.length === 1) {
    const source = script.slice(rag[0].index, rag[0].index + 2000);
    const input = {};
    for (const key of ['query', 'collection', 'source', 'external_id', 'repo', 'phase']) {
      const value = literalField(source, key);
      if (value) input[key] = value;
    }
    uses.push(toolUse(`${callId}:rag`, `mcp__rag__${rag[0][1]}`, input));
    return { uses, ragId: `${callId}:rag`, ragTool: rag[0][1] };
  }
  return { uses, ragId: '', ragTool: '' };
}

function ragResultText(output, tool) {
  const raw = Array.isArray(output) ? output.map((block) => block?.text).filter((value) => typeof value === 'string')
    : typeof output === 'string' ? [output] : [];
  const candidates = [...raw];
  for (const item of raw) {
    try {
      const parsed = JSON.parse(item);
      for (const block of parsed?.content ?? []) if (typeof block?.text === 'string') candidates.push(block.text);
    } catch { /* wrapper is plain text */ }
  }
  return candidates.find((value) => parseRagResult(tool, value)) ?? '';
}

/** Keep human prompts and final answers only. Tool inputs and outputs stay out of the note. */
export function extractCodexTurns(records, sessionCwd, { env = process.env } = {}) {
  // A Windows session read on another platform is joined as Windows text.
  const flavored = Boolean(hostPathFlavor(env));
  const joinPath = flavored ? joinHostPath : nativeJoin;
  // Each turn records the folder it ran in. Later entries carry it, so the
  // policy judges it, and their relative paths join to it, not to the folder
  // the session started in.
  let cwd = sessionCwd;
  const entries = [];
  const ragCalls = new Map();
  let origin = 'codex';
  for (const record of records) {
    const payload = record?.payload;
    if (record?.type === 'session_meta') {
      if (typeof payload?.originator === 'string') origin = payload.originator.slice(0, 80);
      entries.push({ type: 'progress', timestamp: record.timestamp, cwd });
    }
    if (record?.type === 'turn_context' && typeof payload?.cwd === 'string' && payload.cwd) {
      cwd = flavored ? payload.cwd : toPosix(payload.cwd);
      // Recorded even when nothing follows in this turn: being there is enough.
      entries.push({ type: 'progress', timestamp: record.timestamp, cwd });
      continue;
    }
    if (record?.type !== 'response_item') continue;
    if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') {
      const name = String(payload.name ?? '').slice(0, 100);
      const id = String(payload.call_id ?? `codex-${entries.length}`);
      const args = toolArgs(payload);
      const uses = [toolUse(id, name || payload.type, args)];
      if (['exec_command', 'shell_command'].includes(name) && typeof args.cmd === 'string') {
        uses.push(toolUse(`${id}:shell`, 'PowerShell', { command: args.cmd,
          description: args.description || '' }));
      }
      if (name === 'apply_patch') {
        const patch = typeof payload.input === 'string' ? payload.input : String(args.patch ?? '');
        uses.push(...patchFileUses(patch, id, cwd, uses.length, joinPath));
      }
      if (payload.type === 'custom_tool_call' && typeof payload.input === 'string') {
        const nested = nestedUses(payload.input, id, cwd, joinPath);
        uses.push(...nested.uses);
        if (nested.ragId) ragCalls.set(id, nested);
      } else if (name.startsWith('mcp__rag__')) {
        ragCalls.set(id, { ragId: id, ragTool: name.slice('mcp__rag__'.length) });
      }
      entries.push({ type: 'assistant', timestamp: record.timestamp, cwd,
        message: { content: uses } });
      continue;
    }
    if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
      const rag = ragCalls.get(String(payload.call_id ?? ''));
      if (rag) {
        const result = ragResultText(payload.output, rag.ragTool);
        if (result) entries.push({ type: 'user', timestamp: record.timestamp, cwd,
          message: { content: [{ type: 'tool_result', tool_use_id: rag.ragId,
            content: [{ type: 'text', text: result }] }] } });
      }
      continue;
    }
    if (payload?.type !== 'message') continue;
    if (payload.role === 'user') {
      const text = humanPrompt(textBlocks(payload.content, 'input_text'));
      if (text) entries.push({ type: 'user', origin: { kind: 'human' }, timestamp: record.timestamp, cwd, message: { content: text } });
    } else if (payload.role === 'assistant' && ['final_answer', 'final'].includes(payload.phase)) {
      const text = textBlocks(payload.content, 'output_text');
      if (text) entries.push({ type: 'assistant', timestamp: record.timestamp, cwd, message: { model: 'codex', content: [{ type: 'text', text }] } });
    }
  }
  return { entries, origin };
}

function firstPromptFromHead(file, fallback) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(512 * 1024);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, count).toString('utf8').split('\n');
    lines.pop(); // the final line may be cut off
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const item = record?.payload;
        if (record?.type !== 'response_item' || item?.type !== 'message' || item.role !== 'user') continue;
        const prompt = humanPrompt(textBlocks(item.content, 'input_text'));
        if (prompt) return prompt;
      } catch { /* malformed line */ }
    }
  } catch { /* use the parsed tail's first prompt */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return fallback;
}

export function captureCodex({
  input, vaultRoot, deadlineAt = Date.now() + BUDGET_MS, runGit, capturedBy = 'hook',
  stateDir = defaultStateDir(process.env), home = os.homedir(),
  allowSubagent = false, ownTask = '', childSessions = [], env = process.env,
}) {
  const skip = (reason) => ({ written: false, action: 'skip', skip: reason, touchedPaths: [], vaultRoot });
  input = { ...input, runtime: 'codex' };
  const policy = sessionMemoryEligibility({ input, env });
  if (!policy.allowed) return { ...skip(policy.reason), action: 'excluded' };
  if (input.hookEventName !== 'SessionEnd') return skip('not SessionEnd');
  // A worker reading another host's sessions never opens that host's live
  // Codex database (a WAL database across a bind mount); the rollout serves.
  const native = hostPathFlavor(env) ? null : captureCodexSqliteSession({ home, sessionId: input.sessionId, endReason: input.endReason,
    vaultRoot, env, deadlineAt, runGit, stateDir, capturedBy });
  if (native) return native;
  const transcriptPath = resolveCodexTranscript({ declaredPath: input.transcriptPath,
    sessionId: input.sessionId, home, deadlineAt: Math.min(deadlineAt - RESERVE_MS, Date.now() + 500) });
  if (!transcriptPath) return skip('transcript unavailable');
  const { record: head, error: headError } = readCodexHead(transcriptPath);
  if (!head) return skip(`transcript head ${headError}`);
  if (head.payload?.id && head.payload.id !== input.sessionId) return skip('transcript session id mismatch');
  const child = isSubagentHead(head);
  if (child && !allowSubagent) return skip('subagent transcript');
  if (child && !ownTask) return skip('child task unavailable; inherited context excluded');
  // Under a host path flavor the policy judges the cwd as recorded; toPosix
  // would strip a device prefix before it is seen.
  const cwd = hostPathFlavor(env) ? String(head.payload?.cwd || input.cwd || '') : toPosix(head.payload?.cwd || input.cwd);
  let records = readEntries(transcriptPath, MAIN_TRANSCRIPT_MAX_BYTES, deadlineAt);
  if (!records.length) return skip('transcript unreadable or empty');
  if (child) records = records.filter(record => record.timestamp >= head.timestamp);
  if (records[0]?.type !== 'session_meta') records.unshift(head);
  const parsed = extractCodexTurns(records, cwd, { env });
  if (child) {
    parsed.entries = parsed.entries.filter(entry => entry.type !== 'user' || Array.isArray(entry.message?.content));
    parsed.entries.unshift({ type: 'user', origin: { kind: 'human' }, timestamp: head.timestamp, cwd, message: { content: ownTask } });
  }
  const parent = head.payload?.parent_thread_id || head.payload?.source?.subagent?.thread_spawn?.parent_thread_id;
  const latestContext = records.findLast(record => record.type === 'turn_context')?.payload;
  return captureSession({ input: { ...input, cwd, transcriptPath, sessionId: `codex-${input.sessionId}` },
    vaultRoot, entries: parsed.entries, runGit, capturedBy, stateDir, deadlineAt, env,
    agent: 'codex', runtime: 'codex', model: latestContext?.model || '', provider: latestContext?.model_provider || '',
    origin: parsed.origin, generator: GENERATOR,
    briefSessionId: input.sessionId,
    parentSession: parent ? `codex-${parent}` : '', childSessions,
    promptTask: ownTask,
  });
}

function main() {
  const startedAt = Date.now();
  const deadlineAt = startedAt + BUDGET_MS;
  const problems = [];
  Object.assign(process.env, loadMachineEnv(process.env, os.homedir(), (message) => problems.push(message)));
  installExtraRulesFrom(process.env, (message) => problems.push(message));
  const log = createLogger(process.env.HARNESS_CODEX_CAPTURE_LOG || path.join(os.homedir(), '.codex', 'hooks', 'session-capture.log'));
  for (const problem of problems) log(problem);
  if (/^(0|false|off|no)$/i.test(process.env.HARNESS_CODEX_CAPTURE ?? '')) return;

  const parsed = parseHookInput(readStdin(deadlineAt), process.env);
  if (!parsed.ok) return log(`skip: ${parsed.error}`);
  const outcome = captureCodex({
    input: parsed.value,
    vaultRoot: process.env[VAULT_ENV_VAR] || path.join(os.homedir(), 'vault'),
    deadlineAt,
  });
  if (!outcome.written) return log(`${outcome.action}: ${outcome.skip} ms=${Date.now() - startedAt}`);
  if (Date.now() < deadlineAt) {
    queueIngest({ notePaths: outcome.touchedPaths, vaultRoot: outcome.vaultRoot, log });
  }
  log(`${outcome.action}: ${outcome.detail} ms=${Date.now() - startedAt}`);
}

if (isEntryPoint(import.meta.url)) {
  try {
    main();
  } catch (error) {
    createLogger(path.join(os.homedir(), '.codex', 'hooks', 'session-capture.log'))(`fatal: ${error?.stack || error}`);
  }
  process.exit(0); // SessionEnd capture must never block session exit.
}
