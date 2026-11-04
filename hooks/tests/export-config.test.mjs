/**
 * `export-config.mjs`: building the claude-config repo from this machine (R-H5).
 *
 * Every run uses a temp `~/.claude` copied from the fixture and a temp clone
 * made with `git init`; git's global and system config are switched off so a
 * developer's own hooksPath or signing setup cannot change the outcome. A bare
 * repo stands in for GitHub, to prove nothing is ever pushed. The fake key is
 * assembled from parts so no scanner mistakes this file for a leak.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { canonicalFixturePath } from './helpers/fixture-path.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PRE_COMMIT_MARKER, harnessCheckout, parseArgs, preCommitHookScript } from '../export-config.mjs';
import { HOME_PLACEHOLDER, SCAN_EXCEPTIONS_FILE, SETTINGS_TEMPLATE_FILE } from '../lib/claude-config.mjs';
import { FIXTURES_DIR } from './helpers/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPORTER = path.resolve(HERE, '..', 'export-config.mjs');
/** This checkout. The hook the exporter installs calls back into HARNESS_REPO when it is set. */
const HARNESS_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_HOME = path.join(FIXTURES_DIR, 'claude-home');
const FAKE_GITHUB_TOKEN = ['gh', 'p_', 'FakeTestKeyNotReal', '0'.repeat(20)].join('');
const FIXTURE_FILES = Object.freeze([
  'CLAUDE.md',
  'rules/common/coding-style.md',
  'skill-vault/languages/python/SKILL.md',
  'skills/tdd/SKILL.md',
]);

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-config-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function write(dir, relPath, content) {
  const full = path.join(dir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** An isolated git: no global or system config, a fixed identity. */
function gitEnv(root) {
  const globalConfig = path.join(root, 'gitconfig');
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, '');
  return {
    ...process.env,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    // The hook bakes in the MAIN checkout, which need not have this branch's
    // export-config.mjs; the commits here must run the script under test.
    HARNESS_REPO: HARNESS_ROOT,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

function git(root, cwd, ...args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv(root), timeout: 60_000 });
}

/** A source `~/.claude`, an empty clone with a bare "GitHub" as origin. */
function world(root) {
  const source = path.join(root, 'home', '.claude');
  fs.cpSync(FIXTURE_HOME, source, { recursive: true });
  const clone = path.join(root, 'claude-config');
  const bare = path.join(root, 'github.git');
  execFileSync('git', ['init', '-q', '--bare', bare], { env: gitEnv(root) });
  execFileSync('git', ['init', '-q', '-b', 'main', clone], { env: gitEnv(root) });
  git(root, clone, 'remote', 'add', 'origin', bare);
  return { root, source, clone, bare };
}

function exportConfig(w, ...flags) {
  const args = [EXPORTER, ...flags, '--config-repo', w.clone, '--source', w.source];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: gitEnv(w.root), timeout: 120_000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Files in the clone, `.git` aside. */
function cloneFiles(clone) {
  return fs.readdirSync(clone, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(clone, path.join(entry.parentPath ?? entry.path, entry.name)).replace(/\\/g, '/'))
    .filter((p) => !p.startsWith('.git/'))
    .sort();
}

const commitCount = (w) => {
  const result = git(w.root, w.clone, 'rev-list', '--count', 'HEAD');
  return result.status === 0 ? Number(result.stdout.trim()) : 0;
};

// ---------------------------------------------------------------------------
// Arguments and the clone check
// ---------------------------------------------------------------------------

test('parseArgs takes exactly one mode, and defaults to ~/claude-config from ~/.claude', () => {
  const home = path.join(os.tmpdir(), 'h');
  assert.deepEqual(parseArgs(['--dry-run'], home), {
    mode: 'dry-run',
    configRepo: path.join(home, 'claude-config'),
    source: path.join(home, '.claude'),
  });
  assert.equal(parseArgs(['--list-findings', '--config-repo', 'x'], home).mode, 'list-findings');
  assert.throws(() => parseArgs([], home), /one of --dry-run, --apply, --list-findings/);
  assert.throws(() => parseArgs(['--dry-run', '--apply'], home), /only one of/);
  assert.throws(() => parseArgs(['--dry-run', '--push'], home), /unknown argument: --push/);
  assert.throws(() => parseArgs(['--apply', '--source'], home), /--source needs a value/);
});

test('a folder that is not a clone is refused with the commands that make one', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    const notClone = { ...w, clone: path.join(root, 'plain') };
    fs.mkdirSync(notClone.clone);
    for (const mode of ['--dry-run', '--apply', '--list-findings']) {
      const { status, out } = exportConfig(notClone, mode);
      assert.equal(status, 1, out);
      assert.match(out, /is not a git clone/);
      assert.match(out, /gh repo create emstacho-su\/claude-config --private/);
      assert.match(out, /git clone https:\/\/github\.com\/emstacho-su\/claude-config\.git/);
    }
    // A folder inside some other checkout is not the clone's top either.
    const nested = { ...w, clone: path.join(w.clone, 'sub') };
    fs.mkdirSync(nested.clone);
    assert.match(exportConfig(nested, '--dry-run').out, /is not a git clone/);
    assert.deepEqual(fs.readdirSync(notClone.clone), [], 'nothing was written into it');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The scan comes first
// ---------------------------------------------------------------------------

test('a planted fake key refuses by path, rule and line, and nothing is copied or committed', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    write(w.source, 'skills/tdd/SKILL.md', `# tdd\n\npasted ${FAKE_GITHUB_TOKEN} here\n`);

    for (const mode of ['--dry-run', '--apply']) {
      const { status, out } = exportConfig(w, mode);
      assert.equal(status, 1, out);
      assert.match(out, /skills\/tdd\/SKILL\.md:3 github-token/);
      assert.match(out, /nothing copied/);
      assert.ok(!out.includes(FAKE_GITHUB_TOKEN), 'the value is never printed');
    }
    assert.deepEqual(cloneFiles(w.clone), []);
    assert.equal(commitCount(w), 0);
    assert.ok(!fs.existsSync(path.join(w.clone, '.git', 'hooks', 'pre-commit')), 'no hook either');
  } finally {
    cleanup();
  }
});

test('a secret in settings.json that reaches the template refuses too', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    const settings = JSON.parse(fs.readFileSync(path.join(w.source, 'settings.json'), 'utf8'));
    settings.permissions.allow.push(`Bash(curl -H "x: ${FAKE_GITHUB_TOKEN}")`);
    fs.writeFileSync(path.join(w.source, 'settings.json'), JSON.stringify(settings));
    const { status, out } = exportConfig(w, '--apply');
    assert.equal(status, 1, out);
    assert.match(out, new RegExp(`${SETTINGS_TEMPLATE_FILE.replace('.', '\\.')}:\\d+ github-token`));
    assert.deepEqual(cloneFiles(w.clone), []);
  } finally {
    cleanup();
  }
});

