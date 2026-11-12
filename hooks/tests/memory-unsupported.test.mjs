/**
 * A runtime that cannot supply what a note needs is reported, not failed.
 *
 * Codex 0.166 keeps a delegated thread's assignment only in its rollout file,
 * so the SQLite adapter cannot write the child's note. Fifty such threads
 * counted as fifty errors every five minutes, which kept `memory-health.json`
 * red and the scheduled task's result at 1 for good; and each run reopened
 * every one of them to reach the same answer.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TRIVIAL_GENERATION, UNSUPPORTED_GENERATION, checkpointSessions, saveMemoryCheckpoints } from '../lib/memory-checkpoints.mjs';

function outcome(action, skip) {
  return { written: false, action, skip, notePath: '', touchedPaths: [] };
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-unsupported-'));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);
  return { root, vaultRoot, stateDir: path.join(root, 'state'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('an unsupported capture is tallied apart from errors and exclusions', () => {
  const s = sandbox();
  try {
    const candidates = [
      { runtime: 'codex', sessionId: 'codex-child', fingerprint: 'a',
        capture: () => outcome('unsupported', 'child task unavailable; inherited context excluded') },
      { runtime: 'codex', sessionId: 'codex-broken', fingerprint: 'b',
        capture: () => outcome('skip', 'native history could not be read') },
      { runtime: 'codex', sessionId: 'codex-guardian', fingerprint: 'c',
        capture: () => outcome('excluded', 'excluded session purpose') },
    ];

    const result = checkpointSessions({ candidates, vaultRoot: s.vaultRoot, stateDir: s.stateDir });

    assert.equal(result.unsupported, 1);
    assert.equal(result.errors, 1, 'an unreadable history is still a failure');
    assert.equal(result.excluded, 1);
    assert.equal(result.written, 0);
    assert.deepEqual(result.checkpoints, { 'codex:codex-child': { fingerprint: 'a', paths: [], unsupported: true, generation: UNSUPPORTED_GENERATION } },
      'the unsupported thread is remembered at its native revision; the failure is retried');
  } finally {
    s.cleanup();
  }
});

test('a remembered unsupported thread is counted without reopening its history', () => {
  const s = sandbox();
  try {
    const first = checkpointSessions({ vaultRoot: s.vaultRoot, stateDir: s.stateDir, candidates: [
      { runtime: 'codex', sessionId: 'codex-child', fingerprint: 'a', capture: () => outcome('unsupported', 'child task unavailable') },
    ] });
    saveMemoryCheckpoints({ stateDir: s.stateDir, vaultRoot: s.vaultRoot, checkpoints: first.checkpoints });

    // Same native revision: the answer cannot have changed, so capture is not called.
    const again = checkpointSessions({ vaultRoot: s.vaultRoot, stateDir: s.stateDir, candidates: [
      { runtime: 'codex', sessionId: 'codex-child', fingerprint: 'a', capture: () => { throw new Error('must not reopen an unchanged unsupported thread'); } },
    ] });
    assert.equal(again.unsupported, 1, 'still reported in health');
    assert.equal(again.eligible, 0);
    assert.equal(again.errors, 0);

    // A new native revision is looked at again.
    let captured = 0;
    const changed = checkpointSessions({ vaultRoot: s.vaultRoot, stateDir: s.stateDir, candidates: [
      { runtime: 'codex', sessionId: 'codex-child', fingerprint: 'a2', capture: () => { captured += 1; return outcome('unsupported', 'child task unavailable'); } },
    ] });
    assert.equal(captured, 1);
    assert.equal(changed.unsupported, 1);
    assert.equal(changed.checkpoints['codex:codex-child'].fingerprint, 'a2');
  } finally {
    s.cleanup();
  }
});

test('an unsupported verdict from an older generation is looked at again once', () => {
  const s = sandbox();
  try {
    // Remembered before the adapter learned to write these threads: no generation.
    saveMemoryCheckpoints({ stateDir: s.stateDir, vaultRoot: s.vaultRoot,
      checkpoints: { 'codex:codex-child': { fingerprint: 'a', paths: [], unsupported: true } } });
    let captured = 0;
    const note = path.join(s.vaultRoot, 'codex-child.md');
    const result = checkpointSessions({ vaultRoot: s.vaultRoot, stateDir: s.stateDir, candidates: [
      { runtime: 'codex', sessionId: 'codex-child', fingerprint: 'a', capture: () => { captured += 1; fs.writeFileSync(note, '# note\n'); return { written: true, action: 'create', skip: '', notePath: note, touchedPaths: [note] }; } },
    ] });
    assert.equal(captured, 1, 'the same native revision is re-evaluated under the new rules');
    assert.equal(result.written, 1);
    assert.equal(result.unsupported, 0);
    assert.deepEqual(result.checkpoints['codex:codex-child'].paths, [note]);
  } finally {
    s.cleanup();
  }
});

test('a trivial session is remembered at its revision and not reopened until it changes', () => {
  const s = sandbox();
  try {
    let opened = 0;
    const candidate = (fingerprint, skip) => ({ runtime: 'codex', sessionId: `codex-${skip.length}`, fingerprint,
      capture: () => { opened += 1; return outcome('skip', skip); } });
    for (const skip of ['subagent did nothing; assignment not recorded', 'no user prompts (trivial session)']) {
      opened = 0;
      const first = checkpointSessions({ vaultRoot: s.vaultRoot, stateDir: s.stateDir, candidates: [candidate('a', skip)] });
      assert.equal(first.errors, 0);
      assert.deepEqual(first.checkpoints[`codex:codex-${skip.length}`], { fingerprint: 'a', paths: [], trivial: true, generation: TRIVIAL_GENERATION });
      saveMemoryCheckpoints({ stateDir: s.stateDir, vaultRoot: s.vaultRoot, checkpoints: first.checkpoints });
      const again = checkpointSessions({ vaultRoot: s.vaultRoot, stateDir: s.stateDir, candidates: [candidate('a', skip)] });
      assert.equal(again.eligible, 0, `${skip}: not reopened at the same revision`);
      const changed = checkpointSessions({ vaultRoot: s.vaultRoot, stateDir: s.stateDir, candidates: [candidate('b', skip)] });
      assert.equal(changed.eligible, 1, `${skip}: a new revision is looked at again`);
      assert.equal(opened, 2);
    }
  } finally {
    s.cleanup();
  }
});

test('a trivial verdict from an older generation is looked at again once', () => {
  const s = sandbox();
  try {
    let opened = 0;
    const candidate = { runtime: 'codex', sessionId: 'codex-old', fingerprint: 'a',
      capture: () => { opened += 1; return outcome('skip', 'no user prompts (trivial session)'); } };
    saveMemoryCheckpoints({ stateDir: s.stateDir, vaultRoot: s.vaultRoot,
      checkpoints: { 'codex:codex-old': { fingerprint: 'a', paths: [], trivial: true, generation: TRIVIAL_GENERATION - 1 } } });
    assert.equal(checkpointSessions({ vaultRoot: s.vaultRoot, stateDir: s.stateDir, candidates: [candidate] }).eligible, 1);
    assert.equal(opened, 1);
  } finally {
    s.cleanup();
  }
});
