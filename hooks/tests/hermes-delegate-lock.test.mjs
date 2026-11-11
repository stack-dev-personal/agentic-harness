/**
 * A Hermes delegate is filed beside its parent (filing.mjs). The worker must
 * hold the realm lock of the parent's note too, not only its own cwd's.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { discoverMemorySessions } from '../memory-worker.mjs';
import { checkpointSessions } from '../lib/memory-checkpoints.mjs';
import { acquireRealmLock, releaseRealmLock } from '../lib/realm-lock.mjs';

function makeRealm(vaultRoot, area) {
  const root = path.join(vaultRoot, area);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.realm'), `${area}\n`);
  return root;
}

test('a Hermes delegate whose parent note is in a locked realm is deferred, not written there', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-delegate-lock-'));
  let held;
  try {
    const vaultRoot = path.join(root, 'vault');
    const hermesHome = path.join(root, 'hermes');
    const stateDir = path.join(root, 'state');
    const work = path.join(root, 'work');
    for (const dir of [path.join(hermesHome, 'state'), stateDir, work]) fs.mkdirSync(dir, { recursive: true });
    makeRealm(vaultRoot, 'projects');
    const classes = makeRealm(vaultRoot, 'classes');
    const parentNotes = path.join(classes, 'ist323', 'sessions');
    fs.mkdirSync(parentNotes, { recursive: true });
    fs.writeFileSync(path.join(parentNotes, 'hermes-p1.md'), '---\nid: session-hermes-p1\ncollection_source: folder\n---\n');
    fs.writeFileSync(path.join(hermesHome, 'state', 'harness-memory-sessions.json'),
      JSON.stringify({ sessions: { p1: { cwd: work, registered_at: 100 }, s1: { cwd: work, registered_at: 100 } } }));
    const db = new DatabaseSync(path.join(hermesHome, 'state.db'));
    db.exec('CREATE TABLE sessions (id TEXT, cwd TEXT, model TEXT, parent_session_id TEXT, started_at REAL, ended_at REAL); CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, timestamp REAL);');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('p1', work, 'm', null, 100, null);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('s1', work, 'm', 'p1', 110, null);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(1, 's1', 'user', 'Check the parser.', null, 111);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(2, 's1', 'assistant', 'The parser holds.', null, 112);
    db.close();
    const env = { USERPROFILE: root, HARNESS_HERMES_HOME: hermesHome, HARNESS_VAULT: vaultRoot, HARNESS_STATE_DIR: stateDir };
    const discovered = await discoverMemorySessions({ home: root, vaultRoot, stateDir, env, preview: true, log: () => {} });
    const child = discovered.filter((candidate) => candidate.sessionId === 'hermes-s1');
    assert.equal(child.length, 1);
    assert.equal(child[0].parentSession, 'hermes-p1');

    held = acquireRealmLock(classes, { owner: 'sync --push', pid: 4242 });
    assert.equal(held.ok, true);
    const deferred = checkpointSessions({ candidates: child, vaultRoot, stateDir });
    assert.equal(deferred.deferred, 1, 'the parent note\'s realm is held by someone else');
    assert.equal(deferred.written, 0);
    releaseRealmLock(held);
    held = null;
    const written = checkpointSessions({ candidates: child, vaultRoot, stateDir });
    assert.equal(written.written, 1);
    assert.ok(fs.existsSync(path.join(parentNotes, 'hermes-s1.md')), 'filed beside its parent');
  } finally {
    if (held) releaseRealmLock(held);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
