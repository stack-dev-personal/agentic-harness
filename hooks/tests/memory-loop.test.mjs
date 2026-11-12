import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { queueStamp, runWorkerLoop, workerRunner } from '../memory-loop.mjs';

const MINUTE = 60_000;

/** A fake clock the loop's sleep advances; the loop stops after `until`. `stamp(clock)` is the queue's file time. */
function harness({ until, stamp = () => 0, runOnce }) {
  let clock = 0;
  const runs = [];
  const lines = [];
  const deps = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    shouldStop: () => clock >= until,
    queueStamp: () => stamp(clock),
    runOnce: async () => { runs.push(clock); return runOnce ? runOnce(clock) : 0; },
    log: (line) => lines.push(line),
    intervalMs: 5 * MINUTE,
    pollMs: 30_000,
  };
  return { deps, runs, lines };
}

test('the worker runs at start and then every five minutes', async () => {
  const h = harness({ until: 16 * MINUTE });
  await runWorkerLoop(h.deps);
  assert.deepEqual(h.runs, [0, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE]);
});

test('new queue entries start a run within one poll, not at the next interval', async () => {
  // The host writes an entry at 1:45; its file time is the host's clock, far behind
  // this one (1 ms against 105,000), which a comparison with this clock would ignore.
  const h = harness({ until: 4 * MINUTE, stamp: (clock) => (clock >= 1.75 * MINUTE ? 1 : 0) });
  await runWorkerLoop(h.deps);
  assert.deepEqual(h.runs, [0, 2 * MINUTE]);
});

test('an entry written during a run, after its drain, starts the next run at the next poll', async () => {
  let written = 0;
  const h = harness({ until: 3 * MINUTE, stamp: () => written });
  h.deps.runOnce = async () => { h.runs.push(h.deps.now()); if (h.runs.length === 1) written = 42; return 0; };
  await runWorkerLoop(h.deps);
  assert.deepEqual(h.runs, [0, 0.5 * MINUTE]);
});

test('a queue that does not change starts no run between intervals', async () => {
  const h = harness({ until: 4 * MINUTE, stamp: () => 1234 });
  await runWorkerLoop(h.deps);
  assert.deepEqual(h.runs, [0]);
});

test('a run that takes a while still keeps the five-minute rhythm from its start', async () => {
  const h = harness({ until: 11 * MINUTE });
  h.deps.runOnce = async () => { h.runs.push(h.deps.now()); await h.deps.sleep(2 * MINUTE); return 0; };
  await runWorkerLoop(h.deps);
  assert.deepEqual(h.runs, [0, 5 * MINUTE, 10 * MINUTE]);
});

test('a failed run is logged and the loop carries on', async () => {
  const h = harness({ until: 6 * MINUTE, runOnce: () => 1 });
  await runWorkerLoop(h.deps);
  assert.equal(h.runs.length, 2);
  assert.ok(h.lines.some((line) => /exit 1/.test(line)));
});

test('a stop during the wait ends the loop without another run', async () => {
  let stopped = false;
  const h = harness({ until: Infinity });
  h.deps.shouldStop = () => stopped;
  h.deps.sleep = async () => { stopped = true; };
  await runWorkerLoop(h.deps);
  assert.deepEqual(h.runs, [0]);
});

test('a run that outlives its time limit gets SIGTERM, then SIGKILL, and the loop gets its exit code', async () => {
  const { EventEmitter } = await import('node:events');
  const child = Object.assign(new EventEmitter(), { pid: 4242 });
  const signals = [];
  const timers = [];
  const runOnce = workerRunner({
    env: {}, workerPath: '/app/hooks/memory-worker.mjs', timeoutMs: 1000, killAfterMs: 500,
    spawn: (command, args) => { assert.deepEqual(args, ['/app/hooks/memory-worker.mjs']); return child; },
    // A worker stuck in synchronous work ignores SIGTERM; SIGKILL ends it.
    signal: (running, signal) => { signals.push([running.pid, signal]); if (signal === 'SIGKILL') running.emit('exit', null, signal); },
    setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimer: () => {},
  });
  const pending = runOnce();
  timers[0].callback();
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  assert.equal(timers[1].ms, 500);
  timers[1].callback();
  assert.equal(await pending, 128 + os.constants.signals.SIGKILL);
  assert.deepEqual(signals, [[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
});

function killedRun({ lock, exitSignal = 'SIGKILL', exitCode = null }) {
  return async () => {
    const { EventEmitter } = await import('node:events');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-loop-lock-'));
    const lockPath = path.join(dir, 'memory-worker.lock');
    const child = Object.assign(new EventEmitter(), { pid: 4242 });
    const runOnce = workerRunner({ env: {}, workerPath: '/w.mjs', stateDir: dir, spawn: () => {
      if (lock) fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 4242, owner: 'memory worker (container)', startedAt: new Date().toISOString(), token: 't', ...lock })}\n`);
      setImmediate(() => child.emit('exit', exitCode, exitSignal));
      return child;
    } });
    try { await runOnce(); return fs.existsSync(lockPath); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test('the lock of a worker killed mid-run is released by the loop', async () => {
  assert.equal(await killedRun({ lock: {} })(), false);
});

test('a lock the killed worker did not take is left alone', async () => {
  assert.equal(await killedRun({ lock: { pid: 777 } })(), true, 'another process holds it');
  assert.equal(await killedRun({ lock: { owner: 'memory worker (host)' } })(), true, 'the host holds it, whatever its pid');
  assert.equal(await killedRun({ lock: { startedAt: '2026-01-01T00:00:00Z' } })(), true, 'taken before this run: a reused pid');
  assert.equal(await killedRun({ lock: {}, exitSignal: null, exitCode: 0 })(), true, 'a worker that exited normally released its own');
});

test('queueStamp: the newest file time of a non-empty queue, legacy queue included; a drained copy does not count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-loop-'));
  try {
    assert.equal(queueStamp(dir), 0, 'no queue file');
    const queue = path.join(dir, 'memory-ingest-queue.jsonl');
    fs.writeFileSync(queue, '');
    assert.equal(queueStamp(dir), 0, 'empty queue');
    fs.writeFileSync(queue, '{"note":"projects/demo/sessions/a.md"}\n');
    assert.equal(queueStamp(dir), fs.statSync(queue).mtimeMs);
    // A drain renames the queue away; what failed stays in the renamed copy.
    fs.renameSync(queue, `${queue}.processing-7-0`);
    assert.equal(queueStamp(dir), 0, 'a kept copy waits for the interval');
    const legacy = path.join(dir, 'codex-ingest-queue.jsonl');
    fs.writeFileSync(legacy, '"C:/vault/x.md"\n');
    assert.equal(queueStamp(dir), fs.statSync(legacy).mtimeMs, 'the legacy queue counts too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
