#!/usr/bin/env node
/** Capture a Codex SessionEnd transcript with the harness's vault note writer. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyseTranscript } from './lib/analyse.mjs';
import { isSubagentHead, readCodexHead, resolveCodexTranscript } from './lib/codex-head.mjs';
import { captureSession } from './lib/capture.mjs';
import { captureCodexSqliteSession } from './lib/codex-sqlite.mjs';
import { humanPrompt, humanText } from './lib/codex-prompt.mjs';
import { isEncryptedTask, placeholderTask } from './lib/codex-task.mjs';
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
import { WORKDIR_TOOL, extractOutcome, extractPrompts, knownSecrets, readEntries } from './lib/transcript.mjs';

const BUDGET_MS = 2500; // Codex permits up to three seconds for SessionEnd.
const GENERATOR = 'codex-session-capture.mjs 1.0.0';

function textBlocks(content, type) {
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === type && typeof block.text === 'string')
    .map((block) => block.text).join('\n').trim();
}

/** Which user turns a person typed: shared with the SQLite adapter (codex-prompt.mjs). */
export { humanPrompt };

const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

/** A call's arguments as an object; `{}` for anything else (`null`, a list, unparseable text). */
function toolArgs(payload) {
  if (payload?.arguments && typeof payload.arguments === 'string') {
    try { return plainObject(JSON.parse(payload.arguments)) ?? {}; } catch { return {}; }
  }
  return plainObject(payload?.input) ?? {};
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

// A header may be indented: reading it judges one more path, never one fewer.
// A rename's destination is `*** Move to: <path>` in Codex's patch format.
const PATCH_FILE_LINE = /^[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

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

// Sticky: each is tried at one position of the script, never on a copy of its tail.
// A template is read when it holds no `${`; a `$` on its own is text.
const STRING_LITERALS = {
  '"': /"((?:\\.|[^"\\])*)"/sy,
  "'": /'((?:\\.|[^'\\])*)'/sy,
  '`': /`((?:\\.|\$(?!\{)|[^`\\$])*)`/sy,
};

/**
 * The first argument of a code-mode call, when it is a plain string literal;
 * `null` otherwise (a variable, a template with `${}`, anything unparseable).
 * Decoded with JSON.parse, never evaluated.
 */
export function literalArgument(source) {
  return readLiteralAt(source, 0)?.value ?? null;
}

/** The string literal starting at `at`: its value and where it ends; null when there is none to read. */
function readLiteralAt(source, at) {
  const pattern = STRING_LITERALS[source[at]];
  if (!pattern) return null;
  pattern.lastIndex = at;
  const match = pattern.exec(source);
  if (!match) return null;
  try {
    return { value: JSON.parse(`"${toJsonBody(match[1])}"`), end: at + match[0].length };
  } catch {
    return null; // an escape JSON lacks (\x41, \v, …): unreadable, so no paths
  }
}

// What may follow a whole value: the next argument or property, a closing
// bracket, the end of a statement or of the script.
const VALUE_END = new Set([',', '}', ')', ']', ';', undefined]);
// A working folder named in a code-mode script, under any key spelling Codex
// tools use, quoted or not, wherever it appears.
const WORKDIR_KEY = /(?:\b(?:workdir|working_directory)|(["'`])(?:workdir|working_directory)\1)/g;
// Limits on what the reader will do for one script. Past any of them the
// value is not read and the session is refused, never captured unjudged.
const MAX_PAREN_DEPTH = 64;
const MAX_VALUE_CHARS = 32_767; // the longest Windows path
const WORK_PER_SCRIPT_CHAR = 16;
const UNREADABLE = Symbol('unreadable');
// Handed to the policy for a working folder the reader would not finish: a NUL
// cannot be in a path, and the policy refuses it as unverifiable everywhere.
export const UNREADABLE_WORKDIR = "\u0000working folder the reader did not finish";

/** Sorted positions of `pattern` in `text`, found once per script. */
function positions(text, pattern) {
  return Array.from(text.matchAll(pattern), (match) => match.index);
}

/** The first position in sorted `list` at or after `from`, or -1. */
function nextAt(list, from) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle] < from) low = middle + 1; else high = middle;
  }
  return low < list.length ? list[low] : -1;
}

