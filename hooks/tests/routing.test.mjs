/**
 * R-H2: where a session is filed, from wherever it started.
 *
 * One table of cwds against one scratch world: a home with `.claude` and
 * `.harness`, the harness repo and one of its worktrees, bb2dash, a vault that
 * holds the `harness` realm, and Claude Code's two encoded folders
 * (`~/.claude/projects/<encoded>/` and `<tmp>/claude/<encoded>/`). The decoder
 * gets its own cases against a fake directory tree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canonicalFixturePath } from './helpers/fixture-path.mjs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decodeClaudeStateCwd, encodeClaudeProjectName } from '../lib/claude-paths.mjs';
import { deriveCollection, holdsHarnessRealm, placeSession, ROUTING_RULES, routeSession } from '../lib/collection.mjs';
import { resolveRepo } from '../lib/repo.mjs';
import { toPosix } from '../lib/text.mjs';

const SESSION = '0b8f3c1e-7a2d-4e6f-9c10-5d4b3a2f1e0d';

function makeRepo(root, dir, remote) {
  const gitDir = path.join(root, dir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'config'), `[remote "origin"]\n\turl = ${remote}\n`, 'utf8');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return gitDir;
}

function makeWorktree(root, mainGitDir, dir) {
  const name = path.basename(dir);
  const worktreeGitDir = path.join(mainGitDir, 'worktrees', name);
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feat\n', 'utf8');
  fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, '.git'), `gitdir: ${toPosix(worktreeGitDir)}\n`, 'utf8');
}

function world({ harnessRealm = true } = {}) {
  const root = toPosix(canonicalFixturePath(fs.mkdtempSync(path.join(os.tmpdir(), 'routing-'))));
  const home = `${root}/home`;
  const tmp = `${root}/tmp`;
  const vault = `${home}/vault`;
  for (const dir of [
    `${home}/.claude/hooks`,
    `${home}/.harness`,
    `${home}/projects`,
    `${vault}/projects/bb2dash/sessions`,
    `${vault}/projects/agentic-harness/sessions`,
    `${vault}/projects/misc/sessions`,
    `${vault}/classes/ist323/sessions`,
    tmp,
  ]) fs.mkdirSync(dir, { recursive: true });
  if (harnessRealm) {
    fs.mkdirSync(`${vault}/harness`, { recursive: true });
    fs.writeFileSync(`${vault}/harness/.realm`, 'harness\n', 'utf8');
  }
  const harnessGit = makeRepo(root, 'home/agentic-harness', 'git@github.com:emstacho-su/agentic-harness.git');
  makeWorktree(root, harnessGit, 'home/agentic-harness-wt-ha');
  makeRepo(root, 'home/projects/bb2dash', 'https://github.com/emstacho-su/bb2dash.git');

  const claudeProject = (cwd, rest) => {
    const dir = `${home}/.claude/projects/${encodeClaudeProjectName(cwd)}/${rest}`;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const scratchpad = (cwd) => {
    const dir = `${tmp}/claude/${encodeClaudeProjectName(cwd)}/${SESSION}/scratchpad`;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const place = (cwd) => {
    const placed = deriveCollection({ cwd, vaultRoot: vault, repo: resolveRepo(cwd), home, tmp });
    return `${placed.area}/${placed.collection}`;
  };
  return { root, home, tmp, vault, claudeProject, scratchpad, place, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('R-H2: every cwd the spec lists lands where the table says', () => {
  const w = world();
  try {
    const { home, vault } = w;
    const cases = [
      ['the harness repo', `${home}/agentic-harness`, 'harness/agentic-harness'],
      ['a subfolder of it', `${home}/agentic-harness/ingest`, 'harness/agentic-harness'],
      ['a -wt- worktree of it', `${home}/agentic-harness-wt-ha`, 'harness/agentic-harness'],
      ['a deleted -wt- worktree of it (no .git left)', `${home}/agentic-harness-wt-h1`, 'harness/agentic-harness'],
      ['~/.claude', `${home}/.claude`, 'harness/agentic-harness'],
      ['~/.claude/hooks', `${home}/.claude/hooks`, 'harness/agentic-harness'],
      ['~/.harness', `${home}/.harness`, 'harness/agentic-harness'],
      ["the harness's Claude memory folder", w.claudeProject(`${home}/agentic-harness`, 'memory'), 'harness/agentic-harness'],
      ["bb2dash's Claude memory folder", w.claudeProject(`${home}/projects/bb2dash`, 'memory'), 'projects/bb2dash'],
      ["a bb2dash workflow agent's folder", w.claudeProject(`${home}/projects/bb2dash`, `${SESSION}/subagents/workflows/wf_1`), 'projects/bb2dash'],
      ['a harness scratchpad', w.scratchpad(`${home}/agentic-harness`), 'harness/agentic-harness'],
      ['a scratchpad of a harness worktree', w.scratchpad(`${home}/agentic-harness-wt-ha`), 'harness/agentic-harness'],
      ['a scratchpad of a deleted harness worktree', w.scratchpad(`${home}/agentic-harness-wt-gone`), 'harness/agentic-harness'],
      ['a bb2dash scratchpad', w.scratchpad(`${home}/projects/bb2dash`), 'projects/bb2dash'],
      ['~', home, 'projects/home'],
      ['~/projects, the folder of projects', `${home}/projects`, 'projects/misc'],
      ['the vault root', vault, 'projects/vault'],
      ['a class folder in the vault', `${vault}/classes/ist323`, 'classes/ist323'],
      ['bb2dash', `${home}/projects/bb2dash`, 'projects/bb2dash'],
    ];
    const failures = cases
      .map(([label, cwd, expected]) => ({ label, expected, actual: w.place(cwd) }))
      .filter(({ expected, actual }) => expected !== actual);
    assert.deepEqual(failures, []);
  } finally {
    w.cleanup();
  }
});

test('R-H2: without the harness realm on disk, harness work stays in projects/agentic-harness as before', () => {
  const w = world({ harnessRealm: false });
  try {
    assert.equal(w.place(`${w.home}/agentic-harness`), 'projects/agentic-harness');
    assert.equal(w.place(w.scratchpad(`${w.home}/agentic-harness`)), 'projects/agentic-harness', 'the scratchpad is still decoded');
    assert.equal(w.place(w.claudeProject(`${w.home}/projects/bb2dash`, 'memory')), 'projects/bb2dash');
  } finally {
    w.cleanup();
  }
});

test('the rule list is data, in the order the spec gives', () => {
  assert.deepEqual(ROUTING_RULES.map((rule) => rule.name), ['class-folder', 'harness', 'container', 'git', 'folder']);
  assert.ok(Object.isFrozen(ROUTING_RULES));
});

test('routeSession names the rule that placed the session and the cwd it read; deriveCollection keeps its three fields', () => {
  const w = world();
  try {
    const cwd = w.scratchpad(`${w.home}/projects/bb2dash`);
    const args = { cwd, vaultRoot: w.vault, repo: resolveRepo(cwd), home: w.home, tmp: w.tmp };
    const placed = routeSession(args);
    assert.deepEqual(deriveCollection(args), { area: 'projects', collection: 'bb2dash', collectionSource: 'git' });
    assert.equal(placed.rule, 'git');
    assert.equal(placed.routedCwd, `${w.home}/projects/bb2dash`);
    assert.equal(placed.collectionSource, 'git');
  } finally {
    w.cleanup();
  }
});

// ------------------------------------------------------------------- decoder

/** A fake directory tree: `{ 'C:/': ['Users'], 'C:/Users': ['estac'], … }`. */
const fakeTree = (tree) => (dir) => tree[dir] ?? [];

