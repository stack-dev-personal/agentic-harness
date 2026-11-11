#!/usr/bin/env node
/**
 * session-start.mjs — Claude Code `SessionStart` hook (R-H4).
 *
 * Starts a session knowing where its project stands: a brief of at most
 * ~1,500 tokens (lib/start-brief.mjs) goes back as `additionalContext`, and
 * what it used is recorded for capture (SC-2, lib/session-start.mjs).
 *
 * Contract (https://code.claude.com/docs/en/hooks):
 *   stdin  = { session_id, transcript_path, cwd, hook_event_name: "SessionStart",
 *              <why the session started: startup|resume|clear|compact|fork>, … }
 *   stdout = {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
 *   exit 0. Subagents do not fire SessionStart; `claude -p` does.
 * The name of the "why" field is read differently in different sources
 * (`source`, `startup_reason`, …), so nothing depends on it: the settings
 * matcher (`startup|resume`) does the filtering, and every run logs the
 * input's sorted key names — never a value — so the live step can settle it.
 *
 * Rules, in priority order:
 *   1. Always exactly one JSON document on stdout and exit 0. Any error, and
 *      anything slower than 2 s, is the empty answer (`additionalContext: ""`).
 *   2. Nothing from the brief reaches the log: it quotes vault notes.
 *   3. A record that cannot be written is logged and changes nothing else.
 *
 * Installed to `~/.claude/hooks/` by `node hooks/install.mjs` like the capture
 * hook; edit it here, never there. Disable: HARNESS_SESSION_START=0.
 * Codex runs the same hook through codex-session-start.mjs: its
 * `session-start.command.output` schema accepts this same JSON shape.
 */

import os from 'node:os';
import path from 'node:path';

import { DEFAULT_VAULT_SEGMENTS, DISABLE_VALUES, VAULT_ENV_VAR } from './lib/constants.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { createLogger } from './lib/logger.mjs';
import { loadMachineEnv } from './lib/machine-env.mjs';
import { memoryPolicyFields, sessionMemoryEligibility } from './lib/memory-policy.mjs';
import { defaultStateDir, writeSessionStartRecord } from './lib/session-start.mjs';
import {
  BRIEF_DEADLINE_MS,
  BriefDeadlineError,
  DISABLE_ENV_VAR,
  LOG_ENV_VAR,
  SESSION_START_EVENT,
  buildStartBrief,
  isDeadlineError,
} from './lib/start-brief.mjs';
import { isSafeFilenameSegment, pick, toPosix } from './lib/text.mjs';

/** Of the 2 s, how long stdin may take; the rest is the brief's. */
const STDIN_BUDGET_MS = 500;
const MAX_STDIN_BYTES = 1024 * 1024;
/** A key name the log may print; anything else is only counted. */
const PRINTABLE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_KEYS_LOGGED = 40;
/** After the answer is written, the process exits even if its write callback never comes. */
const EXIT_GRACE_MS = 1000;

export function renderOutput(additionalContext) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: SESSION_START_EVENT, additionalContext } });
}

export const EMPTY_OUTPUT = renderOutput('');

function parseInput(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'stdin was not JSON', keys: [] };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'stdin was not an object', keys: [] };
  const keys = Object.keys(input);
  const cwd = toPosix(pick(input, 'cwd'));
  if (!cwd) return { ok: false, reason: 'no cwd', keys };
  return { ok: true, keys, sessionId: pick(input, 'session_id', 'sessionId'), cwd,
    parentSession: pick(input, 'parentSession', 'parent_session_id'), ...memoryPolicyFields(input) };
}

/** The input's key names, sorted, for the log; a key that is not a plain name is counted, not printed. */
export function describeKeys(keys) {
  const printable = keys.filter((key) => PRINTABLE_KEY.test(key)).sort();
  const hidden = keys.length - printable.length;
  const shown = printable.slice(0, MAX_KEYS_LOGGED).join(',') || '(none)';
  return `debug input-keys: ${shown}${hidden > 0 ? ` (+${hidden} unprintable)` : ''}`;
}

/** The error's kind only: a message may quote a note or a payload. */
function describeError(error) {
  const code = typeof error?.code === 'string' && PRINTABLE_KEY.test(error.code) ? ` ${error.code}` : '';
  const name = typeof error?.name === 'string' && PRINTABLE_KEY.test(error.name) ? error.name : 'Error';
  return `${name}${code}`;
}

function withTimeout(promise, ms, { setTimer, clearTimer }) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => reject(new BriefDeadlineError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimer(timer));
}

function recordBrief({ brief, input, now, stateDir, writeRecord, log }) {
  try {
    const written = writeRecord({
      record: {
        at: new Date(now()).toISOString(),
        sessionId: input.sessionId,
        cwd: input.cwd,
        realm: brief.realm,
        collection: brief.collection,
        collectionSource: brief.collectionSource,
        source: brief.source,
        externalIds: brief.externalIds,
        tokens: brief.tokens,
      },
      stateDir,
    });
    if (!written.ok) log(`record skipped: ${written.reason}`);
  } catch (error) {
    log(`record skipped: ${describeError(error)}`);
  }
}

/**
 * One run of the hook, with every dependency injectable. Resolves
 * `{ stdout, reason }` and never rejects.
 */
