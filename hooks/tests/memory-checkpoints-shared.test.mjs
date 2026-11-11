/**
 * Phase 2 of the container move: the host and the container share one
 * `memory-checkpoints.json`.
 *
 * Version 1 kept one vault per file, keyed on the vault path as this process
 * resolved it, and a save from a different path replaced the whole file: the
 * container (vault at `/vault`) and the host (`C:\Users\x\vault`) would have
 * wiped each other on every run. Version 2 keys each vault by the path the host
 * spells it with, keeps every key on save, and stores note paths inside the
 * vault, so both sides read the same entries.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkpointSessions, saveMemoryCheckpoints } from '../lib/memory-checkpoints.mjs';

const HOST_VAULT = 'C:/Users/alex/vault';
const HOST_KEY = 'c:/users/alex/vault';
const FLAVOR = Object.freeze({ HARNESS_HOST_PATH_FLAVOR: 'win32', HARNESS_HOST_HOME: 'C:/Users/alex', HARNESS_HOST_VAULT: HOST_VAULT });
const NOTE = 'projects/demo/sessions/s1.md';

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-checkpoints-'));
  const vaultRoot = path.join(root, 'vault');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(vaultRoot, 'projects', 'demo', 'sessions'), { recursive: true });
  fs.mkdirSync(stateDir);
  const note = path.join(vaultRoot, ...NOTE.split('/'));
  fs.writeFileSync(note, '# note\n');
  const stateFile = path.join(stateDir, 'memory-checkpoints.json');
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const write = (value) => fs.writeFileSync(stateFile, JSON.stringify(value));
  return { root, vaultRoot, stateDir, note, stateFile, read, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** One candidate whose capture is counted, so a skipped one is visible. */
function candidate(fingerprint, calls, notePath) {
  return { runtime: 'claude-code', sessionId: 's1', fingerprint,
    capture: () => { calls.push(1); return { written: true, action: 'merge', notePath, touchedPaths: [notePath] }; } };
}

const localKey = (vaultRoot) => path.resolve(vaultRoot).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

test('a save writes version 2: the vault under its own key, note paths inside the vault', () => {
  const w = world();
  try {
    saveMemoryCheckpoints({ stateDir: w.stateDir, vaultRoot: w.vaultRoot, env: {},
      checkpoints: { 'claude-code:s1': { fingerprint: 'f1', paths: [w.note] } } });
    assert.deepEqual(w.read(), { version: 2, vaults: { [localKey(w.vaultRoot)]: { checkpoints: { 'claude-code:s1': { fingerprint: 'f1', paths: [NOTE] } } } } });
  } finally { w.cleanup(); }
});

test('under a flavor the vault is keyed as the host spells it, so the container reads the host\'s checkpoints', () => {
  const w = world();
  try {
    w.write({ version: 2, vaults: { [HOST_KEY]: { checkpoints: { 'claude-code:s1': { fingerprint: 'f1', paths: [NOTE] } } } } });
    const calls = [];
    const result = checkpointSessions({ candidates: [candidate('f1', calls, w.note)], vaultRoot: w.vaultRoot, stateDir: w.stateDir, env: FLAVOR });
    assert.equal(calls.length, 0, 'unchanged since the host captured it');
    assert.equal(result.eligible, 0);
  } finally { w.cleanup(); }
});

test('a save keeps every other vault\'s checkpoints', () => {
  const w = world();
  try {
    const other = { checkpoints: { 'codex:codex-x': { fingerprint: 'f9', paths: ['projects/other/sessions/codex-x.md'] } } };
    w.write({ version: 2, vaults: { 'd:/elsewhere/vault': other } });
    saveMemoryCheckpoints({ stateDir: w.stateDir, vaultRoot: w.vaultRoot, env: FLAVOR,
      checkpoints: { 'claude-code:s1': { fingerprint: 'f2', paths: [w.note] } } });
    const state = w.read();
    assert.deepEqual(state.vaults['d:/elsewhere/vault'], other);
    assert.deepEqual(state.vaults[HOST_KEY].checkpoints['claude-code:s1'], { fingerprint: 'f2', paths: [NOTE] });
  } finally { w.cleanup(); }
});

test('a version 1 file written by the Windows host is read under a flavor, then kept as version 2', () => {
  const w = world();
  try {
    w.write({ vaultRoot: 'C:\\Users\\alex\\vault', checkpoints: {
      'claude-code:s1': { fingerprint: 'f1', paths: ['C:\\Users\\alex\\vault\\projects\\demo\\sessions\\s1.md'] } } });
    const calls = [];
    const result = checkpointSessions({ candidates: [candidate('f1', calls, w.note)], vaultRoot: w.vaultRoot, stateDir: w.stateDir, env: FLAVOR });
    assert.equal(calls.length, 0, 'the host entry is recognised');
    saveMemoryCheckpoints({ stateDir: w.stateDir, vaultRoot: w.vaultRoot, env: FLAVOR, checkpoints: result.checkpoints });
    assert.deepEqual(w.read(), { version: 2, vaults: { [HOST_KEY]: { checkpoints: { 'claude-code:s1': { fingerprint: 'f1', paths: [NOTE] } } } } });
  } finally { w.cleanup(); }
});

test('a version 1 file for this vault, written natively, is read and migrated', () => {
  const w = world();
  try {
    w.write({ vaultRoot: path.resolve(w.vaultRoot), checkpoints: { 'claude-code:s1': { fingerprint: 'f1', paths: [w.note] } } });
    const calls = [];
    checkpointSessions({ candidates: [candidate('f1', calls, w.note)], vaultRoot: w.vaultRoot, stateDir: w.stateDir, env: {} });
    assert.equal(calls.length, 0);
    saveMemoryCheckpoints({ stateDir: w.stateDir, vaultRoot: w.vaultRoot, env: {}, checkpoints: {} });
    assert.deepEqual(w.read().vaults[localKey(w.vaultRoot)].checkpoints['claude-code:s1'], { fingerprint: 'f1', paths: [NOTE] });
  } finally { w.cleanup(); }
});

test('a version 1 file for another vault is kept, not wiped, by a save', () => {
  const w = world();
  try {
    w.write({ vaultRoot: 'D:\\elsewhere\\vault', checkpoints: { 'codex:codex-x': { fingerprint: 'f9', paths: ['D:\\elsewhere\\vault\\a.md'] } } });
    saveMemoryCheckpoints({ stateDir: w.stateDir, vaultRoot: w.vaultRoot, env: FLAVOR, checkpoints: { 'claude-code:s1': { fingerprint: 'f2', paths: [w.note] } } });
    assert.deepEqual(w.read().vaults['d:/elsewhere/vault'].checkpoints['codex:codex-x'], { fingerprint: 'f9', paths: ['a.md'] });
  } finally { w.cleanup(); }
});

test('a stored path that could leave the vault counts as missing, so the session is looked at again', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.root, 'outside.md'), '# outside\n');
    for (const bad of ['../outside.md', '/etc/hostname', 'projects/../../outside.md', '']) {
      w.write({ version: 2, vaults: { [localKey(w.vaultRoot)]: { checkpoints: { 'claude-code:s1': { fingerprint: 'f1', paths: [bad] } } } } });
      const calls = [];
      checkpointSessions({ candidates: [candidate('f1', calls, w.note)], vaultRoot: w.vaultRoot, stateDir: w.stateDir, env: {} });
      assert.equal(calls.length, 1, bad);
    }
  } finally { w.cleanup(); }
});
