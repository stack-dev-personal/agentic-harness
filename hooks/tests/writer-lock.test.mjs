/**
 * Writers and the realm lock (R-100, H-10).
 *
 * The nightly sync stages, commits, pulls and pushes a realm under its lock
 * (R-B3). The sweep takes that lock per realm and, when it is held, leaves the
 * realm's notes for the next run, as the checkpoint collector does. The hook
 * never waits for the lock (it must not block session exit); instead every
 * note is written to a temporary file in the same folder and renamed into
 * place, so a concurrent stage sees the old note or the new one, never half.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { acquireRealmLock, releaseRealmLock } from '../lib/realm-lock.mjs';
import { persist } from '../lib/notes-io.mjs';
import { discoverClaudeSessions } from '../lib/runtime-adapters.mjs';
import { runSweep, withRealmLocks } from '../lib/sweep.mjs';
import { EXIT_OK, run as runSweepCli } from '../sweep-transcripts.mjs';
import { createSandbox, installTranscript, noGit } from './helpers/sandbox.mjs';
import { SCENARIOS, runScenario } from './helpers/scenarios.mjs';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-17T03:00:00.000Z');
const MAIN = '11111111-1111-4111-8111-111111111111';
const NOTE = `projects/bb2dash/sessions/${MAIN}.md`;

/** Make `<vault>/<area>` a realm checkout: its `.realm` marker and a `.git` folder. */
function makeRealm(vaultRoot, area) {
  const root = path.join(vaultRoot, area);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.realm'), `${area}\n`, 'utf8');
  return root;
}

function holdLock(realmRoot) {
  const lock = acquireRealmLock(realmRoot, { owner: 'sync --push', pid: 4242 });
  assert.equal(lock.ok, true, 'the test holds the realm lock');
  return lock;
}

function idleTranscript(sandbox, fixture = 'plain-main', sessionId = MAIN) {
  const file = installTranscript(sandbox, fixture, sessionId);
  const when = new Date(NOW - 12 * HOUR_MS);
  fs.utimesSync(file, when, when);
  return file;
}

function sweep(sandbox, overrides = {}) {
  return runSweep({
    projectsRoot: sandbox.projectsRoot,
    vaultRoot: sandbox.vaultRoot,
    minIdleMs: 6 * HOUR_MS,
    now: NOW,
    runGit: noGit,
    ...overrides,
  });
}

// ------------------------------------------------------------------- sweep

test('a held realm lock defers the sweep for that realm; the next run writes the note', () => {
  const sandbox = createSandbox();
  try {
    const realm = makeRealm(sandbox.vaultRoot, 'projects');
    idleTranscript(sandbox);
    const lock = holdLock(realm);
    const lines = [];

    const deferred = sweep(sandbox, { log: (line) => lines.push(line) });
    assert.equal(deferred.deferred, 1);
    assert.equal(deferred.written, 0);
    assert.equal(deferred.errors, 0);
    assert.equal(fs.existsSync(path.join(sandbox.vaultRoot, NOTE)), false, 'nothing written into a locked realm');
    assert.ok(lines.some((line) => /realm projects is locked by sync --push, pid 4242/.test(line)), lines.join('\n'));
    assert.ok(fs.existsSync(lock.lockPath), "the holder's lock is left alone");

    releaseRealmLock(lock);
    const next = sweep(sandbox);
    assert.equal(next.deferred, 0);
    assert.equal(next.written, 1);
    assert.ok(fs.existsSync(path.join(sandbox.vaultRoot, NOTE)));
  } finally {
    sandbox.cleanup();
  }
});

test('the sweep takes the lock while it writes and gives it back', () => {
  const sandbox = createSandbox();
  try {
    const realm = makeRealm(sandbox.vaultRoot, 'projects');
    idleTranscript(sandbox);
    const lines = [];
    const summary = sweep(sandbox, { log: (line) => lines.push(line) });
    assert.equal(summary.written, 1);
    assert.equal(fs.existsSync(path.join(realm, '.git', 'harness-sync.lock')), false, 'released after the run');
  } finally {
    sandbox.cleanup();
  }
});

test('a lock on another realm does not hold this one up', () => {
  const sandbox = createSandbox();
  try {
    makeRealm(sandbox.vaultRoot, 'projects');
    const classes = makeRealm(sandbox.vaultRoot, 'classes');
    idleTranscript(sandbox);
    const lock = holdLock(classes);
    try {
      const summary = sweep(sandbox);
      assert.equal(summary.written, 1);
      assert.equal(summary.deferred, 0);
    } finally {
      releaseRealmLock(lock);
    }
  } finally {
    sandbox.cleanup();
  }
});

