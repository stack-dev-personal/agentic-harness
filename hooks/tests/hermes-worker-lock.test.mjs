import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { discoverMemorySessions } from '../memory-worker.mjs';
import { checkpointSessions } from '../lib/memory-checkpoints.mjs';
import { acquireRealmLock, lockPathFor, releaseRealmLock } from '../lib/realm-lock.mjs';

test('Hermes recovery defers before native content reads and does not checkpoint a held realm', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-worker-lock-'));
  let held;
  try {
    const vaultRoot = path.join(root, 'vault');
    const realm = path.join(vaultRoot, 'projects');
    const hermesHome = path.join(root, 'hermes');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(path.join(realm, '.git'), { recursive: true });
    fs.writeFileSync(path.join(realm, '.realm'), 'projects\n');
    fs.mkdirSync(path.join(hermesHome, 'state'), { recursive: true });
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(hermesHome, 'state', 'harness-memory-sessions.json'),
      JSON.stringify({ sessions: { s1: { cwd: root, registered_at: 100 } } }));
    const db = new DatabaseSync(path.join(hermesHome, 'state.db'));
    db.exec('CREATE TABLE sessions (id TEXT, cwd TEXT, model TEXT, parent_session_id TEXT, started_at REAL, ended_at REAL); CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, timestamp REAL);');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('s1', root, 'm', null, 110, null);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(1, 's1', 'user', 'Verify serialized capture.', null, 111);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(2, 's1', 'assistant', 'The shared realm lock protects note updates.', null, 112);
    db.close();
    const env = { USERPROFILE: root, HARNESS_HERMES_HOME: hermesHome, HARNESS_VAULT: vaultRoot };
    const discovered = await discoverMemorySessions({ home: root, vaultRoot, stateDir, env, preview: true, log: () => {} });
    const candidates = discovered.filter(candidate => candidate.runtime === 'hermes');
    assert.equal(candidates.length, 1);
    let contentReads = 0;
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
      if (/SELECT (?:role|content)/i.test(sql)) {
        contentReads++;
        assert.equal(fs.existsSync(lockPathFor(realm)), true, 'native snapshot reads are serialized with note writes');
      }
      return prepare.call(this, sql);
    });
    held = acquireRealmLock(realm, { owner: 'live Hermes callback' });
    assert.equal(held.ok, true);
    const deferred = checkpointSessions({ candidates, vaultRoot, stateDir });
    assert.equal(deferred.deferred, 1);
    assert.deepEqual(deferred.checkpoints, {});
    assert.equal(contentReads, 0);
    assert.equal(deferred.touchedPaths.length, 0);
    releaseRealmLock(held);
    held = null;
    const retried = checkpointSessions({ candidates, vaultRoot, stateDir });
    assert.equal(retried.written, 1);
    assert.ok(contentReads > 0);
    assert.ok(retried.checkpoints['hermes:hermes-s1']);
    assert.equal(fs.existsSync(lockPathFor(realm)), false);
  } finally {
    if (held) releaseRealmLock(held);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
