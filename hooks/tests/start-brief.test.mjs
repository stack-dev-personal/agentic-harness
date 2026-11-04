/**
 * R-H4: the SessionStart brief. Where a session is placed (the same rules as
 * capture), which source feeds the brief (status.md, else the last five main
 * sessions' outcomes, else nothing), the token budget, the pointer line, and
 * the deadline.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canonicalFixturePath } from './helpers/fixture-path.mjs';
import path from 'node:path';
import test from 'node:test';

import { encodeClaudeProjectName } from '../lib/claude-paths.mjs';
import {
  BRIEF_TOKEN_BUDGET,
  CHARS_PER_TOKEN,
  CUT_MARKER,
  MAX_OUTCOME_NOTES,
  buildStartBrief,
  estimateTokens,
  extractOutcomeSection,
  fitLines,
  isDeadlineError,
  pointerLine,
  splitFrontmatter,
} from '../lib/start-brief.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

const HARNESS = 'agentic-harness';

function withSandbox(t) {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  return sandbox;
}

/** Make `<vault>/harness` the harness realm and give it the harness collection folder. */
function addHarnessRealm(vaultRoot) {
  fs.mkdirSync(path.join(vaultRoot, 'harness', HARNESS, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'harness', '.realm'), 'harness\n', 'utf8');
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** A session note shaped like the ones capture writes. */
function writeSession(vaultRoot, { realm = 'harness', collection = HARNESS, name, id, startedAt, status = 'concluded', outcome, title }) {
  const dir = path.join(vaultRoot, realm, collection, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = [
    `id: ${quote(id)}`,
    `title: ${quote(title ?? `Session ${startedAt.slice(0, 10)} — ${collection}`)}`,
    'type: session',
    `collection: ${quote(collection)}`,
    `date: ${startedAt.slice(0, 10)}`,
    `started_at: ${quote(startedAt)}`,
    `status: ${quote(status)}`,
    'tags:',
    "  - 'harness'",
  ];
  const body = ['', `# ${title ?? id}`, '', '## What I asked for', '', '> do the thing', ''];
  if (outcome !== undefined) {
    body.push('## Outcome', '', "_The assistant's closing message, verbatim._", '', ...outcome.split('\n').map((l) => `> ${l}`), '');
  }
  body.push('## Session facts', '', '| Started | x |', '');
  fs.writeFileSync(path.join(dir, name ?? `${id.replace(/^session-/, '')}.md`), `---\n${frontmatter.join('\n')}\n---\n${body.join('\n')}`, 'utf8');
}

function writeStatus(vaultRoot, text, { realm = 'harness', collection = HARNESS } = {}) {
  const file = path.join(vaultRoot, realm, collection, 'status.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function brief(sandbox, cwd, extra = {}) {
  return buildStartBrief({
    cwd,
    vaultRoot: sandbox.vaultRoot,
    home: path.join(sandbox.root, 'home'),
    tmp: path.join(sandbox.root, 'tmp'),
    ...extra,
  });
}

// ------------------------------------------------------------------ helpers

test('estimateTokens is characters over CHARS_PER_TOKEN, rounded up', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('x'.repeat(35)), Math.ceil(35 / CHARS_PER_TOKEN));
  assert.equal(estimateTokens('x'), 1);
});

test('splitFrontmatter returns the body below the block, and refuses an unclosed block', () => {
  const ok = splitFrontmatter("---\nid: 'a'\ntype: status\n---\n\n# Status\nline\n");
  assert.equal(ok.ok, true);
  assert.equal(ok.fields.id, 'a');
  assert.equal(ok.fields.type, 'status');
  assert.equal(ok.body.trim(), '# Status\nline');

  const none = splitFrontmatter('# Just a body\n');
  assert.equal(none.ok, true);
  assert.deepEqual(none.fields, {});
  assert.equal(none.body, '# Just a body\n');

  assert.equal(splitFrontmatter('---\nid: a\nno close\n').ok, false);
});

test('splitFrontmatter reads quoted top-level scalars and ignores nested lines', () => {
  const parsed = splitFrontmatter("---\ntitle: 'It''s here'\nstatus: \"superseded\"\nretrievals:\n  - at: 'x'\n    status: 'nested'\n---\nbody");
  assert.equal(parsed.fields.title, "It's here");
  assert.equal(parsed.fields.status, 'superseded');
});

test('extractOutcomeSection takes the Outcome section and drops its caption', () => {
  const body = ['## What I asked for', '', '> x', '', '## Outcome', '', "_The assistant's closing message, verbatim._", '', '> Done.', '> Next: ship.', '', '## Session facts', '', '| a | b |'].join('\n');
  assert.equal(extractOutcomeSection(body), '> Done.\n> Next: ship.');
  assert.equal(extractOutcomeSection('## What I asked for\n\n> x\n'), '');
});

test('fitLines keeps whole lines, cuts an overflowing line on a word boundary, and says so', () => {
  const lines = ['alpha beta gamma', 'delta epsilon zeta eta theta iota kappa'];
  const whole = fitLines(lines, 1000);
  assert.deepEqual(whole, { lines, cut: false });

  const budget = estimateTokens('alpha beta gamma') + estimateTokens('delta epsilon zeta');
  const cut = fitLines(lines, budget);
  assert.equal(cut.cut, true);
  assert.equal(cut.lines[0], 'alpha beta gamma');
  assert.ok(cut.lines.length <= 2);
  if (cut.lines[1]) {
    assert.ok(lines[1].startsWith(cut.lines[1]), 'a prefix of the line');
    assert.match(lines[1].slice(cut.lines[1].length), /^\s/, 'cut at a space, never mid-word');
  }
});

test('pointerLine names the search_context filter', () => {
  assert.equal(pointerLine('bb2dash'), 'Search past work with mcp__rag__search_context and collection: "bb2dash".');
});

// ------------------------------------------------------------------ resolution

test('resolution: the harness repo goes to harness/agentic-harness once the realm exists', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  const result = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.equal(result.realm, 'harness');
  assert.equal(result.collection, HARNESS);
  assert.equal(result.known, true);
});