test('a dry run only peeks: it reports the deferral and takes no lock', () => {
  const sandbox = createSandbox();
  try {
    const realm = makeRealm(sandbox.vaultRoot, 'projects');
    idleTranscript(sandbox);
    const summary = sweep(sandbox, { dryRun: true });
    assert.equal(summary.candidates.length, 1);
    assert.equal(fs.existsSync(path.join(realm, '.git', 'harness-sync.lock')), false);
  } finally {
    sandbox.cleanup();
  }
});

test('the sweep CLI exits 0 when its only problem is a held lock, as the collector does', () => {
  const sandbox = createSandbox();
  try {
    const realm = makeRealm(sandbox.vaultRoot, 'projects');
    idleTranscript(sandbox);
    const lock = holdLock(realm);
    try {
      const out = [];
      const code = runSweepCli(
        ['--vault', sandbox.vaultRoot, '--projects', sandbox.projectsRoot, '--min-idle-hours', '0'],
        {
          env: {
            HARNESS_MACHINE_ENV: path.join(sandbox.root, 'none.env'),
            HARNESS_TRANSCRIPT_SWEEP_LOG: path.join(sandbox.root, 'sweep.log'),
            HARNESS_STATE_DIR: path.join(sandbox.root, 'state'),
          },
          out: (line) => out.push(line),
          err: () => {},
        },
      );
      assert.equal(code, EXIT_OK);
      assert.match(out.join('\n'), /deferred=1/);
    } finally {
      releaseRealmLock(lock);
    }
  } finally {
    sandbox.cleanup();
  }
});

// -------------------------------------------------------------------- hook

test('the hook writes while the lock is held: it never waits for it', () => {
  const sandbox = createSandbox();
  try {
    const realm = makeRealm(sandbox.vaultRoot, 'projects');
    const lock = holdLock(realm);
    try {
      const outcome = runScenario(sandbox, SCENARIOS.find((scenario) => scenario.name === 'plain-main'));
      assert.equal(outcome.written, true);
      assert.ok(fs.existsSync(path.join(sandbox.vaultRoot, NOTE)));
      assert.ok(fs.existsSync(lock.lockPath), "the hook leaves the sync's lock alone");
    } finally {
      releaseRealmLock(lock);
    }
  } finally {
    sandbox.cleanup();
  }
});

// ------------------------------------------------------- temp file + rename

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-lock-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('persist leaves no temporary file behind, and reports an identical rewrite as unchanged', () => {
  const { dir, cleanup } = scratch();
  try {
    const note = path.join(dir, 'sessions', 'a.md');
    assert.deepEqual(persist(note, 'one\n'), { ok: true, changed: true, error: '' });
    assert.deepEqual(persist(note, 'two\n'), { ok: true, changed: true, error: '' });
    assert.deepEqual(persist(note, 'two\n'), { ok: true, changed: false, error: '' });
    assert.equal(fs.readFileSync(note, 'utf8'), 'two\n');
    assert.deepEqual(fs.readdirSync(path.dirname(note)), ['a.md']);
  } finally {
    cleanup();
  }
});

test('a write that fails leaves the old note whole and no temporary file', () => {
  const { dir, cleanup } = scratch();
  try {
    // A directory where the note belongs: the rename into place must fail.
    const note = path.join(dir, 'b.md');
    fs.mkdirSync(note);
    const result = persist(note, 'new text\n');
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.deepEqual(fs.readdirSync(dir), ['b.md']);
    assert.ok(fs.statSync(note).isDirectory());
  } finally {
    cleanup();
  }
});

/**
 * A reader in another thread reads the note over and over, a few milliseconds
 * apart, as a stage or an indexer would, while this thread rewrites it. Every
 * read must be one of the two whole texts: with write-in-place, a read lands
 * between the truncate and the last byte (this test failed that way before
 * H-10). On Windows a rename that meets the reader's open handle (or the
 * antivirus scan an open sets off) past every retry fails instead of writing
 * in place, so the note then stays the last whole text that landed.
 */
