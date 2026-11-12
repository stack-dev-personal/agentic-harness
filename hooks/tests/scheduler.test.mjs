/**
 * The container scheduler as a process (R-90, P-106): state on disk, the run
 * lock, and the tick that starts what is due.
 *
 * Every test works in a scratch state folder with a scripted clock and a
 * scripted runner, so nothing here starts the nightly reconcile or the
 * collector. The time rules themselves are in schedule.test.mjs.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SYNC_FETCH_TIMEOUT_MS } from '../lib/realm-steps.mjs';
import { composeService } from './helpers/compose-service.mjs';
import { EMPTY_STATE, JOB_COLLECT, JOB_NIGHTLY, serializeState, withStart } from '../lib/schedule.mjs';
import {
  DEFAULT_STATE_FILE,
  EXIT_BUSY,
  EXIT_CONFIG,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_SPAWN_FAILED,
  EXIT_USAGE,
  OWNER_LOOP,
  OWNER_RUN_NOW,
  RUN_LOCK_FILENAME,
  RUN_LOCK_STALE_MS,
  SECRET_FILE_VARS,
  STATE_ENV_VAR,
  TICK_MS,
  acquireRunLock,
  createStopper,
  envWithSecretFiles,
  main,
  parseArgs,
  readState,
  releaseRunLock,
  runLoop,
  signalJob,
  spawnJob,
  spawnRunner,
  tick,
  writeStateAtomic,
} from '../scheduler.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const at = (iso) => Date.parse(iso);
const DEAD_PID = 999_999;

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateFile: path.join(root, 'scheduler.json'), lockPath: path.join(root, RUN_LOCK_FILENAME) };
}

/** A state in which both jobs last started at `iso`. */
function bothRanAt(iso) {
  const run = { startedAtMs: at(iso), windowMs: at(iso) };
  return withStart(withStart(EMPTY_STATE, JOB_NIGHTLY, run), JOB_COLLECT, run);
}

/** A runner that records each job it is asked to run and exits with `code`. */
function recordingRunner(code = 0) {
  const ran = [];
  const runner = async (job) => {
    ran.push(job);
    return code;
  };
  return { ran, runner };
}

/** Dependencies for `tick` and `main`: a fixed clock and a quiet log. */
function deps(s, now, extra = {}) {
  return { stateFile: s.stateFile, now: () => at(now), log: () => {}, pid: process.pid, ...extra };
}

const stateOnDisk = (s) => JSON.parse(fs.readFileSync(s.stateFile, 'utf8'));

test('the defaults are the contract: /state/scheduler.json, a 30 s tick', () => {
  assert.equal(DEFAULT_STATE_FILE, '/state/scheduler.json');
  assert.equal(STATE_ENV_VAR, 'HARNESS_SCHEDULER_STATE');
  assert.equal(TICK_MS, 30_000);
  assert.equal(RUN_LOCK_FILENAME, 'scheduler.lock');
});

test('parseArgs reads --run-now and --state, and refuses anything else', () => {
  assert.deepEqual(parseArgs([], {}), { ok: true, options: { stateFile: DEFAULT_STATE_FILE, runNow: '', help: false } });
  assert.equal(parseArgs([], { [STATE_ENV_VAR]: '/tmp/s.json' }).options.stateFile, '/tmp/s.json');
  assert.equal(parseArgs(['--state', '/x/s.json'], { [STATE_ENV_VAR]: '/tmp/s.json' }).options.stateFile, '/x/s.json');
  assert.equal(parseArgs(['--run-now', 'nightly'], {}).options.runNow, 'nightly');
  assert.equal(parseArgs(['--run-now', 'collect'], {}).options.runNow, 'collect');
  assert.match(parseArgs(['--run-now', 'weekly'], {}).error, /nightly\|collect/);
  assert.match(parseArgs(['--run-now'], {}).error, /needs a value/);
  assert.match(parseArgs(['--state'], {}).error, /needs a value/);
  assert.match(parseArgs(['--nightly'], {}).error, /unknown argument/);
});

test('the state is written to a temporary file and renamed into place', (t) => {
  const s = scratch(t);
  const calls = [];
  const recordingFs = {
    ...fs,
    writeFileSync: (file, ...rest) => { calls.push(['write', path.basename(file)]); return fs.writeFileSync(file, ...rest); },
    renameSync: (from, to) => { calls.push(['rename', path.basename(from), path.basename(to)]); return fs.renameSync(from, to); },
  };
  const state = bothRanAt('2026-10-31T07:00:00.000Z');
  writeStateAtomic(s.stateFile, state, { fsImpl: recordingFs });

  assert.equal(calls.length, 2);
  const [write, rename] = calls;
  assert.equal(write[0], 'write');
  assert.notEqual(write[1], 'scheduler.json', 'the first write never goes to the state file itself');
  assert.deepEqual(rename, ['rename', write[1], 'scheduler.json']);
  assert.deepEqual(fs.readdirSync(s.root), ['scheduler.json'], 'no temporary file is left');
  assert.deepEqual(readState(s.stateFile), state);
});

test('a write that cannot be renamed leaves the old state whole and no temporary file', (t) => {
  const s = scratch(t);
  const old = bothRanAt('2026-10-30T07:00:00.000Z');
  writeStateAtomic(s.stateFile, old);
  const failingFs = { ...fs, renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };

  assert.throws(() => writeStateAtomic(s.stateFile, bothRanAt('2026-10-31T07:00:00.000Z'), { fsImpl: failingFs }), /EBUSY|busy/);
  assert.deepEqual(readState(s.stateFile), old);
  assert.deepEqual(fs.readdirSync(s.root), ['scheduler.json']);
});

test('a missing state reads as empty; a corrupt one is reported and reads as empty', (t) => {
  const s = scratch(t);
  assert.deepEqual(readState(s.stateFile), EMPTY_STATE);
  fs.writeFileSync(s.stateFile, '{"jobs":');
  const reports = [];
  assert.deepEqual(readState(s.stateFile, { report: (line) => reports.push(line) }), EMPTY_STATE);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /scheduler\.json/);
});