test('resolution: without the harness realm the harness repo stays in projects (today)', async (t) => {
  const sandbox = withSandbox(t);
  const result = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.equal(result.realm, 'projects');
  assert.equal(result.collection, HARNESS);
  assert.equal(result.known, true);
});

test('resolution: a class folder is classes/<course>', async (t) => {
  const sandbox = withSandbox(t);
  const result = await brief(sandbox, `${sandbox.root}/onedrive/.fall2026/ist323`);
  assert.equal(result.realm, 'classes');
  assert.equal(result.collection, 'ist323');
});

test('resolution: home is projects/estac when that folder exists, and gets no pointer when it does not', async (t) => {
  const sandbox = withSandbox(t);
  const home = `${sandbox.root}/users/estac`;
  fs.mkdirSync(home, { recursive: true });

  const unknown = await brief(sandbox, home, { home });
  assert.equal(unknown.collection, 'estac');
  assert.equal(unknown.known, false);
  assert.equal(unknown.source, 'none');
  assert.equal(unknown.text, '', 'no folder, no notes: nothing to point at');

  fs.mkdirSync(path.join(sandbox.vaultRoot, 'projects', 'estac', 'sessions'), { recursive: true });
  const known = await brief(sandbox, home, { home });
  assert.equal(known.realm, 'projects');
  assert.equal(known.collection, 'estac');
  assert.equal(known.known, true);
  assert.equal(known.source, 'none');
  assert.equal(known.text, pointerLine('estac'), 'the store may hold history the vault does not');
});

test('resolution: a scratchpad is decoded back to the repository it was made for', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  // Expanded, as Claude Code writes it: on a Windows CI runner os.tmpdir() is an 8.3 short
  // path (RUNNER~1), and an encoded name built from that matches no directory listing.
  const root = canonicalFixturePath(sandbox.root).replace(/\\/g, '/');
  const tmp = `${root}/tmp`;
  const encoded = encodeClaudeProjectName(`${root}/repos/agentic-harness`);
  const cwd = `${tmp}/claude/${encoded}/${uuid(9)}/scratchpad`;
  fs.mkdirSync(cwd, { recursive: true });
  const result = await brief(sandbox, cwd, { tmp });
  assert.equal(result.realm, 'harness');
  assert.equal(result.collection, HARNESS);
});

