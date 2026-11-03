#!/usr/bin/env node
/**
 * The AgenticHarness-CodexIngest scheduled task: drain the queue the SessionEnd
 * hook fills, sweep idle Codex chats that never got a note, then drain what
 * the sweep wrote. Draining first means a long sweep never holds up notes
 * that are already waiting.
 */
import os from 'node:os';
import path from 'node:path';

import { captureCodex } from './codex-session-capture.mjs';
import { drainCodexIngest, queueCodexIngest } from './lib/codex-ingest-queue.mjs';
import { sweepCodex } from './lib/codex-sweep.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { createLogger } from './lib/logger.mjs';
import { loadMachineEnv } from './lib/machine-env.mjs';
import { installExtraRulesFrom } from './lib/redact-extra.mjs';

function drain(log) {
  const result = drainCodexIngest({ log });
  if (result.ingested) log(`complete: ${result.ingested} note(s)`);
  return result.failed.length;
}

function sweepSummary(sweep) {
  const flags = [sweep.blocked && 'blocked (vault unavailable)', sweep.truncated && 'truncated (budget)',
    sweep.deferred && `deferred=${sweep.deferred}`].filter(Boolean).join(' ');
  return `sweep: scanned=${sweep.scanned} eligible=${sweep.eligible} written=${sweep.written} errors=${sweep.errors}${flags ? ` ${flags}` : ''}`;
}

function main(log) {
  // Capture reads machine name and state dir from process.env, as the hooks do.
  Object.assign(process.env, loadMachineEnv(process.env, os.homedir(), log));
  installExtraRulesFrom(process.env, log);
  const vaultRoot = process.env.HARNESS_VAULT || path.join(os.homedir(), 'vault');
  let failedFiles = drain(log);
  const sweep = sweepCodex({ vaultRoot, capture: captureCodex, log });
  if (sweep.due) log(sweepSummary(sweep));
  if (sweep.touchedPaths.length) {
    queueCodexIngest({ notePaths: sweep.touchedPaths, vaultRoot, log, startTask: false });
    failedFiles = drain(log);
  }
  if (failedFiles) process.exitCode = 1;
}

if (isEntryPoint(import.meta.url)) {
  const log = createLogger(path.join(os.homedir(), '.codex', 'hooks', 'ingest-queue.log'));
  try {
    main(log);
  } catch (error) {
    log(`failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