test('a missed window runs once at start', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, withStart(bothRanAt('2026-10-31T12:59:00.000Z'), JOB_NIGHTLY, {
    startedAtMs: at('2026-10-30T07:00:03.000Z'),
    windowMs: at('2026-10-30T07:00:00.000Z'),
  }));
  const { ran, runner } = recordingRunner();

  const results = await tick(deps(s, '2026-10-31T13:00:00.000Z', { runner }));

  assert.deepEqual(ran, ['nightly']);
  assert.deepEqual(results, [{ job: 'nightly', ran: true, exitCode: 0 }]);
  assert.deepEqual(stateOnDisk(s).jobs.nightly, {
    last_run_at: '2026-10-31T13:00:00.000Z',
    window: '2026-10-31T07:00:00.000Z',
    finished_at: '2026-10-31T13:00:00.000Z',
    exit_code: 0,
  });
});

test('two missed windows also run once, and the next tick runs nothing', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, withStart(bothRanAt('2026-10-31T12:59:00.000Z'), JOB_NIGHTLY, {
    startedAtMs: at('2026-10-28T07:00:03.000Z'),
    windowMs: at('2026-10-28T07:00:00.000Z'),
  }));
  const { ran, runner } = recordingRunner();

  await tick(deps(s, '2026-10-31T13:00:00.000Z', { runner }));
  await tick(deps(s, '2026-10-31T13:00:30.000Z', { runner }));

  assert.deepEqual(ran, ['nightly'], 'three missed nights are one catch-up run');
});

test('last_run_at is on disk before the job starts', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, bothRanAt('2026-10-30T22:30:00.000Z'));
  let seen = null;
  const runner = async () => {
    seen = stateOnDisk(s).jobs.nightly;
    return 0;
  };

  await tick(deps(s, '2026-10-31T07:00:10.000Z', { runner }));

  assert.deepEqual(seen, {
    last_run_at: '2026-10-31T07:00:10.000Z',
    window: '2026-10-31T07:00:00.000Z',
    finished_at: null,
    exit_code: null,
  });
});

test('a restart mid-run never runs it twice', async (t) => {
  const s = scratch(t);
  // What a scheduler killed inside the nightly leaves on disk: the lock it took
  // and the last_run_at it wrote before starting the job, with no finish.
  const startedAtMs = at('2026-10-31T07:00:10.000Z');
  const dead = acquireRunLock(s.stateFile, { job: JOB_NIGHTLY, owner: OWNER_LOOP, pid: DEAD_PID, now: startedAtMs });
  assert.equal(dead.ok, true);
  writeStateAtomic(s.stateFile, withStart(bothRanAt('2026-10-30T22:30:00.000Z'), JOB_NIGHTLY, {
    startedAtMs,
    windowMs: at('2026-10-31T07:00:00.000Z'),
  }));
  assert.equal(stateOnDisk(s).jobs.nightly.finished_at, null);

  // The restarted scheduler, minutes later, inside the same window.
  const { ran, runner } = recordingRunner();
  const results = await tick(deps(s, '2026-10-31T07:05:00.000Z', { runner }));

  assert.deepEqual(ran, [], 'the interrupted nightly is not started again');
  assert.deepEqual(results, []);

  // The dead lock is past the stale window by the time the next job comes due, and does not block it.
  const later = await tick(deps(s, '2026-10-31T16:00:00.000Z', { runner }));
  assert.deepEqual(ran, ['collect']);
  assert.equal(later[0].ran, true);
  assert.ok(!fs.existsSync(s.lockPath), 'the lock is released after the run');
});

test('a lock left by a killed run delays the next job until it is stale, and never drops it', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, bothRanAt('2026-10-31T07:00:10.000Z'));
  // A --run-now killed with its container at 11:50 New York: nothing will ever release this lock.
  const leftAt = at('2026-10-31T15:50:00.000Z');
  assert.equal(acquireRunLock(s.stateFile, { job: JOB_NIGHTLY, owner: OWNER_RUN_NOW, pid: process.pid, now: leftAt }).ok, true);
  const { ran, runner } = recordingRunner();
  const lines = [];
  const at12 = deps(s, '2026-10-31T16:00:00.000Z', { runner, log: (line) => lines.push(line) });

  const waiting = await tick(at12);
  assert.deepEqual(ran, [], 'the lock names this very pid and is ten minutes old: it is still someone else\'s');
  assert.equal(waiting[0].busy, true);
  assert.equal(stateOnDisk(s).jobs.collect.last_run_at, '2026-10-31T07:00:10.000Z', 'a job that waits is not stamped, so it stays due');
  assert.ok(lines.some((line) => /collect: waiting, busy: nightly running since 2026-10-31T15:50:00\.000Z \(--run-now, pid \d+\)/.test(line)), lines.join('\n'));

  await tick(deps(s, new Date(leftAt + RUN_LOCK_STALE_MS).toISOString(), { runner }));
  assert.deepEqual(ran, [], 'exactly at the stale window it is still held');

  const after = await tick(deps(s, new Date(leftAt + RUN_LOCK_STALE_MS + 1000).toISOString(), { runner }));
  assert.deepEqual(ran, ['collect'], 'past the window the lock is taken over and the waiting job runs');
  assert.equal(after[0].ran, true);
});

test('a runner that cannot start is recorded and never thrown', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, bothRanAt('2026-10-30T22:30:00.000Z'));
  const lines = [];

  const results = await tick(deps(s, '2026-10-31T07:00:10.000Z', {
    runner: async () => { throw new Error('spawn bash ENOENT'); },
    log: (line) => lines.push(line),
  }));

  assert.deepEqual(results, [{ job: 'nightly', ran: true, exitCode: EXIT_SPAWN_FAILED }]);
  assert.equal(stateOnDisk(s).jobs.nightly.exit_code, EXIT_SPAWN_FAILED);
  assert.ok(lines.some((line) => /spawn bash ENOENT/.test(line)));
  assert.ok(!fs.existsSync(s.lockPath));
});

