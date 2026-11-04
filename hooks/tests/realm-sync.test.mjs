/**
 * Realm sync with a scripted git: the exact argument arrays, in order, for
 * every path through commit → merge-pull → push (R-B1, R-B2, R-B3, R-B4).
 *
 * Real git lives in realm-sync-git.test.mjs; this file proves what is asked
 * of git and, just as much, what never is.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SYNC_PATHSPECS } from '../lib/realm-guard.mjs';
import { REALM_LOCK_FILENAME } from '../lib/realm-lock.mjs';
import { parseRealmPolicies, realmDir, realmRootFor, syncGitEnv, syncRealms } from '../lib/realm-sync.mjs';
import { classifyPullFailure, classifyPushFailure } from '../lib/realm-steps.mjs';
import { parseArgs, run } from '../sync-realms.mjs';

const NOW = new Date('2026-09-22T03:00:00Z');
const MINUTE_MS = 60_000;
const ABSENT_MACHINE_ENV = path.join(os.tmpdir(), 'absent-machine.env');

function scratchVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-sync-'));
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  return { root, vault, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A realm folder with its marker and a real (empty) `.git` directory: enough for the lock and marker checks. */
function realm(vault, name, { git = 'dir' } = {}) {
  const dir = path.join(vault, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.realm'), `${name}\n`);
  if (git === 'dir') fs.mkdirSync(path.join(dir, '.git'));
  if (git === 'file') fs.writeFileSync(path.join(dir, '.git'), 'gitdir: elsewhere\n');
  return dir;
}

const ok = (stdout = '') => ({ ok: true, stdout });
const fail = (status, stderr = '') => ({ ok: false, stdout: '', error: `exit ${status}`, status, stderr });

/** What an ordinary night looks like: one changed note, one commit ahead of the remote. */
const DEFAULT_ANSWERS = Object.freeze({
  'symbolic-ref -q': ok('main\n'),
  'remote get-url': ok('https://example.invalid/projects.git\n'),
  'rev-parse --abbrev-ref': ok('origin/main\n'),
  'status --porcelain=v1': ok(' M a.md\0'),
  'ls-files -z': ok('a.md\0.realm\0'),
  'diff --cached': ok('a.md\0'),
  'rev-list --count': ok('1\n'),
  'rev-parse -q': fail(1),
});

/**
 * A scripted git: `answers` maps the first two args to a result, a list of
 * results (consumed in order, the last one repeats) or a function. Records
 * every call's args and options.
 */
function scriptedGit(answers = {}) {
  const calls = [];
  const table = { ...DEFAULT_ANSWERS, ...answers };
  const served = new Map();
  const runGit = (args, options) => {
    calls.push({ args, options });
    const key = args.slice(0, 2).join(' ');
    const answer = table[key];
    if (typeof answer === 'function') return answer(args, options);
    if (Array.isArray(answer)) {
      const at = served.get(key) ?? 0;
      served.set(key, at + 1);
      return answer[Math.min(at, answer.length - 1)];
    }
    return answer ?? ok('');
  };
  return { runGit, calls, argv: () => calls.map((c) => c.args) };
}

function sync(vault, realms, { mode = 'push', answers, ...rest } = {}) {
  const git = scriptedGit(answers);
  const results = syncRealms({
    vaultRoot: vault,
    policies: parseRealmPolicies(realms),
    mode,
    machine: 'home-pc',
    email: 'home@example.com',
    runGit: git.runGit,
    stat: () => 10,
    clock: () => NOW,
    baseEnv: {},
    ...rest,
  });
  return { ...git, results, result: results[0] };
}

/** Run `fn(vault, dir)` against a scratch vault holding one realm, `projects`. */
function withRealm(fn, options) {
  const { vault, cleanup } = scratchVault();
  try {
    return fn(vault, realm(vault, 'projects', options));
  } finally {
    cleanup();
  }
}

const STATUS = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
const PREFLIGHT = [['symbolic-ref', '-q', '--short', 'HEAD'], ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], ['remote', 'get-url', 'origin']];
const LIST = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SYNC_PATHSPECS];
const ADD = ['add', '--all', '--', ':(glob)**/*.md', '.realm'];
const STAGED = ['diff', '--cached', '--name-only', '-z'];
const COMMIT = ['commit', '--quiet', '-m', 'harness: sync from home-pc 2026-09-22T03:00:00.000Z'];
const PULL = ['pull', '--no-rebase', '--ff', '--no-autostash', '--no-edit', '--quiet'];
const AHEAD = ['rev-list', '--count', '@{u}..HEAD'];
const PUSH = ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'];
const MERGE_HEAD = ['rev-parse', '-q', '--verify', 'MERGE_HEAD'];

