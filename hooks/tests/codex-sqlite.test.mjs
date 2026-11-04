import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { discoverCodexSqliteSessions, captureCodexSqliteSession } from '../lib/codex-sqlite.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

const NOW = Date.UTC(2026, 10, 3, 18);

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sqlite-'));
  const cwd = path.join(home, 'demo');
  const vaultRoot = path.join(home, 'vault');
  const native = path.join(home, '.codex');
  fs.mkdirSync(cwd); fs.mkdirSync(vaultRoot); fs.mkdirSync(native);
  const state = new DatabaseSync(path.join(native, 'state_5.sqlite'));
  const history = new DatabaseSync(path.join(native, 'thread_history_1.sqlite'));
  state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, source TEXT,
    model_provider TEXT, model TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
    history_mode TEXT, archived INTEGER, originator TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`);
  history.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT,
    rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT,
    updated_at_ordinal INTEGER, started_at_ms INTEGER, completed_at_ms INTEGER);
    CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER,
    status TEXT, started_at INTEGER, completed_at INTEGER);`);
  const env = { USERPROFILE: home, HARNESS_MEMORY_STATE_DIR: path.join(home, 'state') };
  function thread(id = 'main', extra = {}) {
    state.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, path.join(native, 'old-rollout.jsonl'), cwd,
      extra.source || 'vscode', 'provider-test', 'model-test', NOW - 60000, extra.updatedAt ?? NOW,
      extra.historyMode || 'paginated', 0, 'Codex Desktop');
  }
  function item(threadId, value, ordinal, extra = {}) {
    history.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?,?,?)').run(threadId, `${threadId}-turn`, value.id || `${threadId}-${ordinal}`,
      ordinal, extra.createdAt ?? NOW + ordinal, extra.raw ?? JSON.stringify(value), value.type,
      extra.updatedOrdinal ?? ordinal, NOW + ordinal, NOW + ordinal + 1);
  }
  function turn(id, status = 'completed') {
    history.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?)').run(id, `${id}-turn`, 0, status, (NOW - 60000) / 1000, NOW / 1000);
  }
  const options = { home, vaultRoot, env, runGit: () => ({ status: 0, stdout: '' }) };
  return { home, cwd, vaultRoot, native, state, history, env, thread, item, turn, options,
    close() { state.close(); history.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}

function mainItems(f, id = 'main') {
  f.thread(id); f.turn(id);
  f.item(id, { type: 'userMessage', content: [{ type: 'text', text: '<environment_context>machine only</environment_context>' }] }, 1);
  f.item(id, { type: 'userMessage', content: [{ type: 'text', text: 'Record the shared database decision.' }] }, 2);
  f.item(id, { type: 'agentMessage', text: 'Working on it.', phase: 'commentary' }, 3);
  f.item(id, { type: 'commandExecution', command: 'git status', cwd: f.cwd, aggregatedOutput: 'RAW-TOOL-SECRET' }, 4);
  f.item(id, { type: 'fileChange', changes: [{ path: path.join(f.cwd, 'result.txt'), kind: 'update', diff: 'RAW-DIFF-SECRET' }] }, 5);
  f.item(id, { type: 'reasoning', content: ['RAW-REASONING-SECRET'] }, 6);
  f.item(id, { type: 'agentMessage', text: 'Use the same memory index for every runtime.', phase: 'final_answer' }, 7);
}

test('SQLite discovery reads metadata only; capture uses native items and shared active lifecycle', () => {
  const f = fixture();
  try {
    mainItems(f);
    let capturing = false;
    const openDatabase = (file, options) => {
      assert.equal(options.readOnly, true);
      const db = new DatabaseSync(file, options);
      return { close: () => db.close(), prepare(sql) {
        if (!capturing) assert.ok(!/item_json/.test(sql), 'discovery must never read content');
        return db.prepare(sql);
      } };
    };
    const candidates = discoverCodexSqliteSessions({ ...f.options, openDatabase });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sessionId, 'codex-main');
    assert.equal(candidates[0].nativeSessionId, 'main');
    assert.equal(candidates[0].sourceKind, 'sqlite');
    assert.equal(candidates[0].authoritative, true);
    capturing = true;
    const outcome = candidates[0].capture({ deadlineAt: Date.now() + 3000 });
    assert.equal(outcome.written, true);
    const raw = fs.readFileSync(outcome.notePath, 'utf8');
    const fields = parseFrontmatter(raw).fields;
    assert.equal(fields.status, 'active', 'a completed turn is not a concluded session');
    assert.equal(fields.agent, 'codex');
    assert.equal(fields.model, 'model-test');
    assert.equal(fields.provider, 'provider-test');
    assert.equal(fields.prompt_count, 1);
    assert.equal(fields.command_count, 1);
    assert.match(raw, /same memory index/);
    assert.match(raw, /result\.txt/);
    assert.ok(!/RAW-|Working on it|machine only/.test(raw));
  } finally { f.close(); }
});

