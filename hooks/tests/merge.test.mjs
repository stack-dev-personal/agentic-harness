/**
 * Merge semantics, as units.
 *
 * `resume.test.mjs` proves the behaviour end to end through the vault; this
 * file pins the rules themselves, so a failure says which rule broke rather
 * than which fixture changed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MAX_RETRIEVALS, MAX_RETRIEVED } from '../lib/constants.mjs';
import { parseFrontmatter, serializeFrontmatter } from '../lib/frontmatter.mjs';
import {
  ACTION_CREATE,
  ACTION_MERGE,
  ACTION_NOOP,
  ACTION_RESUME,
  hasNewActivity,
  markSuperseded,
  mergeFields,
  mergeTags,
  planWrite,
  statusRank,
} from '../lib/merge.mjs';
import { GOLDEN_DIR } from './helpers/sandbox.mjs';

const BASE = Object.freeze({
  id: 'session-abc',
  status: 'active',
  ended_at: '2026-09-13T10:30:00.000Z',
  prompt_count: 1,
  command_count: 2,
  tags: ['docs'],
  commits: ['aaaaaaaaaaaa'],
  prs: [6],
  repo: 'emstacho-su/agentic-harness',
  branch: 'feat/session-context',
  supersedes: [],
  files_modified: ['docs/ingestion.md'],
  tools_used: { Edit: 1 },
});

test('no existing note means create', () => {
  const plan = planWrite(null, { ...BASE });
  assert.equal(plan.action, ACTION_CREATE);
});

test('status ratchets forward and never back', () => {
  assert.equal(statusRank('active'), 0);
  assert.equal(statusRank('concluded'), 1);
  assert.equal(statusRank('superseded'), 2);
  assert.equal(statusRank('nonsense'), 0, 'an unknown status ranks lowest rather than throwing');

  const merged = mergeFields({ ...BASE, status: 'superseded' }, { ...BASE, status: 'active' });
  assert.equal(merged.status, 'superseded');
});

test('a stale SessionEnd over a settled note is a no-op', () => {
  const existing = { ...BASE, status: 'concluded' };
  const plan = planWrite(existing, { ...BASE, status: 'concluded' });
  assert.equal(plan.action, ACTION_NOOP);
});

test('new activity over a settled note starts a resume note', () => {
  const existing = { ...BASE, status: 'concluded' };
  const next = { ...BASE, status: 'concluded', ended_at: '2026-09-14T11:40:00.000Z', prompt_count: 2 };
  const plan = planWrite(existing, next);

  assert.equal(plan.action, ACTION_RESUME);
  assert.equal(plan.fields.resumed_from, 'session-abc');
  assert.deepEqual(plan.fields.supersedes, ['session-abc']);
});

test('a resume note inherits the chain it continues', () => {
  const existing = { ...BASE, id: 'session-abc-r2', status: 'concluded', supersedes: ['session-abc'] };
  const next = { ...BASE, ended_at: '2026-09-15T09:00:00.000Z', status: 'concluded' };
  const plan = planWrite(existing, next);
  assert.deepEqual(plan.fields.supersedes, ['session-abc-r2', 'session-abc']);
});

test('new activity is ended_at first, prompt count as the tie-break', () => {
  assert.equal(hasNewActivity(BASE, { ...BASE, ended_at: '2026-09-14T00:00:00.000Z' }), true);
  assert.equal(hasNewActivity(BASE, { ...BASE }), false);
  assert.equal(hasNewActivity(BASE, { ...BASE, prompt_count: 2 }), true);
  assert.equal(hasNewActivity(BASE, { ...BASE, ended_at: '2026-09-01T00:00:00.000Z' }), false);
});

test('lists grow and never shrink', () => {
  const merged = mergeFields(BASE, {
    ...BASE,
    commits: ['bbbbbbbbbbbb'],
    prs: [12],
    files_modified: ['docs/tags.md'],
  });
  assert.deepEqual(merged.commits, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.deepEqual(merged.prs, [6, 12]);
  assert.deepEqual(merged.files_modified, ['docs/ingestion.md', 'docs/tags.md']);
});

test('a derived scalar replaces an empty one but never the reverse', () => {
  const filled = mergeFields({ ...BASE, branch: '' }, { ...BASE, branch: 'feat/x' });
  assert.equal(filled.branch, 'feat/x');

  const kept = mergeFields({ ...BASE, branch: 'feat/x' }, { ...BASE, branch: '' });
  assert.equal(kept.branch, 'feat/x', 'a failed derivation must not erase a good value');
});

test('counters take the larger of the two', () => {
  const merged = mergeFields({ ...BASE, prompt_count: 9 }, { ...BASE, prompt_count: 2 });
  assert.equal(merged.prompt_count, 9);
});

test('a manual tag survives, and unclassified yields to any real tag', () => {
  assert.deepEqual(mergeTags(['needs-followup'], ['db']), ['needs-followup', 'db']);
  assert.deepEqual(mergeTags(['unclassified'], ['db']), ['db']);
  assert.deepEqual(mergeTags(['needs-followup'], ['unclassified']), ['needs-followup']);
  assert.deepEqual(mergeTags(['unclassified'], ['unclassified']), ['unclassified']);
  assert.deepEqual(mergeTags([], []), ['unclassified']);
  assert.deepEqual(mergeTags(['db'], ['db']), ['db'], 'no duplicates');
});

test('hand tags are uncapped: the cap applies to hook_tags, never to what Stack typed', () => {
  const hand = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.equal(mergeTags(hand, ['db']).length, 9, 'eight hand tags plus one hook tag');

  // The same nine through a merge: the old hook tag is replaced, the eight hand tags stay.
  const merged = mergeFields(
    { ...BASE, tags: [...hand, 'gui'], hook_tags: ['gui'] },
    { ...BASE, tags: ['db'], hook_tags: ['db'] },
  );
  assert.deepEqual(merged.tags, [...hand, 'db']);
  assert.deepEqual(merged.hook_tags, ['db']);
});

test('a merge returns a new object and leaves both inputs alone', () => {
  const existing = { ...BASE, tags: ['docs'] };
  const next = { ...BASE, tags: ['db'] };
  const merged = mergeFields(existing, next);
  assert.notEqual(merged, existing);
  assert.deepEqual(existing.tags, ['docs']);
  assert.deepEqual(next.tags, ['db']);
});

test('markSuperseded changes one field and copies the rest', () => {
  const flipped = markSuperseded(BASE);
  assert.equal(flipped.status, 'superseded');
  assert.equal(BASE.status, 'active');
  assert.equal(flipped.id, BASE.id);
});

test('an unknown field on the existing note is carried through the merge', () => {
  const merged = mergeFields({ ...BASE, reviewed_by: 'stack' }, { ...BASE });
  assert.equal(merged.reviewed_by, 'stack');
  assert.equal(planWrite({ ...BASE, reviewed_by: 'stack' }, { ...BASE }).action, ACTION_MERGE);
});

// ------------------------------------------------ retrieval records (SC-1)

function record(n, extra = {}) {
  return {
    at: `2026-09-24T14:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z`,
    channel: 'tool',
    tool: 'search_context',
    query: `query ${n}`,
    filters: { collection: 'agentic-harness', limit: 10 },
    results: [`obsidian:session-${n}@0.8123`],
    chunks: [`${n}/1@0.016393`],
    ...extra,
  };
}

test('retrievals merge as a union, existing first, deduped by content', () => {
  const merged = mergeFields(
    { ...BASE, retrievals: [record(1), record(2)] },
    { ...BASE, retrievals: [record(2), record(3)] },
  );
  assert.deepEqual(merged.retrievals, [record(1), record(2), record(3)]);
});

test('record identity ignores key order, nested key order included', () => {
  const reordered = Object.fromEntries(Object.entries(record(1)).reverse());
  reordered.filters = { limit: 10, collection: 'agentic-harness' };
  const merged = mergeFields({ ...BASE, retrievals: [record(1)] }, { ...BASE, retrievals: [reordered] });
  assert.equal(merged.retrievals.length, 1);
});

test('a record that differs in any value is a different record', () => {
  const merged = mergeFields(
    { ...BASE, retrievals: [record(1)] },
    { ...BASE, retrievals: [record(1, { results: ['obsidian:session-1@0.9000'] })] },
  );
  assert.equal(merged.retrievals.length, 2);
});

test('a record is compared as it will read back, so a re-merge adds nothing', () => {
  // A query with a line break is written on one line; the copy read back from
  // disk must still match the fresh copy the next capture derives.
  const fresh = record(1, { query: 'line one\nline two' });
  const first = mergeFields({ ...BASE }, { ...BASE, retrievals: [fresh] });
  const again = mergeFields(first, { ...BASE, retrievals: [fresh] });
  assert.equal(again.retrievals.length, 1);
  assert.equal(again.retrievals[0].query, 'line one line two');
});

test('retrievals are capped at MAX_RETRIEVALS, earliest kept', () => {
  const existing = Array.from({ length: 70 }, (_, i) => record(i));
  const next = Array.from({ length: 70 }, (_, i) => record(i + 70));
  const merged = mergeFields({ ...BASE, retrievals: existing }, { ...BASE, retrievals: next });
  assert.equal(MAX_RETRIEVALS, 100);
  assert.equal(merged.retrievals.length, MAX_RETRIEVALS);
  assert.deepEqual(merged.retrievals[0], record(0));
  assert.deepEqual(merged.retrievals.at(-1), record(99));
});

test('an unknown key inside a record survives the merge', () => {
  const annotated = record(1, { reviewed_by: 'stack' });
  const merged = mergeFields({ ...BASE, retrievals: [annotated] }, { ...BASE, retrievals: [record(2)] });
  assert.equal(merged.retrievals[0].reviewed_by, 'stack');
  assert.equal(merged.retrievals.length, 2);
});

test('retrieved is a list capped at MAX_RETRIEVED', () => {
  const links = (from, count) => Array.from({ length: count }, (_, i) => `[[projects/x/sessions/${from + i}]]`);
  const merged = mergeFields({ ...BASE, retrieved: links(0, 15) }, { ...BASE, retrieved: [...links(10, 15)] });
  assert.equal(MAX_RETRIEVED, 20);
  assert.equal(merged.retrieved.length, MAX_RETRIEVED);
  assert.equal(merged.retrieved[0], '[[projects/x/sessions/0]]');
  assert.equal(merged.retrieved.at(-1), '[[projects/x/sessions/19]]');
});

test('a note written before retrievals existed merges cleanly and gains empty lists', () => {
  const golden = fs.readFileSync(path.join(GOLDEN_DIR, 'plain-main.md'), 'utf8');
  // The same note as GENERATOR 2.2.0 wrote it: no retrieval keys at all, and no
  // hook_tags (2.4.0), whose items run from its key to the closing `---`.
  const old = golden
    .replace(/\nhook_tags:(?: \[\])?\n(?: {2}- .*\n)*/, '\n')
    .split('\n')
    .filter((line) => !/^(retrievals|retrieved|runtime|provider|model):/.test(line))
    .join('\n')
    .replace(/session-capture\.mjs \d+\.\d+\.\d+/, 'session-capture.mjs 2.2.0');
  const parsed = parseFrontmatter(old);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal('retrievals' in parsed.fields, false);
  assert.equal('hook_tags' in parsed.fields, false);

  const next = { ...parsed.fields, generator: 'session-capture.mjs 2.3.0', retrievals: [], retrieved: [] };
  const merged = mergeFields(parsed.fields, next);
  assert.deepEqual(merged.retrievals, []);
  assert.deepEqual(merged.retrieved, []);
  assert.deepEqual(merged.hook_tags, [], 'a note without hook_tags gains an empty list');
  assert.deepEqual(merged.tags, parsed.fields.tags, 'and keeps every tag, all of them hand tags now');

  const text = serializeFrontmatter(merged);
  assert.ok(text.includes('\nretrievals: []\nretrieved: []\nhook_tags: []\n---'), 'appended after machine, in order');
  const round = parseFrontmatter(`${text}\n${parsed.body}`);
  assert.equal(round.ok, true, round.error);
  assert.deepEqual(round.fields, merged);
});