const FORBIDDEN = new Set(['rebase', '--rebase', 'stash', '--autostash', '--force', '-f', '--force-with-lease', '-A', 'reset', 'checkout', 'clean']);
const commands = (argv) => argv.map((args) => args[0]);

// ------------------------------------------------------------------ policies

test('parseRealmPolicies mirrors the Python side', () => {
  assert.deepEqual(parseRealmPolicies('projects:push, classes:local'), [
    { name: 'projects', policy: 'push' },
    { name: 'classes', policy: 'local' },
  ]);
  assert.deepEqual(parseRealmPolicies(''), []);
  for (const bad of ['projects', 'projects:sync', 'Projects:push', 'a:push,a:local']) {
    assert.throws(() => parseRealmPolicies(bad), /HARNESS_REALMS/);
  }
});

test('realmRootFor is the vault root whenever the root carries a marker, else the folder realm', () => {
  const { vault, cleanup } = scratchVault();
  try {
    const dir = realm(vault, 'projects');
    assert.equal(realmRootFor(vault, 'projects'), dir);
    assert.equal(realmRootFor(vault, 'classes'), '');
    fs.writeFileSync(path.join(vault, '.realm'), 'personal\n');
    assert.equal(realmRootFor(vault, 'projects'), vault, 'an area under a root realm lives in the root realm');
  } finally {
    cleanup();
  }
});

test('realmDir finds a folder realm or a root realm, and refuses a mismatch', () => {
  const { vault, cleanup } = scratchVault();
  try {
    const dir = realm(vault, 'projects');
    assert.equal(realmDir(vault, 'projects'), dir);
    assert.equal(realmDir(vault, 'classes'), '');
    fs.writeFileSync(path.join(vault, '.realm'), 'personal\n');
    assert.equal(realmDir(vault, 'personal'), vault);
    assert.equal(realmDir(vault, 'projects'), '', 'a root marker makes the whole vault one realm');
  } finally {
    cleanup();
  }
});

// ----------------------------------------------------------- the sequence (R-B1)

test('R-B1: push mode runs commit, merge-pull, push with these exact arguments', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push');
    assert.deepEqual(argv(), [...PREFLIGHT, STATUS, LIST, ADD, STAGED, COMMIT, PULL, AHEAD, PUSH]);
    assert.deepEqual(result.steps, ['committed', 'pulled', 'pushed']);
    assert.equal(result.outcome, 'ok');
    assert.equal(result.error, '');
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.steps) && Object.isFrozen(result.notes));
  }));

test('R-B1: pull mode is the same sequence without the push', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { mode: 'pull' });
    assert.deepEqual(argv(), [...PREFLIGHT, STATUS, LIST, ADD, STAGED, COMMIT, PULL]);
    assert.deepEqual(result.steps, ['committed', 'pulled']);
  }));

