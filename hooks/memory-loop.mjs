#!/usr/bin/env node
/**
 * The memory worker on a timer, for the `harness-memory` container service.
 *
 *   node hooks/memory-loop.mjs
 *
 * Runs `memory-worker.mjs` once at start, then every five minutes, and within
 * one poll (30 s) when a host hook adds to the ingest queue. One run at a time,
 * each in its own process group, so a stop or a time limit reaches the worker
 * and the ingest it starts. Not a scheduler job: `scheduler.mjs` holds one run
 * lock for wall-clock windows, and a nightly would hold this back for an hour.
 *
 * The worker's own log and health file are where they are on the host
 * (`~/.harness`); this process writes one line per run to stdout for
 * `docker logs`. A failed run is logged and the next one comes on time: the
 * health check (`memory-worker.mjs --health`) is what turns red.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './lib/entry-point.mjs';
import { harnessDir } from './lib/machine-env.mjs';
import { createStopper, envWithSecretFiles, signalJob, spawnJob } from './scheduler.mjs';

export const RUN_INTERVAL_MS = 5 * 60_000;
export const QUEUE_POLL_MS = 30_000;
/** Longer than the worker's own 15-minute capture budget plus an ingest. */
export const RUN_TIMEOUT_MS = 30 * 60_000;
const QUEUE_FILES = ['memory-ingest-queue.jsonl', 'codex-ingest-queue.jsonl'];
const SIGNAL_EXIT_BASE = 128;
const EXIT_CONFIG = 78;

/**
 * True when a queue holds entries written after `sinceMs`. Entries a failed
 * drain kept are older than the run that kept them, so they wait for the next
 * interval instead of starting a run every poll.
 */
export function queueChangedSince(stateDir, sinceMs) {
  return QUEUE_FILES.some((name) => {
    try {
      const stat = fs.statSync(path.join(stateDir, name));
      return stat.size > 0 && stat.mtimeMs > sinceMs;
    } catch { return false; }
  });
}

/** One worker run as a child process; resolves with its exit code. */
export function workerRunner({ env, workerPath, timeoutMs = RUN_TIMEOUT_MS, onChild = () => {},
  spawn: spawnImpl = spawn, signal = signalJob, setTimer = setTimeout, clearTimer = clearTimeout }) {
  return () => {
    let running = null;
    const timer = setTimer(() => { if (running) signal(running, 'SIGTERM'); }, timeoutMs);
    return spawnJob({ command: process.execPath, args: [workerPath] }, {
      env,
      spawn: spawnImpl,
      onChild: (child) => { running = child; onChild(child); },
    }).finally(() => clearTimer(timer));
  };
}

/** Run at start, then on the interval or on new queue entries, until `shouldStop`. */
export async function runWorkerLoop({ now, sleep, shouldStop, queueChanged, runOnce, log,
  intervalMs = RUN_INTERVAL_MS, pollMs = QUEUE_POLL_MS }) {
  let lastStart = Number.NEGATIVE_INFINITY;
  let lastEnd = Number.NEGATIVE_INFINITY;
  while (!shouldStop()) {
    const due = now() - lastStart >= intervalMs;
    const queued = !due && queueChanged(lastEnd);
    if (due || queued) {
      lastStart = now();
      let code;
      try { code = await runOnce(); } catch (error) { code = `spawn failed (${error?.code || 'error'})`; }
      lastEnd = now();
      log(`run (${queued ? 'queue' : 'interval'}) exit ${code} in ${Math.round((lastEnd - lastStart) / 1000)} s`);
    }
    if (shouldStop()) break;
    await sleep(pollMs);
  }
}

function runAsProcess() {
  const log = (line) => console.log(`${new Date().toISOString()} memory-loop: ${line}`);
  const secrets = envWithSecretFiles(process.env);
  if (!secrets.ok) {
    console.error(`memory-loop: ${secrets.problem}`);
    return Promise.resolve(EXIT_CONFIG);
  }
  const stopper = createStopper();
  process.once('SIGTERM', () => stopper.stop('SIGTERM'));
  process.once('SIGINT', () => stopper.stop('SIGINT'));
  const stateDir = harnessDir(os.homedir());
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-worker.mjs');
  log(`started: every ${RUN_INTERVAL_MS / 60_000} min, queue checked every ${QUEUE_POLL_MS / 1000} s`);
  return runWorkerLoop({
    now: Date.now,
    sleep: stopper.sleep,
    shouldStop: stopper.shouldStop,
    queueChanged: (since) => queueChangedSince(stateDir, since),
    runOnce: workerRunner({ env: secrets.env, workerPath, onChild: stopper.onChild }),
    log,
  }).then(() => { log('stopped'); return 0; });
}

if (isEntryPoint(import.meta.url)) {
  runAsProcess().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`memory-loop: ${error?.stack || error}`); process.exitCode = 70; },
  );
}
