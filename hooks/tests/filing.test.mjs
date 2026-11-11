/**
 * Where a captured session is filed when the checkout that would name it is
 * out of reach (Phase 2 of the jobs container move), and on the host alike.
 *
 * Order: an existing note for the session anywhere in the vault; the
 * session-start record; the same two for the parent and older ancestors; the
 * routing rules on the path text. One session id in two folders is refused.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureSession } from '../lib/capture.mjs';
import { FilingConflictError, fileSession } from '../lib/filing.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { readSessionStartPlacement, writeSessionStartRecord } from '../lib/session-start.mjs';
import { collectionsHolding, createSandbox } from './helpers/sandbox.mjs';

const OWN = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const GRANDPARENT = '33333333-3333-4333-8333-333333333333';
const FLAVOR = Object.freeze({ HARNESS_HOST_PATH_FLAVOR: 'win32', HARNESS_HOST_HOME: 'C:/Users/alex',
  HARNESS_HOST_VAULT: 'C:/Users/alex/vault' });

function world() {
  const sandbox = createSandbox();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filing-state-'));
  return {
    ...sandbox,
    stateDir,
    // A folder the routing rules file under its own name: `projects/plain-folder`.
    plainCwd: path.join(sandbox.root, 'repos', 'plain-folder'),
    cleanup() { sandbox.cleanup(); fs.rmSync(stateDir, { recursive: true, force: true }); },
  };
}

function writeRecord(w, sessionId, fields) {
  const written = writeSessionStartRecord({ stateDir: w.stateDir, record: { at: '2026-11-11T10:00:00.000Z', sessionId,
    cwd: 'C:/Users/alex/projects/app', source: 'none', externalIds: [], tokens: 0, ...fields } });
  assert.ok(written.ok, written.reason);
}

function writeNoteAt(w, area, collection, sessionId, source = 'git') {
  const dir = path.join(w.vaultRoot, area, collection, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.md`), `---\nid: session-${sessionId}\ncollection: ${collection}\ncollection_source: ${source}\n---\n\nbody\n`);
}

const file = (w, extra = {}) => fileSession({ sessionId: OWN, cwd: w.plainCwd, vaultRoot: w.vaultRoot, stateDir: w.stateDir, holdsHarness: false, ...extra });
const where = (placed) => [placed.area, placed.collection, placed.collectionSource, placed.basis];

test('with no note and no record the routing rules place the session', () => {
  const w = world();
  try {
    assert.deepEqual(where(file(w)), ['projects', 'plain-folder', 'folder', 'rules']);
  } finally { w.cleanup(); }
});

test('the session-start record beats the rules, and keeps the source the host recorded', () => {
  const w = world();
  try {
    writeRecord(w, OWN, { realm: 'projects', collection: 'bb2dash', collectionSource: 'git' });
    assert.deepEqual(where(file(w)), ['projects', 'bb2dash', 'git', 'record']);
  } finally { w.cleanup(); }
});

test('a record from before collection_source was kept agrees with the rules or says folder', () => {
  const w = world();
  try {
    writeRecord(w, OWN, { realm: 'projects', collection: 'bb2dash' });
    assert.deepEqual(where(file(w)), ['projects', 'bb2dash', 'folder', 'record']);
    const agreeing = file(w, { cwd: path.join(w.root, 'repos', 'bb2dash') });
    assert.deepEqual(where(agreeing), ['projects', 'bb2dash', 'git', 'record'], 'the rules name the same folder');
  } finally { w.cleanup(); }
});

test('a record naming no usable folder is passed over', () => {
  const w = world();
  try {
    for (const [realm, collection] of [['nowhere', 'bb2dash'], ['projects', '..'], ['projects', 'a/b'], ['projects', 'Bad Name'], ['', '']]) {
      writeRecord(w, OWN, { realm, collection });
      assert.equal(file(w).basis, 'rules', `${realm}/${collection}`);
      assert.equal(readSessionStartPlacement({ sessionId: OWN, stateDir: w.stateDir }), null);
    }
  } finally { w.cleanup(); }
});

test('an existing note anywhere in the vault beats the record and the rules', () => {
  const w = world();
  try {
    writeRecord(w, OWN, { realm: 'projects', collection: 'bb2dash', collectionSource: 'git' });
    writeNoteAt(w, 'classes', 'ist323', OWN, 'folder');
    assert.deepEqual(where(file(w)), ['classes', 'ist323', 'folder', 'note']);
  } finally { w.cleanup(); }
});

test('one session id with notes in two folders is refused, naming both', () => {
  const w = world();
  try {
    writeNoteAt(w, 'projects', 'bb2dash', OWN);
    writeNoteAt(w, 'classes', 'ist323', OWN);
    assert.throws(() => file(w), (error) => error instanceof FilingConflictError
      && /classes\/ist323/.test(error.message) && /projects\/bb2dash/.test(error.message));
  } finally { w.cleanup(); }
});

test('a delegated session files with its parent: note first, then the parent record, then older ancestors', () => {
  const w = world();
  try {
    const ancestors = [{ sessionId: `codex-${PARENT}`, briefSessionId: PARENT }, { sessionId: `codex-${GRANDPARENT}`, briefSessionId: GRANDPARENT }];
    const child = () => file(w, { sessionId: `codex-${OWN}`, briefSessionId: OWN, ancestors });
    writeRecord(w, GRANDPARENT, { realm: 'classes', collection: 'ist323', collectionSource: 'folder' });
    assert.deepEqual(where(child()), ['classes', 'ist323', 'folder', 'parent']);
    writeRecord(w, PARENT, { realm: 'projects', collection: 'agentic-harness', collectionSource: 'git' });
    assert.deepEqual(where(child()), ['projects', 'agentic-harness', 'git', 'parent']);
    writeNoteAt(w, 'projects', 'bb2dash', `codex-${PARENT}`);
    assert.deepEqual(where(child()), ['projects', 'bb2dash', 'git', 'parent']);
    writeRecord(w, OWN, { realm: 'projects', collection: 'plain-folder', collectionSource: 'folder' });
    assert.equal(child().basis, 'record', 'the session\'s own record still comes first');
  } finally { w.cleanup(); }
});

test('in the container a Windows session lands where the host record put it, with no repository read', () => {
  const w = world();
  try {
    writeRecord(w, OWN, { realm: 'projects', collection: 'bb2dash', collectionSource: 'git' });
    const refuse = () => { throw new Error('repository lookup under a flavor'); };
    const placed = file(w, { cwd: 'C:\\Users\\alex\\projects\\bb2dash-wt-x', env: FLAVOR, resolveRepoFor: refuse });
    assert.deepEqual(where(placed), ['projects', 'bb2dash', 'git', 'record']);
    assert.equal(placed.repo.repoFullName, '');
  } finally { w.cleanup(); }
});

// ------------------------------------------------------- wired into capture

function captureWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filing-capture-'));
  const vaultRoot = path.join(root, 'vault');
  const cwd = path.join(root, 'demo');
  const stateDir = path.join(root, 'state', 'session-start');
  fs.mkdirSync(cwd);
  fs.mkdirSync(vaultRoot);
  const entries = [
    { type: 'user', timestamp: '2026-11-03T12:00:00Z', cwd, origin: { kind: 'human' }, message: { content: 'Remember the tested decision.' } },
    { type: 'assistant', timestamp: '2026-11-03T12:00:01Z', cwd, message: { content: [{ type: 'text', text: 'Use one shared store.' }] } },
  ];
  const run = (input, extra = {}) => captureSession({ vaultRoot, entries, stateDir, env: { USERPROFILE: root },
    input: { cwd, endReason: 'resume', ...input }, runGit: () => ({ status: 0, stdout: '' }), ...extra });
  return { root, vaultRoot, stateDir, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a session whose note was moved is merged where the note now is, never copied back', () => {
  const w = captureWorld();
  try {
    const first = w.run({ sessionId: OWN });
    assert.equal(first.written, true, first.skip);
    assert.deepEqual(collectionsHolding(w.vaultRoot, `${OWN}.md`), ['projects/demo']);
    const moved = path.join(w.vaultRoot, 'classes', 'ist323', 'sessions');
    fs.mkdirSync(moved, { recursive: true });
    fs.renameSync(first.notePath, path.join(moved, `${OWN}.md`));
    const again = w.run({ sessionId: OWN, endReason: 'clear' });
    assert.equal(again.written, true, again.skip);
    assert.deepEqual(collectionsHolding(w.vaultRoot, `${OWN}.md`), ['classes/ist323']);
  } finally { w.cleanup(); }
});

test('a new session is filed where its session-start record placed it', () => {
  const w = captureWorld();
  try {
    writeSessionStartRecord({ stateDir: w.stateDir, record: { at: '2026-11-03T11:59:00.000Z', sessionId: OWN, cwd: 'x',
      realm: 'classes', collection: 'ist323', collectionSource: 'folder', source: 'none', externalIds: [], tokens: 0 } });
    const result = w.run({ sessionId: OWN });
    assert.equal(result.written, true, result.skip);
    assert.deepEqual(collectionsHolding(w.vaultRoot, `${OWN}.md`), ['classes/ist323']);
  } finally { w.cleanup(); }
});

test('a session with notes in two folders is refused and nothing is written', () => {
  const w = captureWorld();
  try {
    for (const folder of ['projects/demo', 'classes/ist323']) {
      fs.mkdirSync(path.join(w.vaultRoot, folder, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(w.vaultRoot, folder, 'sessions', `${OWN}.md`), '---\nid: x\n---\n');
    }
    const result = w.run({ sessionId: OWN });
    assert.equal(result.written, false);
    assert.match(result.skip, /notes in 2 folders/);
  } finally { w.cleanup(); }
});

test('a delegated Codex thread files beside its parent: by the parent note, then by an ancestor record', () => {
  const w = captureWorld();
  try {
    const input = { sessionId: `codex-${OWN}`, parentSession: `codex-${PARENT}`, ancestorSessions: [PARENT, GRANDPARENT] };
    writeSessionStartRecord({ stateDir: w.stateDir, record: { at: '2026-11-03T11:59:00.000Z', sessionId: GRANDPARENT, cwd: 'x',
      realm: 'classes', collection: 'ist323', collectionSource: 'folder', source: 'none', externalIds: [], tokens: 0 } });
    const byAncestor = w.run(input, { runtime: 'codex', agent: 'codex', briefSessionId: OWN });
    assert.equal(byAncestor.written, true, byAncestor.skip);
    assert.deepEqual(collectionsHolding(w.vaultRoot, `codex-${OWN}.md`), ['classes/ist323']);

    // A second child of a parent that already has a note: the parent's note beats the older ancestor's record.
    const sibling = '44444444-4444-4444-8444-444444444444';
    const parentDir = path.join(w.vaultRoot, 'projects', 'bb2dash', 'sessions');
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(path.join(parentDir, `codex-${PARENT}.md`), '---\nid: session-codex-x\ncollection_source: git\n---\n');
    const byParent = w.run({ ...input, sessionId: `codex-${sibling}` }, { runtime: 'codex', agent: 'codex', briefSessionId: sibling });
    assert.equal(byParent.written, true, byParent.skip);
    assert.deepEqual(collectionsHolding(w.vaultRoot, `codex-${sibling}.md`), ['projects/bb2dash']);
    assert.equal(parseFrontmatter(fs.readFileSync(byParent.notePath, 'utf8')).fields.collection_source, 'git');
  } finally { w.cleanup(); }
});
