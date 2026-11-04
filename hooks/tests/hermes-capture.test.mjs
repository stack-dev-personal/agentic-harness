import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { normalizeHermesSession, readHermesSession, discoverHermesSessions, captureHermes } from '../hermes-session-capture.mjs';
import { extractPrompts, extractOutcome } from '../lib/transcript.mjs';
import { memoryEligibility, memoryPolicyFields, recordMemoryExclusion } from '../lib/memory-policy.mjs';

const at = (second) => new Date(Date.UTC(2026, 10, 3, 12, 0, second)).toISOString();

test('Hermes preserves every shared exclusion field through normalization and capture', () => {
  for (const policy of [{ restricted: true }, { persistence: 'exclude' }]) {
    assert.deepEqual(memoryPolicyFields(policy), policy);
    let captured;
    captureHermes({ snapshot: { session_id: 'excluded', cwd: 'C:/work', ...policy, messages: [] },
      vaultRoot: 'C:/vault', capture: args => { captured = args; return { written: false }; } });
    assert.deepEqual(memoryPolicyFields(captured.input), policy);
    assert.equal(memoryEligibility({ input: captured.input, env: {} }).allowed, false);
  }
});

test('Hermes normalization keeps human prompts, final answers, and selected activity without raw outputs', () => {
  const parsed = normalizeHermesSession({ session_id: 's1', cwd: 'C:/work/demo', model: 'any-model', messages: [
    { role: 'system', content: 'system-private' },
    { role: 'user', content: 'Find the invariant.', timestamp: at(1) },
    { role: 'assistant', reasoning: 'private-thought', tool_calls: [{ id: 't1', function: {
      name: 'terminal', arguments: JSON.stringify({ command: 'git status --short' }) } }], timestamp: at(2) },
    { role: 'tool', content: 'raw-tool-private', timestamp: at(3) },
    { role: 'assistant', content: 'The invariant holds.', timestamp: at(4) },
  ] });
  assert.equal(extractPrompts(parsed.entries)[0].text, 'Find the invariant.');
  assert.equal(extractOutcome(parsed.entries), 'The invariant holds.');
  assert.ok(JSON.stringify(parsed.entries).includes('git status --short'));
  for (const excluded of ['system-private', 'private-thought', 'raw-tool-private']) assert.ok(!JSON.stringify(parsed).includes(excluded));
});

test('Hermes delegated task excludes inherited context and keeps its own assignment', () => {
  const parsed = normalizeHermesSession({ session_id: 'child', parent_session_id: 'parent', task: 'Verify parser behavior.',
    cwd: 'C:/work/demo', messages: [
      { role: 'user', content: 'inherited-parent-private', timestamp: at(1) },
      { role: 'assistant', content: 'Verified.', timestamp: at(2) },
    ] });
  assert.deepEqual(extractPrompts(parsed.entries).map(p => p.text), ['Verify parser behavior.']);
  assert.ok(!JSON.stringify(parsed).includes('inherited-parent-private'));
  assert.equal(parsed.parentSession, 'hermes-parent');
});

test('Hermes successor lineage preserves new human prompts without treating them as delegation', () => {
  for (const source of [undefined, 'cli']) {
    const parsed = normalizeHermesSession({ session_id: 'successor', parent_session_id: 'previous', source,
      cwd: 'C:/work/demo', messages: [
        { role: 'user', content: 'inherited-context', inherited: true, timestamp: at(1) },
        { role: 'user', content: 'Solve the new task.', timestamp: at(2) },
        { role: 'assistant', content: 'The new task is complete.', timestamp: at(3) },
      ] });
    assert.deepEqual(extractPrompts(parsed.entries).map(p => p.text), ['Solve the new task.']);
    assert.equal(parsed.parentSession, 'hermes-previous');
    assert.ok(!JSON.stringify(parsed).includes('inherited-context'));
  }
  const child = normalizeHermesSession({ session_id: 'child', parent_session_id: 'parent', source: 'subagent',
    messages: [{ role: 'user', content: 'inherited-parent-private' }, { role: 'assistant', content: 'Done.' }] });
  assert.deepEqual(extractPrompts(child.entries), [], 'delegates without a verified assignment stay uncapturable');
});