test('SQLite fingerprints detect in-place updates, new items and turn status changes', () => {
  const f = fixture();
  try {
    mainItems(f);
    const discover = () => discoverCodexSqliteSessions(f.options)[0].fingerprint;
    const first = discover();
    f.history.prepare('UPDATE thread_items SET updated_at_ordinal=100 WHERE item_id=?').run('main-7');
    const second = discover(); assert.notEqual(second, first);
    f.item('main', { type: 'agentMessage', text: 'Another result.', phase: 'final_answer' }, 8);
    const third = discover(); assert.notEqual(third, second);
    f.history.prepare("UPDATE thread_turns SET status='interrupted'").run();
    assert.notEqual(discover(), third);
  } finally { f.close(); }
});

test('only recent paginated SQLite sessions are candidates', () => {
  const f = fixture();
  try {
    mainItems(f);
    f.thread('old', { updatedAt: NOW - 1000000 });
    f.thread('legacy', { historyMode: 'legacy' });
    const recent = discoverCodexSqliteSessions({ ...f.options, since: NOW - 1000 });
    assert.deepEqual(recent.map(c => c.sessionId), ['codex-main']);
    assert.deepEqual([...recent.authoritativeIds].sort(), ['main', 'old'], 'old paginated threads cannot fall back to stale rollouts');
  } finally { f.close(); }
});

test('excluded sessions are rejected before any native JSON content read', () => {
  const f = fixture();
  try {
    mainItems(f);
    const openDatabase = (file, options) => {
      const db = new DatabaseSync(file, options);
      return { close: () => db.close(), prepare(sql) {
        assert.ok(!/item_json/.test(sql), 'excluded content must never be read');
        return db.prepare(sql);
      } };
    };
    const candidates = discoverCodexSqliteSessions({ ...f.options, env: { ...f.env, HARNESS_MEMORY_PERSISTENCE: 'off' }, openDatabase });
    assert.equal(candidates.length, 0);
    assert.deepEqual(fs.readdirSync(f.vaultRoot), []);
  } finally { f.close(); }
});

test('SQLite child capture uses parent assignment and never inherited child user content', () => {
  const f = fixture();
  try {
    mainItems(f, 'parent');
    f.thread('child', { source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'parent' } } }) });
    f.turn('child');
    f.state.prepare("INSERT INTO thread_spawn_edges VALUES ('parent','child','completed')").run();
    f.item('parent', { type: 'collabAgentToolCall', tool: 'spawnAgent', prompt: 'Verify the shared storage implementation.', receiverThreadIds: ['child'] }, 9);
    f.item('child', { type: 'userMessage' }, 10, { raw: 'inherited JSON must never be decoded' });
    f.item('child', { type: 'agentMessage', text: 'Shared storage verified.', phase: 'final_answer' }, 11);
    const candidate = discoverCodexSqliteSessions(f.options).find(c => c.nativeSessionId === 'child');
    const outcome = candidate.capture({ deadlineAt: Date.now() + 3000 });
    assert.equal(outcome.written, true);
    const raw = fs.readFileSync(outcome.notePath, 'utf8');
    const fields = parseFrontmatter(raw).fields;
    assert.equal(fields.parent_session, 'codex-parent');
    assert.equal(fields.prompt_count, 1);
    assert.match(raw, /Verify the shared storage implementation/);
    assert.ok(!raw.includes('Record the shared database decision'));
  } finally { f.close(); }
});

