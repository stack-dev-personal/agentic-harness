import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { baselineCodex, rolloutEndedAtMs } from '../lib/memory-baseline.mjs';
import { checkpointSessions, saveMemoryCheckpoints } from '../lib/memory-checkpoints.mjs';
import { discoverCodexSessions } from '../lib/runtime-adapters.mjs';
import { runCodexBaseline, runMemoryWorker } from '../memory-worker.mjs';

const at = (seconds) => new Date(Date.UTC(2026, 10, 3, 12, 0, seconds)).toISOString();
const line = (record) => `${JSON.stringify(record)}\n`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-baseline-'));
  const cwd = path.join(root, 'demo');
  const vaultRoot = path.join(root, 'vault');
  const directory = path.join(root, '.codex', 'sessions');
  fs.mkdirSync(cwd); fs.mkdirSync(vaultRoot); fs.mkdirSync(directory, { recursive: true });
  const env = { USERPROFILE: root, HARNESS_MEMORY_STATE_DIR: path.join(root, 'state') };
  const rollout = (id) => path.join(directory, `rollout-${id}.jsonl`);
  const write = (id, extra = []) => fs.writeFileSync(rollout(id), [
    { type: 'session_meta', timestamp: at(0), payload: { id, cwd, source: 'vscode' } },
    { type: 'response_item', timestamp: at(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Record the decision.' }] } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Recorded.' }] } },
    ...extra,
  ].map(line).join(''));
  const discover = () => discoverCodexSessions({ home: root, vaultRoot, env });
  const candidate = (id) => discover().find((each) => each.sessionId === `codex-${id}`);
  return { root, cwd, vaultRoot, env, rollout, write, discover, candidate,
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a rollout no newer than its note is recorded as current, and the next run does not recapture it', () => {
  const f = fixture();
  try {
    f.write('done');
    const first = f.candidate('done').capture({ deadlineAt: Date.now() + 3000 });
    assert.equal(first.written, true);
    // Events after the last turn (token counts) are not activity.
    fs.appendFileSync(f.rollout('done'), line({ type: 'event_msg', timestamp: at(30), payload: { type: 'token_count' } }));
    const result = baselineCodex({ candidates: f.discover(), vaultRoot: f.vaultRoot, env: f.env });
    assert.deepEqual(result.counts, { candidates: 1, baselined: 1, newer: 0, noNote: 0, excluded: 0, unreadable: 0 });
    const checkpoint = result.checkpoints['codex:codex-done'];
    assert.equal(checkpoint.fingerprint, f.candidate('done').fingerprint);
    assert.deepEqual(checkpoint.paths, [first.notePath]);
    const stateDir = path.join(f.root, 'harness');
    fs.mkdirSync(stateDir);
    saveMemoryCheckpoints({ stateDir, vaultRoot: f.vaultRoot, checkpoints: result.checkpoints, env: f.env });
    const next = checkpointSessions({ candidates: f.discover(), vaultRoot: f.vaultRoot, stateDir, env: f.env });
    assert.equal(next.eligible, 0, 'the baselined thread is not captured again');
  } finally { f.close(); }
});

test('a few milliseconds of drift between the sources is not activity', () => {
  const f = fixture();
  try {
    f.write('drift');
    assert.equal(f.candidate('drift').capture({ deadlineAt: Date.now() + 3000 }).written, true);
    // The same final answer, stamped 450 ms later by the other source's clock.
    const drifted = new Date(Date.parse(at(2)) + 450).toISOString();
    fs.writeFileSync(f.rollout('drift'), fs.readFileSync(f.rollout('drift'), 'utf8').replace(`"timestamp":"${at(2)}"`, `"timestamp":"${drifted}"`));
    assert.equal(baselineCodex({ candidates: f.discover(), vaultRoot: f.vaultRoot, env: f.env }).counts.baselined, 1);
  } finally { f.close(); }
});

test('a rollout with activity after its note is left for capture', () => {
  const f = fixture();
  try {
    f.write('later');
    assert.equal(f.candidate('later').capture({ deadlineAt: Date.now() + 3000 }).written, true);
    fs.appendFileSync(f.rollout('later'), line({ type: 'response_item', timestamp: at(59),
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'One more thing.' }] } }));
    const result = baselineCodex({ candidates: f.discover(), vaultRoot: f.vaultRoot, env: f.env });
    assert.equal(result.counts.newer, 1);
    assert.deepEqual(result.checkpoints, {});
  } finally { f.close(); }
});

test('a session with no note is not baselined', () => {
  const f = fixture();
  try {
    f.write('fresh');
    const result = baselineCodex({ candidates: f.discover(), vaultRoot: f.vaultRoot, env: f.env });
    assert.equal(result.counts.noNote, 1);
    assert.deepEqual(result.checkpoints, {});
  } finally { f.close(); }
});