test('nightly and collect never overlap: the second starts after the first has ended', async (t) => {
  const s = scratch(t);
  const events = [];
  let releaseNightly;
  const nightlyDone = new Promise((resolve) => { releaseNightly = resolve; });
  const runner = async (job) => {
    events.push(`start ${job}`);
    if (job === 'nightly') await nightlyDone;
    events.push(`end ${job}`);
    return 0;
  };

  const running = tick(deps(s, '2026-10-31T16:00:00.000Z', { runner }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start nightly'], 'collect waits while nightly runs');
  assert.equal(JSON.parse(fs.readFileSync(s.lockPath, 'utf8')).job, 'nightly');

  // A second process asked to run collect right now stands down instead of overlapping.
  const second = recordingRunner();
  const lines = [];
  const code = await main(['--run-now', 'collect', '--state', s.stateFile], {
    ...deps(s, '2026-10-31T16:00:05.000Z', { runner: second.runner }),
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    env: {},
  });
  assert.equal(code, EXIT_BUSY);
  assert.deepEqual(second.ran, []);
  assert.ok(lines.some((line) => /busy: nightly/.test(line)), lines.join('\n'));
  assert.equal(stateOnDisk(s).jobs.collect, undefined, 'a refused run stamps nothing');

  releaseNightly();
  await running;
  assert.deepEqual(events, ['start nightly', 'end nightly', 'start collect', 'end collect']);
  assert.ok(!fs.existsSync(s.lockPath));
});

test('--run-now runs the job whether or not it is due and returns its exit code', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, bothRanAt('2026-10-31T07:00:10.000Z'));
  const { ran, runner } = recordingRunner(4);

  const code = await main(['--run-now', 'nightly', '--state', s.stateFile], {
    ...deps(s, '2026-10-31T09:00:00.000Z', { runner }),
    out: () => {},
    err: () => {},
    env: {},
  });

  assert.equal(code, 4);
  assert.deepEqual(ran, ['nightly']);
  const record = stateOnDisk(s).jobs.nightly;
  assert.equal(record.last_run_at, '2026-10-31T09:00:00.000Z');
  assert.equal(record.window, '2026-10-31T07:00:00.000Z');
  assert.equal(record.exit_code, 4);
});

test('a bad argument is exit 64 with the usage, and nothing runs', async (t) => {
  const s = scratch(t);
  const { ran, runner } = recordingRunner();
  const lines = [];
  const code = await main(['--run-now', 'weekly'], { ...deps(s, '2026-10-31T09:00:00.000Z', { runner }), out: () => {}, err: (line) => lines.push(line), env: {} });
  assert.equal(code, EXIT_USAGE);
  assert.deepEqual(ran, []);
  assert.match(lines.join('\n'), /usage: node hooks\/scheduler\.mjs/);
  assert.ok(!fs.existsSync(s.stateFile));
});

test('the run lock is judged by age alone: a pid says nothing in a container', (t) => {
  const s = scratch(t);
  const now = at('2026-10-31T07:00:00.000Z');
  assert.equal(RUN_LOCK_STALE_MS, 6 * 60 * 60_000);
  const first = acquireRunLock(s.stateFile, { job: 'nightly', owner: OWNER_LOOP, pid: 7, now });
  assert.equal(first.ok, true);
  assert.equal(first.lockPath, s.lockPath);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(s.lockPath, 'utf8'))).sort(), ['job', 'owner', 'pid', 'startedAt', 'token']);

  const held = acquireRunLock(s.stateFile, { job: 'collect', owner: OWNER_RUN_NOW, pid: 42, now: now + 60_000 });
  assert.equal(held.ok, false);
  assert.equal(held.reason, 'held');
  assert.deepEqual(
    { job: held.holder.job, owner: held.holder.owner, pid: held.holder.pid, startedAt: held.holder.startedAt },
    { job: 'nightly', owner: OWNER_LOOP, pid: 7, startedAt: '2026-10-31T07:00:00.000Z' },
  );

  const samePidFresh = acquireRunLock(s.stateFile, { job: 'collect', owner: OWNER_LOOP, pid: 7, now: now + 60_000 });
  assert.equal(samePidFresh.ok, false, 'pid 7 is every scheduler in every container: a fresh lock naming it is still held');

  const atTheWindow = acquireRunLock(s.stateFile, { job: 'collect', owner: OWNER_RUN_NOW, pid: 42, now: now + RUN_LOCK_STALE_MS });
  assert.equal(atTheWindow.ok, false, 'exactly at the stale window it is still held');

  const pastIt = acquireRunLock(s.stateFile, { job: 'collect', owner: OWNER_RUN_NOW, pid: 42, now: now + RUN_LOCK_STALE_MS + 1 });
  assert.equal(pastIt.ok, true, 'past the stale window any holder is taken over');
  assert.equal(JSON.parse(fs.readFileSync(s.lockPath, 'utf8')).job, 'collect');
  assert.deepEqual(fs.readdirSync(s.root), [RUN_LOCK_FILENAME], 'the stale copy moved aside is removed');
});

test('a stale lock naming the current pid does not stop --run-now', async (t) => {
  const s = scratch(t);
  const now = '2026-10-31T16:00:00.000Z';
  const left = acquireRunLock(s.stateFile, { job: 'nightly', owner: OWNER_LOOP, pid: process.pid, now: at(now) - RUN_LOCK_STALE_MS - 60_000 });
  assert.equal(left.ok, true);
  const { ran, runner } = recordingRunner();

  const code = await main(['--run-now', 'collect', '--state', s.stateFile], { ...deps(s, now, { runner }), out: () => {}, err: () => {}, env: {} });

  assert.equal(code, EXIT_OK);
  assert.deepEqual(ran, ['collect']);
  assert.ok(!fs.existsSync(s.lockPath));
});

test('an unreadable lock file is judged by its own age, never treated as free', (t) => {
  const s = scratch(t);
  fs.writeFileSync(s.lockPath, 'not json');
  const mtimeMs = fs.statSync(s.lockPath).mtimeMs;
  assert.equal(acquireRunLock(s.stateFile, { job: 'collect', owner: OWNER_LOOP, pid: 7, now: mtimeMs + 60_000 }).ok, false);
  assert.equal(acquireRunLock(s.stateFile, { job: 'collect', owner: OWNER_LOOP, pid: 7, now: mtimeMs + RUN_LOCK_STALE_MS + 1 }).ok, true);
});