const TREE = fakeTree({
  'C:/': ['Users', 'Windows'],
  'C:/Users': ['estac', 'Public'],
  'C:/Users/estac': ['.claude', 'agentic', 'agentic-harness', 'agentic-harness-wt-ha', 'OneDrive - Syracuse University', 'projects'],
  'C:/Users/estac/agentic-harness': ['hooks', 'ingest'],
  'C:/Users/estac/projects': ['bb2dash', 'bb2dash-wt-sl'],
  '/': ['home'],
  '/home': ['stack'],
  '/home/stack': ['agentic-harness'],
});
const HOME = 'C:/Users/estac';
const TMP = 'C:/Users/estac/AppData/Local/Temp';
const decode = (cwd) => decodeClaudeStateCwd(cwd, { home: HOME, tmp: TMP, listDir: TREE });

test('the encoding is Claude Code\'s: every character that is not a letter or digit becomes a dash', () => {
  assert.equal(encodeClaudeProjectName('C:\\Users\\estac\\agentic-harness'), 'C--Users-estac-agentic-harness');
  assert.equal(encodeClaudeProjectName('C:/Users/estac/.claude'), 'C--Users-estac--claude');
  assert.equal(encodeClaudeProjectName('C:/Users/estac/OneDrive - Syracuse University'), 'C--Users-estac-OneDrive---Syracuse-University');
});

test('decoding follows the directories on disk, longest match first', () => {
  const cases = [
    [`${HOME}/.claude/projects/C--Users-estac-agentic-harness/memory`, 'C:/Users/estac/agentic-harness'],
    [`${HOME}/.claude/projects/C--Users-estac-agentic-harness-wt-ha/x/subagents`, 'C:/Users/estac/agentic-harness-wt-ha'],
    [`${HOME}/.claude/projects/C--Users-estac-agentic-harness-hooks`, 'C:/Users/estac/agentic-harness/hooks'],
    [`${HOME}/.claude/projects/C--Users-estac--claude`, 'C:/Users/estac/.claude'],
    [`${HOME}/.claude/projects/C--Users-estac-OneDrive---Syracuse-University/m`, 'C:/Users/estac/OneDrive - Syracuse University'],
    [`${TMP}/claude/C--Users-estac-projects-bb2dash/${SESSION}/scratchpad`, 'C:/Users/estac/projects/bb2dash'],
    [`${TMP}/claude/C--Users-estac-projects-bb2dash-wt-sl/${SESSION}/scratchpad/a`, 'C:/Users/estac/projects/bb2dash-wt-sl'],
    ['c:\\users\\estac\\appdata\\local\\temp\\claude\\C--Users-estac-projects-bb2dash\\s', 'C:/Users/estac/projects/bb2dash'],
    [`${HOME}/.claude/projects/-home-stack-agentic-harness/memory`, '/home/stack/agentic-harness'],
  ];
  for (const [cwd, expected] of cases) assert.equal(decode(cwd), expected, cwd);
});