test('SQLite child missing its own task fails closed and logs a capability gap', () => {
  const f = fixture();
  try {
    mainItems(f, 'parent'); f.thread('child'); f.turn('child');
    f.state.prepare("INSERT INTO thread_spawn_edges VALUES ('parent','child','completed')").run();
    f.item('child', { type: 'userMessage', content: [{ type: 'text', text: 'INHERITED-PARENT-TEXT' }] }, 9);
    const messages = [];
    const candidate = discoverCodexSqliteSessions({ ...f.options, log: m => messages.push(m) }).find(c => c.nativeSessionId === 'child');
    const outcome = candidate.capture({ deadlineAt: Date.now() + 3000 });
    assert.equal(outcome.written, false);
    assert.match(outcome.skip, /child task unavailable/);
    assert.ok(messages.some(m => /child task unavailable/.test(m)));
    assert.deepEqual(fs.readdirSync(f.vaultRoot), []);
  } finally { f.close(); }
});

test('actual SessionEnd can finalize the current SQLite snapshot without using stale rollout data', () => {
  const f = fixture();
  try {
    mainItems(f);
    const outcome = captureCodexSqliteSession({ ...f.options, sessionId: 'main', endReason: 'other', deadlineAt: Date.now() + 3000 });
    assert.equal(outcome.written, true);
    assert.equal(parseFrontmatter(fs.readFileSync(outcome.notePath, 'utf8')).fields.status, 'concluded');
  } finally { f.close(); }
});

test('unknown subagent source without verifiable parent task never reads inherited user items', () => {
  const f = fixture();
  try {
    f.thread('unknown-worker', { source: JSON.stringify({ subagent: { other: 'unknown-worker' } }) });
    f.item('unknown-worker', { type: 'userMessage' }, 1, { raw: 'must never parse inherited content' });
    const candidate = discoverCodexSqliteSessions(f.options)[0];
    const outcome = candidate.capture({ deadlineAt: Date.now() + 3000 });
    assert.equal(outcome.written, false);
    assert.match(outcome.skip, /child task unavailable/);
  } finally { f.close(); }
});

test('native guardian observer role is excluded before JSON without excluding its parent', () => {
  const f = fixture();
  try {
    mainItems(f, 'parent');
    f.thread('guardian', { source: JSON.stringify({ subagent: { other: 'guardian' } }) });
    f.state.prepare("INSERT INTO thread_spawn_edges VALUES ('parent','guardian','completed')").run();
    f.item('guardian', { type: 'userMessage' }, 9, { raw: 'observer inherited history must never be read' });
    const openDatabase = (file, options) => {
      const db = new DatabaseSync(file, options);
      return { close: () => db.close(), prepare(sql) {
        assert.ok(!/item_json/.test(sql), 'guardian discovery must remain content-free');
        return db.prepare(sql);
      } };
    };
    const candidates = discoverCodexSqliteSessions({ ...f.options, openDatabase });
    assert.deepEqual(candidates.map(c => c.nativeSessionId), ['parent']);
    assert.ok(candidates.authoritativeIds.has('guardian'));
    const observer = captureCodexSqliteSession({ ...f.options, sessionId: 'guardian' });
    assert.equal(observer.action, 'excluded');
    const parent = captureCodexSqliteSession({ ...f.options, sessionId: 'parent', deadlineAt: Date.now() + 3000 });
    assert.equal(parent.written, true, 'observer purpose must not taint its parent');
  } finally { f.close(); }
});