export async function run({
  raw,
  env = process.env,
  home = os.homedir(),
  tmp = os.tmpdir(),
  log = () => {},
  now = Date.now,
  timeoutMs = BRIEF_DEADLINE_MS,
  runtime = 'claude-code',
  stateDir = defaultStateDir(env, home),
  build = buildStartBrief,
  writeRecord = writeSessionStartRecord,
  io,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const startedAt = now();
  const empty = (reason) => {
    log(`empty: ${reason} ms=${now() - startedAt}`);
    return { stdout: EMPTY_OUTPUT, reason };
  };
  try {
    if (DISABLE_VALUES.has(String(env?.[DISABLE_ENV_VAR] ?? '').toLowerCase())) return empty('disabled');
    const input = parseInput(String(raw ?? ''));
    log(describeKeys(input.keys));
    if (!input.ok) return empty(input.reason);
    const policy = sessionMemoryEligibility({ input: { ...input, runtime }, env });
    if (!policy.allowed) return empty('memory policy excludes session');

    const vaultRoot = env[VAULT_ENV_VAR] || path.join(home, ...DEFAULT_VAULT_SEGMENTS);
    const args = { cwd: input.cwd, vaultRoot, home, tmp, now, deadlineAt: startedAt + timeoutMs, ...(io ? { io } : {}) };
    const brief = await withTimeout(build(args), timeoutMs, { setTimer, clearTimer });

    recordBrief({ brief, input, now, stateDir, writeRecord, log });
    const session = isSafeFilenameSegment(input.sessionId) ? input.sessionId : '-';
    const passed = brief.notes.length ? ` passed-over=[${brief.notes.join('; ')}]` : '';
    log(
      `start ${session} ${brief.realm}/${brief.collection} source=${brief.source} rule=${brief.rule} ` +
        `ids=${brief.externalIds.length} tokens=${brief.tokens}${passed} ms=${now() - startedAt}`,
    );
    return { stdout: renderOutput(brief.text), reason: 'ok' };
  } catch (error) {
    return empty(isDeadlineError(error) ? 'timeout' : `error ${describeError(error)}`);
  }
}

// ------------------------------------------------------------------ the process

/** stdin, asynchronously, so the deadline can end the wait; '' when it is too large. */
function readStdinText(stream, waitMs, log) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.pause?.();
      resolve(text);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), waitMs);
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        log('stdin too large');
        finish('');
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', (error) => {
      log(`stdin unreadable: ${describeError(error)}`);
      finish('');
    });
  });
}

/** Claude Code's log; the Codex entry point passes its own (codex-session-start.mjs). */
export const CLAUDE_LOG_PATH = path.join(os.homedir(), '.claude', 'hooks', 'session-start.log');

/** Where this process logs when HARNESS_SESSION_START_LOG is unset; set by startHookProcess. */
let fallbackLogPath = CLAUDE_LOG_PATH;

function defaultLogPath(env) {
  return env[LOG_ENV_VAR] || fallbackLogPath;
}

async function main(runtime) {
  const startedAtMs = Date.now();
  const problems = [];
  let env = process.env;
  try {
    env = loadMachineEnv(process.env, os.homedir(), (message) => problems.push(message));
  } catch (error) {
    problems.push(`machine.env: ${describeError(error)}`);
  }
  const log = createLogger(defaultLogPath(env));
  for (const problem of problems) log(problem);

  const raw = await readStdinText(process.stdin, STDIN_BUDGET_MS, log);
  const remaining = Math.max(0, startedAtMs + BRIEF_DEADLINE_MS - Date.now());
  const { stdout } = await run({ raw, env, log, timeoutMs: remaining, runtime });
  return stdout;
}

/** Set once the one answer is on its way; rule 1 allows exactly one JSON document. */
let answered = false;

function answerAndExit(stdout) {
  if (answered) return;
  answered = true;
  // A pending read on a stalled drive would otherwise keep the process alive.
  setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref();
  process.stdout.on('error', () => process.exit(0));
  process.stdout.write(stdout, () => process.exit(0));
}

/**
 * The last line of defence for rule 1: a throw from outside run() — a stray
 * timer, a rejected promise nobody awaited — still gets the empty answer if
 * none has gone out, and never a second one if it has; the exit is 0 either
 * way (the pending write's callback, or the grace timer, ends the process).
 */
function onFatal(error) {
  try {
    createLogger(defaultLogPath(process.env))(`fatal: uncaught ${describeError(error)}`);
  } catch {
    /* the answer matters more than the log line */
  }
  answerAndExit(EMPTY_OUTPUT);
}

/**
 * Run as a hook process: read stdin, answer once, exit 0. Claude Code's entry
 * point (below) and Codex's (codex-session-start.mjs) both call this; they
 * differ only in where the log goes when HARNESS_SESSION_START_LOG is unset.
 */
export function startHookProcess({ logPath = CLAUDE_LOG_PATH, runtime = 'claude-code' } = {}) {
  fallbackLogPath = logPath;
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  main(runtime).then(answerAndExit, (error) => {
    createLogger(defaultLogPath(process.env))(`fatal: ${describeError(error)}`);
    answerAndExit(EMPTY_OUTPUT);
  });
}

if (isEntryPoint(import.meta.url)) startHookProcess();