test('a fresh lock moved aside by mistake is put back; when the path was taken meanwhile that is contention, not a holder', (t) => {
  const s = scratch(t);
  const now = at('2026-10-31T16:00:00.000Z');
  const stale = () => {
    fs.rmSync(s.root, { recursive: true, force: true });
    fs.mkdirSync(s.root);
    assert.equal(acquireRunLock(s.stateFile, { job: 'nightly', owner: OWNER_LOOP, pid: 7, now: now - RUN_LOCK_STALE_MS - 1 }).ok, true);
  };
  const freshLock = `${JSON.stringify({ pid: 9, owner: OWNER_RUN_NOW, job: 'collect', startedAt: new Date(now).toISOString(), token: 'fresh' })}\n`;
  // Between our judging the stale lock and our rename, its holder released it and a
  // fresh one was written: the file we move aside is the fresh lock.
  const racing = (afterRename) => ({
    ...fs,
    renameSync: (from, to) => {
      fs.writeFileSync(from, freshLock);
      fs.renameSync(from, to);
      afterRename();
    },
  });

  stale();
  const putBack = acquireRunLock(s.stateFile, { job: 'collect', owner: OWNER_LOOP, pid: 7, now, fsImpl: racing(() => {}) });
  assert.equal(putBack.ok, false);
  assert.equal(putBack.reason, 'held');
  assert.equal(putBack.holder.token, undefined, 'a holder is described without its token');
  assert.equal(putBack.holder.job, 'collect');
  assert.equal(fs.readFileSync(s.lockPath, 'utf8'), freshLock, 'the fresh lock is back in place');
  assert.deepEqual(fs.readdirSync(s.root), [RUN_LOCK_FILENAME]);

  stale();
  const third = `${JSON.stringify({ pid: 11, owner: OWNER_RUN_NOW, job: 'nightly', startedAt: new Date(now).toISOString(), token: 'third' })}\n`;
  const contended = acquireRunLock(s.stateFile, {
    job: 'collect', owner: OWNER_LOOP, pid: 7, now, fsImpl: racing(() => fs.writeFileSync(s.lockPath, third)),
  });
  assert.deepEqual(contended, { ok: false, reason: 'error', error: 'lock contended' });
  assert.equal(fs.readFileSync(s.lockPath, 'utf8'), third, 'the third contender keeps the path');
  const aside = fs.readdirSync(s.root).filter((name) => name !== RUN_LOCK_FILENAME);
  assert.equal(aside.length, 1, 'the only copy of the fresh lock is kept');
  assert.equal(fs.readFileSync(path.join(s.root, aside[0]), 'utf8'), freshLock);
});

test('release removes only a lock carrying our token', (t) => {
  const s = scratch(t);
  const now = at('2026-10-31T07:00:00.000Z');
  const ours = acquireRunLock(s.stateFile, { job: 'nightly', owner: OWNER_LOOP, pid: 41, now });
  assert.deepEqual(releaseRunLock({ lockPath: ours.lockPath, token: 'someone-else' }), { ok: false, error: 'not ours' });
  assert.ok(fs.existsSync(s.lockPath));
  assert.deepEqual(releaseRunLock(ours), { ok: true });
  assert.ok(!fs.existsSync(s.lockPath));
  assert.deepEqual(releaseRunLock(ours), { ok: true }, 'releasing twice is not an error');
});

// ------------------------------------------------ stopping (SIGTERM, SIGINT)

/** Resolves with `value`, or rejects after `ms`: a hang becomes a failure, not a stuck suite. */
const within = (ms, promise, what) => Promise.race([
  promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms).unref(); }),
]);

test('a stop that lands during the first of two due jobs: the second never starts and stays due', async (t) => {
  const s = scratch(t);
  const stopper = createStopper();
  const ran = [];
  const runner = async (job) => {
    ran.push(job);
    stopper.stop('SIGTERM'); // docker stop arrives while the nightly runs
    return 143;
  };

  const results = await tick(deps(s, '2026-10-31T16:00:00.000Z', { runner, shouldStop: stopper.shouldStop }));

  assert.deepEqual(ran, ['nightly'], 'collect was due too, and is not started after the stop');
  assert.deepEqual(results, [{ job: 'nightly', ran: true, exitCode: 143 }]);
  assert.equal(stateOnDisk(s).jobs.collect, undefined, 'unstamped, so the next start runs it');
  assert.ok(!fs.existsSync(s.lockPath));
});

test('a stop before the tick starts nothing at all', async (t) => {
  const s = scratch(t);
  const { ran, runner } = recordingRunner();
  const results = await tick(deps(s, '2026-10-31T16:00:00.000Z', { runner, shouldStop: () => true }));
  assert.deepEqual(ran, []);
  assert.deepEqual(results, []);
  assert.ok(!fs.existsSync(s.stateFile));
});

test('the loop ends as soon as a job stopped mid-run returns: no second job, no 30-second sleep', async (t) => {
  const s = scratch(t);
  const stopper = createStopper();
  const ran = [];
  const lines = [];
  const runner = async (job) => {
    ran.push(job);
    stopper.stop('SIGTERM');
    return 143;
  };

  await within(5_000, runLoop({
    ...deps(s, '2026-10-31T16:00:00.000Z', { runner, log: (line) => lines.push(line) }),
    sleep: stopper.sleep,
    shouldStop: stopper.shouldStop,
  }), 'the loop');

  assert.deepEqual(ran, ['nightly']);
  assert.equal(lines.at(-1), 'stopped');
});

test('a stop wakes a sleep in progress, and a sleep begun after it returns at once', async () => {
  const stopper = createStopper();
  assert.equal(stopper.shouldStop(), false);
  const sleeping = stopper.sleep(60_000);
  setImmediate(() => stopper.stop('SIGTERM'));
  await within(2_000, sleeping, 'the sleep in progress');
  assert.equal(stopper.shouldStop(), true);
  await within(2_000, stopper.sleep(60_000), 'a sleep after the stop');
});

test('a stop passes the signal to the running job, and to nothing when no job runs', () => {
  const signalled = [];
  const stopper = createStopper({ signalJob: (child, signal) => signalled.push([child.pid, signal]) });
  stopper.stop('SIGINT');
  assert.deepEqual(signalled, [], 'no job was running');

  const second = createStopper({ signalJob: (child, signal) => signalled.push([child.pid, signal]) });
  second.onChild({ pid: 4242 });
  second.stop('SIGTERM');
  assert.deepEqual(signalled, [[4242, 'SIGTERM']]);
  second.onChild(null);
  second.stop('SIGTERM');
  assert.deepEqual(signalled, [[4242, 'SIGTERM']], 'the job had ended by the second signal');
});