test('a session the policy now excludes is not baselined, even with a note', () => {
  const f = fixture();
  try {
    f.write('secret');
    assert.equal(f.candidate('secret').capture({ deadlineAt: Date.now() + 3000 }).written, true);
    const env = { ...f.env, HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([f.cwd]) };
    const candidates = discoverCodexSessions({ home: f.root, vaultRoot: f.vaultRoot, env });
    const result = baselineCodex({ candidates, vaultRoot: f.vaultRoot, env });
    assert.equal(result.counts.excluded, 1);
    assert.deepEqual(result.checkpoints, {});
  } finally { f.close(); }
});

test('only rollout-sourced Codex candidates are considered', () => {
  const result = baselineCodex({ vaultRoot: os.tmpdir(), env: {}, candidates: [
    { runtime: 'claude-code', sessionId: 'c1', fingerprint: 'x', input: {} },
    { runtime: 'codex', sourceKind: 'sqlite', sessionId: 'codex-s1', fingerprint: 'x', input: {} },
  ] });
  assert.equal(result.counts.candidates, 0);
});

test('the newest note in a resume chain is the one compared', () => {
  const f = fixture();
  try {
    f.write('chain');
    const first = f.candidate('chain').capture({ deadlineAt: Date.now() + 3000 });
    const head = first.notePath.replace(/\.md$/, '-r2.md');
    const raw = fs.readFileSync(first.notePath, 'utf8');
    fs.writeFileSync(first.notePath, raw.replace(/ended_at: '[^']*'/, `ended_at: '${at(1)}'`));
    fs.writeFileSync(head, raw);
    const result = baselineCodex({ candidates: f.discover(), vaultRoot: f.vaultRoot, env: f.env });
    assert.equal(result.counts.baselined, 1);
    assert.deepEqual(result.checkpoints['codex:codex-chain'].paths, [head]);
  } finally { f.close(); }
});

test('--baseline codex saves only outside a dry run, and the worker then leaves the thread alone', async () => {
  const f = fixture();
  try {
    f.write('cutover');
    assert.equal(f.candidate('cutover').capture({ deadlineAt: Date.now() + 3000 }).written, true);
    const env = { ...f.env, HARNESS_VAULT: f.vaultRoot, HARNESS_MACHINE_ENV: path.join(f.root, 'absent.env') };
    const stateFile = path.join(f.root, '.harness', 'memory-checkpoints.json');
    const dry = await runCodexBaseline({ home: f.root, env, dryRun: true });
    assert.equal(dry.baselined, 1);
    assert.equal(dry.saved, false);
    assert.equal(fs.existsSync(stateFile), false, 'a dry run writes nothing');
    const real = await runCodexBaseline({ home: f.root, env });
    assert.equal(real.baselined, 1);
    assert.equal(real.failed, 0);
    assert.match(fs.readFileSync(stateFile, 'utf8'), /codex:codex-cutover/);
    const before = fs.readFileSync(path.join(f.vaultRoot, 'projects', 'demo', 'sessions', 'codex-cutover.md'), 'utf8');
    const run = await runMemoryWorker({ home: f.root, env, drain: () => ({ failed: [], ingested: 0 }), queue: () => ({ queued: true }) });
    assert.equal(run.written, 0);
    assert.equal(fs.readFileSync(path.join(f.vaultRoot, 'projects', 'demo', 'sessions', 'codex-cutover.md'), 'utf8'), before);
  } finally { f.close(); }
});

test('rolloutEndedAtMs is the end a capture derives: reasoning, tool output, events and torn lines do not count', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-baseline-'));
  try {
    const file = path.join(root, 'r.jsonl');
    fs.writeFileSync(file, [
      line({ type: 'session_meta', timestamp: at(0), payload: { id: 'r', cwd: root } }),
      line({ type: 'response_item', timestamp: at(5), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Go.' }] } }),
      line({ type: 'response_item', timestamp: at(6), payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' } }),
      line({ type: 'response_item', timestamp: at(20), payload: { type: 'function_call_output', call_id: 'c1', output: 'x' } }),
      line({ type: 'response_item', timestamp: at(25), payload: { type: 'reasoning', summary: [] } }),
      line({ type: 'event_msg', timestamp: at(40), payload: { type: 'token_count' } }),
      '{"type":"response_item","timestamp":"2026-11-03T12:00:50',
    ].join(''));
    assert.equal(rolloutEndedAtMs(file, { cwd: root, env: {} }), Date.parse(at(6)));
    assert.ok(Number.isNaN(rolloutEndedAtMs(path.join(root, 'missing.jsonl'))));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
