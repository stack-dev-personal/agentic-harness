/**
 * R-H3: the harness history moves into the harness realm, and every other
 * note in the five artefact collections goes where R-H2 now sends it.
 *
 * The fixture mirrors what the live vault holds: harness sessions and their
 * workers in `projects/agentic-harness`, bb2dash workers filed under `memory`
 * and `projects` (their cwds are Claude Code's own folders), harness
 * scratchpads under `claude` and `remote`, and one session from `~/projects`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canonicalFixturePath } from './helpers/fixture-path.mjs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encodeClaudeProjectName } from '../lib/claude-paths.mjs';
import { ensureIndex } from '../lib/notes-io.mjs';
import { checkPreconditions, planMoveToRealm, SOURCE_COLLECTIONS } from '../lib/move-to-realm.mjs';
import { applyMoveToRealm } from '../lib/move-to-realm-apply.mjs';
import { run } from '../move-to-realm.mjs';
import { toPosix } from '../lib/text.mjs';

const ids = {
  harness: '11111111-1111-4111-8111-111111111111',
  harnessWorker: '11111111-1111-4111-8111-111111111111--a1b2c3',
  home: '22222222-2222-4222-8222-222222222222',
  noCwd: '33333333-3333-4333-8333-333333333333',
  bbParent: '44444444-4444-4444-8444-444444444444',
  memoryWorker: '44444444-4444-4444-8444-444444444444--d4e5f6',
  orphanWorkflow: '55555555-5555-4555-8555-555555555555--wf0001',
  container: '66666666-6666-4666-8666-666666666666',
  scratch: '77777777-7777-4777-8777-777777777777',
  remote: '88888888-8888-4888-8888-888888888888',
  strayWorker: '11111111-1111-4111-8111-111111111111--f9f9f9',
};
const sessionOf = (id) => id.split('--')[0];

function makeRepo(root, dir, remote) {
  const gitDir = path.join(root, dir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'config'), `[remote "origin"]\n\turl = ${remote}\n`, 'utf8');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

const q = (value) => `'${String(value).replace(/'/g, "''")}'`;
function noteText(fields, body = 'Body text.\n') {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${key === 'type' ? value : q(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

function world({ harnessRealm = true } = {}) {
  const root = toPosix(canonicalFixturePath(fs.mkdtempSync(path.join(os.tmpdir(), 'move-to-realm-'))));
  const home = `${root}/home`;
  const tmp = `${root}/tmp`;
  const vault = `${home}/vault`;
  const archiveRoot = `${root}/archive`;
  fs.mkdirSync(`${home}/projects`, { recursive: true });
  makeRepo(root, 'home/agentic-harness', 'git@github.com:emstacho-su/agentic-harness.git');
  makeRepo(root, 'home/projects/bb2dash', 'https://github.com/emstacho-su/bb2dash.git');
  write(`${vault}/projects/.realm`, 'projects\n');
  if (harnessRealm) write(`${vault}/harness/.realm`, 'harness\n');

  const claudeDir = (cwd, rest) => {
    const dir = `${home}/.claude/projects/${encodeClaudeProjectName(cwd)}/${rest}`;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const scratchpad = (cwd) => {
    const dir = `${tmp}/claude/${encodeClaudeProjectName(cwd)}/${ids.scratch}/scratchpad`;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const hub = (collection) =>
    write(`${vault}/projects/${collection}/${collection}.md`, noteText({ id: `hub-${collection}`, title: collection, collection, type: 'index' }));
  const session = (collection, id, fields) =>
    write(`${vault}/projects/${collection}/sessions/${id}.md`, noteText({ id: `note-${id}`, session_id: sessionOf(id), collection, ...fields, type: 'session' }));

  for (const collection of SOURCE_COLLECTIONS) hub(collection);
  hub('bb2dash');
  write(`${vault}/projects/agentic-harness/notes/plan.md`, noteText({ id: 'note-plan', title: 'Plan' }));
  write(`${vault}/projects/agentic-harness/decisions/d1.md`, noteText({ id: 'note-d1', title: 'Decision 1' }));

  const harnessHubLink = '[[projects/agentic-harness/agentic-harness|agentic-harness]]';
  session('agentic-harness', ids.harness, { title: 'Session 2026-09-20 — agentic-harness', cwd: `${home}/agentic-harness`, up: harnessHubLink });
  session('agentic-harness', ids.harnessWorker, {
    title: 'Subagent Explore 2026-09-20 — agentic-harness',
    parent_session: ids.harness,
    cwd: `${home}/agentic-harness`,
    up: `[[projects/agentic-harness/sessions/${ids.harness}|Session 2026-09-20 — agentic-harness]]`,
  });
  session('agentic-harness', ids.home, { title: 'Session 2026-09-21 — agentic-harness', cwd: home, up: harnessHubLink });
  session('agentic-harness', ids.noCwd, { title: 'Session 2026-09-22 — agentic-harness', up: harnessHubLink });
  write(`${vault}/projects/bb2dash/sessions/${ids.bbParent}.md`, noteText({ id: 'note-bb', session_id: ids.bbParent, collection: 'bb2dash', collection_source: 'git', title: 'Session 2026-09-16 — bb2dash', cwd: `${home}/projects/bb2dash`, type: 'session' }));
  session('memory', ids.memoryWorker, {
    title: 'Subagent general-purpose 2026-09-16 — memory',
    parent_session: ids.bbParent,
    cwd: claudeDir(`${home}/projects/bb2dash`, 'memory'),
    up: `[[projects/bb2dash/sessions/${ids.bbParent}|Session 2026-09-16 — bb2dash]]`,
  });
  session('projects', ids.orphanWorkflow, {
    title: 'Subagent workflow-subagent 2026-09-23 — projects',
    parent_session: sessionOf(ids.orphanWorkflow),
    cwd: claudeDir(`${home}/projects/bb2dash`, `${sessionOf(ids.orphanWorkflow)}/subagents/workflows/wf_1`),
    up: '[[projects/projects/projects|projects]]',
  });
  session('projects', ids.container, { title: 'Session 2026-09-17 — projects', cwd: `${home}/projects`, up: '[[projects/projects/projects|projects]]' });
  session('claude', ids.scratch, { title: 'Session 2026-09-18 — claude', cwd: scratchpad(`${home}/agentic-harness`), up: '[[projects/claude/claude|claude]]' });
  session('remote', ids.remote, { title: 'Session 2026-09-19 — remote', cwd: scratchpad(`${home}/agentic-harness`), up: '[[projects/remote/remote|remote]]' });
  // A worker of a harness session that an old capture filed under bb2dash: it is not moved, but its link is.
  write(`${vault}/projects/bb2dash/sessions/${ids.strayWorker}.md`, noteText({
    id: 'note-stray', session_id: ids.harness, parent_session: ids.harness, collection: 'bb2dash', title: 'Subagent Plan 2026-09-20 — bb2dash',
    up: `[[projects/agentic-harness/sessions/${ids.harness}|Session 2026-09-20 — agentic-harness]]`, type: 'session',
  }));

  const options = { vault, home, tmp, archiveRoot };
  const read = (rel) => fs.readFileSync(`${vault}/${rel}`, 'utf8');
  const exists = (rel) => fs.existsSync(`${vault}/${rel}`);
  return { root, home, vault, archiveRoot, options, read, exists, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[toPosix(path.relative(dir, full))] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const destinations = (plan) => Object.fromEntries(plan.moves.map((move) => [path.posix.basename(move.from), move.to]));

test('the plan sends each note where the R-H2 rules or its parent say, with a reason', () => {
  const w = world();
  try {
    const plan = planMoveToRealm(w.options);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(destinations(plan), {
      'agentic-harness.md': 'harness/agentic-harness/agentic-harness.md',
      'd1.md': 'harness/agentic-harness/decisions/d1.md',
      'plan.md': 'harness/agentic-harness/notes/plan.md',
      [`${ids.harness}.md`]: `harness/agentic-harness/sessions/${ids.harness}.md`,
      [`${ids.harnessWorker}.md`]: `harness/agentic-harness/sessions/${ids.harnessWorker}.md`,
      [`${ids.home}.md`]: `projects/home/sessions/${ids.home}.md`,
      [`${ids.noCwd}.md`]: `harness/agentic-harness/sessions/${ids.noCwd}.md`,
      [`${ids.memoryWorker}.md`]: `projects/bb2dash/sessions/${ids.memoryWorker}.md`,
      [`${ids.orphanWorkflow}.md`]: `projects/bb2dash/sessions/${ids.orphanWorkflow}.md`,
      [`${ids.container}.md`]: `projects/misc/sessions/${ids.container}.md`,
      [`${ids.scratch}.md`]: `harness/agentic-harness/sessions/${ids.scratch}.md`,
      [`${ids.remote}.md`]: `harness/agentic-harness/sessions/${ids.remote}.md`,
    });
    const reasonOf = (id) => plan.moves.find((move) => move.from.endsWith(`/${id}.md`)).reason;
    assert.match(reasonOf(ids.harness), /^harness: .*\/home\/agentic-harness$/);
    assert.match(reasonOf(ids.harnessWorker), /^parent 11111111 -> harness\/agentic-harness$/);
    assert.match(reasonOf(ids.memoryWorker), /^parent 44444444 -> projects\/bb2dash$/);
    assert.match(reasonOf(ids.orphanWorkflow), /^git: .*\/home\/projects\/bb2dash \(decoded; parent 55555555 not in the vault\)$/);
    assert.match(reasonOf(ids.scratch), /^harness: .*\/home\/agentic-harness \(decoded\)$/);
    assert.match(reasonOf(ids.container), /^container: /);
    assert.match(reasonOf(ids.noCwd), /^no cwd: stays with its collection agentic-harness$/);
    assert.deepEqual(plan.archives.map((a) => a.from).sort(), ['projects/claude/claude.md', 'projects/memory/memory.md', 'projects/projects/projects.md', 'projects/remote/remote.md']);
    assert.deepEqual(plan.rewrites.map((r) => r.path), [`projects/bb2dash/sessions/${ids.strayWorker}.md`]);
  } finally {
    w.cleanup();
  }
});

test('the dry run writes nothing', () => {
  const w = world();
  try {
    const before = snapshot(w.root);
    planMoveToRealm(w.options);
    assert.deepEqual(snapshot(w.root), before);
  } finally {
    w.cleanup();
  }
});

test('apply moves every note, edits only collection, up and the title suffix, archives the emptied hubs, and converges', () => {
  const w = world();
  try {
    const before = w.read(`projects/agentic-harness/sessions/${ids.harness}.md`);
    const result = applyMoveToRealm(planMoveToRealm(w.options));
    assert.deepEqual(result.errors, []);

    const moved = w.read(`harness/agentic-harness/sessions/${ids.harness}.md`);
    assert.equal(moved, before.replace("up: '[[projects/agentic-harness/agentic-harness|agentic-harness]]'", "up: '[[harness/agentic-harness/agentic-harness|agentic-harness]]'"));
    assert.match(w.read(`harness/agentic-harness/sessions/${ids.harnessWorker}.md`), new RegExp(`up: '\\[\\[harness/agentic-harness/sessions/${ids.harness}\\|Session 2026-09-20 — agentic-harness\\]\\]'`));

    const memory = w.read(`projects/bb2dash/sessions/${ids.memoryWorker}.md`);
    assert.match(memory, /^collection: 'bb2dash'$/m);
    assert.match(memory, /^title: 'Subagent general-purpose 2026-09-16 — bb2dash'$/m);
    assert.match(memory, /^id: 'note-44444444/m, 'the id, the store key, is untouched');
    assert.match(w.read(`projects/bb2dash/sessions/${ids.orphanWorkflow}.md`), /^up: '\[\[projects\/bb2dash\/bb2dash\|bb2dash\]\]'$/m);
    assert.match(w.read(`projects/misc/sessions/${ids.container}.md`), /^collection: 'misc'$/m);
    assert.match(w.read(`projects/bb2dash/sessions/${ids.strayWorker}.md`), new RegExp(`^up: '\\[\\[harness/agentic-harness/sessions/${ids.harness}\\|`, 'm'));
    assert.equal(w.read('harness/agentic-harness/notes/plan.md'), noteText({ id: 'note-plan', title: 'Plan' }), 'a non-session note moves byte for byte');

    for (const collection of SOURCE_COLLECTIONS) assert.equal(w.exists(`projects/${collection}`), false, `projects/${collection} is gone`);
    const archived = snapshot(w.archiveRoot);
    assert.deepEqual(Object.keys(archived).sort(), ['projects/claude/claude.md', 'projects/memory/memory.md', 'projects/projects/projects.md', 'projects/remote/remote.md']);

    const again = planMoveToRealm(w.options);
    assert.deepEqual([again.moves, again.archives, again.rewrites, again.conflicts], [[], [], [], []], 'a second run finds nothing to do');
  } finally {
    w.cleanup();
  }
});

test('a target that already holds different text is a conflict: that note stays, and so does its hub', () => {
  const w = world();
  try {
    write(`${w.vault}/projects/misc/sessions/${ids.container}.md`, 'something else\n');
    const plan = planMoveToRealm(w.options);
    assert.deepEqual(plan.conflicts.map((c) => c.path), [`projects/projects/sessions/${ids.container}.md`]);
    assert.ok(!plan.moves.some((move) => move.from.endsWith(`${ids.container}.md`)));
    assert.ok(!plan.archives.some((a) => a.from === 'projects/projects/projects.md'), 'a collection that keeps a note keeps its hub');
  } finally {
    w.cleanup();
  }
});

test("a parent's conflict holds its workers back with it", () => {
  const w = world();
  try {
    write(`${w.vault}/harness/agentic-harness/sessions/${ids.harness}.md`, 'something else\n');
    const plan = planMoveToRealm(w.options);
    assert.deepEqual(plan.conflicts.map((c) => c.path).sort(), [
      `projects/agentic-harness/sessions/${ids.harness}.md`,
      `projects/agentic-harness/sessions/${ids.harnessWorker}.md`,
    ].sort());
    assert.ok(!plan.rewrites.length, 'no link is pointed at a parent that stays');
  } finally {
    w.cleanup();
  }
});

test('a target that already holds the same text is taken as done: the source is removed', () => {
  const w = world();
  try {
    const first = planMoveToRealm(w.options);
    const move = first.moves.find((m) => m.from.endsWith(`${ids.container}.md`));
    write(`${w.vault}/${move.to}`, move.text);
    const plan = planMoveToRealm(w.options);
    const again = plan.moves.find((m) => m.from.endsWith(`${ids.container}.md`));
    assert.equal(again.alreadyThere, true);
    applyMoveToRealm(plan);
    assert.equal(w.exists(move.from), false);
  } finally {
    w.cleanup();
  }
});

test('--apply is refused without the harness realm on disk, unlisted, or with a realm lock held', () => {
  const w = world({ harnessRealm: false });
  try {
    const listed = ['projects', 'classes', 'harness'];
    assert.match(checkPreconditions({ vault: w.vault, realmsListed: listed }).join('\n'), /harness\/\.realm/);
    write(`${w.vault}/harness/.realm`, 'harness\n');
    assert.deepEqual(checkPreconditions({ vault: w.vault, realmsListed: listed }), []);
    assert.match(checkPreconditions({ vault: w.vault, realmsListed: ['projects', 'classes'] }).join('\n'), /HARNESS_REALMS/);
    const peek = (realmRoot) => ({ held: realmRoot.endsWith('projects'), holder: null, stale: false });
    assert.match(checkPreconditions({ vault: w.vault, realmsListed: listed, peek }).join('\n'), /lock/);
  } finally {
    w.cleanup();
  }
});

test('--plan-only previews the move before the harness realm exists', () => {
  const w = world({ harnessRealm: false });
  try {
    const plan = planMoveToRealm({ ...w.options, holdsHarness: true });
    assert.equal(destinations(plan)[`${ids.harness}.md`], `harness/agentic-harness/sessions/${ids.harness}.md`);
  } finally {
    w.cleanup();
  }
});

// ------------------------------------------------------------------- the CLI

function cli(w, argv, realms = 'projects:push,classes:push,harness:push') {
  const lines = [];
  const env = { HARNESS_MACHINE_ENV: `${w.root}/absent-machine.env`, HARNESS_VAULT: w.vault, HARNESS_REALMS: realms };
  const code = run(argv, { env, out: (line) => lines.push(line), err: (line) => lines.push(line), home: w.home, tmp: `${w.root}/tmp`, now: new Date('2026-09-28T12:00:00Z') });
  return { code, lines, text: lines.join('\n') };
}

test('CLI --dry-run prints the vault first, one line per note with its reason, and writes nothing', () => {
  const w = world();
  try {
    const before = snapshot(w.root);
    const r = cli(w, ['--dry-run']);
    assert.equal(r.code, 0, r.text);
    assert.equal(r.lines[0], `vault: ${w.vault}`);
    assert.ok(r.lines.includes(`move projects/memory/sessions/${ids.memoryWorker}.md -> projects/bb2dash/sessions/${ids.memoryWorker}.md (parent 44444444 -> projects/bb2dash)`), r.text);
    assert.ok(r.lines.includes(`archive projects/memory/memory.md -> ${w.home}/.claude-archive/2026-09-28-vault-hubs/projects/memory/memory.md`), r.text);
    assert.match(r.text, /^ {2}-> harness\/agentic-harness: 8$/m);
    assert.match(r.text, /^dry-run: nothing was written$/m);
    assert.deepEqual(snapshot(w.root), before);
  } finally {
    w.cleanup();
  }
});

test('CLI refuses --dry-run and --apply without the realm, or with a bad HARNESS_REALMS; --plan-only runs', () => {
  const w = world({ harnessRealm: false });
  try {
    for (const mode of ['--dry-run', '--apply']) {
      const r = cli(w, [mode]);
      assert.equal(r.code, 2);
      assert.match(r.text, /refused: harness\/\.realm is missing/);
    }
    write(`${w.vault}/harness/.realm`, 'harness\n');
    const bad = cli(w, ['--apply'], 'projects:sync');
    assert.equal(bad.code, 2);
    assert.match(bad.text, /refused: HARNESS_REALMS: 'projects:sync'/);
    fs.rmSync(`${w.vault}/harness`, { recursive: true });
    const preview = cli(w, ['--plan-only']);
    assert.equal(preview.code, 0, preview.text);
    assert.match(preview.text, /-> harness\/agentic-harness: 8/);
  } finally {
    w.cleanup();
  }
});

test('CLI --apply carries the move out and exits 0; usage errors exit 1', () => {
  const w = world();
  try {
    const r = cli(w, ['--apply']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /^applied: moved 12, links 1, new hubs 2, archived 4, failed 0$/m);
    assert.equal(w.exists('projects/agentic-harness'), false);
    assert.equal(cli(w, []).code, 1);
    assert.equal(cli(w, ['--dry-run', '--apply']).code, 1);
    assert.equal(cli(w, ['--vault']).code, 1);
  } finally {
    w.cleanup();
  }
});

// ------------------------------------------------------------------ review fixes

test('an unreadable note keeps its collection and hub, and the CLI refuses --apply until it is fixed', () => {
  const w = world();
  try {
    write(`${w.vault}/projects/claude/sessions/broken.md`, '---\nid: [unclosed\n---\n');
    const plan = planMoveToRealm(w.options);
    assert.deepEqual(plan.unreadable.map((u) => u.path), ['projects/claude/sessions/broken.md']);
    assert.ok(!plan.archives.some((a) => a.from === 'projects/claude/claude.md'), 'the hub stays with the note that stays');
    const before = snapshot(w.vault);
    const r = cli(w, ['--apply']);
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /refused: the plan has 1 unreadable note/);
    assert.deepEqual(snapshot(w.vault), before, 'nothing was written');
  } finally {
    w.cleanup();
  }
});

test('the CLI refuses --apply while the plan has conflicts', () => {
  const w = world();
  try {
    write(`${w.vault}/projects/misc/sessions/${ids.container}.md`, 'something else\n');
    const r = cli(w, ['--apply']);
    assert.equal(r.code, 2);
    assert.match(r.text, /refused: the plan has 1 conflict/);
    assert.equal(w.exists(`projects/agentic-harness/sessions/${ids.harness}.md`), true);
  } finally {
    w.cleanup();
  }
});

test("a stub hub the new hook wrote into harness/ is replaced by the real one, and the stub is archived", () => {
  const w = world();
  try {
    ensureIndex(w.vault, 'harness', 'agentic-harness');
    const stub = w.read('harness/agentic-harness/agentic-harness.md');
    const plan = planMoveToRealm(w.options);
    assert.deepEqual(plan.conflicts, []);
    const hubMove = plan.moves.find((m) => m.to === 'harness/agentic-harness/agentic-harness.md');
    assert.equal(hubMove.replacesStub, true);
    const result = applyMoveToRealm(plan);
    assert.deepEqual(result.errors, []);
    assert.match(w.read('harness/agentic-harness/agentic-harness.md'), /^id: 'hub-agentic-harness'$/m);
    assert.equal(fs.readFileSync(`${w.archiveRoot}/harness/agentic-harness/agentic-harness.stub.md`, 'utf8'), stub);
  } finally {
    w.cleanup();
  }
});

test('a staying note whose parent moves has its link repointed', () => {
  const w = world();
  try {
    const worker = `${ids.harness}--c0ffee`;
    write(`${w.vault}/projects/agentic-harness/notes/${worker}.md`, noteText({
      id: 'note-odd', parent_session: ids.harness,
      up: `[[projects/agentic-harness/sessions/${ids.harness}|Session 2026-09-20 — agentic-harness]]`,
    }));
    fs.rmSync(`${w.vault}/harness/.realm`);
    write(`${w.vault}/harness/.realm`, 'harness\n');
    write(`${w.vault}/projects/claude/notes/keep.md`, noteText({ id: 'note-keep', up: `[[projects/agentic-harness/sessions/${ids.harness}]]` }));
    const plan = planMoveToRealm(w.options);
    assert.ok(plan.stays.some((s) => s.path === 'projects/claude/notes/keep.md'));
    assert.ok(plan.rewrites.some((r) => r.path === 'projects/claude/notes/keep.md'), 'a note that stays is still repointed');
  } finally {
    w.cleanup();
  }
});

test('two notes planned onto one target: the second is a conflict, not an apply-time failure', () => {
  const w = world();
  try {
    const twin = fs.readFileSync(`${w.vault}/projects/claude/sessions/${ids.scratch}.md`, 'utf8');
    write(`${w.vault}/projects/remote/sessions/${ids.scratch}.md`, twin.replace("collection: 'claude'", "collection: 'remote'"));
    const plan = planMoveToRealm(w.options);
    assert.deepEqual(plan.conflicts.map((c) => c.path), [`projects/remote/sessions/${ids.scratch}.md`]);
    assert.match(plan.conflicts[0].error, /also planned from projects\/claude/);
  } finally {
    w.cleanup();
  }
});

test('a note whose frontmatter cannot be edited in place is a conflict, not a silent stale move', () => {
  const w = world();
  try {
    const file = `${w.vault}/projects/projects/sessions/${ids.container}.md`;
    const escaped = `collection: "pro${String.fromCharCode(92)}u006aects"`; // YAML reads "projects"; the line editor refuses escapes
    const text = fs.readFileSync(file, 'utf8').replace("collection: 'projects'", escaped);
    fs.writeFileSync(file, text, 'utf8');
    const plan = planMoveToRealm(w.options);
    assert.deepEqual(plan.conflicts.map((c) => c.path), [`projects/projects/sessions/${ids.container}.md`]);
    assert.match(plan.conflicts[0].error, /could not edit collection/);
  } finally {
    w.cleanup();
  }
});

test('a moved note records how its new collection was decided', () => {
  const w = world();
  try {
    const file = `${w.vault}/projects/memory/sessions/${ids.memoryWorker}.md`;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("collection: 'memory'", "collection: 'memory'\ncollection_source: 'folder'"), 'utf8');
    const plan = planMoveToRealm(w.options);
    const move = plan.moves.find((m) => m.from.endsWith(`${ids.memoryWorker}.md`));
    assert.match(move.text, /^collection_source: 'git'$/m, 'the parent bb2dash is a git collection');
  } finally {
    w.cleanup();
  }
});

test('apply holds both realm locks for the whole move, and stops before writing when one cannot be taken', () => {
  const w = world();
  try {
    const calls = [];
    const locks = {
      acquire: (realm) => {
        calls.push(`acquire ${realm}`);
        return { ok: true, lock: realm };
      },
      release: (lock) => calls.push(`release ${lock}`),
    };
    const result = applyMoveToRealm(planMoveToRealm(w.options), { locks });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(calls, ['acquire projects', 'acquire harness', 'release harness', 'release projects']);

    const w2 = world();
    try {
      const busy = { acquire: (realm) => (realm === 'harness' ? { ok: false, error: 'held by sync --push' } : { ok: true, lock: realm }), release: () => {} };
      const before = snapshot(w2.vault);
      const blocked = applyMoveToRealm(planMoveToRealm(w2.options), { locks: busy });
      assert.match(blocked.errors.map((e) => e.error).join(), /held by sync --push/);
      assert.deepEqual(snapshot(w2.vault), before);
    } finally {
      w2.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

test('a stale realm lock does not refuse the move: the apply takes it over, as the collector does', () => {
  const w = world();
  try {
    const peek = () => ({ held: true, holder: null, stale: true });
    assert.deepEqual(checkPreconditions({ vault: w.vault, realmsListed: ['projects', 'classes', 'harness'], peek }), []);
  } finally {
    w.cleanup();
  }
});

// ------------------------------------------------------------------ third review

test('a staying note that links to a moved note but cannot be edited is a conflict', () => {
  const w = world();
  try {
    const bs = String.fromCharCode(92);
    write(`${w.vault}/projects/bb2dash/notes/odd.md`, `---\nid: 'odd'\nup: "[[projects/agentic-harness/sessions/${ids.harness}|say ${bs}"hi${bs}"]]"\n---\n`);
    const plan = planMoveToRealm(w.options);
    assert.deepEqual(plan.conflicts.map((c) => c.path), ['projects/bb2dash/notes/odd.md']);
    assert.match(plan.conflicts[0].error, /links to a moved note but its up: cannot be edited in place/);
  } finally {
    w.cleanup();
  }
});

test('an escaped value the move would not change is no conflict', () => {
  const w = world();
  try {
    const bs = String.fromCharCode(92);
    const file = `${w.vault}/projects/memory/sessions/${ids.memoryWorker}.md`;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^title: .*$/m, `title: "Say ${bs}"hi${bs}""`), 'utf8');
    assert.deepEqual(planMoveToRealm(w.options).conflicts, []);
  } finally {
    w.cleanup();
  }
});

test('an up link elsewhere to the moving collection hub is repointed', () => {
  const w = world();
  try {
    write(`${w.vault}/projects/bb2dash/notes/hubref.md`, noteText({ id: 'hubref', up: '[[projects/agentic-harness/agentic-harness|agentic-harness]]' }));
    const plan = planMoveToRealm(w.options);
    const rewrite = plan.rewrites.find((r) => r.path === 'projects/bb2dash/notes/hubref.md');
    assert.match(rewrite.text, /^up: '\[\[harness\/agentic-harness\/agentic-harness\|agentic-harness\]\]'$/m);
  } finally {
    w.cleanup();
  }
});

test('a target collection without a hub gets one, so every moved up: link resolves', () => {
  const w = world();
  try {
    const plan = planMoveToRealm(w.options);
    assert.deepEqual(plan.hubsToCreate, ['projects/home', 'projects/misc']);
    applyMoveToRealm(plan);
    assert.equal(w.exists('projects/home/home.md'), true);
    assert.equal(w.exists('projects/misc/misc.md'), true);
  } finally {
    w.cleanup();
  }
});

test('a note changed between plan and apply is left alone and reported, not overwritten', () => {
  const w = world();
  try {
    const plan = planMoveToRealm(w.options);
    const source = `${w.vault}/projects/claude/sessions/${ids.scratch}.md`;
    fs.appendFileSync(source, 'written by a hook after the plan\n');
    const linking = `${w.vault}/projects/bb2dash/sessions/${ids.strayWorker}.md`;
    fs.appendFileSync(linking, 'also changed\n');
    const result = applyMoveToRealm(plan);
    const failed = result.errors.map((e) => e.path).sort();
    assert.deepEqual(failed, [`projects/bb2dash/sessions/${ids.strayWorker}.md`, `projects/claude/sessions/${ids.scratch}.md`]);
    assert.match(result.errors[0].error, /changed since the plan/);
    assert.match(fs.readFileSync(source, 'utf8'), /written by a hook after the plan/);
    assert.equal(w.exists(`harness/agentic-harness/sessions/${ids.scratch}.md`), false);
    assert.equal(w.exists('projects/claude/claude.md'), true, 'a collection that still holds a note keeps its hub');
  } finally {
    w.cleanup();
  }
});

test('a hub held back by a later file in its collection is reported as staying', () => {
  const w = world();
  try {
    write(`${w.vault}/projects/remote/zz-notes.txt`, 'kept\n');
    const plan = planMoveToRealm(w.options);
    assert.ok(plan.stays.some((s) => s.path === 'projects/remote/remote.md'), JSON.stringify(plan.stays));
  } finally {
    w.cleanup();
  }
});