test('R-B1: no argument ever rebases, stashes, forces, resets, checks out or cleans', () => {
  const scenarios = {
    success: {},
    conflict: { 'pull --no-rebase': fail(1, 'CONFLICT (content)'), 'rev-parse -q': [ok('abc\n'), fail(1)], 'diff --name-only': ok('note.md\0') },
    error: { 'pull --no-rebase': fail(1, 'fatal: unable to access'), 'push --quiet': fail(1, 'rejected') },
    dryRun: {},
  };
  for (const [label, answers] of Object.entries(scenarios)) {
    withRealm((vault) => {
      const { argv } = sync(vault, 'projects:push', { answers, dryRun: label === 'dryRun' });
      for (const args of argv()) {
        for (const token of args) {
          assert.ok(!FORBIDDEN.has(token), `${label}: forbidden token ${token} in ${args.join(' ')}`);
          assert.ok(!token.startsWith('+'), `${label}: forced refspec in ${args.join(' ')}`);
        }
      }
    });
  }
});

test('R-B1: a conflicting pull is aborted and reported, the local commit stays, nothing is pushed', () =>
  withRealm((vault) => {
    const answers = { 'pull --no-rebase': fail(1, 'CONFLICT (add/add): Merge conflict in note.md'), 'rev-parse -q': [ok('abc\n'), fail(1)], 'diff --name-only': ok('note.md\0') };
    const { result, argv } = sync(vault, 'projects:push', { answers });
    assert.deepEqual(argv().slice(0, 8), [...PREFLIGHT, STATUS, LIST, ADD, STAGED, COMMIT]);
    assert.deepEqual(argv().slice(8), [PULL, MERGE_HEAD, ['diff', '--name-only', '--diff-filter=U', '-z'], ['merge', '--abort'], MERGE_HEAD]);
    assert.equal(result.outcome, 'conflict');
    assert.deepEqual(result.steps, ['committed']);
    assert.match(result.error, /note\.md/);
    assert.ok(!commands(argv()).includes('push'));
  }));

test('R-B1: a pull that fails without MERGE_HEAD is never aborted', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'pull --no-rebase': fail(128, 'fatal: unable to access remote') } });
    assert.ok(!commands(argv()).includes('merge'));
    assert.deepEqual(argv().at(-1), MERGE_HEAD);
    assert.equal(result.outcome, 'error');
    assert.match(result.error, /^pull failed \(exit 128\): fatal: unable to access remote/);
  }));

test('R-B4: a pull that needs a credential it cannot get fails closed and says credential', () =>
  withRealm((vault) => {
    const stderr = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    const { result } = sync(vault, 'projects:push', { answers: { 'pull --no-rebase': fail(128, stderr) } });
    assert.equal(result.outcome, 'error');
    assert.match(result.error, /^credential missing or rejected for origin: .*terminal prompts disabled/);
  }));

test('a merge that would overwrite local changes outside the sync paths is an error, not an abort', () =>
  withRealm((vault) => {
    const stderr = 'error: Your local changes to the following files would be overwritten by merge:\n\tscratch.txt';
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'pull --no-rebase': fail(1, stderr) } });
    assert.equal(result.error, 'local changes outside the sync paths block the merge');
    assert.ok(!commands(argv()).includes('merge'));
  }));

// ---------------------------------------------------------- remote and branch

test('no origin remote: commit only, and the night is still in order', () =>
  withRealm((vault) => {
    const answers = { 'rev-parse --abbrev-ref': fail(128, 'fatal: no upstream configured for branch'), 'remote get-url': fail(2, "error: No such remote 'origin'") };
    const { result, argv } = sync(vault, 'projects:push', { answers });
    assert.deepEqual(result.steps, ['committed', 'no-remote', 'no-remote']);
    assert.equal(result.outcome, 'ok');
    assert.deepEqual(argv().slice(0, 3), PREFLIGHT);
    assert.ok(!commands(argv()).some((c) => ['pull', 'push', 'rev-list'].includes(c)));
  }));

test('the push goes to the upstream branch, not to the local branch name', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'rev-parse --abbrev-ref': ok('origin/master\n') } });
    assert.equal(result.outcome, 'ok', result.error);
    assert.deepEqual(argv().at(-1), ['push', '--quiet', 'origin', 'HEAD:refs/heads/master']);
  }));