test('ancestor exclusions block a grandchild before any item JSON read', () => {
  const f = fixture();
  try {
    for (const id of ['grandparent', 'parent', 'child']) f.thread(id);
    f.state.prepare("INSERT INTO thread_spawn_edges VALUES ('grandparent','parent','completed'),('parent','child','completed')").run();
    const first = discoverCodexSqliteSessions(f.options).find(c => c.nativeSessionId === 'child');
    assert.deepEqual(first.input.ancestorSessions, ['parent', 'grandparent']);
    const env = { ...f.env, HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([f.cwd]) };
    const openDatabase = (file, options) => {
      const db = new DatabaseSync(file, options);
      return { close: () => db.close(), prepare(sql) { assert.ok(!/item_json/.test(sql)); return db.prepare(sql); } };
    };
    const result = discoverCodexSqliteSessions({ ...f.options, env, openDatabase });
    assert.equal(result.length, 0);
    assert.equal(result.authoritativeIds.size, 3);
  } finally { f.close(); }
});

test('only missing or nonpaginated threads return null; native schema failure cannot fall back', () => {
  const f = fixture();
  try {
    f.thread('legacy', { historyMode: 'legacy' });
    assert.equal(captureCodexSqliteSession({ ...f.options, sessionId: 'legacy' }), null);
    assert.equal(captureCodexSqliteSession({ ...f.options, sessionId: 'unknown' }), null);
    f.thread('native');
    const excluded = captureCodexSqliteSession({ ...f.options, sessionId: 'native', env: { ...f.env, HARNESS_MEMORY_PERSISTENCE: 'off' } });
    assert.equal(excluded.action, 'excluded');
    f.history.exec('DROP TABLE thread_items');
    assert.throws(() => discoverCodexSqliteSessions(f.options), /capability unavailable/);
  } finally { f.close(); }
});

test('native MCP retrieval keeps result identities without copying returned content', () => {
  const f = fixture();
  try {
    mainItems(f);
    const result = fs.readFileSync(new URL('./fixtures/rag-results/search-one.txt', import.meta.url), 'utf8');
    f.item('main', { type: 'mcpToolCall', id: 'rag-call', server: 'rag', tool: 'search_context',
      arguments: { query: 'ledger invariants' }, result: { content: [{ type: 'text', text: result }] } }, 8);
    const captured = discoverCodexSqliteSessions(f.options)[0].capture({ deadlineAt: Date.now() + 3000 });
    const raw = fs.readFileSync(captured.notePath, 'utf8');
    const fields = parseFrontmatter(raw).fields;
    assert.equal(fields.retrievals.length, 1);
    assert.equal(fields.retrievals[0].query, 'ledger invariants');
    assert.ok(!raw.includes('The ledger emits cash and wager events'));
  } finally { f.close(); }
});

test('large irrelevant native tool output is projected away before the capture budget', () => {
  const f = fixture();
  try {
    mainItems(f);
    f.item('main', { type: 'commandExecution', command: 'git diff --stat', cwd: f.cwd,
      aggregatedOutput: 'irrelevant-output'.repeat(1100000) }, 8);
    const result = discoverCodexSqliteSessions(f.options)[0].capture({ deadlineAt: Date.now() + 3000 });
    assert.equal(result.written, true);
    const raw = fs.readFileSync(result.notePath, 'utf8');
    assert.match(raw, /git diff --stat/);
    assert.ok(!raw.includes('irrelevant-output'));
  } finally { f.close(); }
});

test('native image paths participate in protected-path exclusion', () => {
  const f = fixture();
  try {
    mainItems(f);
    f.item('main', { type: 'imageView', path: path.join(f.cwd, 'private', 'image.png') }, 8);
    const env = { ...f.env, HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([path.join(f.cwd, 'private')]) };
    const result = discoverCodexSqliteSessions({ ...f.options, env })[0].capture({ deadlineAt: Date.now() + 3000 });
    assert.equal(result.action, 'excluded');
    assert.deepEqual(fs.readdirSync(f.vaultRoot), []);
  } finally { f.close(); }
});