const POSIX = process.platform !== 'win32';
const NO_GROUPS = 'process groups are POSIX; the scheduler runs in a Linux container';

/** Is a process with this pid still there? */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Poll `check` every 25 ms until it is true or `ms` has passed; returns its last answer. */
async function eventually(check, ms) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 25); });
  return check();
}

test('each job is the leader of its own process group, and a stop signals the group', () => {
  const spawned = [];
  const fakeSpawn = (command, args, options) => {
    spawned.push({ command, args, options });
    return { pid: 4242, once: () => {} };
  };
  spawnJob({ command: 'bash', args: ['/app/scripts/nightly-ingest.sh'] }, { env: { A: '1' }, spawn: fakeSpawn, platform: 'linux' });
  spawnJob({ command: 'bash', args: ['x.sh'] }, { env: {}, spawn: fakeSpawn, platform: 'win32' });
  assert.equal(spawned[0].options.detached, true, 'detached makes the child a group leader on POSIX');
  assert.deepEqual(spawned[0].options.stdio, ['ignore', 'inherit', 'inherit']);
  assert.deepEqual(spawned[0].options.env, { A: '1' });
  assert.equal(spawned[1].options.detached, false, 'on Windows detached would open a console window and gives no group');

  const killed = [];
  const kill = (pid, signal) => killed.push([pid, signal]);
  signalJob({ pid: 4242, kill: () => assert.fail('the child alone must not be signalled') }, 'SIGTERM', { platform: 'linux', kill });
  assert.deepEqual(killed, [[-4242, 'SIGTERM']], 'a negative pid is the whole group');

  const direct = [];
  signalJob({ pid: 4242, kill: (signal) => direct.push(signal) }, 'SIGTERM', { platform: 'win32', kill });
  assert.deepEqual(direct, ['SIGTERM']);
  assert.equal(killed.length, 1);

  const gone = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
  assert.doesNotThrow(() => signalJob({ pid: 4242 }, 'SIGTERM', { platform: 'linux', kill: gone }), 'a group that already ended is not an error');
});

test('compose gives a stopping job longer than one realm push may take', () => {
  const compose = fs.readFileSync(path.join(REPO, 'compose.yaml'), 'utf8');
  const grace = /^\s+stop_grace_period:\s*(\d+)s\s*$/m.exec(compose);
  assert.ok(grace, 'compose.yaml sets no stop_grace_period in whole seconds');
  assert.ok(
    Number(grace[1]) * 1000 > SYNC_FETCH_TIMEOUT_MS,
    `stop_grace_period ${grace[1]}s does not cover a push, which may take ${SYNC_FETCH_TIMEOUT_MS / 1000}s`,
  );
});

