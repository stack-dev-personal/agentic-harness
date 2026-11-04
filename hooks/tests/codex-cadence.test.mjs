import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureChangedCodex } from '../lib/codex-cadence.mjs';
import { captureCodex } from '../codex-session-capture.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cadence-'));
  const vaultRoot = path.join(home, 'vault');
  const cwd = path.join(home, 'demo');
  fs.mkdirSync(path.join(vaultRoot, 'projects', 'demo', 'sessions'), { recursive: true });
  fs.mkdirSync(cwd);
  const root = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'rollout.jsonl');
  const record = (text) => ({ timestamp: new Date().toISOString(), type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  fs.writeFileSync(file, [ { type: 'session_meta', payload: { id: 'test-cadence', cwd } },
    record('Remember this live session.') ].map(JSON.stringify).join('\n') + '\n');
  return { home, vaultRoot, file, record, capture: captureCodex };
}

test('cadence captures open chats, skips unchanged rollouts, and refreshes appended prompts', () => {
  const f = fixture();
  const queued = [];
  const queue = ({ notePaths }) => { queued.push(...notePaths); return { queued: true }; };
  try {
    assert.equal(captureChangedCodex({ ...f, queue }).captured, 1);
    assert.equal(parseFrontmatter(fs.readFileSync(queued[0], 'utf8')).fields.status, 'active');
    assert.equal(captureChangedCodex({ ...f, queue }).unchanged, 1);
    assert.equal(queued.length, 1);
    fs.appendFileSync(f.file, JSON.stringify(f.record('A new update to remember.')) + '\n');
    assert.equal(captureChangedCodex({ ...f, queue }).captured, 1);
    assert.match(fs.readFileSync(queued.at(-1), 'utf8'), /A new update to remember/);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('failed enqueue is retried even when the note is already written', () => {
  const f = fixture();
  try {
    assert.equal(captureChangedCodex({ ...f, queue: () => ({ queued: false }) }).errors, 1);
    let paths = [];
    const r = captureChangedCodex({ ...f, queue: ({ notePaths }) => { paths = notePaths; return { queued: true }; } });
    assert.equal(r.errors, 0);
    assert.equal(paths.length, 1);
    assert.ok(fs.existsSync(paths[0]));
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('cadence excludes inherited subagent histories', () => {
  const f = fixture();
  try {
    const records = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse);
    records[0].payload.parent_thread_id = 'parent';
    fs.writeFileSync(f.file, records.map(JSON.stringify).join('\n') + '\n');
    const r = captureChangedCodex({ ...f, queue: () => { throw new Error('must not queue'); } });
    assert.equal(r.captured, 0);
    assert.equal(r.errors, 0);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('archiving a closed chat preserves its concluded note', () => {
  const f = fixture();
  const queued = [];
  const queue = ({ notePaths }) => { queued.push(...notePaths); return { queued: true }; };
  try {
    assert.equal(captureChangedCodex({ ...f, queue }).captured, 1);
    const closed = captureCodex({ vaultRoot: f.vaultRoot, input: {
      sessionId: 'test-cadence', transcriptPath: f.file,
      hookEventName: 'SessionEnd', endReason: 'other',
    } });
    assert.equal(closed.written, true);
    const before = fs.readFileSync(closed.notePath, 'utf8');
    assert.equal(parseFrontmatter(before).fields.status, 'concluded');
    const archive = path.join(f.home, '.codex', 'archived_sessions');
    fs.mkdirSync(archive);
    fs.renameSync(f.file, path.join(archive, 'rollout.jsonl'));
    const result = captureChangedCodex({ ...f, queue });
    assert.equal(result.errors, 0);
    assert.equal(result.captured, 0);
    assert.equal(fs.readFileSync(closed.notePath, 'utf8'), before);
    assert.equal(queued.at(-1), closed.notePath);
    assert.equal(captureChangedCodex({ ...f, queue }).unchanged, 1);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('a failed capture remains eligible for the next cadence run', () => {
  const f = fixture();
  try {
    const queue = () => ({ queued: true });
    const failed = captureChangedCodex({ ...f, queue,
      capture: () => ({ written: false, action: 'skip', skip: 'vault unavailable' }) });
    assert.equal(failed.errors, 1);
    const retried = captureChangedCodex({ ...f, queue });
    assert.equal(retried.captured, 1);
    assert.equal(retried.errors, 0);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