test('parent-first capture preflights descendant paths before reading or writing parent content', () => {
  const f = fixture();
  try {
    mainItems(f, 'parent');
    f.thread('child'); f.turn('child');
    f.state.prepare("INSERT INTO thread_spawn_edges VALUES ('parent','child','completed')").run();
    f.item('child', { type: 'imageView', path: path.join(f.cwd, 'private', 'input.png') }, 9);
    const env = { ...f.env, HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([path.join(f.cwd, 'private')]) };
    const openDatabase = (file, options) => {
      const db = new DatabaseSync(file, options);
      return { close: () => db.close(), prepare(sql) {
        assert.ok(!/AS item_json/.test(sql), 'no body projection before descendant exclusion');
        return db.prepare(sql);
      } };
    };
    const candidate = discoverCodexSqliteSessions({ ...f.options, env, openDatabase }).find(c => c.nativeSessionId === 'parent');
    const result = candidate.capture({ deadlineAt: Date.now() + 3000 });
    assert.equal(result.action, 'excluded');
    assert.deepEqual(fs.readdirSync(f.vaultRoot), []);
    assert.equal(fs.existsSync(path.join(f.home, 'state', 'memory-ingest-queue.jsonl')), false);
    const direct = captureCodexSqliteSession({ ...f.options, env, sessionId: 'parent', endReason: 'other', deadlineAt: Date.now() + 3000 });
    assert.equal(direct.action, 'excluded', 'SessionEnd cannot bypass descendant preflight');
  } finally { f.close(); }
});

for (const kind of ['localImage', 'fileChange', 'commandRead', 'commandCwd', 'mcpPath']) {
  test(`descendant ${kind} path activity blocks direct parent SessionEnd without body export`, () => {
    const f = fixture();
    try {
      mainItems(f, 'parent'); f.thread('middle'); f.thread('child');
      f.state.prepare("INSERT INTO thread_spawn_edges VALUES ('parent','middle','completed'),('middle','child','completed')").run();
      const privateRoot = path.join(f.cwd, 'private');
      const file = path.join(privateRoot, 'secret.txt');
      const value = {
        localImage: { type: 'userMessage', content: [{ type: 'text', text: 'DO-NOT-EXPORT-DESCENDANT-TEXT' }, { type: 'localImage', path: file }] },
        fileChange: { type: 'fileChange', changes: [{ path: file, diff: 'DO-NOT-EXPORT-DIFF' }] },
        commandRead: { type: 'commandExecution', cwd: f.cwd, command: 'DO-NOT-EXPORT-COMMAND', commandActions: [{ type: 'read', path: 'private/secret.txt' }] },
        commandCwd: { type: 'commandExecution', cwd: privateRoot, command: 'DO-NOT-EXPORT-COMMAND', commandActions: [] },
        mcpPath: { type: 'mcpToolCall', server: 'files', tool: 'read', arguments: { nested: { file_path: file } }, result: 'DO-NOT-EXPORT-RESULT' },
      }[kind];
      f.item('child', value, 10);
      const env = { ...f.env, HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([privateRoot]) };
      const result = captureCodexSqliteSession({ ...f.options, env, sessionId: 'parent', endReason: 'other', deadlineAt: Date.now() + 3000 });
      assert.equal(result.action, 'excluded');
      assert.deepEqual(fs.readdirSync(f.vaultRoot), []);
    } finally { f.close(); }
  });
}

test('capture snapshot cannot include a parent result appended after descendant preflight', () => {
  const f = fixture();
  try {
    f.history.exec('PRAGMA journal_mode=WAL');
    mainItems(f, 'parent'); f.thread('child');
    f.state.prepare("INSERT INTO thread_spawn_edges VALUES ('parent','child','completed')").run();
    let appended = false;
    const openDatabase = (file, options) => {
      const db = new DatabaseSync(file, options);
      return { close: () => db.close(), prepare(sql) {
        if (/AS item_json/.test(sql) && !appended) {
          appended = true;
          f.item('child', { type: 'imageView', path: path.join(f.cwd, 'private', 'late.png') }, 10);
          f.item('parent', { type: 'agentMessage', text: 'MUST-NOT-EXPORT-LATE-RESULT', phase: 'final_answer' }, 11);
        }
        return db.prepare(sql);
      } };
    };
    const env = { ...f.env, HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([path.join(f.cwd, 'private')]) };
    const result = captureCodexSqliteSession({ ...f.options, env, openDatabase, sessionId: 'parent', deadlineAt: Date.now() + 3000 });
    assert.equal(result.written, true);
    assert.ok(!fs.readFileSync(result.notePath, 'utf8').includes('MUST-NOT-EXPORT-LATE-RESULT'));
    assert.equal(captureCodexSqliteSession({ ...f.options, env, sessionId: 'parent', deadlineAt: Date.now() + 3000 }).action, 'excluded');
  } finally { f.close(); }
});