// ------------------------------------------------------------------ sources

test('status.md wins over outcomes: its body, not its frontmatter, and its id', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  writeSession(sandbox.vaultRoot, { id: `session-${uuid(1)}`, startedAt: '2026-09-20T10:00:00Z', outcome: 'OUTCOME-TEXT' });
  writeStatus(sandbox.vaultRoot, "---\nid: 'status-agentic-harness'\ntype: status\ncaptured_by: curator\n---\n\n# Status\n\n- R-H4 in progress\n");

  const result = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.equal(result.source, 'status');
  assert.deepEqual(result.externalIds, ['status-agentic-harness']);
  assert.match(result.text, /R-H4 in progress/);
  assert.doesNotMatch(result.text, /captured_by/);
  assert.doesNotMatch(result.text, /OUTCOME-TEXT/);
  assert.ok(result.text.endsWith(pointerLine(HARNESS)));
  assert.equal(result.tokens, estimateTokens(result.text));
});

test('a status.md without an id is named by its vault path, as ingest names it', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  writeStatus(sandbox.vaultRoot, '# Status\n\nall green\n');
  const result = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.equal(result.source, 'status');
  assert.deepEqual(result.externalIds, ['harness/agentic-harness/status.md']);
});

test('an empty or broken status.md falls back to outcomes', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  writeSession(sandbox.vaultRoot, { id: `session-${uuid(1)}`, startedAt: '2026-09-20T10:00:00Z', outcome: 'the outcome' });

  writeStatus(sandbox.vaultRoot, "---\nid: 's'\n---\n\n   \n");
  const empty = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.equal(empty.source, 'outcomes');

  writeStatus(sandbox.vaultRoot, "---\nid: 's'\nnever closed\n");
  const broken = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.equal(broken.source, 'outcomes');
  assert.ok(broken.notes.some((note) => /status/.test(note)), 'the reason is reported');
});

test('outcomes: the five newest main sessions with an outcome, newest first; workers and superseded notes skipped', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  const vault = sandbox.vaultRoot;
  for (let day = 1; day <= 7; day += 1) {
    writeSession(vault, { id: `session-${uuid(day)}`, startedAt: `2026-09-0${day}T10:00:00Z`, outcome: `outcome of day ${day}` });
  }
  // Newer than all of them, but not candidates.
  writeSession(vault, { id: `session-${uuid(1)}--abc123`, name: `${uuid(1)}--abc123.md`, startedAt: '2026-09-20T10:00:00Z', outcome: 'WORKER' });
  writeSession(vault, { id: `session-${uuid(20)}`, startedAt: '2026-09-21T10:00:00Z', status: 'superseded', outcome: 'SUPERSEDED' });
  writeSession(vault, { id: `session-${uuid(21)}`, startedAt: '2026-09-22T10:00:00Z' }); // no outcome
  // A resumed session's successor is a main session too.
  writeSession(vault, { id: `session-${uuid(20)}-r2`, name: `${uuid(20)}-r2.md`, startedAt: '2026-09-21T12:00:00Z', outcome: 'RESUMED' });

  const result = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.equal(result.source, 'outcomes');
  assert.equal(MAX_OUTCOME_NOTES, 5);
  assert.deepEqual(result.externalIds, [
    `session-${uuid(20)}-r2`,
    `session-${uuid(7)}`,
    `session-${uuid(6)}`,
    `session-${uuid(5)}`,
    `session-${uuid(4)}`,
  ]);
  assert.doesNotMatch(result.text, /WORKER|SUPERSEDED/);
  assert.ok(result.text.indexOf('RESUMED') < result.text.indexOf('outcome of day 7'), 'newest first');
  assert.doesNotMatch(result.text, /outcome of day 3/);
  assert.doesNotMatch(result.text, /closing message, verbatim/);
  assert.ok(result.text.endsWith(pointerLine(HARNESS)));
});