test('a stop reaches the whole job: the child and the grandchild it started are both gone', { skip: POSIX ? false : NO_GROUPS }, async (t) => {
  const s = scratch(t);
  const pidFile = path.join(s.root, 'pids.json');
  // The child starts a grandchild, as bash starts git, and both then wait.
  const childScript = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
    setInterval(() => {}, 1000);`;
  const stopper = createStopper();
  const running = spawnJob({ command: process.execPath, args: ['-e', childScript] }, { env: process.env, onChild: stopper.onChild });

  assert.ok(await eventually(() => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0, 5_000), 'the child never reported its pids');
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => {
    for (const pid of [pids.child, pids.grandchild]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone, which is the point */ }
    }
  });
  assert.ok(alive(pids.child) && alive(pids.grandchild));

  stopper.stop('SIGTERM');

  assert.equal(await within(5_000, running, 'the stopped job'), 128 + os.constants.signals.SIGTERM);
  assert.ok(await eventually(() => !alive(pids.grandchild), 5_000), 'the grandchild outlived the stop');
  assert.ok(!alive(pids.child));
});

test('the loop catches up after a sleep: the clock jumps past 03:00 and nightly runs once', async (t) => {
  const s = scratch(t);
  writeStateAtomic(s.stateFile, bothRanAt('2026-10-30T22:30:00.000Z'));
  // 22:31 New York, lid closed; the next tick the process sees is 09:00, then 09:00:30.
  const clock = ['2026-10-31T02:31:00.000Z', '2026-10-31T13:00:00.000Z', '2026-10-31T13:00:30.000Z'].map(at);
  let reads = 0;
  const sleeps = [];
  const { ran, runner } = recordingRunner();

  await runLoop({
    ...deps(s, '2026-10-31T02:31:00.000Z', { runner }),
    now: () => clock[Math.min(reads, clock.length - 1)],
    sleep: async (ms) => { sleeps.push(ms); reads += 1; },
    shouldStop: () => reads >= clock.length,
  });

  assert.deepEqual(ran, ['nightly']);
  assert.deepEqual(sleeps, [TICK_MS, TICK_MS, TICK_MS]);
  assert.equal(stateOnDisk(s).jobs.nightly.window, '2026-10-31T07:00:00.000Z');
});

test('the state file the scheduler writes is the one schedule.mjs serializes', (t) => {
  const s = scratch(t);
  const state = bothRanAt('2026-10-31T07:00:00.000Z');
  writeStateAtomic(s.stateFile, state);
  assert.equal(fs.readFileSync(s.stateFile, 'utf8'), serializeState(state));
});

// ------------------------------------------------ secrets from files, for a process the entrypoint did not start

/** A made-up connection string. Nothing in these tests is a real credential. */
const FAKE_URL = 'postgresql://harness:not-a-real-password@localhost:5433/harness';

/** A child that exits 0 as soon as someone listens for its exit; records what it was spawned with. */
function fakeSpawn(spawned) {
  return (command, args, options) => {
    spawned.push({ command, args, options });
    return {
      pid: 4242,
      once(event, listener) {
        if (event === 'exit') setImmediate(() => listener(0, null));
      },
    };
  };
}

test('envWithSecretFiles reads DATABASE_URL from DATABASE_URL_FILE and leaves the input alone', (t) => {
  const s = scratch(t);
  const file = path.join(s.root, 'harness_database_url');
  fs.writeFileSync(file, `${FAKE_URL}\r\n`);
  const env = Object.freeze({ PATH: '/bin', DATABASE_URL_FILE: file, HARNESS_INGEST_STATE_FILE: '/state/ingest-state.json' });

  const resolved = envWithSecretFiles(env);

  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.env, { PATH: '/bin', DATABASE_URL: FAKE_URL, HARNESS_INGEST_STATE_FILE: '/state/ingest-state.json' },
    'the CR and LF are gone, the _FILE name is consumed, and another variable that ends in _FILE is not a secret');
  assert.deepEqual(resolved.fromFiles, ['DATABASE_URL']);
  assert.deepEqual(SECRET_FILE_VARS, ['DATABASE_URL']);
  assert.equal(env.DATABASE_URL, undefined);

  const plain = envWithSecretFiles({ PATH: '/bin', DATABASE_URL: FAKE_URL });
  assert.deepEqual(plain, { ok: true, env: { PATH: '/bin', DATABASE_URL: FAKE_URL }, fromFiles: [] }, 'what the entrypoint already exported passes through');
  assert.deepEqual(envWithSecretFiles({}), { ok: true, env: {}, fromFiles: [] });
});

test('envWithSecretFiles refuses a missing file, an empty one, and both names at once, and never quotes a value', (t) => {
  const s = scratch(t);
  const empty = path.join(s.root, 'empty');
  const good = path.join(s.root, 'good');
  fs.writeFileSync(empty, '\r\n');
  fs.writeFileSync(good, FAKE_URL);
  const absent = path.join(s.root, 'absent');

  assert.deepEqual(envWithSecretFiles({ DATABASE_URL_FILE: absent }), {
    ok: false, problem: `DATABASE_URL_FILE names ${absent}, which is not a readable file`,
  });
  assert.deepEqual(envWithSecretFiles({ DATABASE_URL_FILE: empty }), {
    ok: false, problem: `DATABASE_URL_FILE names ${empty}, which is empty`,
  });
  const both = envWithSecretFiles({ DATABASE_URL_FILE: good, DATABASE_URL: 'postgresql://other:also-not-real@h/db' });
  assert.deepEqual(both, { ok: false, problem: 'DATABASE_URL and DATABASE_URL_FILE are both set; set only DATABASE_URL_FILE' });
  assert.ok(!JSON.stringify(both).includes('not-real'));
});

test('--run-now from an exec: the job is spawned with DATABASE_URL read from the file', async (t) => {
  const s = scratch(t);
  const file = path.join(s.root, 'harness_database_url');
  fs.writeFileSync(file, `${FAKE_URL}\n`);
  const spawned = [];
  const lines = [];

  // What `docker compose exec harness-jobs node hooks/scheduler.mjs --run-now nightly` has:
  // the service's environment, with the file's name and not its content.
  const code = await main(['--run-now', 'nightly', '--state', s.stateFile], {
    now: () => at('2026-10-31T09:00:00.000Z'),
    env: { PATH: process.env.PATH, DATABASE_URL_FILE: file, HARNESS_VAULT: '/vault' },
    spawn: fakeSpawn(spawned),
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });

  assert.equal(code, EXIT_OK, lines.join('\n'));
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'bash');
  assert.equal(spawned[0].options.env.DATABASE_URL, FAKE_URL);
  assert.equal(spawned[0].options.env.DATABASE_URL_FILE, undefined);
  assert.equal(spawned[0].options.env.HARNESS_VAULT, '/vault');
  assert.ok(!lines.join('\n').includes('not-a-real-password'), 'the value reaches the child and nothing else');
});

test('a secret file that cannot be read stops the scheduler with exit 78 before anything runs', async (t) => {
  const s = scratch(t);
  const absent = path.join(s.root, 'absent');
  const spawned = [];
  const lines = [];
  for (const argv of [['--run-now', 'nightly', '--state', s.stateFile], ['--state', s.stateFile]]) {
    const code = await main(argv, {
      env: { DATABASE_URL_FILE: absent },
      spawn: fakeSpawn(spawned),
      shouldStop: () => true,
      out: () => {},
      err: (line) => lines.push(line),
    });
    assert.equal(code, EXIT_CONFIG);
  }
  assert.equal(EXIT_CONFIG, 78);
  assert.deepEqual(spawned, []);
  assert.ok(!fs.existsSync(s.stateFile));
  assert.match(lines[0], /^error: DATABASE_URL_FILE names .*absent, which is not a readable file$/);
});

test('a job the plan skips is logged in one line, exits 0 and spawns nothing', async (t) => {
  const s = scratch(t);
  const spawned = [];
  const lines = [];
  const code = await main(['--run-now', 'collect', '--state', s.stateFile], {
    now: () => at('2026-10-31T16:00:00.000Z'),
    env: { HARNESS_JOBS_CONTAINER: '1' },
    spawn: fakeSpawn(spawned),
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  assert.equal(code, EXIT_OK, lines.join('\n'));
  assert.deepEqual(spawned, []);
  assert.equal(lines.filter((line) => /collect: skipped in the jobs container \(HARNESS_CHECKPOINT_REPOS is not set\)/.test(line)).length, 1, lines.join('\n'));
  assert.equal(stateOnDisk(s).jobs.collect.exit_code, 0);

  const withRepos = [];
  await main(['--run-now', 'collect', '--state', s.stateFile], {
    now: () => at('2026-10-31T16:00:00.000Z'),
    env: { HARNESS_JOBS_CONTAINER: '1', HARNESS_CHECKPOINT_REPOS: '/repos/bb2dash', HARNESS_CHECKPOINT_AUTHORS: 'a@example.com' },
    spawn: fakeSpawn(withRepos),
    out: () => {},
    err: () => {},
  });
  assert.deepEqual(withRepos[0].args.slice(1), ['--ingest', '--repo', '/repos/bb2dash', '--author', 'a@example.com']);
});

test('main starts a real job only when it is handed spawn: without a runner or spawn it refuses', async (t) => {
  // The guard this test pins exists because a test once reached the default
  // runner by omission and ran the real nightly. Neither call below may start
  // anything whatever main does: the loop is told to stop before its first tick.
  const s = scratch(t);
  const lines = [];
  const code = await main(['--state', s.stateFile], { env: {}, shouldStop: () => true, out: () => {}, err: (line) => lines.push(line) });
  assert.equal(code, EXIT_INTERNAL);
  assert.deepEqual(lines, ['error: no runner and no spawn were given, so no job can be started']);
  assert.throws(() => spawnRunner({ env: {} }), /needs the spawn to use/);
  assert.ok(!fs.existsSync(s.stateFile));
});

// ------------------------------------------------ the entrypoint script (bash)

const ENTRYPOINT = path.join(REPO, 'scripts', 'jobs-entrypoint.sh').replace(/\\/g, '/');

/**
 * Whether `bash` here can run a script of this checkout: true on Linux and in
 * Git Bash; false where there is no bash, or where `bash` is the WSL launcher,
 * which cannot see a Windows path. The Linux CI leg always runs these.
 */
const BASH_RUNS_REPO_SCRIPTS = spawnSync('bash', ['-c', 'test -f "$1" && echo ok', 'probe', ENTRYPOINT], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const NEEDS_BASH = BASH_RUNS_REPO_SCRIPTS ? false : 'no bash that can run this checkout\'s scripts';

/** A scratch folder as bash and git name it: forward slashes on every platform. */
function scratchForBash(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-entrypoint-')).replace(/\\/g, '/');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Run the entrypoint with `command` under a minimal environment plus `env`. */
function runEntrypoint(root, env, command) {
  return spawnSync('bash', [ENTRYPOINT, ...command], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', ...env },
  });
}

test('the entrypoint writes the git config where GIT_CONFIG_GLOBAL already points, so an exec finds it', { skip: NEEDS_BASH }, (t) => {
  const root = scratchForBash(t);
  fs.mkdirSync(`${root}/vault/projects/.git`, { recursive: true });
  fs.mkdirSync(`${root}/vault/daily`, { recursive: true });
  const fixed = `${root}/gitconfig-jobs`;

  const run = runEntrypoint(root, { GIT_CONFIG_GLOBAL: fixed, HARNESS_VAULT: `${root}/vault` }, ['bash', '-c', 'printf %s "$GIT_CONFIG_GLOBAL"']);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, fixed, 'the path the image set is kept, not replaced');
  const config = fs.readFileSync(fixed, 'utf8');
  assert.match(config, /directory = .*\/vault\/projects/);
  assert.ok(!config.includes('/vault/daily'), 'a folder that is not a checkout is not marked safe');

  // A second process that only inherits the variable, as `docker compose exec` does, reads the same file.
  const exec = spawnSync('git', ['config', '--global', '--get-all', 'safe.directory'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: `${root}/elsewhere`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: fixed },
  });
  assert.equal(exec.stdout.trim(), `${root}/vault/projects`);
});

// ------------------------------------------------ the nightly script (bash), with stubs for node and uv

const NIGHTLY = path.join(REPO, 'scripts', 'nightly-ingest.sh').replace(/\\/g, '/');
/** Records its own name and arguments, and does nothing else. */
const STUB = '#!/usr/bin/env bash\nprintf \'%s %s\\n\' "$(basename "$0")" "$*" >> "$STUB_RECORD"\n';

/**
 * Run the real nightly script where it can reach nothing real: every path it
 * reads (home, machine file, vault, hooks, ingest project, log) is inside a
 * scratch folder, the environment is built from nothing rather than inherited,
 * and node and uv are stubs that only record what they were asked to run.
 * Returns the exit status, the recorded calls with the scratch root as `<root>`, and the log.
 */
function runNightly(t, extra = {}) {
  const root = scratchForBash(t);
  for (const dir of ['vault', 'hooks', 'project', 'bin']) fs.mkdirSync(`${root}/${dir}`);
  fs.writeFileSync(`${root}/project/pyproject.toml`, '[project]\nname = "scratch"\n');
  for (const stub of ['node-stub', 'uv-stub']) fs.writeFileSync(`${root}/bin/${stub}`, STUB, { mode: 0o755 });
  const run = spawnSync('bash', [NIGHTLY], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      HARNESS_MACHINE_ENV: `${root}/no-machine.env`,
      HARNESS_VAULT: `${root}/vault`,
      HARNESS_INGEST_PROJECT: `${root}/project`,
      HARNESS_HOOKS_DIR: `${root}/hooks`,
      HARNESS_NODE: `${root}/bin/node-stub`,
      HARNESS_UV: `${root}/bin/uv-stub`,
      HARNESS_NIGHTLY_LOG: `${root}/nightly.log`,
      STUB_RECORD: `${root}/calls.txt`,
      REALM_SYNC: 'skip',
      ...extra,
    },
  });
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split(root).join('<root>');
  const calls = read(`${root}/calls.txt`).split('\n').filter(Boolean);
  return { status: run.status, stderr: run.stderr, calls, log: read(`${root}/nightly.log`) };
}

const CHECKPOINT_CALL = 'node-stub <root>/hooks/collect-checkpoints.mjs --vault <root>/vault';
const stepsRun = (calls) => calls.map((call) => /(sweep-transcripts|sweep-state|collect-checkpoints|sync-realms)\.mjs|run ingest (sweep-concluded|verify|eval|--source)/.exec(call)?.[0] ?? call);

test('the nightly on a host runs every step, and its stubs are what ran', { skip: NEEDS_BASH }, (t) => {
  const night = runNightly(t);
  assert.equal(night.status, 0, night.stderr);
  assert.deepEqual(stepsRun(night.calls), [
    'sweep-transcripts.mjs', 'sweep-state.mjs', 'collect-checkpoints.mjs',
    'run ingest sweep-concluded', 'run ingest --source', 'run ingest verify', 'run ingest eval',
  ]);
  assert.ok(night.calls.includes(CHECKPOINT_CALL), 'with no repositories listed the collector is left to its own defaults');
  assert.match(night.log, /=== nightly reconcile finished \(realms-pull 0, transcripts 0, state 0, checkpoints 0, sweep 0, ingest 0, verify 0, eval 0, realms-push 0\) ===/);
});

test('the nightly passes the listed checkpoint repositories and authors to the collector', { skip: NEEDS_BASH }, (t) => {
  const night = runNightly(t, { HARNESS_CHECKPOINT_REPOS: '/repos/agentic-harness, /repos/bb2dash,', HARNESS_CHECKPOINT_AUTHORS: 'a@example.com,b@example.com' });
  assert.equal(night.status, 0, night.stderr);
  assert.ok(
    night.calls.includes(`${CHECKPOINT_CALL} --repo /repos/agentic-harness --repo /repos/bb2dash --author a@example.com --author b@example.com`),
    night.calls.join('\n'),
  );
});

test('in the jobs container the nightly skips the checkpoints step when no repository is listed, with one line and no failure', { skip: NEEDS_BASH }, (t) => {
  const unset = runNightly(t, { HARNESS_JOBS_CONTAINER: '1' });
  assert.equal(unset.status, 0, unset.stderr);
  assert.ok(!unset.calls.some((call) => call.includes('collect-checkpoints.mjs')), 'the collector would only report its default paths missing');
  assert.equal(unset.log.split('\n').filter((line) => /Z checkpoints[ :]/.test(line)).length, 1, unset.log);
  assert.match(unset.log, /checkpoints: skipped in the jobs container \(HARNESS_CHECKPOINT_REPOS is not set\)/);
  assert.match(unset.log, /checkpoints 0, /);

  const set = runNightly(t, { HARNESS_JOBS_CONTAINER: '1', HARNESS_CHECKPOINT_REPOS: '/repos/bb2dash' });
  assert.ok(set.calls.includes(`${CHECKPOINT_CALL} --repo /repos/bb2dash`), set.calls.join('\n'));
});

test('in the jobs container the nightly never sweeps transcripts or session-start state, and says so in one line', { skip: NEEDS_BASH }, (t) => {
  const night = runNightly(t, { HARNESS_JOBS_CONTAINER: '1', HARNESS_CHECKPOINT_REPOS: '/repos/bb2dash' });
  assert.equal(night.status, 0, night.stderr);
  assert.deepEqual(stepsRun(night.calls), [
    'collect-checkpoints.mjs', 'run ingest sweep-concluded', 'run ingest --source', 'run ingest verify', 'run ingest eval',
  ], 'no sweep-transcripts.mjs and no sweep-state.mjs');
  const skipped = night.log.split('\n').filter((line) => /transcripts|state/.test(line) && !/=== nightly reconcile finished/.test(line));
  assert.deepEqual(skipped.map((line) => line.replace(/^\S+ /, '')), [
    'transcripts and state: skipped in the jobs container (sessions are captured by the host\'s SessionEnd hook)',
  ]);
  assert.match(night.log, /finished \(realms-pull 0, transcripts 0, state 0, checkpoints 0,/, 'the summary keeps its nine fields');
});

test('the jobs image marks itself, and the nightly service mounts no transcripts folder', () => {
  const dockerfile = fs.readFileSync(path.join(REPO, 'docker', 'jobs', 'Dockerfile'), 'utf8');
  // The service that holds the realm token never sees transcripts; harness-memory
  // (compose-memory.test.mjs) is the one that does, without the token.
  const jobs = composeService(fs.readFileSync(path.join(REPO, 'compose.yaml'), 'utf8'), 'harness-jobs');
  assert.match(dockerfile, /^\s+HARNESS_JOBS_CONTAINER=1 \\?$/m);
  assert.ok(!jobs.includes('CLAUDE_PROJECTS_DIR'), 'harness-jobs still names CLAUDE_PROJECTS_DIR');
  assert.ok(!jobs.includes('.claude/projects'), 'harness-jobs still mounts a .claude/projects folder');
  assert.ok(!jobs.includes('.codex'), 'harness-jobs mounts a Codex folder');
  assert.ok(!dockerfile.includes('.claude/projects'), 'the image still makes a mount point for transcripts');
});

// ------------------------------------------------ secret files saved by Windows tools (BOM, CRLF)

/** What PowerShell 5.1's `Set-Content -Encoding UTF8` and Notepad write in front of a file. */
const BOM = '﻿';
const FAKE_PAT = 'github_pat_not_a_real_token_0000';

test('envWithSecretFiles drops a UTF-8 byte-order mark as well as CR and LF', (t) => {
  const s = scratch(t);
  const file = path.join(s.root, 'harness_database_url');
  fs.writeFileSync(file, `${BOM}${FAKE_URL}\r\n`, 'utf8');
  assert.equal(fs.readFileSync(file)[0], 0xef, 'the file really starts with the BOM bytes');
  const resolved = envWithSecretFiles({ DATABASE_URL_FILE: file });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.env.DATABASE_URL, FAKE_URL);

  fs.writeFileSync(file, `${BOM}\r\n`, 'utf8');
  assert.equal(envWithSecretFiles({ DATABASE_URL_FILE: file }).ok, false, 'a file holding only a BOM is empty');
});

test('the entrypoint drops a BOM from a secret file before exporting it', { skip: NEEDS_BASH }, (t) => {
  const root = scratchForBash(t);
  fs.writeFileSync(`${root}/harness_database_url`, `${BOM}${FAKE_URL}\r\n`, 'utf8');
  const run = runEntrypoint(root, { DATABASE_URL_FILE: `${root}/harness_database_url`, GIT_CONFIG_GLOBAL: `${root}/gitconfig` }, [
    'bash', '-c', 'printf %s "$DATABASE_URL"',
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, FAKE_URL);
});

test('the credential helper drops a BOM from the token file, and the token is in no config', { skip: NEEDS_BASH }, (t) => {
  const root = scratchForBash(t);
  fs.writeFileSync(`${root}/vault_realm_pat`, `${BOM}${FAKE_PAT}\r\n`, 'utf8');
  const config = `${root}/gitconfig`;
  const env = { VAULT_REALM_PAT_FILE: `${root}/vault_realm_pat`, GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0' };

  const setup = runEntrypoint(root, env, ['true']);
  assert.equal(setup.status, 0, setup.stderr);
  assert.ok(!fs.readFileSync(config, 'utf8').includes(FAKE_PAT), 'the config names the file, not the token');

  // Only this config is read: no system file (where Git for Windows keeps its credential manager).
  const fill = spawnSync('git', ['credential', 'fill'], {
    encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\n\n',
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(fill.status, 0, fill.stderr);
  const answer = Object.fromEntries(fill.stdout.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(answer.username, 'x-access-token');
  assert.equal(answer.password, FAKE_PAT);
});

test('the image fixes GIT_CONFIG_GLOBAL, so the entrypoint and an exec agree on the file', () => {
  const dockerfile = fs.readFileSync(path.join(REPO, 'docker', 'jobs', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^\s+GIT_CONFIG_GLOBAL=\/home\/harness\/\.gitconfig-jobs \\?$/m);
});