const READER = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const flag = new Int32Array(workerData.stop);
let reads = 0, partial = 0, missing = 0;
while (Atomics.load(flag, 0) === 0) {
  let text;
  try { text = fs.readFileSync(workerData.note, 'utf8'); } catch { missing += 1; continue; }
  reads += 1;
  if (text !== workerData.a && text !== workerData.b) partial += 1;
  Atomics.wait(flag, 0, 0, 5);
}
parentPort.postMessage({ reads, partial, missing });
`;

const TRANSIENT = ['EPERM', 'EACCES', 'EBUSY'];

test('no partial file is ever observable at the note path', async () => {
  const { dir, cleanup } = scratch();
  try {
    const note = path.join(dir, 'c.md');
    const a = `---\nid: a\n---\n${'A'.repeat(192 * 1024)}\n`;
    const b = `---\nid: b\n---\n${'B'.repeat(256 * 1024)}\n`;
    assert.equal(persist(note, a).ok, true);

    const stop = new SharedArrayBuffer(4);
    const reader = new Worker(READER, { eval: true, workerData: { note, a, b, stop } });
    const result = new Promise((resolve, reject) => {
      reader.once('message', resolve);
      reader.once('error', reject);
    });
    const failures = [];
    let last = a;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (let i = 0; i < 40; i += 1) {
        const text = i % 2 === 0 ? b : a;
        const written = persist(note, text);
        if (written.ok) last = text;
        else failures.push(written.error);
      }
    } finally {
      // Always stop the reader, or a failed write leaves the test hanging.
      Atomics.store(new Int32Array(stop), 0, 1);
    }
    const { reads, partial, missing } = await result;
    await reader.terminate();

    assert.ok(reads > 0, 'the reader read something');
    assert.equal(partial, 0, `${partial} of ${reads} reads saw half a note`);
    assert.equal(missing, 0, `${missing} reads found no note at all`);
    assert.ok(failures.length < 40, 'writes land while a reader comes and goes');
    assert.ok(failures.every((code) => TRANSIENT.includes(code)), failures.join(','));
    assert.equal(fs.readFileSync(note, 'utf8'), last, 'the note is the last whole text that landed');
    assert.deepEqual(fs.readdirSync(dir), ['c.md']);
  } finally {
    cleanup();
  }
});

test('a note held open past the retries is never written in place: it stays whole, and no temporary file is left', () => {
  const { dir, cleanup } = scratch();
  try {
    const note = path.join(dir, 'd.md');
    assert.equal(persist(note, 'old\n').ok, true);
    // On Windows an open handle refuses the rename while it is open; POSIX renames over it.
    const handle = fs.openSync(note, 'r');
    let result;
    try {
      result = persist(note, 'new\n');
    } finally {
      fs.closeSync(handle);
    }
    if (!result.ok) assert.ok(TRANSIENT.includes(result.error), result.error);
    assert.equal(fs.readFileSync(note, 'utf8'), result.ok ? 'new\n' : 'old\n');
    assert.deepEqual(fs.readdirSync(dir), ['d.md']);
  } finally {
    cleanup();
  }
});

// ------------------------------------- the lock follows where filing writes

test('a session whose note lives in another realm takes that realm\'s lock too', () => {
  const sandbox = createSandbox();
  try {
    makeRealm(sandbox.vaultRoot, 'projects');
    const classes = makeRealm(sandbox.vaultRoot, 'classes');
    fs.writeFileSync(path.join(sandbox.vaultRoot, 'classes', 'ist323', 'sessions', `${MAIN}.md`), '---\nid: x\n---\n');
    const lock = holdLock(classes);
    const cwd = path.join(sandbox.root, 'repos', 'bb2dash');
    const run = (sessions) => withRealmLocks({ cwd, vaultRoot: sandbox.vaultRoot, sessions }, () => 'written', (name) => `deferred:${name}`);
    assert.equal(run([{ sessionId: MAIN }]), 'deferred:classes', 'the note\'s realm is locked by someone else');
    assert.equal(run(undefined), 'written', 'without session ids only the cwd\'s realm is taken, as before');
    releaseRealmLock(lock);
  } finally {
    sandbox.cleanup();
  }
});

test('the memory worker defers a session whose note is in a locked realm', () => {
  const sandbox = createSandbox();
  try {
    makeRealm(sandbox.vaultRoot, 'projects');
    const classes = makeRealm(sandbox.vaultRoot, 'classes');
    const home = path.join(sandbox.root, 'home');
    const transcript = installTranscript(sandbox, 'plain-main', MAIN);
    const projectDir = path.join(home, '.claude', 'projects', 'fixture');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.copyFileSync(transcript, path.join(projectDir, `${MAIN}.jsonl`));
    fs.writeFileSync(path.join(sandbox.vaultRoot, 'classes', 'ist323', 'sessions', `${MAIN}.md`), '---\nid: x\n---\n');
    const lock = holdLock(classes);
    const [candidate] = discoverClaudeSessions({ home, vaultRoot: sandbox.vaultRoot, env: {} });
    assert.equal(candidate.sessionId, MAIN);
    assert.equal(candidate.capture({ deadlineAt: Date.now() + 30_000 }).action, 'deferred');
    releaseRealmLock(lock);
  } finally {
    sandbox.cleanup();
  }
});