test('--list-findings prints each finding with its would-be exception, and an accepted one lets the export through', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    const planted = `# tdd\n\npasted ${FAKE_GITHUB_TOKEN} here\n`;
    write(w.source, 'skills/tdd/SKILL.md', planted);

    const listed = exportConfig(w, '--list-findings');
    assert.equal(listed.status, 0, listed.out);
    assert.ok(!listed.out.includes(FAKE_GITHUB_TOKEN));
    const entry = { path: 'skills/tdd/SKILL.md', rule: 'github-token', line: 3, sha256: sha256(planted) };
    assert.ok(listed.out.includes(JSON.stringify(entry)), listed.out);
    assert.deepEqual(cloneFiles(w.clone), [], '--list-findings writes nothing, the exceptions file least of all');

    write(w.clone, SCAN_EXCEPTIONS_FILE, `${JSON.stringify([entry], null, 2)}\n`);
    const passed = exportConfig(w, '--apply');
    assert.equal(passed.status, 0, passed.out);
    assert.match(passed.out, /1 excepted/);
    assert.equal(commitCount(w), 1, 'the pre-commit hook accepted the same exception');

    // Any edit to the file brings the finding back.
    write(w.source, 'skills/tdd/SKILL.md', `${planted}one more line\n`);
    const back = exportConfig(w, '--apply');
    assert.equal(back.status, 1, back.out);
    assert.match(back.out, /skills\/tdd\/SKILL\.md:3 github-token/);
    assert.equal(commitCount(w), 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// --apply: mirror, commit, never push
// ---------------------------------------------------------------------------

test('a dry run lists the files and writes nothing', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    const { status, out } = exportConfig(w, '--dry-run');
    assert.equal(status, 0, out);
    for (const file of FIXTURE_FILES) assert.match(out, new RegExp(`new\\s+${file.replace(/\./g, '\\.')}`));
    assert.match(out, /files: 4 new, 0 changed, 0 unchanged, 0 deleted/);
    assert.match(out, /dry run: nothing written/);
    assert.deepEqual(cloneFiles(w.clone), []);
    assert.ok(!fs.existsSync(path.join(w.clone, '.git', 'hooks', 'pre-commit')));
  } finally {
    cleanup();
  }
});

