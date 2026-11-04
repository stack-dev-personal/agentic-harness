#!/usr/bin/env node
/**
 * session-capture.mjs — Claude Code `SessionEnd` hook.
 *
 * Turns a finished session's JSONL transcript into one markdown note in the
 * Obsidian vault, so the RAG ingestion pipeline can embed it.
 *
 * Contract (verified against the Claude Code 2.1.267 bundle, not assumed):
 *   stdin JSON = { session_id, transcript_path, cwd, hook_event_name:"SessionEnd",
 *                  reason: "clear"|"resume"|"logout"|"prompt_input_exit"|"other",
 *                  prompt_id?, permission_mode?, agent_id?, agent_type?,
 *                  scratchpad_dir?, effort? }
 *
 * Design rules, in priority order:
 *   1. NEVER block session exit. Everything optional is behind a deadline check
 *      and the elapsed milliseconds are logged on every run.
 *   2. NEVER fail loudly. Every path exits 0. A capture hook that throws on the
 *      way out of a session is worse than no capture hook at all.
 *   3. NEVER write a credential. Only user prompts, tool *inputs* and the closing
 *      assistant message are copied, all through redaction; raw tool output is
 *      never copied.
 *   4. NEVER write an empty note. Zero user prompts means nothing to remember.
 *
 * This file is the deployed copy's source of truth. It lives in the repo at
 * `hooks/session-capture.mjs` and is installed to `~/.claude/hooks/` by
 * `node hooks/install.mjs`. Edit it here, never there.
 *
 * Disable: set HARNESS_SESSION_CAPTURE=0, or remove the SessionEnd block from
 * ~/.claude/settings.json. See ./README.md.
 */

import os from 'node:os';
import path from 'node:path';

import { capture } from './lib/capture.mjs';
import { captureSubagent } from './lib/subagent.mjs';
import {
  BUDGET_MS,
  DEFAULT_VAULT_SEGMENTS,
  DISABLE_ENV_VAR,
  DISABLE_VALUES,
  LOG_ENV_VAR,
  SUBAGENT_STOP_EVENT,
  VAULT_ENV_VAR,
} from './lib/constants.mjs';
import { createLogger } from './lib/logger.mjs';
import { loadMachineEnv } from './lib/machine-env.mjs';
import { installExtraRulesFrom } from './lib/redact-extra.mjs';
import { queueIngest } from './lib/ingest-queue.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { parseHookInput, readStdin } from './lib/stdin.mjs';

const STARTED_AT_MS = Date.now();
const DEADLINE_AT = STARTED_AT_MS + BUDGET_MS;

// The machine file behaves like exported variables for this process and the
// detached ingest it spawns. Read after the clock starts, so its cost is in
// the logged milliseconds, and inside its own guard: a machine file that
// somehow throws must not cost the note. Problems are logged once the logger exists.
// The machine's extra redaction rules (R-106) are installed here too, after the
// machine file that may name them and before anything is read from a transcript.
function loadEnvironment() {
  const problems = [];
  try {
    Object.assign(process.env, loadMachineEnv(process.env, os.homedir(), (message) => problems.push(message)));
  } catch (err) {
    problems.push(`machine.env: ${err?.message || err}`);
  }
  try {
    installExtraRulesFrom(process.env, (message) => problems.push(message));
  } catch (err) {
    problems.push(`redact-extra: ${err?.message || err}`);
  }
  return problems;
}

/** Read after the machine file is loaded, which may name it. */
function defaultLogPath() {
  return process.env[LOG_ENV_VAR] || path.join(os.homedir(), '.claude', 'hooks', 'session-capture.log');
}

function main(logPath, machineEnvProblems) {
  const log = createLogger(logPath);
  for (const problem of machineEnvProblems) log(problem);

  if (DISABLE_VALUES.has(String(process.env[DISABLE_ENV_VAR] ?? '').toLowerCase())) return;

  const raw = readStdin(DEADLINE_AT);
  const parsed = parseHookInput(raw, process.env);
  if (!parsed.ok) {
    log(`skip: ${parsed.error}`);
    return;
  }

  const input = parsed.value;
  // One entry point, two events. `SubagentStop` writes the worker's own note and
  // links it to its parent; `SessionEnd` writes the session's.
  const write = input.hookEventName === SUBAGENT_STOP_EVENT ? captureSubagent : capture;
  const outcome = write({
    input,
    vaultRoot: process.env[VAULT_ENV_VAR] || path.join(os.homedir(), ...DEFAULT_VAULT_SEGMENTS),
    projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
    startedAtMs: STARTED_AT_MS,
    deadlineAt: DEADLINE_AT,
    // Only `captureSubagent` has anything to say besides its outcome (a
    // duplicate or unreadable copy elsewhere); `capture` ignores it.
    log,
  });

  if (!outcome.written) {
    log(
      `${outcome.action} ${input.hookEventName || 'SessionEnd'} ${input.sessionId}: ` +
        `${outcome.skip} ms=${Date.now() - STARTED_AT_MS}`,
    );
    return;
  }

  // ------------------------------------------------------------------ SEAM
  // The note is on disk and correct. The detached per-note ingest (R-27.5)
  // starts here and nowhere else: enqueueIngest does not await, cannot throw,
  // and leaves the log line below as the last thing this function does.
  //
  // It is still optional work, so rule 1 applies to it like everything else:
  // past the deadline the note waits for the nightly reconcile rather than
  // holding up session exit. `touchedPaths` is every note the capture actually
  // changed, which on a resume is two.
  // ----------------------------------------------------------------------

  if (Date.now() < DEADLINE_AT) {
    queueIngest({ notePaths: outcome.touchedPaths, vaultRoot: outcome.vaultRoot, log });
  } else {
    log('ingest-enqueue skipped: over budget');
  }

  // Measured last, so the number in the log is the hook's real cost including
  // the spawn, not the cost of everything that came before it.
  log(`${outcome.action} ${outcome.detail} ms=${Date.now() - STARTED_AT_MS}`);
}

// Importable without acting (and without ending the importer's process): only
// the run Claude Code starts reads stdin, writes a note and exits.
if (isEntryPoint(import.meta.url)) {
  const machineEnvProblems = loadEnvironment();
  const logPath = defaultLogPath();
  try {
    main(logPath, machineEnvProblems);
  } catch (err) {
    // Absolute last line of defence: session exit must not surface an error.
    createLogger(logPath)(`fatal: ${err?.stack || err?.message || String(err)}`);
  }
  process.exit(0);
}
