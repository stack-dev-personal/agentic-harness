/**
 * Phase 2 of the container move: queue entries name a note by its path inside
 * the vault, so the host and the container can read each other's entries.
 *
 * An old entry is a JSON string holding an absolute path. It is still read:
 * on the side that wrote it as it always was, and under a host path flavor by
 * the host's vault prefix. Anything else stays in the queue for review.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { QUEUE_NAME, drainIngest, queueIngest } from '../lib/ingest-queue.mjs';
import { loadMachineEnv } from '../lib/machine-env.mjs';

const NOTE = ['projects', 'demo', 'sessions', 'a.md'];
const FLAVOR = Object.freeze({ HARNESS_HOST_PATH_FLAVOR: 'win32', HARNESS_HOST_HOME: 'C:/Users/alex',
  HARNESS_HOST_VAULT: 'C:/Users/alex/vault', HARNESS_MEMORY_EXCLUDED_ROOTS: '[]' });

function world(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-queue-portable-'));
  const vaultRoot = path.join(root, 'vault');
  const project = path.join(root, 'project');
  const uv = path.join(root, 'uv.exe');
  fs.mkdirSync(path.join(vaultRoot, ...NOTE.slice(0, -1)), { recursive: true });
  fs.mkdirSync(project);
  fs.writeFileSync(uv, '');
  const note = path.join(vaultRoot, ...NOTE);
  fs.writeFileSync(note, '# Harmless fixture\n');
  const env = { USERPROFILE: root, HARNESS_VAULT: vaultRoot, HARNESS_INGEST_PROJECT: project, HARNESS_UV_BIN: uv,
    HARNESS_MACHINE_ENV: path.join(root, 'absent.env'), ...extraEnv };
  const queueFile = path.join(root, '.harness', QUEUE_NAME);
  const writeQueue = (lines) => {
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    fs.writeFileSync(queueFile, lines.map((line) => (typeof line === 'string' && line.startsWith('RAW:') ? line.slice(4) : JSON.stringify(line))).join('\n') + '\n');
  };
  const drain = () => {
    const ingested = [];
    const result = drainIngest({ env, run: (command, args) => {
      for (let i = 0; i < args.length; i += 1) if (args[i] === '--only') ingested.push(args[i + 1]);
      return { status: 0 };
    } });
    const left = result.failed.map((name) => fs.readFileSync(path.join(root, '.harness', name), 'utf8'));
    return { ...result, ingested, left };
  };
  return { root, vaultRoot, note, env, queueFile, writeQueue, drain, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a queued note is written as its path inside the vault', () => {
  const w = world();
  try {
    assert.equal(queueIngest({ notePaths: [w.note], vaultRoot: w.vaultRoot, env: w.env, startTask: false }).queued, true);
    assert.deepEqual(fs.readFileSync(w.queueFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
      [{ note: 'projects/demo/sessions/a.md' }]);
  } finally { w.cleanup(); }
});

test('a vault-relative entry and an old absolute entry from this side are both ingested', () => {
  const w = world();
  try {
    w.writeQueue([{ note: 'projects/demo/sessions/a.md' }, w.note]);
    const result = w.drain();
    assert.deepEqual(result.ingested, [w.note]);
    assert.deepEqual(result.left, []);
  } finally { w.cleanup(); }
});

test('a vault-relative entry that could leave the vault is kept for review, never ingested', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.root, 'outside.md'), '# outside\n');
    const bad = ['../outside.md', 'projects/../../outside.md', '/etc/passwd', 'C:/x.md', 'projects\\demo\\sessions\\a.md',
      'projects//demo/sessions/a.md', './projects/demo/sessions/a.md', ''];
    w.writeQueue(bad.map((note) => ({ note })));
    const result = w.drain();
    assert.deepEqual(result.ingested, []);
    assert.equal(result.left.join('').trim().split('\n').length, bad.length);
  } finally { w.cleanup(); }
});

test('under a flavor an old Windows entry under the host vault is read from this side\'s vault', () => {
  const w = world(FLAVOR);
  try {
    w.writeQueue(['C:\\Users\\alex\\vault\\projects\\demo\\sessions\\a.md', 'c:/users/ALEX/vault/projects/demo/sessions/a.md']);
    const result = w.drain();
    assert.deepEqual(result.ingested, [w.note], 'one note, however often it was queued');
    assert.deepEqual(result.left, []);
  } finally { w.cleanup(); }
});

test('under a flavor an old Windows entry outside the host vault, or climbing out of it, is kept for review', () => {
  const w = world(FLAVOR);
  try {
    const bad = ['C:\\Users\\alex\\other\\a.md', 'C:\\Users\\alex\\vault-old\\projects\\demo\\sessions\\a.md',
      'C:\\Users\\alex\\vault\\..\\vault\\projects\\demo\\sessions\\a.md', '\\\\?\\C:\\Users\\alex\\vault\\projects\\demo\\sessions\\a.md',
      '\\\\server\\share\\vault\\projects\\demo\\sessions\\a.md', 'C:\\Users\\alex\\vault'];
    w.writeQueue(bad);
    const result = w.drain();
    assert.deepEqual(result.ingested, []);
    assert.equal(result.left.join('').trim().split('\n').length, bad.length);
  } finally { w.cleanup(); }
});

test('without a flavor an old entry from another host is kept for review, as before', { skip: process.platform === 'win32' }, () => {
  const w = world();
  try {
    w.writeQueue(['C:\\Users\\alex\\vault\\projects\\demo\\sessions\\a.md']);
    const result = w.drain();
    assert.deepEqual(result.ingested, []);
    assert.equal(result.left.length, 1);
  } finally { w.cleanup(); }
});

// ------------------------------------- the host stands down at cutover

test('HARNESS_MEMORY_START_WORKER=0 in machine.env queues the note and starts nothing', () => {
  const w = world();
  try {
    const machineEnv = path.join(w.root, 'machine.env');
    fs.writeFileSync(machineEnv, 'HARNESS_MEMORY_START_WORKER=0\n');
    // What every host hook does: machine.env underneath the process environment.
    const env = loadMachineEnv({ ...w.env, HARNESS_MACHINE_ENV: machineEnv }, w.root);
    const started = [];
    const result = queueIngest({ notePaths: [w.note], vaultRoot: w.vaultRoot, env, run: (...args) => { started.push(args); return { status: 0 }; } });
    assert.deepEqual([result.queued, result.taskStarted, started.length], [true, false, 0]);
    assert.equal(fs.readFileSync(w.queueFile, 'utf8').trim().split('\n').length, 1, 'the container worker drains it');
  } finally { w.cleanup(); }
});