test('apply mirrors the allowlist, writes the template, commits once and never pushes', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    // The fixture's paths name another home; point one at this one so the placeholder shows.
    const settingsFile = path.join(w.source, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.permissions.allow.push(`Read(${path.join(root, 'home', 'notes')}\\**)`);
    fs.writeFileSync(settingsFile, JSON.stringify(settings));

    const { status, out } = exportConfig(w, '--apply');
    assert.equal(status, 0, out);
    assert.deepEqual(cloneFiles(w.clone), ['.gitattributes', ...FIXTURE_FILES, SETTINGS_TEMPLATE_FILE].sort());
    for (const file of FIXTURE_FILES) {
      assert.equal(
        fs.readFileSync(path.join(w.clone, file), 'utf8'),
        fs.readFileSync(path.join(w.source, file), 'utf8'),
        file,
      );
    }
    const template = JSON.parse(fs.readFileSync(path.join(w.clone, SETTINGS_TEMPLATE_FILE), 'utf8'));
    assert.deepEqual(Object.keys(template).sort(), ['hooks', 'permissions']);
    assert.ok(JSON.stringify(template).includes(HOME_PLACEHOLDER));

    assert.equal(commitCount(w), 1);
    assert.match(git(root, w.clone, 'log', '-1', '--format=%s').stdout, /^chore: export ~\/\.claude config/);
    assert.equal(git(root, w.clone, 'status', '--porcelain').stdout, '', 'everything was committed');
    assert.equal(git(root, w.bare, 'for-each-ref').stdout, '', 'nothing reached the remote');
    assert.match(out, /not pushed/);

    const again = exportConfig(w, '--apply');
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /nothing to commit/);
    assert.equal(commitCount(w), 1);
  } finally {
    cleanup();
  }
});

test('the exporter never runs git push', () => {
  const source = fs.readFileSync(EXPORTER, 'utf8');
  assert.ok(!/['"]push['"]/.test(source), 'no git argument vector names push');
});

test('apply deletes stale files inside the clone only, and never touches the source', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    assert.equal(exportConfig(w, '--apply').status, 0);
    write(w.clone, 'README.md', '# claude-config\n');
    git(root, w.clone, 'add', 'README.md');
    git(root, w.clone, 'commit', '-q', '-m', 'docs: readme');

    fs.rmSync(path.join(w.source, 'rules', 'common', 'coding-style.md'));
    write(w.source, 'skills/new/SKILL.md', '# new skill\n');
    const sourceBefore = cloneFiles(w.source);

    const { status, out } = exportConfig(w, '--apply');
    assert.equal(status, 0, out);
    assert.match(out, /delete\s+rules\/common\/coding-style\.md/);
    assert.match(out, /files: 1 new, 0 changed, 3 unchanged, 1 deleted/);
    assert.ok(!fs.existsSync(path.join(w.clone, 'rules', 'common', 'coding-style.md')));
    assert.ok(fs.existsSync(path.join(w.clone, 'skills', 'new', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(w.clone, 'README.md')), 'a repo meta file is not stale');
    assert.deepEqual(cloneFiles(w.source), sourceBefore, 'the source is read, never written');
    assert.equal(commitCount(w), 3);
  } finally {
    cleanup();
  }
});

test('a clone holding something outside the allowlist is refused before anything is copied', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    write(w.clone, 'notes/private.md', 'not config\n');
    const { status, out } = exportConfig(w, '--apply');
    assert.equal(status, 1, out);
    assert.match(out, /notes.*outside the allowlist/);
    assert.deepEqual(cloneFiles(w.clone), ['notes/private.md']);
  } finally {
    cleanup();
  }
});