test('an upstream on another remote: that remote is checked and pushed to, and a branch may hold a slash', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'rev-parse --abbrev-ref': ok('hub/notes/main\n') } });
    assert.equal(result.outcome, 'ok', result.error);
    assert.deepEqual(argv()[2], ['remote', 'get-url', 'hub']);
    assert.ok(!argv().some((a) => a.join(' ') === 'remote get-url origin'));
    assert.deepEqual(argv().at(-1), ['push', '--quiet', 'hub', 'HEAD:refs/heads/notes/main']);
  }));

test('an upstream that is a local branch is an error before anything is staged', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'rev-parse --abbrev-ref': ok('main\n') } });
    assert.equal(result.outcome, 'error');
    assert.match(result.error, /upstream 'main' is not a remote branch/);
    assert.ok(!commands(argv()).includes('status'));
  }));

test('no upstream is an error before anything is staged', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'rev-parse --abbrev-ref': fail(128, 'fatal: no upstream configured') } });
    assert.equal(result.outcome, 'error');
    assert.equal(result.error, 'no upstream on origin; run git push -u origin main once by hand');
    assert.deepEqual(argv(), PREFLIGHT);
  }));

test('a detached HEAD is an error before anything else', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'symbolic-ref -q': fail(1) } });
    assert.equal(result.outcome, 'error');
    assert.match(result.error, /detached HEAD/);
    assert.equal(argv().length, 1);
  }));

test('a merge, rebase, cherry-pick or revert in progress, or an index.lock, stops the realm with no git call', () => {
  const cases = [['MERGE_HEAD', 'conflict'], ['rebase-merge', 'conflict'], ['rebase-apply', 'conflict'], ['CHERRY_PICK_HEAD', 'conflict'], ['REVERT_HEAD', 'conflict'], ['index.lock', 'error']];
  for (const [marker, outcome] of cases) {
    withRealm((vault, dir) => {
      fs.writeFileSync(path.join(dir, '.git', marker), '');
      const { result, calls } = sync(vault, 'projects:push');
      assert.equal(result.outcome, outcome, marker);
      assert.equal(calls.length, 0, marker);
      assert.ok(!fs.existsSync(path.join(dir, '.git', REALM_LOCK_FILENAME)), 'the lock is given back');
    });
  }
});

test('a realm that is missing, has no .git, or whose .git is a file', () => {
  const { vault, cleanup } = scratchVault();
  try {
    realm(vault, 'classes', { git: 'none' });
    realm(vault, 'projects', { git: 'file' });
    const { results, calls } = sync(vault, 'projects:push,classes:local,work-vm:push');
    assert.deepEqual(results.map((r) => [r.name, r.outcome]), [['projects', 'error'], ['classes', 'skip'], ['work-vm', 'skip']]);
    assert.match(results[0].error, /\.git is a file/);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

// -------------------------------------------------------------- staging (R-B2)

test('R-B2: a stray .env is not in the add arguments and is named on a not staged note', () =>
  withRealm((vault) => {
    const { result, calls } = sync(vault, 'projects:push', { answers: { 'status --porcelain=v1': ok(' M a.md\0?? .env\0?? x.txt\0?? y.bin\0?? z.log\0') } });
    const add = calls.find((c) => c.args[0] === 'add');
    assert.ok(!add.args.includes('.env'));
    assert.deepEqual(add.args, ADD);
    assert.ok(result.notes.includes('not staged: .env; x.txt; y.bin; …1 more'), result.notes.join('\n'));
    assert.equal(result.outcome, 'ok');
  }));

test('R-B2: a file staged by hand outside the sync paths refuses the realm, nothing is added', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'status --porcelain=v1': ok(' M a.md\0A  .env\0') } });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.error, 'staged by hand outside the sync paths: .env; run git restore --staged');
    assert.deepEqual(argv(), [...PREFLIGHT, STATUS]);
  }));

