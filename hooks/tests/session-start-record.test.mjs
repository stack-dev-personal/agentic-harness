/**
 * SC-2, the writing side: the SessionStart hook's record of what its brief
 * injected. Written atomically, only for a UUID session id, in exactly the
 * shape unit P's reader accepts — the round trip below is the contract.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_EXTERNAL_ID_CHARS,
  MAX_EXTERNAL_IDS,
  readSessionStartRecord,
  writeSessionStartRecord,
} from '../lib/session-start.mjs';

const SESSION = '1a2b3c4d-0000-4111-8111-222233334444';
const AT = '2026-09-27T14:03:11.000Z';

function tempState(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateDir: path.join(root, 'state', 'session-start') };
}

function input(overrides = {}) {
  return {
    at: AT,
    sessionId: SESSION,
    cwd: 'C:/Users/estac/agentic-harness',
    realm: 'harness',
    collection: 'agentic-harness',
    source: 'outcomes',
    externalIds: ['session-aaaa', 'session-bbbb'],
    tokens: 812,
    ...overrides,
  };
}

test('writes exactly the SC-2 keys to <stateDir>/<session_id>.json, creating the folder', (t) => {
  const { stateDir } = tempState(t);
  const written = writeSessionStartRecord({ record: input(), stateDir });
  assert.equal(written.ok, true, written.reason);
  assert.equal(written.path, path.join(stateDir, `${SESSION}.json`));

  const raw = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  assert.deepEqual(raw, {
    at: AT,
    session_id: SESSION,
    cwd: 'C:/Users/estac/agentic-harness',
    realm: 'harness',
    collection: 'agentic-harness',
    collection_source: '',
    source: 'outcomes',
    external_ids: ['session-aaaa', 'session-bbbb'],
    tokens: 812,
  });
  assert.deepEqual(fs.readdirSync(stateDir), [`${SESSION}.json`], 'no temp file left behind');
});

test('collection_source keeps how the placement was decided, and only a known value', (t) => {
  const { stateDir } = tempState(t);
  for (const [given, kept] of [['git', 'git'], ['folder', 'folder'], ['guess', ''], [undefined, '']]) {
    const written = writeSessionStartRecord({ record: { ...input(), collectionSource: given }, stateDir });
    assert.equal(written.ok, true, written.reason);
    assert.equal(JSON.parse(fs.readFileSync(written.path, 'utf8')).collection_source, kept, String(given));
  }
});

test('round trip: what the writer writes, P\'s reader turns into one SC-1 entry', (t) => {
  const { stateDir } = tempState(t);
  assert.equal(writeSessionStartRecord({ record: input(), stateDir }).ok, true);

  const { record, reason } = readSessionStartRecord({ sessionId: SESSION, stateDir, env: {} });
  assert.equal(reason, 'ok');
  assert.deepEqual(record, {
    at: AT,
    channel: 'session-start',
    tool: 'session-start',
    query: '',
    filters: { source: 'outcomes', collection: 'agentic-harness', realm: 'harness', tokens: 812 },
    results: ['obsidian:session-aaaa', 'obsidian:session-bbbb'],
    chunks: [],
  });
});

test('round trip: an empty brief (source none) is still one entry with no results', (t) => {
  const { stateDir } = tempState(t);
  assert.equal(writeSessionStartRecord({ record: input({ source: 'none', externalIds: [], tokens: 0 }), stateDir }).ok, true);
  const { record } = readSessionStartRecord({ sessionId: SESSION, stateDir, env: {} });
  assert.deepEqual(record.results, []);
  assert.equal(record.filters.source, 'none');
  assert.equal(record.filters.tokens, 0);
});

test('a second write for the same session replaces the first (a resume re-briefs)', (t) => {
  const { stateDir } = tempState(t);
  writeSessionStartRecord({ record: input({ source: 'none', externalIds: [] }), stateDir });
  writeSessionStartRecord({ record: input({ source: 'status', externalIds: ['status-x'] }), stateDir });
  const raw = JSON.parse(fs.readFileSync(path.join(stateDir, `${SESSION}.json`), 'utf8'));
  assert.equal(raw.source, 'status');
  assert.deepEqual(fs.readdirSync(stateDir), [`${SESSION}.json`]);
});

test('a session id that is not a UUID is refused before any path is built', (t) => {
  const { stateDir } = tempState(t);
  for (const sessionId of ['../../evil', 'abc', '', null, `${SESSION}/x`, SESSION.toUpperCase()]) {
    const written = writeSessionStartRecord({ record: input({ sessionId }), stateDir });
    assert.equal(written.ok, false, String(sessionId));
    assert.equal(written.reason, 'bad session id');
  }
  assert.equal(fs.existsSync(stateDir), false, 'nothing was created');
});

test('fields the reader would reject are refused; ids are capped as the reader caps them', (t) => {
  const { stateDir } = tempState(t);
  assert.equal(writeSessionStartRecord({ record: input({ at: 'yesterday' }), stateDir }).reason, 'bad at');
  assert.equal(writeSessionStartRecord({ record: input({ source: 'guess' }), stateDir }).reason, 'bad source');
  assert.equal(writeSessionStartRecord({ record: input({ tokens: -1 }), stateDir }).reason, 'bad tokens');
  assert.equal(writeSessionStartRecord({ record: input({ externalIds: 'x' }), stateDir }).reason, 'bad external_ids');

  const many = Array.from({ length: MAX_EXTERNAL_IDS + 10 }, (_, i) => `session-${i}`);
  const long = 'x'.repeat(MAX_EXTERNAL_ID_CHARS + 1);
  const written = writeSessionStartRecord({ record: input({ externalIds: [long, 7, '', ...many] }), stateDir });
  assert.equal(written.ok, true);
  const raw = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  assert.equal(raw.external_ids.length, MAX_EXTERNAL_IDS);
  assert.equal(raw.external_ids[0], 'session-0', 'non-strings, empties and over-long ids dropped');
});

test('a state dir that cannot be created is a reason, never a throw', (t) => {
  const { root } = tempState(t);
  const blocker = path.join(root, 'a-file');
  fs.writeFileSync(blocker, 'x');
  const written = writeSessionStartRecord({ record: input(), stateDir: path.join(blocker, 'session-start') });
  assert.equal(written.ok, false);
  assert.match(written.reason, /^write failed/);
});