test('an empty source is refused rather than read as "delete everything"', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    assert.equal(exportConfig(w, '--apply').status, 0);
    const empty = { ...w, source: path.join(root, 'empty', '.claude') };
    fs.mkdirSync(empty.source, { recursive: true });
    const { status, out } = exportConfig(empty, '--apply');
    assert.equal(status, 1, out);
    assert.match(out, /no allowlisted files/);
    assert.equal(commitCount(w), 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The pre-commit hook
// ---------------------------------------------------------------------------

test('preCommitHookScript names this node and this checkout, and refuses a path the shell would mangle', () => {
  const script = preCommitHookScript({ node: 'C:\\Program Files\\nodejs\\node.exe', harnessRepo: 'C:\\h\\agentic-harness' });
  assert.ok(script.startsWith('#!/bin/sh\n'));
  assert.ok(script.includes(PRE_COMMIT_MARKER));
  assert.ok(script.includes('"${HARNESS_NODE:-C:/Program Files/nodejs/node.exe}"') || script.includes('HARNESS_NODE:-C:/Program Files/nodejs/node.exe'));
  assert.ok(script.includes('HARNESS_REPO:-C:/h/agentic-harness'));
  assert.ok(script.includes('--pre-commit'));
  for (const bad of ['C:/a"b', 'C:/$x', 'C:/`x`']) {
    assert.throws(() => preCommitHookScript({ node: bad, harnessRepo: 'C:/h' }), /cannot be written into the hook/);
  }
});

test('the pre-commit hook is installed once, and a foreign hook is never overwritten', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    assert.equal(exportConfig(w, '--apply').status, 0);
    const hook = path.join(w.clone, '.git', 'hooks', 'pre-commit');
    const first = fs.readFileSync(hook, 'utf8');
    assert.ok(first.includes(PRE_COMMIT_MARKER));

    const again = exportConfig(w, '--apply');
    assert.match(again.out, /pre-commit: unchanged/);
    assert.equal(fs.readFileSync(hook, 'utf8'), first);

    const other = world(path.join(root, 'b'));
    write(other.clone, '.git/hooks/pre-commit', '#!/bin/sh\necho someone else\n');
    const refused = exportConfig(other, '--apply');
    assert.equal(refused.status, 1, refused.out);
    assert.match(refused.out, /pre-commit hook that is not ours/);
    assert.deepEqual(cloneFiles(other.clone), []);
  } finally {
    cleanup();
  }
});

test('the pre-commit hook blocks a staged fake key, a denylisted path and a stray file', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    assert.equal(exportConfig(w, '--apply').status, 0);

    write(w.clone, 'skills/tdd/SKILL.md', `# tdd\n\npasted ${FAKE_GITHUB_TOKEN} here\n`);
    git(root, w.clone, 'add', '-A');
    const blocked = git(root, w.clone, 'commit', '-q', '-m', 'sneak a key in');
    assert.notEqual(blocked.status, 0, 'the commit is refused');
    const said = `${blocked.stdout}${blocked.stderr}`;
    assert.match(said, /skills\/tdd\/SKILL\.md:3 github-token/);
    assert.ok(!said.includes(FAKE_GITHUB_TOKEN));
    assert.equal(commitCount(w), 1);

    git(root, w.clone, 'reset', '-q', '--hard');
    write(w.clone, 'skills/tdd/.env.local', 'A=1\n');
    write(w.clone, 'notes.md', 'stray\n');
    git(root, w.clone, 'add', '-A');
    const paths = git(root, w.clone, 'commit', '-q', '-m', 'stray files');
    assert.notEqual(paths.status, 0);
    assert.match(`${paths.stderr}`, /skills\/tdd\/\.env\.local.*denylist:\.env\*/);
    assert.match(`${paths.stderr}`, /notes\.md.*not-allowlisted/);
    assert.equal(commitCount(w), 1);
  } finally {
    cleanup();
  }
});

test('the pre-commit hook reads .scan-exceptions.json from the staged tree, not the working tree', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    assert.equal(exportConfig(w, '--apply').status, 0);

    const planted = `# tdd\n\npasted ${FAKE_GITHUB_TOKEN} here\n`;
    write(w.clone, 'skills/tdd/SKILL.md', planted);
    const entry = { path: 'skills/tdd/SKILL.md', rule: 'github-token', line: 3, sha256: sha256(planted) };
    write(w.clone, SCAN_EXCEPTIONS_FILE, `${JSON.stringify([entry], null, 2)}\n`);
    git(root, w.clone, 'add', 'skills/tdd/SKILL.md'); // the exception stays unstaged

    const unstaged = git(root, w.clone, 'commit', '-q', '-m', 'key, exception not staged');
    assert.notEqual(unstaged.status, 0, 'an exception only in the working tree accepts nothing');
    assert.match(`${unstaged.stderr}`, /skills\/tdd\/SKILL\.md:3 github-token/);
    assert.equal(commitCount(w), 1);

    git(root, w.clone, 'add', SCAN_EXCEPTIONS_FILE);
    const staged = git(root, w.clone, 'commit', '-q', '-m', 'key, exception staged');
    assert.equal(staged.status, 0, `${staged.stdout}${staged.stderr}`);
    assert.equal(commitCount(w), 2);
  } finally {
    cleanup();
  }
});