test('R-B2: a hand-staged rename from outside the sync paths refuses the realm and names both ends', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'status --porcelain=v1': ok('R  notes/n.md\0drafts/n.txt\0') } });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.error, 'staged by hand outside the sync paths: drafts/n.txt -> notes/n.md; run git restore --staged');
    assert.deepEqual(argv(), [...PREFLIGHT, STATUS]);
  }));

test('R-B2: the add arguments are exactly the pathspecs that match something', () =>
  withRealm((vault) => {
    const listed = ok('a.md\0.obsidian/app.json\0attachments/x.png\0.gitignore\0');
    const { calls } = sync(vault, 'projects:push', { answers: { 'ls-files -z': listed, 'diff --cached': ok('a.md\0') } });
    assert.deepEqual(calls.find((c) => c.args[0] === 'add').args, ['add', '--all', '--', ':(glob)**/*.md', ':(glob).obsidian/*.json', 'attachments/', '.gitignore']);
  }));

test('nothing staged after add is clean: no commit, and the pull still runs', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'diff --cached': ok('') } });
    assert.ok(!commands(argv()).includes('commit'));
    assert.deepEqual(result.steps, ['clean', 'pulled', 'pushed']);
  }));

test('no change on a sync path is clean without a scan or an add', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'status --porcelain=v1': ok('') } });
    assert.ok(!commands(argv()).some((c) => ['ls-files', 'add', 'commit'].includes(c)));
    assert.deepEqual(result.steps, ['clean', 'pulled', 'pushed']);
  }));

test('a staged path the guard never scanned stops the realm before the commit', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'diff --cached': ok('a.md\0late.md\0') } });
    assert.equal(result.outcome, 'error');
    assert.match(result.error, /late\.md.*appeared during the run/);
    assert.ok(!commands(argv()).some((c) => ['commit', 'pull', 'push'].includes(c)));
  }));

test('the guard refuses a name one platform rejects before anything is staged', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'status --porcelain=v1': ok('?? CON.md\0'), 'ls-files -z': ok('a.md\0CON.md\0') } });
    assert.equal(result.outcome, 'refused');
    assert.match(result.error, /1 path\(s\) refused: CON\.md.*device name/);
    assert.ok(!commands(argv()).includes('add'));
  }));

test('a large attachment is committed and reported', () =>
  withRealm((vault) => {
    const answers = { 'status --porcelain=v1': ok('?? attachments/deck.pptx\0'), 'ls-files -z': ok('attachments/deck.pptx\0'), 'diff --cached': ok('attachments/deck.pptx\0') };
    const { result } = sync(vault, 'projects:local', { answers, stat: () => 5 * 1024 * 1024 + 1 });
    assert.deepEqual(result.steps, ['committed', 'pulled', 'kept-local']);
    assert.ok(result.notes.includes('reported: attachments/deck.pptx: 5.0 MiB is over 5 MiB'));
  }));

test('a symlink is sized as git commits it: the link, not the file it points at', (t) => {
  const { vault, cleanup } = scratchVault();
  t.after(cleanup);
  const dir = realm(vault, 'projects');
  const target = path.join(dir, 'big.bin');
  fs.writeFileSync(target, Buffer.alloc(5 * 1024 * 1024 + 1));
  fs.mkdirSync(path.join(dir, 'attachments'));
  try {
    fs.symlinkSync(target, path.join(dir, 'attachments', 'link.bin'));
  } catch (err) {
    if (process.platform === 'win32' && err?.code === 'EPERM') return t.skip('creating a symlink needs Developer Mode or admin on Windows');
    throw err;
  }
  const answers = { 'status --porcelain=v1': ok('?? attachments/link.bin\0'), 'ls-files -z': ok('attachments/link.bin\0'), 'diff --cached': ok('attachments/link.bin\0') };
  const { result } = sync(vault, 'projects:local', { answers, stat: undefined });
  assert.deepEqual(result.steps, ['committed', 'pulled', 'kept-local'], result.error);
  assert.ok(!result.notes.some((n) => n.startsWith('reported:')), result.notes.join('\n'));
});