test('a folder no longer on disk keeps the rest of the name as its last segment', () => {
  assert.equal(decode(`${TMP}/claude/C--Users-estac-projects-bb2dash-wt-gone/${SESSION}`), 'C:/Users/estac/projects/bb2dash/wt-gone');
  assert.equal(decode(`${HOME}/.claude/projects/C--Users-estac-deleted-project/memory`), 'C:/Users/estac/deleted-project');
});

test('a cwd outside the two encoded folders is not decoded', () => {
  for (const cwd of [
    `${HOME}/agentic-harness`,
    `${HOME}/.claude`,
    `${HOME}/.claude/projects`,
    `${HOME}/.claude/hooks`,
    `${TMP}/claude`,
    `${TMP}/other/C--Users-estac-agentic-harness`,
    '',
  ]) assert.equal(decode(cwd), '', cwd);
});

test('placeSession resolves the repository from the cwd the rules read, so a git collection always has its repo', () => {
  const w = world();
  try {
    const cwd = w.claudeProject(`${w.home}/projects/bb2dash`, 'memory');
    const { placement, repo } = placeSession({ cwd, vaultRoot: w.vault, home: w.home, tmp: w.tmp });
    assert.equal(`${placement.area}/${placement.collection}`, 'projects/bb2dash');
    assert.equal(placement.collectionSource, 'git');
    assert.equal(repo.repoFullName, 'emstacho-su/bb2dash');
    const plain = placeSession({ cwd: `${w.home}/projects/bb2dash`, vaultRoot: w.vault, home: w.home, tmp: w.tmp });
    assert.equal(plain.repo.repoFullName, 'emstacho-su/bb2dash');
  } finally {
    w.cleanup();
  }
});

test('the harness realm is held only when harness/.realm names it', () => {
  const w = world();
  try {
    assert.equal(holdsHarnessRealm(w.vault), true);
    fs.writeFileSync(`${w.vault}/harness/.realm`, '\n', 'utf8');
    assert.equal(holdsHarnessRealm(w.vault), false, 'an empty marker is no realm to realm-sync either');
    fs.writeFileSync(`${w.vault}/harness/.realm`, 'projects\n', 'utf8');
    assert.equal(holdsHarnessRealm(w.vault), false);
  } finally {
    w.cleanup();
  }
});

test('decoding backtracks: a longer sibling that leads nowhere does not swallow a path that decodes whole', () => {
  const tree = fakeTree({
    'C:/': ['Users'],
    'C:/Users': ['estac'],
    'C:/Users/estac': ['projects', 'foo'],
    'C:/Users/estac/projects': ['bb2dash', 'bb2dash-course'],
    'C:/Users/estac/projects/bb2dash': ['course-context'],
  });
  const at = (cwd) => decodeClaudeStateCwd(cwd, { home: HOME, tmp: TMP, listDir: tree });
  assert.equal(at(`${HOME}/.claude/projects/C--Users-estac-projects-bb2dash-course-context/m`), 'C:/Users/estac/projects/bb2dash/course-context');
  // The ambiguity documented in claude-paths.mjs: a deleted foo-web beside foo reads as foo/web.
  assert.equal(at(`${HOME}/.claude/projects/C--Users-estac-foo-web/m`), 'C:/Users/estac/foo/web');
});

test('on Windows a cwd typed in another case still decodes: folder names compare without case', () => {
  const tree = fakeTree({ 'C:/': ['Users'], 'C:/Users': ['estac'], 'C:/Users/estac': ['bb2dash'] });
  const at = (cwd, caseInsensitive) => decodeClaudeStateCwd(cwd, { home: HOME, tmp: TMP, listDir: tree, caseInsensitive });
  assert.equal(at(`${HOME}/.claude/projects/c--users-estac-bb2dash/m`, true), 'C:/Users/estac/bb2dash');
  assert.equal(at(`${HOME}/.claude/projects/c--users-estac-bb2dash/m`, false), 'C:/users-estac-bb2dash', 'POSIX keeps case');
});

test('home and tmp given in 8.3 short form are expanded before the prefix test', () => {
  const tree = fakeTree({ 'C:/': ['Users'], 'C:/Users': ['estac'], 'C:/Users/estac': ['bb2dash'] });
  const expand = (p) => p.replace('ESTAC~1', 'estac');
  const cwd = `${HOME}/AppData/Local/Temp/claude/C--Users-estac-bb2dash/${SESSION}/scratchpad`;
  assert.equal(decodeClaudeStateCwd(cwd, { home: 'C:/Users/ESTAC~1', tmp: 'C:/Users/ESTAC~1/AppData/Local/Temp', listDir: tree, realpath: expand }), 'C:/Users/estac/bb2dash');
});
