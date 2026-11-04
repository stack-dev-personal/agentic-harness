import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { queueIngest, drainIngest, QUEUE_NAME } from '../lib/ingest-queue.mjs';
import { runMemoryWorker } from '../memory-worker.mjs';

test('unsupported Codex storage reports a capability failure without starving Claude or queued work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-isolation-'));
  try {
    const vaultRoot = path.join(root, 'vault');
    const cwd = path.join(root, 'demo');
    const claude = path.join(root, '.claude', 'projects', 'demo');
    const codex = path.join(root, '.codex');
    for (const directory of [vaultRoot, cwd, claude, codex]) fs.mkdirSync(directory, { recursive: true });
    const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)');
    db.close();
    const timestamp = new Date().toISOString();
    fs.writeFileSync(path.join(claude, 'isolated-session.jsonl'), [
      { type: 'user', cwd, timestamp, message: { content: 'Record the shared memory decision.' } },
      { type: 'assistant', cwd, timestamp, message: { content: [{ type: 'text', text: 'The other runtimes continue when one adapter is unavailable.' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    const env = { USERPROFILE: root, HARNESS_VAULT: vaultRoot, HARNESS_MACHINE_ENV: path.join(root, 'absent.env') };
    const queued = [];
    let drains = 0;
    const result = await runMemoryWorker({ home: root, env,
      drain: () => { drains++; return { failed: [], ingested: 0 }; },
      queue: ({ notePaths }) => { queued.push(...notePaths); return { queued: true }; } });
    assert.equal(result.written, 1);
    assert.equal(queued.length, 1);
    assert.match(fs.readFileSync(queued[0], 'utf8'), /other runtimes continue/);
    assert.equal(drains, 3, 'both queues and post-capture ingestion still run');
    assert.equal(result.failed, 1);
    const health = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'memory-health.json'), 'utf8'));
    assert.deepEqual(health.capabilities.find(item => item.runtime === 'codex'), { runtime: 'codex', available: false });
    assert.equal(health.capabilities.find(item => item.runtime === 'claude-code').available, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('malformed queue lines stay recoverable without blocking eligible sibling notes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-queue-'));
  try {
    const vaultRoot = path.join(root, 'vault');
    const project = path.join(root, 'project');
    fs.mkdirSync(vaultRoot); fs.mkdirSync(project);
    const uv = path.join(root, 'uv.exe'); fs.writeFileSync(uv, '');
    const note = path.join(vaultRoot, 'good.md'); fs.writeFileSync(note, '# Harmless fixture\n');
    const env = { USERPROFILE: root, HARNESS_VAULT: vaultRoot, HARNESS_INGEST_PROJECT: project, HARNESS_UV_BIN: uv,
      HARNESS_MACHINE_ENV: path.join(root, 'absent.env') };
    assert.equal(queueIngest({ notePaths: [note], vaultRoot, env, startTask: false }).queued, true);
    fs.appendFileSync(path.join(root, '.harness', QUEUE_NAME), 'not-json\n');
    const calls = [];
    const result = drainIngest({ env, run: (command, args) => { calls.push(args); return { status: 0 }; } });
    assert.equal(result.ingested, 1);
    assert.equal(calls.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(fs.readFileSync(path.join(root, '.harness', result.failed[0]), 'utf8'), 'not-json\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('worker never commits a checkpoint when its durable queue handoff fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-worker-'));
  try {
    const vaultRoot = path.join(root, 'vault'); fs.mkdirSync(vaultRoot);
    const note = path.join(vaultRoot, 'n.md'); fs.writeFileSync(note, '# fixture\n');
    const env = { USERPROFILE: root, HARNESS_VAULT: vaultRoot, HARNESS_MACHINE_ENV: path.join(root, 'absent.env') };
    const candidates = [{ runtime: 'test', sessionId: 'one', fingerprint: 'one',
      capture: () => ({ written: true, action: 'create', notePath: note, touchedPaths: [note] }) }];
    await assert.rejects(runMemoryWorker({ home: root, env, candidates,
      drain: () => ({ failed: [], ingested: 0 }), queue: () => ({ queued: false }) }), /handoff/);
    assert.equal(fs.existsSync(path.join(root, '.harness', 'memory-checkpoints.json')), false);
    const result = await runMemoryWorker({ home: root, env, candidates,
      drain: () => ({ failed: [], ingested: 0 }), queue: () => ({ queued: true }) });
    assert.equal(result.written, 1);
    assert.equal(result.failed, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