test('a listing that fails is an error, not a commit of whatever is there', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'ls-files -z': { ok: false, stdout: '', error: 'ETIMEDOUT', status: null, stderr: '' } } });
    assert.equal(result.outcome, 'error');
    assert.match(result.error, /ls-files failed/);
    assert.ok(!commands(argv()).includes('add'));
  }));

// --------------------------------------------------------------------- push

test('a local realm is kept local: no rev-list, no push', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:local');
    assert.deepEqual(result.steps, ['committed', 'pulled', 'kept-local']);
    assert.ok(!commands(argv()).some((c) => c === 'rev-list' || c === 'push'));
  }));

test('nothing ahead of the remote is up to date, with no push', () =>
  withRealm((vault) => {
    const { result, argv } = sync(vault, 'projects:push', { answers: { 'rev-list --count': ok('0\n') } });
    assert.deepEqual(result.steps, ['committed', 'pulled', 'up-to-date']);
    assert.ok(!commands(argv()).includes('push'));
  }));

test('a rejected push is an error that says why', () =>
  withRealm((vault) => {
    const stderr = ' ! [rejected]        HEAD -> main (fetch first)';
    const { result } = sync(vault, 'projects:push', { answers: { 'push --quiet': fail(1, stderr) } });
    assert.equal(result.outcome, 'error');
    assert.match(result.error, /rejected/);
    assert.deepEqual(result.steps, ['committed', 'pulled']);
  }));

// ----------------------------------------------------------------- identity (R-B4)

test('R-B4: every git call carries the identity, no prompts, stderr capture and its timeout', () =>
  withRealm((vault) => {
    const { calls } = sync(vault, 'projects:push');
    const expected = {
      GCM_INTERACTIVE: 'never',
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_AUTHOR_NAME: 'home-pc',
      GIT_AUTHOR_EMAIL: 'home@example.com',
      GIT_COMMITTER_NAME: 'home-pc',
      GIT_COMMITTER_EMAIL: 'home@example.com',
    };
    for (const { args, options } of calls) {
      assert.deepEqual({ ...options.env }, expected, args.join(' '));
      assert.equal(options.captureStderr, true);
      assert.equal(options.timeoutMs, ['pull', 'push'].includes(args[0]) ? 120_000 : 90_000, args.join(' '));
    }
  }));