test('capture refreshes newly discovered descendants before loading parent content', () => {
  const f = fixture();
  try {
    mainItems(f, 'parent');
    const env = { ...f.env, HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([path.join(f.cwd, 'private')]) };
    const candidate = discoverCodexSqliteSessions({ ...f.options, env })[0];
    f.thread('late-child');
    f.state.prepare("INSERT INTO thread_spawn_edges VALUES ('parent','late-child','completed')").run();
    f.item('late-child', { type: 'imageView', path: path.join(f.cwd, 'private', 'late.png') }, 9);
    f.item('parent', { type: 'agentMessage', text: 'MUST-NOT-EXPORT-LATE-CHILD-RESULT', phase: 'final_answer' }, 10);
    const result = candidate.capture({ deadlineAt: Date.now() + 3000 });
    assert.equal(result.action, 'excluded');
    assert.deepEqual(fs.readdirSync(f.vaultRoot), []);
  } finally { f.close(); }
});

for (const kind of ['commandRead', 'nestedMcpPath']) {
  test(`root ${kind} structured path is checked before body projection`, () => {
    const f = fixture();
    try {
      mainItems(f);
      const privateRoot = path.join(f.cwd, 'private');
      const value = kind === 'commandRead'
        ? { type: 'commandExecution', cwd: f.cwd, command: 'DO-NOT-EXPORT-READ', commandActions: [{ type: 'read', path: 'private/input.txt' }] }
        : { type: 'mcpToolCall', server: 'files', tool: 'read', arguments: { request: { notebook_path: path.join(privateRoot, 'input.ipynb') } }, result: 'DO-NOT-EXPORT-RESULT' };
      f.item('main', value, 9);
      const env = { ...f.env, HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([privateRoot]) };
      const openDatabase = (file, options) => {
        const db = new DatabaseSync(file, options);
        return { close: () => db.close(), prepare(sql) {
          assert.ok(!/AS item_json/.test(sql), 'protected structured path must be checked before body projection');
          return db.prepare(sql);
        } };
      };
      const result = captureCodexSqliteSession({ ...f.options, env, openDatabase, sessionId: 'main', endReason: 'other', deadlineAt: Date.now() + 3000 });
      assert.equal(result.action, 'excluded');
      assert.deepEqual(fs.readdirSync(f.vaultRoot), []);
    } finally { f.close(); }
  });
}

test('child own-thread path preflight does not inspect inherited userMessage images', () => {
  const f = fixture();
  try {
    mainItems(f, 'parent'); f.thread('child'); f.turn('child');
    f.state.prepare("INSERT INTO thread_spawn_edges VALUES ('parent','child','completed')").run();
    f.item('parent', { type: 'collabAgentToolCall', tool: 'spawnAgent', prompt: 'Check the public source files.', receiverThreadIds: ['child'] }, 9);
    f.item('child', { type: 'userMessage' }, 10, { raw: 'inherited userMessage must not be parsed for paths or text' });
    f.item('child', { type: 'agentMessage', text: 'Public files verified.', phase: 'final_answer' }, 11);
    const result = captureCodexSqliteSession({ ...f.options, sessionId: 'child', deadlineAt: Date.now() + 3000 });
    assert.equal(result.written, true);
    assert.match(fs.readFileSync(result.notePath, 'utf8'), /Public files verified/);
  } finally { f.close(); }
});