test('Hermes capture passes active and concluded lifecycle through shared capture', () => {
  const calls = [];
  const capture = args => { calls.push(args); return { written: true, touchedPaths: ['note.md'] }; };
  captureHermes({ snapshot: { session_id: 's1', cwd: 'C:/work', messages: [{ role: 'user', content: 'Remember this.' }] },
    vaultRoot: 'C:/vault', capture });
  captureHermes({ snapshot: { session_id: 's1', cwd: 'C:/work', concluded: true, messages: [{ role: 'user', content: 'Remember this.' }] },
    vaultRoot: 'C:/vault', capture });
  assert.equal(calls[0].input.endReason, 'resume');
  assert.equal(calls[1].input.endReason, 'other');
  assert.equal(calls[0].input.sessionId, 'hermes-s1');
  assert.equal(calls[0].runtime, 'hermes');
});

test('Hermes recovery reads only registered sessions with read-only native DB access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-read-'));
  try {
    fs.mkdirSync(path.join(root, 'state'));
    const db = new DatabaseSync(path.join(root, 'state.db'));
    db.exec('CREATE TABLE sessions (id TEXT, cwd TEXT, model TEXT, parent_session_id TEXT, started_at REAL, ended_at REAL, transcript_revision INTEGER, source TEXT); CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, timestamp REAL, active INTEGER);');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('s1', 'C:/work/demo', 'm1', null, 100, null, 1, 'cli');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('historical', 'C:/work/demo', 'm1', null, 100, null, 1, 'cli');
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, 's1', 'user', 'A saved task.', null, 101, 1);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 's1', 'tool', 'raw-tool-private', null, 102, 1);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(3, 's1', 'assistant', 'Done.', null, 103, 1);
    db.close();
    assert.deepEqual(discoverHermesSessions({ hermesHome: root }), []);
    fs.writeFileSync(path.join(root, 'state', 'harness-memory-sessions.json'), JSON.stringify({ sessions: { s1: { cwd: 'C:/work/demo' } } }));
    const candidates = discoverHermesSessions({ hermesHome: root });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sessionId, 'hermes-s1');
    const parsed = readHermesSession({ hermesHome: root, sessionId: 's1' });
    assert.equal(extractOutcome(parsed.entries), 'Done.');
    assert.ok(!JSON.stringify(parsed).includes('raw-tool-private'));
    assert.throws(() => readHermesSession({ hermesHome: root, sessionId: 'historical' }), /not registered/);
    const writer = new DatabaseSync(path.join(root, 'state.db'));
    writer.exec('ALTER TABLE messages ADD COLUMN compacted INTEGER DEFAULT 0');
    writer.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(0, 's1', 'user', 'Original precompaction task.', null, 100, 0, 1);
    writer.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(4, 's1', 'user', 'Withdrawn instruction.', null, 104, 0, 0);
    writer.close();
    const compacted = readHermesSession({ hermesHome: root, sessionId: 's1' });
    assert.deepEqual(extractPrompts(compacted.entries).map(p => p.text), ['Original precompaction task.', 'A saved task.']);
    assert.ok(!JSON.stringify(compacted.entries).includes('Withdrawn instruction.'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Hermes discovery exposes full native ancestry before any message bodies are read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-ancestry-'));
  let db;
  try {
    fs.mkdirSync(path.join(root, 'state'));
    db = new DatabaseSync(path.join(root, 'state.db'));
    db.exec('CREATE TABLE sessions (id TEXT, cwd TEXT, model TEXT, parent_session_id TEXT, started_at REAL, ended_at REAL); CREATE TABLE messages (id INTEGER, session_id TEXT);');
    const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('grandparent', root, 'm', null, 100, null);
    insert.run('parent', root, 'm', 'grandparent', 101, null);
    insert.run('child', root, 'm', 'parent', 102, null);
    fs.writeFileSync(path.join(root, 'state', 'harness-memory-sessions.json'), JSON.stringify({ sessions: { child: { cwd: root } } }));
    const [candidate] = discoverHermesSessions({ hermesHome: root });
    assert.equal(candidate.parentSession, 'hermes-parent');
    assert.deepEqual(candidate.ancestorSessions, ['hermes-parent', 'hermes-grandparent']);
    const env = { USERPROFILE: root };
    recordMemoryExclusion({ input: { runtime: 'hermes', sessionId: 'grandparent' }, env });
    assert.equal(memoryEligibility({ input: { ...candidate, runtime: 'hermes' }, env }).allowed, false);
    // The intermediate session does not need a registration or exclusion of its own.
    db.prepare('UPDATE sessions SET parent_session_id = ? WHERE id = ?').run('child', 'grandparent');
    assert.throws(() => discoverHermesSessions({ hermesHome: root }), /ancestry/);
  } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

function delegatedWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-children-'));
  fs.mkdirSync(path.join(root, 'state'));
  const db = new DatabaseSync(path.join(root, 'state.db'));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, model TEXT, parent_session_id TEXT,
    started_at REAL, ended_at REAL, transcript_revision INTEGER, source TEXT, model_config TEXT);
    CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT,
      timestamp REAL, active INTEGER, compacted INTEGER DEFAULT 0, _compressed_summary INTEGER DEFAULT 0);`);
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('parent', root, 'm', null, 50, null, 1, 'cli', '{}');
  insert.run('child', root, 'm', 'parent', 110, 120, 1, 'subagent', '{"_delegate_from":"parent"}');
  insert.run('nested', root, 'm', 'child', 115, 120, 1, 'subagent', '{"_delegate_from":"child"}');
  insert.run('old-child', root, 'm', 'parent', 90, 95, 1, 'subagent', '{"_delegate_from":"parent"}');
  insert.run('branch', root, 'm', 'parent', 110, null, 1, 'cli', '{}');
  insert.run('unrelated', root, 'm', null, 110, null, 1, 'cli', '{}');
  const message = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  message.run(1, 'parent', 'user', 'parent-only-context', null, 51, 1, 0, 0);
  message.run(2, 'child', 'system', 'inherited-system-context', null, 110, 1, 0, 0);
  message.run(3, 'child', 'user', 'Verify parser behavior.', null, 111, 0, 1, 0);
  message.run(4, 'child', 'tool', 'raw-tool-output', null, 112, 1, 0, 0);
  message.run(5, 'child', 'assistant', 'Verified parser.', null, 113, 1, 0, 0);
  const registryPath = path.join(root, 'state', 'harness-memory-sessions.json');
  fs.writeFileSync(registryPath, JSON.stringify({ sessions: { parent: { cwd: root, registered_at: 100 } } }));
  return { root, db, registryPath, env: { USERPROFILE: root }, close: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('Hermes recovery captures an explicitly registered ordinary branch with its new task', () => {
  const f = delegatedWorld();
  try {
    const state = JSON.parse(fs.readFileSync(f.registryPath, 'utf8'));
    state.sessions.branch = { cwd: f.root, registered_at: 111 };
    fs.writeFileSync(f.registryPath, JSON.stringify(state));
    const message = f.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    message.run(6, 'branch', 'user', 'Solve the branched task.', null, 112, 1, 0, 0);
    message.run(7, 'branch', 'assistant', 'The branch is complete.', null, 113, 1, 0, 0);
    const parsed = readHermesSession({ hermesHome: f.root, sessionId: 'branch', env: f.env });
    assert.deepEqual(extractPrompts(parsed.entries).map(p => p.text), ['Solve the branched task.']);
    const vaultRoot = path.join(f.root, 'vault');
    fs.mkdirSync(vaultRoot);
    const captured = captureHermes({ snapshot: parsed.snapshot, vaultRoot, env: f.env,
      runGit: () => ({ status: 0, stdout: '' }) });
    assert.equal(captured.written, true);
    const note = fs.readFileSync(captured.notePath, 'utf8');
    assert.match(note, /Solve the branched task/);
    assert.match(note, /The branch is complete/);
    assert.ok(!note.includes('parent-only-context'));
  } finally { f.close(); }
});

test('Hermes recovery discovers only new native delegated descendants of registered sessions', () => {
  const f = delegatedWorld();
  try {
    const before = fs.readFileSync(f.registryPath, 'utf8');
    const candidates = discoverHermesSessions({ hermesHome: f.root });
    assert.deepEqual(candidates.map(row => row.nativeSessionId).sort(), ['child', 'nested', 'parent']);
    assert.equal(fs.readFileSync(f.registryPath, 'utf8'), before);
    const parsed = readHermesSession({ hermesHome: f.root, sessionId: 'child', env: f.env });
    assert.deepEqual(extractPrompts(parsed.entries).map(p => p.text), ['Verify parser behavior.']);
    assert.equal(extractOutcome(parsed.entries), 'Verified parser.');
    for (const excluded of ['parent-only-context', 'inherited-system-context', 'raw-tool-output']) {
      assert.ok(!JSON.stringify(parsed).includes(excluded));
    }
    assert.equal(parsed.parentSession, 'hermes-parent');
    for (const id of ['old-child', 'branch', 'unrelated']) {
      assert.throws(() => readHermesSession({ hermesHome: f.root, sessionId: id, env: f.env }), /not registered|eligible|delegat/);
    }
  } finally { f.close(); }
});

test('Hermes delegated recovery rejects exclusions and mismatched ancestry before reading messages', () => {
  const f = delegatedWorld();
  try {
    // An absent content column makes any accidental transcript read fail visibly.
    f.db.exec('ALTER TABLE messages DROP COLUMN content');
    for (const policy of [{ restricted: true }, { persistence: 'exclude' }, { classification: 'TLP:AMBER+STRICT' }]) {
      fs.writeFileSync(f.registryPath, JSON.stringify({ sessions: { parent: { cwd: f.root, registered_at: 100, ...policy } } }));
      assert.throws(() => readHermesSession({ hermesHome: f.root, sessionId: 'child', env: f.env }), /excluded/);
    }
    fs.writeFileSync(f.registryPath, JSON.stringify({ sessions: { parent: { cwd: f.root, registered_at: 100 } } }));
    recordMemoryExclusion({ input: { runtime: 'hermes', sessionId: 'parent' }, env: f.env });
    assert.throws(() => readHermesSession({ hermesHome: f.root, sessionId: 'child', env: f.env }), /excluded/);
    f.db.prepare('UPDATE sessions SET model_config = ? WHERE id = ?').run('{"_delegate_from":"unrelated"}', 'child');
    assert.throws(() => readHermesSession({ hermesHome: f.root, sessionId: 'child', env: f.env }), /ancestry|delegat/);
  } finally { f.close(); }
});
test('Hermes native recovery decodes multimodal task text without retaining image payloads', () => {
  const f = delegatedWorld();
  try {
    const encoded = '\u0000json:' + JSON.stringify([
      { type: 'text', text: 'Inspect the parser diagram.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,private-image-payload' } },
    ]);
    f.db.prepare('UPDATE messages SET content = ? WHERE id = 3').run(encoded);
    const parsed = readHermesSession({ hermesHome: f.root, sessionId: 'child', env: f.env });
    assert.deepEqual(extractPrompts(parsed.entries).map(p => p.text), ['Inspect the parser diagram.']);
    assert.ok(!JSON.stringify(parsed).includes('private-image-payload'));
  } finally { f.close(); }
});

test('Hermes legacy registration does not opt historical descendants into recovery', () => {
  const f = delegatedWorld();
  try {
    fs.writeFileSync(f.registryPath, JSON.stringify({ sessions: { parent: { cwd: f.root } } }));
    assert.deepEqual(discoverHermesSessions({ hermesHome: f.root }).map(row => row.nativeSessionId), ['parent']);
    assert.throws(() => readHermesSession({ hermesHome: f.root, sessionId: 'child', env: f.env }), /not eligible/);
  } finally { f.close(); }
});
test('Hermes child recovery checks protected native and registered ancestor paths before body reads', () => {
  const f = delegatedWorld();
  try {
    const protectedRoot = path.join(f.root, 'private');
    fs.mkdirSync(protectedRoot);
    f.db.prepare('UPDATE sessions SET cwd = ? WHERE id = ?').run(protectedRoot, 'parent');
    fs.writeFileSync(f.registryPath, JSON.stringify({ sessions: { parent: { cwd: protectedRoot, registered_at: 100 } } }));
    f.db.exec('ALTER TABLE messages DROP COLUMN content');
    assert.throws(() => readHermesSession({ hermesHome: f.root, sessionId: 'child',
      env: { ...f.env, HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([protectedRoot]) } }), /excluded/);
  } finally { f.close(); }
});

test('Hermes malformed activation times cannot opt historical children into recovery', () => {
  const f = delegatedWorld();
  try {
    for (const registered_at of [0, -1]) {
      fs.writeFileSync(f.registryPath, JSON.stringify({ sessions: { parent: { cwd: f.root, registered_at } } }));
      assert.deepEqual(discoverHermesSessions({ hermesHome: f.root }).map(row => row.nativeSessionId), ['parent']);
      assert.throws(() => readHermesSession({ hermesHome: f.root, sessionId: 'child', env: f.env }), /not eligible/);
    }
  } finally { f.close(); }
});