test('R-B4: without an email git config applies and the realm says so', () => {
  const env = syncGitEnv({ machine: 'home-pc', email: '', baseEnv: {} });
  assert.deepEqual({ ...env }, { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' });
  assert.ok(Object.isFrozen(env));
  withRealm((vault) => {
    const { result, calls } = sync(vault, 'projects:push', { email: '' });
    assert.ok(result.notes.includes('identity: git config (set HARNESS_MACHINE and HARNESS_GIT_EMAIL)'));
    assert.ok(calls.every((c) => !('GIT_AUTHOR_NAME' in c.options.env)));
  });
});

test('R-B4: ssh runs in batch mode unless the user already chose an ssh command', () => {
  assert.equal(syncGitEnv({ baseEnv: {} }).GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  assert.ok(!('GIT_SSH_COMMAND' in syncGitEnv({ baseEnv: { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/vault' } })), "the user's GIT_SSH_COMMAND is left to flow through");
  assert.ok(!('GIT_SSH_COMMAND' in syncGitEnv({ baseEnv: { GIT_SSH: 'plink.exe' } })), 'GIT_SSH is left alone too');
});

test('R-B4: ssh refusals under batch mode read as a credential failure', () => {
  const stderrs = [
    'Host key verification failed.\nfatal: Could not read from remote repository.',
    'git@github.com: Permission denied (publickey,password).',
    'Permission denied (publickey).',
    'ssh: BatchMode: passphrase prompt refused',
  ];
  for (const stderr of stderrs) {
    assert.match(classifyPullFailure(fail(128, stderr)), /^credential missing or rejected for origin: /, stderr);
    assert.match(classifyPushFailure(fail(128, stderr)), /^credential missing or rejected for origin: /, stderr);
  }
});

// ------------------------------------------------------------------ dry run

test('a dry run asks git only questions: no add, commit, pull, push, merge, and no lock file', () =>
  withRealm((vault, dir) => {
    const seen = [];
    const { result, argv } = sync(vault, 'projects:push', {
      dryRun: true,
      answers: { 'status --porcelain=v1': () => (seen.push(fs.readdirSync(path.join(dir, '.git'))), ok(' M a.md\0')) },
    });
    assert.ok(!commands(argv()).some((c) => ['add', 'commit', 'pull', 'push', 'merge', 'rev-list'].includes(c)));
    assert.deepEqual(result.steps, ['would-commit', 'would-pull', 'would-push']);
    assert.equal(result.dryRun, true);
    assert.deepEqual(seen, [[]], 'no lock file while it ran');
  }));

test('a dry run with nothing to commit counts what is ahead: 0 is up to date, more would push', () => {
  for (const [count, word] of [['0\n', 'up-to-date'], ['2\n', 'would-push']]) {
    withRealm((vault) => {
      const answers = { 'status --porcelain=v1': ok(''), 'rev-list --count': ok(count) };
      const { result, argv } = sync(vault, 'projects:push', { dryRun: true, answers });
      assert.deepEqual(result.steps, ['clean', 'would-pull', word], count);
      assert.deepEqual(argv().at(-1), AHEAD, 'rev-list is local and read-only, so a dry run asks it');
      assert.ok(!commands(argv()).includes('push'));
    });
  }
});

// --------------------------------------------------------------- lock (R-B3)

function writeLock(dir, { pid, ageMinutes }) {
  const startedAt = new Date(NOW.getTime() - ageMinutes * MINUTE_MS).toISOString();
  fs.writeFileSync(path.join(dir, '.git', REALM_LOCK_FILENAME), JSON.stringify({ pid, owner: 'sync --push', startedAt, token: 'theirs' }));
}

function cli(vault, realms, { runGit, argv = ['--push'] }) {
  const lines = [];
  const env = { HARNESS_REALMS: realms, HARNESS_MACHINE: 'home-pc', HARNESS_GIT_EMAIL: 'home@example.com', HARNESS_MACHINE_ENV: ABSENT_MACHINE_ENV };
  const code = run([...argv, '--vault', vault], { env, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), runGit, stat: () => 10, clock: () => NOW });
  return { code, lines };
}

test('R-B3: a fresh lock stops that realm with exit 2 and no git call; the other realm still syncs', () => {
  const { vault, cleanup } = scratchVault();
  try {
    const projects = realm(vault, 'projects');
    const classes = realm(vault, 'classes');
    writeLock(projects, { pid: 999, ageMinutes: 1 });
    const git = scriptedGit();
    const { code, lines } = cli(vault, 'projects:push,classes:push', { runGit: git.runGit });
    assert.equal(code, 2);
    assert.match(lines[0], /^projects: locked \(held by sync --push, pid 999, since 2026-09-22T02:59:00\.000Z\)$/);
    assert.equal(lines[1], 'classes: committed -> pulled -> pushed');
    assert.ok(git.calls.every((c) => c.options.cwd === classes));
    assert.ok(fs.existsSync(path.join(projects, '.git', REALM_LOCK_FILENAME)), "the holder's lock is untouched");
  } finally {
    cleanup();
  }
});

test('R-B3: a 31-minute-old lock is taken over, said so, and gone afterwards', () =>
  withRealm((vault, dir) => {
    writeLock(dir, { pid: 4242, ageMinutes: 31 });
    const { code, lines } = cli(vault, 'projects:push', { runGit: scriptedGit().runGit });
    assert.equal(code, 0);
    assert.deepEqual(lines, ['projects: committed -> pulled -> pushed', 'projects: lock: taken over from sync --push, pid 4242, since 2026-09-22T02:29:00.000Z (31 min old)']);
    assert.ok(!fs.existsSync(path.join(dir, '.git', REALM_LOCK_FILENAME)));
  }));

test('R-B3: each realm reads the clock for its own lock and its own commit, so a late realm is not born old', () => {
  const { vault, cleanup } = scratchVault();
  try {
    realm(vault, 'projects');
    realm(vault, 'classes');
    const readings = [];
    const clock = () => {
      const reading = new Date(NOW.getTime() + readings.length * 7 * MINUTE_MS);
      readings.push(reading.toISOString());
      return reading;
    };
    const lockStarts = [];
    const readLockStart = (args, options) => {
      const lock = JSON.parse(fs.readFileSync(path.join(options.cwd, '.git', REALM_LOCK_FILENAME), 'utf8'));
      lockStarts.push(lock.startedAt);
      return ok(' M a.md\0');
    };
    const { argv } = sync(vault, 'projects:push,classes:push', { clock, answers: { 'status --porcelain=v1': readLockStart } });
    const messages = argv().filter((args) => args[0] === 'commit').map((args) => args.at(-1));
    assert.equal(readings.length, 4, 'one reading per lock and one per commit');
    assert.deepEqual(lockStarts, [readings[0], readings[2]]);
    assert.notEqual(lockStarts[0], lockStarts[1]);
    assert.deepEqual(messages, [`harness: sync from home-pc ${readings[1]}`, `harness: sync from home-pc ${readings[3]}`]);
  } finally {
    cleanup();
  }
});

test('R-B3: a git runner that throws mid-sequence still gives the lock back', () =>
  withRealm((vault, dir) => {
    const answers = { 'add --all': () => { throw new Error('boom'); } };
    assert.throws(() => sync(vault, 'projects:push', { answers }), /boom/);
    assert.ok(!fs.existsSync(path.join(dir, '.git', REALM_LOCK_FILENAME)));
  }));

// -------------------------------------------------------------- command line

test('the command needs exactly one of --pull and --push, and no realms means nothing to do', () => {
  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(['--pull', '--push']).ok, false);
  assert.equal(parseArgs(['--push', '--dry-run'], { HARNESS_VAULT: 'v' }).options.dryRun, true);

  const lines = [];
  const code = run(['--pull'], { env: { HARNESS_REALMS: '', HARNESS_MACHINE_ENV: ABSENT_MACHINE_ENV }, out: (l) => lines.push(l), err: () => {} });
  assert.equal(code, 0);
  assert.match(lines[0], /nothing to sync/);
});

test('the command prints one line per realm, a note per line, and exits 2 on a conflict or a dry-run refusal', () => {
  const { vault, cleanup } = scratchVault();
  try {
    realm(vault, 'projects');
    const conflict = scriptedGit({ 'pull --no-rebase': fail(1, 'CONFLICT'), 'rev-parse -q': [ok('abc\n'), fail(1)], 'diff --name-only': ok('note.md\0'), 'status --porcelain=v1': ok(' M a.md\0?? .env\0') });
    const first = cli(vault, 'projects:push', { runGit: conflict.runGit });
    assert.equal(first.code, 2);
    assert.deepEqual(first.lines, ['projects: committed -> conflict (merge conflict in note.md; merge aborted, the local commit stays)', 'projects: not staged: .env']);

    const refusal = scriptedGit({ 'status --porcelain=v1': ok('?? CON.md\0'), 'ls-files -z': ok('CON.md\0') });
    const dry = cli(vault, 'projects:push', { runGit: refusal.runGit, argv: ['--push', '--dry-run'] });
    assert.equal(dry.code, 2);
    assert.match(dry.lines[0], /^projects: would-refuse \(1 path\(s\) refused: CON\.md/);

    const missing = cli(vault, 'work-vm:push', { runGit: scriptedGit().runGit });
    assert.deepEqual(missing, { code: 0, lines: ['work-vm: skip (not on this machine)'] });
  } finally {
    cleanup();
  }
});
