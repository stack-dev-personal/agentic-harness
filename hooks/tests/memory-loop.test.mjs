import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { queueChangedSince, runWorkerLoop, workerRunner } from '../memory-loop.mjs';

const MINUTE = 60_000;

/** A fake clock the loop's sleep advances; the loop stops after `until`. */
function harness({ until, queue = () => false, runOnce }) {
  let clock = 0;
  const runs = [];
  const lines = [];
  const deps = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    shouldStop: () => clock >= until,
    queueChanged: (since) => queue(since, clock),
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
  const h = harness({ until: 4 * MINUTE, queue: (since, clock) => clock === 2 * MINUTE && since < clock });
  await runWorkerLoop(h.deps);
  assert.deepEqual(h.runs, [0, 2 * MINUTE]);
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

test('queueChangedSince: only a non-empty queue written after the last run counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-loop-'));
  try {
    assert.equal(queueChangedSince(dir, 0), false, 'no queue file');
    const queue = path.join(dir, 'memory-ingest-queue.jsonl');
    fs.writeFileSync(queue, '');
    assert.equal(queueChangedSince(dir, 0), false, 'empty queue');
    fs.writeFileSync(queue, '{"note":"projects/demo/sessions/a.md"}\n');
    const written = fs.statSync(queue).mtimeMs;
    assert.equal(queueChangedSince(dir, written - 1000), true, 'written after the last run');
    assert.equal(queueChangedSince(dir, written + 1000), false, 'left over from a failed drain: wait for the interval');
    fs.rmSync(queue);
    fs.writeFileSync(path.join(dir, 'codex-ingest-queue.jsonl'), '"C:/vault/x.md"\n');
    assert.equal(queueChangedSince(dir, 0), true, 'the legacy queue counts too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