/**
 * The literal working folders of one code-mode script, read as text and never
 * run. Linear in the script: comment ends are looked up, and a `+` chain read
 * from one key is not read again from the next (`chains`).
 *
 * @returns {{ values: string[], unverifiable: boolean }}
 */
function scriptWorkdirs(script) {
  // Most scripts name no working folder: build nothing for them.
  if (!/workdir|working_directory/.test(script)) return { values: [], unverifiable: false };
  const length = script.length;
  const commentCloses = positions(script, /\*\//g);
  // JavaScript ends a line comment at any line terminator, not only LF.
  const lineEnds = positions(script, /[\n\r\u2028\u2029]/g);
  let budget = WORK_PER_SCRIPT_CHAR * length + 1_000_000;
  const chains = new Map();

  // Where trivia starting at each comment ends, so a run of comments is walked once
  // however many keys start inside it.
  const skipped = new Map();
  const skip = (at) => {
    let index = at;
    const walked = [];
    let result;
    for (;;) {
      while (index < length && /\s/.test(script[index])) index += 1;
      if (skipped.has(index)) { result = skipped.get(index); break; }
      if (script.startsWith('/*', index)) {
        walked.push(index);
        const close = nextAt(commentCloses, index + 2);
        if (close === -1) { result = length; break; }
        index = close + 2;
      } else if (script.startsWith('//', index)) {
        walked.push(index);
        const end = nextAt(lineEnds, index + 2);
        if (end === -1) { result = length; break; }
        index = end + 1;
      } else { result = index; break; }
    }
    for (const start of walked) skipped.set(start, result);
    return result;
  };

  // A chain is a linked list from its first operand: { value, rest, chars, links, end }.
  // Joining one costs a step per link, charged to the budget.
  const join = (chain) => {
    let text = '';
    for (let link = chain; link; link = link.rest) text += link.value;
    return text;
  };

  const operandAt = (at, depth) => {
    if (script[at] !== '(') return readLiteralAt(script, at);
    if (depth >= MAX_PAREN_DEPTH) return UNREADABLE;
    const inner = chainAt(skip(at + 1), depth + 1);
    if (!inner || inner === UNREADABLE) return inner;
    budget -= inner.links + inner.chars;
    if (inner.chars > MAX_VALUE_CHARS || budget < 0) return UNREADABLE;
    const close = skip(inner.end);
    return script[close] === ')' ? { value: join(inner), end: close + 1 } : null;
  };

  // Literals joined with `+` from `start`; null when one is not a literal.
  const chainAt = (start, depth) => {
    const pending = [];
    let at = start;
    let tail;
    for (;;) {
      if (chains.has(at)) { tail = chains.get(at); break; }
      budget -= 1;
      const operand = budget < 0 ? UNREADABLE : operandAt(at, depth);
      // A failed start is remembered too: every key that reaches it would read it again.
      if (!operand || operand === UNREADABLE) { tail = operand; chains.set(at, operand); break; }
      const plus = skip(operand.end);
      pending.push({ at, operand });
      if (script[plus] !== '+') { tail = undefined; break; }
      at = skip(plus + 1);
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const { at: from, operand } = pending[index];
      const chain = tail === null || tail === UNREADABLE ? tail
        : { value: operand.value, rest: tail, chars: operand.value.length + (tail?.chars ?? 0),
          links: 1 + (tail?.links ?? 0), end: tail?.end ?? operand.end };
      chains.set(from, chain);
      tail = chain;
    }
    return tail ?? null;
  };

  const values = new Set();
  let unverifiable = false;
  for (const match of script.matchAll(WORKDIR_KEY)) {
    const colon = skip(match.index + match[0].length);
    if (script[colon] !== ':') continue;
    const chain = chainAt(skip(colon + 1), 0);
    if (chain === UNREADABLE) { unverifiable = true; continue; }
    // Not literals to the end of the expression: a part of a value is not the folder it names.
    if (!chain || !VALUE_END.has(script[skip(chain.end)])) continue;
    budget -= chain.links + chain.chars;
    if (chain.chars > MAX_VALUE_CHARS || budget < 0) { unverifiable = true; continue; }
    values.add(join(chain));
  }
  return { values: [...values], unverifiable };
}

/**
 * The policy's view of a working folder: a tool path, judged from the entry's
 * own folder (the turn's), so a relative, drive-relative or rooted spelling is
 * placed the way Codex places it. A path, not a folder of the note: the text
 * is the model's, and `cwds_seen` lists only folders the transcript declared.
 */
const workdirUse = (id, workdir) => toolUse(id, WORKDIR_TOOL, { path: workdir });

// Escapes JSON and JavaScript read alike. Hex, code point and octal escapes
// and a line continuation are left to JSON.parse, which refuses them: not
// read. `\8` and `\9` are the digits themselves, as sloppy JavaScript reads them.
const JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u', 'x', '0', '1', '2', '3', '4', '5', '6', '7', '\n', '\r', '\u2028', '\u2029']);

/** A JS string literal's body as a JSON string body: same escapes, quotes and raw newlines adjusted. */
function toJsonBody(body) {
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && index + 1 < body.length) {
      const next = body[index + 1];
      // `\v` is a vertical tab; any other escape JavaScript does not define is the character itself.
      if (next === 'v') out += jsonChar(String.fromCharCode(11));
      else if (JSON_ESCAPES.has(next)) out += `\\${next}`;
      else out += jsonChar(next);
      index += 1;
    } else out += jsonChar(char);
  }
  return out;
}

