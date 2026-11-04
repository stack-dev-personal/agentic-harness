import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureSession } from '../lib/capture.mjs';
import { checkpointSessions, saveMemoryCheckpoints } from '../lib/memory-checkpoints.mjs';
import { memoryEligibility, sessionMemoryEligibility } from '../lib/memory-policy.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-parity-'));
  const vaultRoot = path.join(root, 'vault');
  const cwd = path.join(root, 'demo');
  fs.mkdirSync(cwd);
  fs.mkdirSync(vaultRoot);
  const entries = [
    { type: 'user', timestamp: '2026-11-03T12:00:00Z', cwd, origin: { kind: 'human' }, message: { content: 'Remember the tested decision.' } },
    { type: 'assistant', timestamp: '2026-11-03T12:00:01Z', cwd, message: { content: [{ type: 'text', text: 'The decision is to use one shared store.' }] } },
  ];
  return { root, vaultRoot, cwd, entries, env: { USERPROFILE: root } };
}

test('the same normalized session has one capture contract across all runtimes', () => {
  const f = fixture();
  try {
    for (const runtime of ['claude-code', 'codex', 'hermes']) {
      const result = captureSession({ ...f, input: { sessionId: `${runtime}-test`, cwd: f.cwd, endReason: 'resume' },
        agent: runtime, runtime, model: `model-${runtime}`, provider: 'test', runGit: () => ({ status: 0, stdout: '' }) });
      assert.equal(result.written, true);
      const raw = fs.readFileSync(result.notePath, 'utf8');
      const fields = parseFrontmatter(raw).fields;
      assert.equal(fields.agent, runtime);
      assert.equal(fields.runtime, runtime);
      assert.equal(fields.model, `model-${runtime}`);
      assert.equal(fields.provider, 'test');
      assert.equal(fields.status, 'active');
      assert.equal(fields.prompt_count, 1);
      assert.match(raw, /one shared store/);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('shared exclusions reject every runtime before any vault write', () => {
  const f = fixture();
  try {
    for (const agent of ['claude-code', 'codex', 'hermes']) {
      for (const policy of [{ memory_excluded: true }, { purpose: 'observer' }, { classification: 'TLP:AMBER' }]) {
        const result = captureSession({ ...f, agent, input: { sessionId: `${agent}-blocked`, cwd: f.cwd, ...policy } });
        assert.equal(result.written, false);
        assert.equal(result.action, 'excluded');
      }
    }
    assert.deepEqual(fs.readdirSync(f.vaultRoot), []);
    assert.equal(memoryEligibility({ input: {}, env: { HARNESS_MEMORY_EXCLUDED_ROOTS: 'invalid' } }).allowed, false);
    assert.equal(memoryEligibility({ input: {}, env: { HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([f.cwd]) }, paths: [path.join(f.cwd, 'private.txt')] }).allowed, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('canonical capture rejects untrusted identities and resolves protected relative read paths', () => {
  const f = fixture();
  try {
    const result = captureSession({ ...f, input: { sessionId: '../../../../outside', cwd: f.cwd } });
    assert.equal(result.written, false);
    assert.match(result.skip, /session.*id/i);
    assert.deepEqual(fs.readdirSync(f.vaultRoot), []);
    assert.equal(memoryEligibility({ input: { classification: 'public', data_classification: 'TLP:RED' }, env: {} }).allowed, false);
    assert.equal(memoryEligibility({ input: { classification: 'TLP:AMBER+STRICT' }, env: {} }).allowed, false);
    assert.equal(memoryEligibility({ input: { cwd: f.cwd }, env: { HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([path.join(f.cwd, 'private')]) }, paths: ['private/test.txt'] }).allowed, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('sensitive delegated work excludes its parent while housekeeping remains an independent opt-out', () => {
  const f = fixture();
  try {
    for (const runtime of ['claude-code', 'codex', 'hermes']) {
      const common = { runtime, cwd: f.cwd };
      sessionMemoryEligibility({ input: { ...common, sessionId: 'observer', parentSession: 'public-parent', purpose: 'observer' }, env: f.env });
      assert.equal(memoryEligibility({ input: { ...common, sessionId: 'public-parent' }, env: f.env }).allowed, true);
      sessionMemoryEligibility({ input: { ...common, sessionId: 'observer', parentSession: 'public-parent', classification: 'TLP:RED' }, env: f.env });
      assert.equal(memoryEligibility({ input: { ...common, sessionId: 'public-parent' }, env: f.env }).allowed, false, 'a later privacy restriction strengthens an earlier observer opt-out');
      sessionMemoryEligibility({ input: { ...common, sessionId: 'sensitive-child', parentSession: 'sensitive-parent',
        ancestorSessions: ['grandparent'], classification: 'TLP:RED' }, env: f.env });
      for (const sessionId of ['sensitive-child', 'sensitive-parent', 'grandparent']) assert.equal(memoryEligibility({ input: { ...common, sessionId }, env: f.env }).allowed, false);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('one checkpoint algorithm handles every runtime and commits only durable work', () => {
  const f = fixture();
  try {
    const stateDir = path.join(f.root, 'state');
    const candidates = ['claude-code', 'codex', 'hermes'].map(runtime => ({ runtime, sessionId: `${runtime}-test`, fingerprint: 'one',
      capture: () => captureSession({ ...f, input: { sessionId: `${runtime}-test`, cwd: f.cwd, endReason: 'resume' }, agent: runtime }) }));
    const first = checkpointSessions({ candidates, vaultRoot: f.vaultRoot, stateDir });
    assert.equal(first.written, 3);
    assert.equal(first.touchedPaths.length, 3);
    assert.equal(checkpointSessions({ candidates, vaultRoot: f.vaultRoot, stateDir }).touchedPaths.length, 3, 'retry uncommitted queue handoff');
    saveMemoryCheckpoints({ vaultRoot: f.vaultRoot, stateDir, checkpoints: first.checkpoints });
    assert.equal(checkpointSessions({ candidates, vaultRoot: f.vaultRoot, stateDir }).eligible, 0);
    const changed = candidates.map(c => ({ ...c, fingerprint: 'two' }));
    assert.equal(checkpointSessions({ candidates: changed, vaultRoot: f.vaultRoot, stateDir }).eligible, 3);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('shared capture persists complete ancestry for later exclusion checks across all runtimes', () => {
  const f = fixture();
  try {
    for (const runtime of ['claude-code', 'codex', 'hermes']) {
      const ancestors = [`${runtime}-parent-parser`, `${runtime}-grandparent-audit`];
      const result = captureSession({ ...f, input: { sessionId: `${runtime}-child-verifier`, cwd: f.cwd,
        endReason: 'resume', parentSession: ancestors[0], ancestorSessions: ancestors },
        agent: runtime, runtime, runGit: () => ({ status: 0, stdout: '' }) });
      assert.equal(result.written, true);
      const fields = parseFrontmatter(fs.readFileSync(result.notePath, 'utf8')).fields;
      assert.deepEqual(fields.ancestor_sessions, ancestors);
      assert.equal(fields.parent_session, ancestors[0]);
      const main = captureSession({ ...f, input: { sessionId: `${runtime}-main-task`, cwd: f.cwd, endReason: 'resume' },
        agent: runtime, runtime, runGit: () => ({ status: 0, stdout: '' }) });
      const mainFields = parseFrontmatter(fs.readFileSync(main.notePath, 'utf8')).fields;
      assert.equal(Object.hasOwn(mainFields, 'ancestor_sessions'), false);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('serialized note ancestry enforces sticky grandparent exclusions across runtimes', () => {
  const f = fixture();
  try {
    for (const runtime of ['claude-code', 'codex', 'hermes']) {
      const grandparent = `${runtime}-grandparent`;
      const note = { runtime, session_id: `${runtime}-grandchild`, parent_session: `${runtime}-parent`,
        ancestor_sessions: [`${runtime}-parent`, grandparent] };
      sessionMemoryEligibility({ input: { runtime, sessionId: grandparent, classification: 'TLP:RED' }, env: f.env });
      assert.equal(memoryEligibility({ input: note, env: f.env }).allowed, false);
      assert.equal(memoryEligibility({ input: { ...note, ancestorSessions: [] }, env: f.env }).allowed, false,
        'an empty native alias cannot hide persisted ancestry');
    }
    assert.equal(memoryEligibility({ input: { ancestor_sessions: 'invalid' }, env: f.env }).allowed, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