test('the pre-commit hook finds a fake key in a staged UTF-16 file', () => {
  const { root, cleanup } = scratch();
  try {
    const w = world(root);
    assert.equal(exportConfig(w, '--apply').status, 0);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`use ${FAKE_GITHUB_TOKEN}\r\n`, 'utf16le')]);
    write(w.clone, 'skills/tdd/notes.md', utf16);
    git(root, w.clone, 'add', '-A');
    const blocked = git(root, w.clone, 'commit', '-q', '-m', 'utf-16 key');
    assert.notEqual(blocked.status, 0);
    assert.match(`${blocked.stderr}`, /skills\/tdd\/notes\.md:1 github-token/);
    assert.equal(commitCount(w), 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Which checkout the hook calls back into
// ---------------------------------------------------------------------------

/** A committed repo at <root>/main and a worktree of it at <root>/wt. */
function repoWithWorktree(root) {
  const main = path.join(root, 'main');
  execFileSync('git', ['init', '-q', '-b', 'main', main], { env: gitEnv(root) });
  write(main, 'README.md', 'x\n');
  git(root, main, 'add', '-A');
  assert.equal(git(root, main, 'commit', '-q', '-m', 'init').status, 0);
  const wt = path.join(root, 'wt');
  assert.equal(git(root, main, 'worktree', 'add', '-q', '-b', 'feature', wt).status, 0);
  return { main, wt };
}

const samePath = (a, b) => canonicalFixturePath(a).toLowerCase() === canonicalFixturePath(b).toLowerCase();
/** The checkout a pre-commit hook's text falls back to when HARNESS_REPO is unset. */
const bakedRepo = (hookText) => /HARNESS_REPO:-([^}]*)\}/.exec(hookText)[1];

test('harnessCheckout: a worktree resolves to its main checkout; the main checkout and a non-repo to themselves', () => {
  const { root, cleanup } = scratch();
  try {
    const { main, wt } = repoWithWorktree(root);
    const fromWorktree = harnessCheckout(wt);
    assert.ok(samePath(fromWorktree.path, main), fromWorktree.path);
    assert.ok(samePath(fromWorktree.worktree, wt));
    const fromMain = harnessCheckout(main);
    assert.ok(samePath(fromMain.path, main));
    assert.equal(fromMain.worktree, null);
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    assert.deepEqual(harnessCheckout(plain), { path: plain, worktree: null });
  } finally {
    cleanup();
  }
});

test('export run from a worktree bakes the main checkout into the hook, says so, and HARNESS_REPO still wins', () => {
  const { root, cleanup } = scratch();
  try {
    const { main, wt } = repoWithWorktree(root);
    // This checkout's hooks/ (not its tests) stands in for the harness, in both checkouts.
    for (const dir of [main, wt]) {
      fs.cpSync(path.join(HARNESS_ROOT, 'hooks'), path.join(dir, 'hooks'), {
        recursive: true,
        filter: (source) => !/[\\/](tests|node_modules)$/.test(source),
      });
    }
    const w = world(path.join(root, 'w'));
    const { HARNESS_REPO: _unset, ...env } = gitEnv(w.root);
    const args = [path.join(wt, 'hooks', 'export-config.mjs'), '--apply', '--config-repo', w.clone, '--source', w.source];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 120_000 });
    const out = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, out);
    assert.match(out, /pre-commit: calls the main checkout .* \(this run is from the worktree /);

    const hookFile = path.join(w.clone, '.git', 'hooks', 'pre-commit');
    const baked = bakedRepo(fs.readFileSync(hookFile, 'utf8'));
    assert.ok(samePath(baked, main), `the hook names ${baked}, not the main checkout ${main}`);
    assert.equal(commitCount(w), 1, "the commit went through the main checkout's gate");

    // HARNESS_REPO at export time is what gets baked, worktree or not.
    const pinned = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...env, HARNESS_REPO: wt }, timeout: 120_000 });
    assert.equal(pinned.status, 0, `${pinned.stdout}${pinned.stderr}`);
    assert.ok(samePath(bakedRepo(fs.readFileSync(hookFile, 'utf8')), wt));
  } finally {
    cleanup();
  }
});