/**
 * One character as JSON string text. A raw control character (a TAB in a
 * patch, a LF in a template) is valid in a JavaScript literal but not in JSON,
 * so it is written as its escape; a quote is escaped.
 */
function jsonChar(char) {
  const code = char.charCodeAt(0);
  if (code < 0x20) return `${String.fromCharCode(92)}u${code.toString(16).padStart(4, '0')}`;
  return char === '"' ? `${String.fromCharCode(92)}"` : char;
}

/** Read only literal tool inputs from a Codex code-mode call. Never evaluate its JS. */
function nestedUses(script, callId, cwd, joinPath) {
  const uses = [];
  const read = scriptWorkdirs(script);
  const workdirs = read.unverifiable ? [...read.values, UNREADABLE_WORKDIR] : read.values;
  for (const match of script.matchAll(/tools\.exec_command\s*\(/g)) {
    const source = script.slice(match.index, match.index + 2000);
    const command = literalField(source, 'cmd');
    if (command) uses.push(toolUse(`${callId}:shell:${uses.length}`, 'PowerShell', {
      command, description: literalField(source, 'description'),
    }));
  }
  for (const match of script.matchAll(/tools\.apply_patch\s*\(\s*/g)) {
    // Only a literal patch can be read; its body never reaches the note.
    const patch = readLiteralAt(script, match.index + match[0].length)?.value ?? null;
    if (patch) for (const use of patchFileUses(patch, callId, cwd, uses.length, joinPath)) uses.push(use);
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
    return { uses, workdirs, ragId: `${callId}:rag`, ragTool: rag[0][1] };
  }
  return { uses, workdirs, ragId: '', ragTool: '' };
}

/**
 * The texts a tool result carries: its `content` blocks, also when a script
 * wrapped the call in `Promise.allSettled` (`{status, value}`), possibly under
 * `result`. A result marked `isError` carries none. Bounded: a script's own
 * output is data, not a structure to walk without limit.
 */
function resultTexts(node, depth = 0) {
  if (depth > 3 || !node || typeof node !== 'object' || node.isError === true) return [];
  // `Promise.allSettled` printed whole is an array of settled results.
  if (Array.isArray(node)) return node.slice(0, 64).flatMap((item) => resultTexts(item, depth + 1));
  const texts = Array.isArray(node.content)
    ? node.content.map((block) => block?.text).filter((value) => typeof value === 'string') : [];
  return [...texts, ...resultTexts(node.value, depth + 1), ...resultTexts(node.result, depth + 1)];
}

function ragResultText(output, tool) {
  const raw = Array.isArray(output) ? output.map((block) => block?.text).filter((value) => typeof value === 'string')
    : typeof output === 'string' ? [output] : [];
  const candidates = [...raw];
  for (const item of raw) {
    try { candidates.push(...resultTexts(JSON.parse(item))); } catch { /* wrapper is plain text */ }
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
      // A shell call's `workdir` is a folder the session was in, as a turn's is.
      const workdirs = typeof args.workdir === 'string' && args.workdir ? [args.workdir] : [];
      if (['exec_command', 'shell_command'].includes(name) && typeof args.cmd === 'string') {
        uses.push(toolUse(`${id}:shell`, 'PowerShell', { command: args.cmd,
          description: args.description || '' }));
      }
      if (name === 'apply_patch') {
        const patch = typeof payload.input === 'string' ? payload.input : String(args.patch ?? '');
        for (const use of patchFileUses(patch, id, cwd, uses.length, joinPath)) uses.push(use);
      }
      if (payload.type === 'custom_tool_call' && typeof payload.input === 'string') {
        const nested = nestedUses(payload.input, id, cwd, joinPath);
        // Loops, not spreads: a script can name hundreds of thousands of calls.
        for (const use of nested.uses) uses.push(use);
        for (const workdir of nested.workdirs) workdirs.push(workdir);
        if (nested.ragId) ragCalls.set(id, nested);
      } else if (name.startsWith('mcp__rag__')) {
        ragCalls.set(id, { ragId: id, ragTool: name.slice('mcp__rag__'.length) });
      }
      let index = 0;
      for (const workdir of new Set(workdirs)) uses.push(workdirUse(`${id}:workdir:${index++}`, workdir));
      entries.push({ type: 'assistant', timestamp: record.timestamp, cwd,
        message: { content: uses } });
      continue;
    }
    // The older shell item: its command and working folder are in `action`.
    if (payload?.type === 'local_shell_call') {
      const id = String(payload.call_id ?? payload.id ?? `codex-${entries.length}`);
      const action = plainObject(payload.action) ?? {};
      const uses = [toolUse(id, 'local_shell', {})];
      const command = Array.isArray(action.command) ? action.command.filter((part) => typeof part === 'string').join(' ') : '';
      if (command) uses.push(toolUse(`${id}:shell`, 'PowerShell', { command }));
      if (typeof action.working_directory === 'string' && action.working_directory) uses.push(workdirUse(`${id}:workdir:0`, action.working_directory));
      entries.push({ type: 'assistant', timestamp: record.timestamp, cwd, message: { content: uses } });
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
      const text = humanText(payload.content, 'input_text');
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
        const prompt = humanText(item.content, 'input_text');
        if (prompt) return prompt;
      } catch { /* malformed line */ }
    }
  } catch { /* use the parsed tail's first prompt */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return fallback;
}

export function captureCodex({
  input, vaultRoot, deadlineAt = Date.now() + BUDGET_MS, runGit, capturedBy = 'hook',
  stateDir, home = os.homedir(),
  allowSubagent = false, ownTask = '', childSessions = [], env = process.env,
}) {
  const skip = (reason) => ({ written: false, action: 'skip', skip: reason, touchedPaths: [], vaultRoot });
  stateDir ??= defaultStateDir(env);
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
  const spawn = head.payload?.source?.subagent?.thread_spawn;
  const parent = head.payload?.parent_thread_id || spawn?.parent_thread_id;
  // A delegate with no parent has no note to belong to; its context is inherited.
  if (child && !parent) return { ...skip('child task unavailable; inherited context excluded'), action: 'unsupported' };
  // An encrypted spawn prompt is no task (codex-task.mjs): the placeholder stands in, as from SQLite.
  const readableTask = isEncryptedTask(ownTask) ? '' : ownTask;
  const task = child ? readableTask || placeholderTask({ agentPath: spawn?.agent_path,
    agentNickname: spawn?.agent_nickname || head.payload?.agent_nickname, id: input.sessionId }) : readableTask;
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
    // A placeholder stands in only above the delegate's own activity; one that did
    // nothing would otherwise become a note of one synthetic line.
    if (!readableTask && !parsed.entries.some(entry => entry.type !== 'progress')) return skip('subagent did nothing; assignment not recorded');
    parsed.entries.unshift({ type: 'user', origin: { kind: 'human' }, timestamp: head.timestamp, cwd, message: { content: task } });
  }
  const latestContext = records.findLast(record => record.type === 'turn_context')?.payload;
  return captureSession({ input: { ...input, cwd, transcriptPath, sessionId: `codex-${input.sessionId}` },
    vaultRoot, entries: parsed.entries, runGit, capturedBy, stateDir, deadlineAt, env,
    agent: 'codex', runtime: 'codex',
    // Codex 0.166 names the provider in the session head only, not per turn.
    model: latestContext?.model || '', provider: latestContext?.model_provider || head.payload?.model_provider || '',
    origin: parsed.origin, generator: GENERATOR,
    briefSessionId: input.sessionId,
    parentSession: parent ? `codex-${parent}` : '', childSessions,
    promptTask: task,
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
