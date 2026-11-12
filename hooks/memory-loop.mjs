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
export const KILL_AFTER_MS = 60_000;
/** After a stop: well inside compose's stop_grace_period (150 s) for harness-memory. */
export const STOP_KILL_AFTER_MS = 90_000;
/** The owner a container worker writes into memory-worker.lock (memory-worker.mjs). */
const CONTAINER_LOCK_OWNER = 'memory worker (container)';
const QUEUE_FILES = ['memory-ingest-queue.jsonl', 'codex-ingest-queue.jsonl'];
const SIGNAL_EXIT_BASE = 128;
const EXIT_CONFIG = 78;

/**
 * The newest modification time of a non-empty queue file, or 0. Compared only
 * with an earlier reading of itself, never with this process's clock: the
 * host's hooks write the queue, and the host's clock and the container's can
 * differ (WSL2 after sleep). A drain renames the queue away and keeps what
 * failed in the renamed copy, so a failed drain does not start a run every poll.
 */
export function queueStamp(stateDir) {
  let newest = 0;
  for (const name of QUEUE_FILES) {
    try {
      const stat = fs.statSync(path.join(stateDir, name));
      if (stat.size > 0) newest = Math.max(newest, stat.mtimeMs);
    } catch { /* no queue */ }
  }
  return newest;
}

/**
 * One worker run as a child process; resolves with its exit code. Past its time
 * limit the run gets SIGTERM, which the worker takes when its synchronous work
 * yields (it then releases its lock); a run that never yields gets SIGKILL a
 * minute later, and its lock goes stale on its own.
 */
export function workerRunner({ env, workerPath, stateDir = '', timeoutMs = RUN_TIMEOUT_MS, killAfterMs = KILL_AFTER_MS, onChild = () => {},
  spawn: spawnImpl = spawn, signal = signalJob, setTimer = setTimeout, clearTimer = clearTimeout }) {
  return async () => {
    let running = null;
    let pid = 0;
    const startedAt = Date.now();
    const timers = [];
    timers.push(setTimer(() => {
      if (!running) return;
      signal(running, 'SIGTERM');
      timers.push(setTimer(() => { if (running) signal(running, 'SIGKILL'); }, killAfterMs));
    }, timeoutMs));
    try {
      const code = await spawnJob({ command: process.execPath, args: [workerPath] }, {
        env,
        spawn: spawnImpl,
        onChild: (child) => { running = child; if (child) pid = child.pid; onChild(child); },
      });
      if (code >= SIGNAL_EXIT_BASE && stateDir) releaseKilledWorkerLock(stateDir, pid, startedAt);
      return code;
    } finally { timers.forEach(clearTimer); }
  };
}

/**
 * A worker ended by a signal before its run yielded cannot release its lock,
 * and the lock would stop every worker, host included, until it is 90 minutes
 * old. The loop removes it, but only one this worker took: its process id, and
 * taken after this run started (a reused id of an older holder does not count).
 */
export function releaseKilledWorkerLock(stateDir, pid, startedAtMs) {
  const lockPath = path.join(stateDir, 'memory-worker.lock');
  let holder;
  try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return false; }
  // The container's own lock only: a host pid can equal a container one.
  if (holder?.owner !== CONTAINER_LOCK_OWNER) return false;
  if (!pid || holder?.pid !== pid || !(Date.parse(holder.startedAt) >= startedAtMs - 1000)) return false;
  try { fs.rmSync(lockPath); return true; } catch { return false; }
}

/**
 * Run at start, then on the interval or when the queue changed since the last
 * run started (an entry written during a run, after its drain, counts), until
 * `shouldStop`.
 */
export async function runWorkerLoop({ now, sleep, shouldStop, queueStamp, runOnce, log,
  intervalMs = RUN_INTERVAL_MS, pollMs = QUEUE_POLL_MS }) {
  let lastStart = Number.NEGATIVE_INFINITY;
  let seenStamp = Number.NEGATIVE_INFINITY;
  while (!shouldStop()) {
    const due = now() - lastStart >= intervalMs;
    const queued = !due && queueStamp() > seenStamp;
    if (due || queued) {
      lastStart = now();
      seenStamp = queueStamp();
      let code;
      try { code = await runOnce(); } catch (error) { code = `spawn failed (${error?.code || 'error'})`; }
      log(`run (${queued ? 'queue' : 'interval'}) exit ${code} in ${Math.round((now() - lastStart) / 1000)} s`);
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
  let running = null;
  // A stop reaches the worker as SIGTERM, which it takes when its synchronous
  // run yields. A run that does not yield in time is killed here, inside
  // compose's 150 s grace, so the loop is still alive to release its lock.
  const stop = (signal) => {
    stopper.stop(signal);
    setTimeout(() => { if (running) signalJob(running, 'SIGKILL'); }, STOP_KILL_AFTER_MS).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  const stateDir = harnessDir(os.homedir());
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-worker.mjs');
  log(`started: every ${RUN_INTERVAL_MS / 60_000} min, queue checked every ${QUEUE_POLL_MS / 1000} s`);
  return runWorkerLoop({
    now: Date.now,
    sleep: stopper.sleep,
    shouldStop: stopper.shouldStop,
    queueStamp: () => queueStamp(stateDir),
    runOnce: workerRunner({ env: secrets.env, workerPath, stateDir,
      onChild: (child) => { running = child; stopper.onChild(child); } }),
    log,
  }).then(() => { log('stopped'); return 0; });
}

if (isEntryPoint(import.meta.url)) {
  runAsProcess().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`memory-loop: ${error?.stack || error}`); process.exitCode = 70; },
  );
}