test('a collection folder with no status and no outcomes gives only the pointer', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  const result = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.equal(result.source, 'none');
  assert.deepEqual(result.externalIds, []);
  assert.equal(result.text, pointerLine(HARNESS));
});

// ------------------------------------------------------------------ budget

test('budget: a long status.md is cut on a line or word boundary, marked, and fits', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  const lines = Array.from({ length: 800 }, (_, i) => `- requirement ${i} is in progress with some words after it`);
  writeStatus(sandbox.vaultRoot, `---\nid: 's'\n---\n${lines.join('\n')}\n`);

  const result = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.ok(result.tokens <= BRIEF_TOKEN_BUDGET, `${result.tokens} tokens`);
  assert.equal(estimateTokens(result.text), result.tokens);
  assert.match(result.text, new RegExp(CUT_MARKER.replace(/[[\]]/g, '\\$&')));
  assert.ok(result.text.endsWith(pointerLine(HARNESS)), 'the pointer survives the cut');
  const kept = result.text.split('\n').filter((line) => line.startsWith('- requirement'));
  assert.ok(kept.length > 10);
  const last = kept[kept.length - 1];
  const original = lines.find((line) => line.startsWith(last));
  assert.ok(original, 'the last kept line is a prefix of a real line');
  assert.ok(original === last || /^\s/.test(original.slice(last.length)), 'never mid-word');
});

test('budget: one giant paragraph is cut between words', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  const words = Array.from({ length: 3000 }, (_, i) => `word${i}`);
  writeStatus(sandbox.vaultRoot, words.join(' '));
  const result = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.ok(result.tokens <= BRIEF_TOKEN_BUDGET);
  const paragraph = result.text.split('\n').find((line) => line.startsWith('word0 '));
  assert.ok(paragraph, 'a prefix of the paragraph is kept');
  assert.match(paragraph, /word\d+$/, 'ends on a whole word');
  assert.ok(words.join(' ').startsWith(paragraph));
});

test('budget: large outcomes keep only the notes that made it in', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  const big = Array.from({ length: 60 }, (_, i) => `line ${i} of a long closing message with words`).join('\n');
  for (let day = 1; day <= 5; day += 1) {
    writeSession(sandbox.vaultRoot, { id: `session-${uuid(day)}`, startedAt: `2026-09-0${day}T10:00:00Z`, outcome: big });
  }
  const result = await brief(sandbox, `${sandbox.root}/repos/agentic-harness`);
  assert.ok(result.tokens <= BRIEF_TOKEN_BUDGET);
  assert.ok(result.externalIds.length >= 1 && result.externalIds.length < 5, `${result.externalIds.length} notes`);
  assert.equal(result.externalIds[0], `session-${uuid(5)}`);
  assert.ok(result.text.includes(CUT_MARKER));
});

// ------------------------------------------------------------------ deadline

test('deadline: a slow reader past the deadline rejects with a deadline error', async (t) => {
  const sandbox = withSandbox(t);
  addHarnessRealm(sandbox.vaultRoot);
  for (let day = 1; day <= 3; day += 1) {
    writeSession(sandbox.vaultRoot, { id: `session-${uuid(day)}`, startedAt: `2026-09-0${day}T10:00:00Z`, outcome: 'x' });
  }
  let clock = 0;
  const realRead = (file) => fs.promises.readFile(file, 'utf8');
  const io = {
    // Every read "takes" 1.5 s of an injected clock.
    readText: async (file) => {
      clock += 1500;
      try {
        return await realRead(file);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    listDir: (dir) => fs.promises.readdir(dir),
    isDirectory: async (dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false,
  };
  await assert.rejects(
    brief(sandbox, `${sandbox.root}/repos/agentic-harness`, { io, now: () => clock, deadlineAt: 2000 }),
    (error) => isDeadlineError(error),
  );
});
