import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { diagnose, formatRows, problemRows, realmsOnDisk, runDoctor } from '../doctor.mjs';

const DOCTOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'doctor.mjs');

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('realmsOnDisk reads a root marker, or one per top-level folder', () => {
  const { root, cleanup } = scratch();
  try {
    fs.mkdirSync(path.join(root, 'projects'));
    fs.mkdirSync(path.join(root, 'daily'));
    fs.writeFileSync(path.join(root, 'projects', '.realm'), 'projects\n');
    assert.deepEqual(realmsOnDisk(root), [{ folder: 'projects', name: 'projects' }]);
    fs.writeFileSync(path.join(root, '.realm'), 'personal\n');
    assert.deepEqual(realmsOnDisk(root), [{ folder: '.', name: 'personal' }]);
    assert.deepEqual(realmsOnDisk(path.join(root, 'absent')), []);
  } finally {
    cleanup();
  }
});

test('diagnose reports the machine file, an unlisted realm, and never a secret value', () => {
  const { root, cleanup } = scratch();
  try {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'work-vm'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'work-vm', '.realm'), 'work-vm\n');
    const machineFile = path.join(root, 'machine.env');
    fs.writeFileSync(machineFile, `HARNESS_VAULT=${vault}\nHARNESS_MACHINE=vm\nHARNESS_REALMS=projects:push\nDATABASE_URL=postgresql://u:hunter2@h/db\n`);

    const rows = Object.fromEntries(diagnose({ HARNESS_MACHINE_ENV: machineFile }, root));
    assert.equal(rows['machine'], 'vm');
    assert.equal(rows['machine file'], machineFile);
    assert.match(rows['realms unlisted'], /work-vm/);
    assert.equal(rows['DATABASE_URL'], 'set');
    assert.ok(!JSON.stringify(rows).includes('hunter2'));
  } finally {
    cleanup();
  }
});

/** A vault under `root` with a machine file naming it; `lines` are extra machine.env lines. */
function vaultWith(root, lines = []) {
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const machineFile = path.join(root, 'machine.env');
  fs.writeFileSync(machineFile, [`HARNESS_VAULT=${vault}`, ...lines, ''].join('\n'));
  return { vault, env: Object.freeze({ HARNESS_MACHINE_ENV: machineFile }) };
}

/** A realm folder `name` under `vault`; `git` is 'directory', 'file' or 'none'. */
function addRealm(vault, name, git = 'directory') {
  const dir = path.join(vault, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.realm'), `${name}\n`);
  if (git === 'directory') fs.mkdirSync(path.join(dir, '.git'));
  if (git === 'file') fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ../elsewhere/.git\n');
  return dir;
}

/**
 * A runGit that answers from `script` (keyed by `<realm folder>|<args>`) and
 * records every call. Anything unscripted fails loudly as an unknown exit.
 */
function scriptedGit(script) {
  const calls = [];
  const runGit = (args, options = {}) => {
    calls.push(Object.freeze({ args, ...options }));
    const reply = script[`${path.basename(options.cwd ?? '')}|${args.join(' ')}`];
    return reply ?? { ok: false, stdout: '', error: 'unscripted', status: null };
  };
  return { runGit, calls };
}

const ORIGIN = 'remote get-url origin';
const COUNT = 'rev-list --count HEAD';
const UNBORN = 'rev-parse --verify --quiet HEAD';
const ok = (stdout) => ({ ok: true, stdout });
const exit = (status) => ({ ok: false, stdout: '', error: `exit ${status}`, status, stderr: '' });

test('git email shows HARNESS_GIT_EMAIL, or says the git config identity applies', () => {
  const { root, cleanup } = scratch();
  try {
    const set = vaultWith(root, ['HARNESS_GIT_EMAIL=vm@example.com']);
    assert.equal(Object.fromEntries(diagnose(set.env, root))['git email'], 'vm@example.com');
    const unset = vaultWith(root);
    assert.equal(
      Object.fromEntries(diagnose(unset.env, root))['git email'],
      '(unset: git config identity applies to realm commits)',
    );
  } finally {
    cleanup();
  }
});

test('realms missing names a listed realm with no folder on disk', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root, ['HARNESS_REALMS=projects:push,classes:push']);
    addRealm(vault, 'projects', 'none');
    const rows = Object.fromEntries(diagnose(env, root));
    assert.equal(rows['realms missing'], 'classes');
    assert.equal(rows['realms unlisted'], 'none');

    addRealm(vault, 'classes', 'none');
    assert.equal(Object.fromEntries(diagnose(env, root))['realms missing'], 'none');
  } finally {
    cleanup();
  }
});

test('the new rows come after realms unlisted, and every existing row keeps its place', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    const labels = diagnose(env, root).map(([label]) => label);
    assert.deepEqual(labels.slice(0, 6), [
      'machine file', 'machine', 'vault', 'realms on disk', 'realms listed', 'realms unlisted',
    ]);
    assert.deepEqual(labels.slice(6, 8), ['git email', 'realms missing']);
    assert.equal(labels.at(-1), 'transcripts');
  } finally {
    cleanup();
  }
});

test('realm rows: no .git, a .git file, an origin with its token stripped, no origin', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    addRealm(vault, 'bare', 'none');
    addRealm(vault, 'linked', 'file');
    addRealm(vault, 'pushed');
    addRealm(vault, 'local');
    const { runGit, calls } = scriptedGit({
      [`pushed|${ORIGIN}`]: ok('https://x:token@github.com/o/r.git\n'),
      [`pushed|${COUNT}`]: ok('12\n'),
      [`local|${ORIGIN}`]: exit(2),
      [`local|${COUNT}`]: ok('3\n'),
    });
    const rows = Object.fromEntries(diagnose(env, root, { runGit }));
    assert.equal(rows['realm bare'], 'not a checkout (no .git)');
    assert.equal(rows['realm linked'], '.git is a file (worktree or submodule): not synced');
    assert.equal(rows['realm pushed'], 'git checkout, origin https://github.com/o/r.git, 12 commits');
    assert.equal(rows['realm local'], 'git checkout, no origin remote, 3 commits');
    assert.ok(!JSON.stringify(rows).includes('token'), 'a remote token never reaches the report');
    assert.ok(!rows['realm pushed'].includes('x:'), 'nor does the user part of the url');

    assert.ok(calls.every((call) => ['pushed', 'local'].includes(path.basename(call.cwd))), 'git runs only in real checkouts');
    assert.ok(calls.every((call) => call.timeoutMs === 5000), 'every doctor git call is bounded at 5 s');
  } finally {
    cleanup();
  }
});

const TIMED_OUT = Object.freeze({ ok: false, stdout: '', error: 'ETIMEDOUT', status: null });

test('realm rows: a failing remote lookup, an unborn branch, a count that fails', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    addRealm(vault, 'fresh');
    addRealm(vault, 'broken');
    const { runGit } = scriptedGit({
      [`fresh|${ORIGIN}`]: exit(2),
      [`fresh|${COUNT}`]: exit(128),
      [`fresh|${UNBORN}`]: exit(1),
      [`broken|${ORIGIN}`]: exit(128),
      [`broken|${COUNT}`]: exit(128),
      [`broken|${UNBORN}`]: exit(128),
    });
    const rows = Object.fromEntries(diagnose(env, root, { runGit }));
    assert.equal(rows['realm fresh'], 'git checkout, no origin remote, no commits yet');
    assert.equal(rows['realm broken'], 'git checkout, remote unknown (exit 128), commit count unknown (exit 128)');
  } finally {
    cleanup();
  }
});

test('realm rows: when git does not answer, the second probe is never run', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    addRealm(vault, 'silent');
    addRealm(vault, 'slow');
    const { runGit, calls } = scriptedGit({
      [`silent|${ORIGIN}`]: TIMED_OUT,
      [`slow|${ORIGIN}`]: exit(2),
      [`slow|${COUNT}`]: TIMED_OUT,
    });
    const rows = Object.fromEntries(diagnose(env, root, { runGit }));
    assert.equal(rows['realm silent'], 'git checkout, remote unknown (ETIMEDOUT), commit count skipped (git did not answer)');
    assert.equal(rows['realm slow'], 'git checkout, no origin remote, commit count unknown (ETIMEDOUT)');
    const asked = (realm) => calls.filter((call) => path.basename(call.cwd) === realm).map((call) => call.args.join(' '));
    assert.deepEqual(asked('silent'), [ORIGIN]);
    assert.deepEqual(asked('slow'), [ORIGIN, COUNT]);
  } finally {
    cleanup();
  }
});

test('realm rows name a lock holder, and mark a stale one', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    const writeLock = (dir, startedAt) =>
      fs.writeFileSync(
        path.join(dir, '.git', 'harness-sync.lock'),
        `${JSON.stringify({ pid: 4242, owner: 'sync --push', startedAt, token: 'tok' })}\n`,
      );
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    writeLock(addRealm(vault, 'busy'), fresh);
    writeLock(addRealm(vault, 'dead'), old);
    const { runGit } = scriptedGit({
      [`busy|${ORIGIN}`]: exit(2),
      [`busy|${COUNT}`]: ok('1\n'),
      [`dead|${ORIGIN}`]: exit(2),
      [`dead|${COUNT}`]: ok('1\n'),
    });
    const rows = Object.fromEntries(diagnose(env, root, { runGit }));
    assert.equal(rows['realm busy'], `git checkout, no origin remote, lock held by sync --push, pid 4242, since ${fresh}, 1 commits`);
    assert.equal(rows['realm dead'], `git checkout, no origin remote, lock held by sync --push, pid 4242, since ${old} (stale), 1 commits`);
  } finally {
    cleanup();
  }
});

test('realm row against real git: unborn, then one commit and a file:// origin', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    const realm = addRealm(vault, 'projects', 'none');
    const git = (...args) => execFileSync('git', ['-C', realm, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    assert.equal(Object.fromEntries(diagnose(env, root))['realm projects'], 'git checkout, no origin remote, no commits yet');

    git('add', '.realm');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    const origin = pathToFileURL(path.join(root, 'remote.git')).href;
    git('remote', 'add', 'origin', origin);
    assert.equal(Object.fromEntries(diagnose(env, root))['realm projects'], `git checkout, origin ${origin}, 1 commits`);
  } finally {
    cleanup();
  }
});

test('formatRows pads labels into one column, as main prints them', () => {
  assert.equal(formatRows([['a', '1'], ['long', '2']]), 'a     1\nlong  2');
});

// ------------------------------------------------ problem status, the SessionStart rows, --strict

/**
 * The words bootstrap step 9 used to scan doctor's printed report for, before
 * a problem became a field of the row. Kept here only to prove the field and
 * the text agree on every row that existed then.
 */
const OLD_MARKERS = Object.freeze(['(MISSING', 'ABSENT', '(absent', '(not built', '(not found', 'ingest will refuse']);
const oldScanSaysProblem = ([label, value]) =>
  (label === 'realms missing' && value !== 'none') || OLD_MARKERS.some((marker) => value.includes(marker));
const NEW_ROWS = Object.freeze(['SessionStart hook', 'session-start log']);

test('every row is [label, value, problem], problem a boolean, frozen', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    for (const row of diagnose(env, root)) {
      assert.equal(row.length, 3, `row ${row[0]} is not a triple`);
      assert.equal(typeof row[1], 'string');
      assert.equal(typeof row[2], 'boolean', `row ${row[0]} has no problem flag`);
      assert.ok(Object.isFrozen(row));
    }
  } finally {
    cleanup();
  }
});

test('the problem field agrees with the text markers on every older row, in a bad and a good setup', () => {
  const { root, cleanup } = scratch();
  try {
    // Bad: no machine file, no vault, no ingest project, no uv, a CA cert that is not there.
    const bad = {
      HARNESS_MACHINE_ENV: path.join(root, 'absent.env'),
      HARNESS_VAULT: path.join(root, 'no-vault'),
      HARNESS_INGEST_PROJECT: path.join(root, 'no-ingest'),
      HARNESS_UV_BIN: path.join(root, 'no-uv.exe'),
      DATABASE_CA_CERT: path.join(root, 'no-ca.pem'),
    };
    // Good-ish: a machine file and a vault, but a listed realm missing and an unlisted one on disk.
    const { vault, env } = vaultWith(root, ['HARNESS_REALMS=projects:push']);
    addRealm(vault, 'stray', 'none');
    for (const rows of [diagnose(bad, root), diagnose(env, root)]) {
      for (const row of rows.filter(([label]) => !NEW_ROWS.includes(label))) {
        assert.equal(row[2], oldScanSaysProblem(row), `row ${row[0]} = ${row[1]}`);
      }
    }
    const badProblems = problemRows(diagnose(bad, root)).map(([label]) => label);
    for (const label of ['machine file', 'vault', 'ingest project', 'uv', 'DATABASE_CA_CERT']) {
      assert.ok(badProblems.includes(label), `${label} is not flagged`);
    }
    const flags = Object.fromEntries(diagnose(env, root).map(([label, , problem]) => [label, problem]));
    assert.equal(flags['realms missing'], true);
    assert.equal(flags['realms unlisted'], true);
    assert.equal(flags['machine file'], false);
    assert.equal(flags['vault'], false);
  } finally {
    cleanup();
  }
});

/** A settings.json under `<home>/.claude` holding `hooks` (or raw text); returns the hooks folder. */
function settingsWith(home, hooks) {
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'settings.json'), typeof hooks === 'string' ? hooks : JSON.stringify({ hooks }));
  return path.join(claude, 'hooks').replace(/\\/g, '/');
}
const startHooks = (command) => ({
  SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command }] }],
});
const sessionStartRow = (env, home) => diagnose(env, home).find(([label]) => label === 'SessionStart hook');

test('SessionStart hook row: missing, not installed, registered, wrong script, unreadable', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    assert.deepEqual(sessionStartRow(env, root), [
      'SessionStart hook', '(not registered: node hooks/install.mjs registers it)', true,
    ]);

    const installed = path.join(root, '.claude', 'hooks', 'session-start.mjs');
    const hooksDir = settingsWith(root, startHooks(`"C:/node/node.exe" "${installed}"`));
    const script = `${hooksDir}/session-start.mjs`;
    assert.deepEqual(sessionStartRow(env, root), [
      'SessionStart hook', `registered: ${script} (MISSING: node hooks/install.mjs)`, true,
    ]);

    fs.writeFileSync(installed, '// installed\n');
    assert.deepEqual(sessionStartRow(env, root), ['SessionStart hook', `registered: ${script}`, false]);

    settingsWith(root, startHooks(`node "${hooksDir}/session-capture.mjs"`));
    assert.deepEqual(sessionStartRow(env, root), [
      'SessionStart hook', `(wrong script: ${hooksDir}/session-capture.mjs; expected ${script})`, true,
    ]);

    settingsWith(root, '{ "env": { "TOKEN": "hunter2" }, oops');
    const [, value, problem] = sessionStartRow(env, root);
    assert.equal(problem, true);
    assert.match(value, /settings\.json is not valid JSON/);
    assert.ok(!value.includes('hunter2'), 'no part of settings.json reaches the report');
  } finally {
    cleanup();
  }
});

test('session-start log row: none yet, then the age of the last line, and never a problem', () => {
  const { root, cleanup } = scratch();
  try {
    const log = path.join(root, 'logs', 'start.log');
    const { env } = vaultWith(root, [`HARNESS_SESSION_START_LOG=${log}`]);
    const now = () => Date.parse('2026-09-27T12:00:00.000Z');
    const logRow = () => diagnose(env, root, { now }).find(([label]) => label === 'session-start log');

    assert.deepEqual(logRow(), ['session-start log', `${log} (none yet: no session has started since install)`, false]);

    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, [
      '2026-09-25T12:00:00.000Z debug input-keys: cwd,session_id',
      '2026-09-27T11:55:00.000Z start abc projects/harness source=status rule=x ids=0 tokens=12 ms=40',
      '',
    ].join('\n'));
    assert.deepEqual(logRow(), ['session-start log', `${log}, last line 5m ago`, false]);

    fs.appendFileSync(log, 'garbage without a date\n');
    assert.deepEqual(logRow(), ['session-start log', `${log}, last line undated`, false]);
  } finally {
    cleanup();
  }
});

test('the new rows sit just before transcripts', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    const labels = diagnose(env, root).map(([label]) => label);
    assert.deepEqual(labels.slice(-3), ['SessionStart hook', 'session-start log', 'transcripts']);
  } finally {
    cleanup();
  }
});

const ROWS = Object.freeze([
  Object.freeze(['vault', '/v', false]),
  Object.freeze(['uv', '(not found: ~/.local/bin or PATH)', true]),
  Object.freeze(['SessionStart hook', '(not registered: node hooks/install.mjs registers it)', true]),
]);

test('runDoctor without --strict prints exactly the report and exits 0 whatever it finds', () => {
  const lines = [];
  const code = runDoctor([], { rows: () => ROWS, write: (text) => lines.push(text) });
  assert.equal(code, 0);
  assert.deepEqual(lines, [formatRows(ROWS)]);
});

test('runDoctor --strict exits 1 and names each problem row; 0 when there is none', () => {
  const lines = [];
  assert.equal(runDoctor(['--strict'], { rows: () => ROWS, write: (text) => lines.push(text) }), 1);
  assert.equal(lines[0], formatRows(ROWS));
  assert.deepEqual(lines.slice(1), ['doctor --strict: 2 problems', '  problem: uv', '  problem: SessionStart hook']);

  const clean = [];
  assert.equal(runDoctor(['--strict'], { rows: () => ROWS.slice(0, 1), write: (text) => clean.push(text) }), 0);
  assert.deepEqual(clean.slice(1), ['doctor --strict: no problems']);
});

test('runDoctor refuses an unknown argument with exit 2 and builds no report', () => {
  const lines = [];
  let built = false;
  const rows = () => {
    built = true;
    return ROWS;
  };
  assert.equal(runDoctor(['--strcit'], { rows, write: (text) => lines.push(text) }), 2);
  assert.equal(built, false);
  assert.match(lines.join('\n'), /unknown argument: --strcit/);
});

test('the CLI: --strict exits 1 on a bare machine, the plain run exits 0 with the same report', () => {
  const { root, cleanup } = scratch();
  try {
    const env = {
      ...process.env,
      USERPROFILE: root,
      HOME: root,
      HARNESS_MACHINE_ENV: path.join(root, 'absent.env'),
      HARNESS_VAULT: path.join(root, 'no-vault'),
    };
    const strict = spawnSync(process.execPath, [DOCTOR, '--strict'], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(strict.status, 1, strict.stderr);
    assert.match(strict.stdout, /doctor --strict: \d+ problems/);
    assert.match(strict.stdout, /problem: vault/);
    const plain = spawnSync(process.execPath, [DOCTOR], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(!plain.stdout.includes('doctor --strict'), 'the plain report is unchanged');
    assert.ok(strict.stdout.startsWith(plain.stdout.trimEnd()), 'strict prints the same report first');
  } finally {
    cleanup();
  }
});

// ------------------------------------------------ the claude-config row (R-H5)

test('claude-config row: not cloned is informational; a clone with the wrong or no origin is a problem', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    const dir = path.join(root, 'claude-config');
    const configRow = (runGit) => diagnose(env, root, { runGit }).find(([label]) => label === 'claude-config');

    assert.deepEqual(configRow(), ['claude-config', `${dir} (not cloned on this machine)`, false]);

    fs.mkdirSync(dir);
    assert.deepEqual(configRow(), ['claude-config', `${dir} (exists but is not a git clone)`, true]);

    fs.mkdirSync(path.join(dir, '.git'));
    const other = scriptedGit({ [`claude-config|${ORIGIN}`]: ok('https://github.com/someone/else.git\n') });
    assert.deepEqual(configRow(other.runGit), [
      'claude-config', `${dir}, origin https://github.com/someone/else.git (expected emstacho-su/claude-config)`, true,
    ]);

    const none = scriptedGit({ [`claude-config|${ORIGIN}`]: exit(2) });
    assert.deepEqual(configRow(none.runGit), [
      'claude-config', `${dir}, no origin remote (expected emstacho-su/claude-config)`, true,
    ]);
  } finally {
    cleanup();
  }
});

test('claude-config row: the right origin shows the last commit age and the exceptions file, never a token', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    const dir = path.join(root, 'claude-config');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const now = () => Date.parse('2026-09-27T12:00:00.000Z');
    const twoDaysAgo = Math.floor(Date.parse('2026-09-25T12:00:00.000Z') / 1000);
    const configRow = (script) =>
      diagnose(env, root, { runGit: scriptedGit(script).runGit, now }).find(([label]) => label === 'claude-config');
    const origin = { [`claude-config|${ORIGIN}`]: ok('https://x-access-token:s3cret@github.com/emstacho-su/claude-config.git\n') };

    const fresh = configRow({ ...origin, 'claude-config|log -1 --format=%ct': ok(`${twoDaysAgo}\n`) });
    assert.deepEqual(fresh, [
      'claude-config',
      `${dir}, origin https://github.com/emstacho-su/claude-config.git, last commit 2d ago, no .scan-exceptions.json`,
      false,
    ]);
    assert.ok(!fresh[1].includes('s3cret'));

    fs.writeFileSync(path.join(dir, '.scan-exceptions.json'), '[]\n');
    const ssh = { [`claude-config|${ORIGIN}`]: ok('git@github.com:emstacho-su/claude-config.git\n') };
    const unborn = configRow({
      ...ssh,
      'claude-config|log -1 --format=%ct': exit(128),
      [`claude-config|${UNBORN}`]: exit(1),
    });
    assert.deepEqual(unborn, [
      'claude-config',
      `${dir}, origin git@github.com:emstacho-su/claude-config.git, no commits yet, .scan-exceptions.json present`,
      false,
    ]);
  } finally {
    cleanup();
  }
});

test('the claude-config row sits just before the SessionStart rows', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    const labels = diagnose(env, root).map(([label]) => label);
    assert.deepEqual(labels.slice(-4), ['claude-config', 'SessionStart hook', 'session-start log', 'transcripts']);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------ DATABASE_URL as a secret file (Phase 14)

test('DATABASE_URL row: set when DATABASE_URL_FILE names a readable file, ABSENT with the reason when it does not', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    const file = path.join(root, 'harness_database_url');
    fs.writeFileSync(file, 'postgresql://u:hunter2@h/db\n');
    const urlRow = (extra) => diagnose({ ...env, ...extra }, root, { repoDir: root }).find(([label]) => label === 'DATABASE_URL');

    // What `docker compose exec harness-jobs node hooks/doctor.mjs` sees: the file's name, not its content.
    assert.deepEqual(urlRow({ DATABASE_URL_FILE: file }), ['DATABASE_URL', 'set (read from DATABASE_URL_FILE)', false]);
    assert.ok(!JSON.stringify(diagnose({ ...env, DATABASE_URL_FILE: file }, root, { repoDir: root })).includes('hunter2'));

    const absent = path.join(root, 'absent');
    assert.deepEqual(urlRow({ DATABASE_URL_FILE: absent }), [
      'DATABASE_URL', `ABSENT (DATABASE_URL_FILE names ${absent}, which is not a readable file)`, true,
    ]);
    assert.deepEqual(urlRow({ DATABASE_URL: 'postgresql://u:hunter2@h/db' }), ['DATABASE_URL', 'set', false]);
    assert.deepEqual(urlRow({}), ['DATABASE_URL', 'ABSENT', true]);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------ realm clean and pushed rows, the nightly ingest row (Phase 14)

const STATUS = '--no-optional-locks status --porcelain=v1 -z --untracked-files=all';
const AHEAD = 'rev-list --count @{upstream}..HEAD';
const BRANCH = 'symbolic-ref --quiet --short HEAD';
const MERGE = 'config --get branch.main.merge';
const ON_MAIN = ok('main\n');
const TRACKS_MAIN = ok('refs/heads/main\n');
const realmSyncRows = (rows) => rows.filter(([label]) => / (clean|pushed)$/.test(label));
const flagsOf = (rows) => Object.fromEntries(rows.map(([label, value, problem]) => [label, [value, problem]]));

test('--strict exits 1 on a realm with an uncommitted entry or one ahead of its remote, and 0 when clean', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root, ['HARNESS_REALMS=projects:push']);
    const realm = addRealm(vault, 'projects', 'none');
    const remote = path.join(root, 'remote.git');
    const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
    const git = (...args) => execFileSync('git', ['-C', realm, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('add', '.realm');
    git(...identity, 'commit', '-q', '-m', 'init');
    git('remote', 'add', 'origin', pathToFileURL(remote).href);
    git('push', '-q', '-u', 'origin', 'main');

    const strict = () => {
      const lines = [];
      const code = runDoctor(['--strict'], { rows: () => realmSyncRows(diagnose(env, root)), write: (text) => lines.push(text) });
      return { code, lines };
    };

    const clean = strict();
    assert.equal(clean.code, 0, clean.lines.join('\n'));
    assert.deepEqual(realmSyncRows(diagnose(env, root)), [
      ['realm projects clean', 'yes', false],
      ['realm projects pushed', 'yes', false],
    ]);

    fs.writeFileSync(path.join(realm, 'note.md'), '# a note the sync has not committed\n');
    const dirty = strict();
    assert.equal(dirty.code, 1);
    assert.deepEqual(dirty.lines.slice(1), ['doctor --strict: 1 problem', '  problem: realm projects clean']);
    assert.equal(flagsOf(diagnose(env, root))['realm projects clean'][0], 'no: 1 uncommitted entry');

    git('add', 'note.md');
    git(...identity, 'commit', '-q', '-m', 'a note');
    const ahead = strict();
    assert.equal(ahead.code, 1);
    assert.deepEqual(ahead.lines.slice(1), ['doctor --strict: 1 problem', '  problem: realm projects pushed']);
    assert.equal(flagsOf(diagnose(env, root))['realm projects pushed'][0], 'no: 1 commit ahead of its upstream');

    git('push', '-q', 'origin', 'main');
    assert.equal(strict().code, 0);
  } finally {
    cleanup();
  }
});

test('clean and pushed rows: counts, a local realm, no upstream, and only for real checkouts', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root, ['HARNESS_REALMS=busy:push,kept:local,fresh:push,bare:push']);
    addRealm(vault, 'busy');
    addRealm(vault, 'kept');
    addRealm(vault, 'fresh');
    addRealm(vault, 'bare', 'none');
    const { runGit, calls } = scriptedGit({
      [`busy|${ORIGIN}`]: ok('https://github.com/o/busy.git\n'),
      [`busy|${COUNT}`]: ok('9\n'),
      [`busy|${STATUS}`]: ok('?? new.md\0 M old.md\0?? attachments/ist466/deck.pptx\0'),
      [`busy|${BRANCH}`]: ON_MAIN,
      [`busy|${MERGE}`]: TRACKS_MAIN,
      [`busy|${AHEAD}`]: ok('2\n'),
      [`kept|${ORIGIN}`]: exit(2),
      [`kept|${COUNT}`]: ok('4\n'),
      [`kept|${STATUS}`]: ok(''),
      [`fresh|${ORIGIN}`]: ok('https://github.com/o/fresh.git\n'),
      [`fresh|${COUNT}`]: ok('1\n'),
      [`fresh|${STATUS}`]: ok(''),
      [`fresh|${BRANCH}`]: ON_MAIN,
      [`fresh|${MERGE}`]: exit(1),
    });
    const rows = flagsOf(diagnose(env, root, { runGit }));

    assert.deepEqual(rows['realm busy clean'], ['no: 3 uncommitted entries', true]);
    assert.deepEqual(rows['realm busy pushed'], ['no: 2 commits ahead of its upstream', true]);
    assert.deepEqual(rows['realm kept clean'], ['yes', false]);
    assert.deepEqual(rows['realm kept pushed'], ['local realm: it stays on this machine', false]);
    assert.deepEqual(rows['realm fresh clean'], ['yes', false]);
    assert.deepEqual(rows['realm fresh pushed'], ['no: no upstream branch (git push -u origin main once)', true]);
    assert.equal(rows['realm bare clean'], undefined, 'a folder that is not a checkout has no sync rows');
    assert.equal(rows['realm bare pushed'], undefined);

    const asked = (name) => calls.filter((call) => path.basename(call.cwd) === name).map((call) => call.args.join(' '));
    assert.deepEqual(asked('busy'), [ORIGIN, COUNT, STATUS, BRANCH, MERGE, AHEAD]);
    assert.deepEqual(asked('fresh'), [ORIGIN, COUNT, STATUS, BRANCH, MERGE], 'with no upstream there is nothing to count');
    assert.deepEqual(asked('kept'), [ORIGIN, COUNT, STATUS], 'a local realm is never asked how far ahead it is');
    assert.ok(calls.every((call) => call.timeoutMs === 5000));

    const labels = diagnose(env, root, { runGit }).map(([label]) => label);
    const at = labels.indexOf('realm busy');
    assert.deepEqual(labels.slice(at, at + 3), ['realm busy', 'realm busy clean', 'realm busy pushed'], 'the two rows follow their realm');
  } finally {
    cleanup();
  }
});

test('a file the sync never stages does not fail the clean row: --strict exits 0 with a .canvas in the realm', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root, ['HARNESS_REALMS=projects:local']);
    const realm = addRealm(vault, 'projects', 'none');
    const git = (...args) => execFileSync('git', ['-C', realm, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    git('add', '.realm');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(realm, 'board.canvas'), '{}\n');

    const lines = [];
    const code = runDoctor(['--strict'], { rows: () => realmSyncRows(diagnose(env, root)), write: (text) => lines.push(text) });
    assert.equal(code, 0, lines.join('\n'));
    assert.deepEqual(flagsOf(diagnose(env, root))['realm projects clean'], ['yes (the sync never stages 1 entry: board.canvas)', false]);

    fs.writeFileSync(path.join(realm, 'note.md'), '# a note\n');
    assert.deepEqual(flagsOf(diagnose(env, root))['realm projects clean'], [
      'no: 1 uncommitted entry (the sync never stages 1 entry: board.canvas)', true,
    ]);
  } finally {
    cleanup();
  }
});

test('the clean row names at most three unstaged leftovers, and says so when git prints something it cannot read', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root, ['HARNESS_REALMS=many:local,odd:local']);
    addRealm(vault, 'many');
    addRealm(vault, 'odd');
    const { runGit } = scriptedGit({
      [`many|${ORIGIN}`]: exit(2),
      [`many|${COUNT}`]: ok('4\n'),
      [`many|${STATUS}`]: ok('?? a.canvas\0?? b.pptx\0?? c.txt\0?? d.env\0R  notes/n.md\0drafts/n.txt\0'),
      [`odd|${ORIGIN}`]: exit(2),
      [`odd|${COUNT}`]: ok('4\n'),
      [`odd|${STATUS}`]: ok('??\0'),
    });
    const rows = flagsOf(diagnose(env, root, { runGit }));
    assert.deepEqual(rows['realm many clean'], ['yes (the sync never stages 5 entries: a.canvas, b.pptx, c.txt, …)', false],
      'a rename out of a path the sync never stages is not the sync\'s to carry');
    assert.deepEqual(rows['realm odd clean'], ['unknown (git status output not understood)', true]);
  } finally {
    cleanup();
  }
});

test('the pushed row tells a detached HEAD and a failing count from a missing upstream', () => {
  const { root, cleanup } = scratch();
  try {
    const names = ['detached', 'gone', 'odd', 'unset'];
    const { vault, env } = vaultWith(root, [`HARNESS_REALMS=${names.map((name) => `${name}:push`).join(',')}`]);
    const healthy = (name) => {
      addRealm(vault, name);
      return { [`${name}|${ORIGIN}`]: exit(2), [`${name}|${COUNT}`]: ok('3\n'), [`${name}|${STATUS}`]: ok('') };
    };
    const { runGit, calls } = scriptedGit({
      ...healthy('detached'),
      [`detached|${BRANCH}`]: exit(1),
      ...healthy('gone'),
      [`gone|${BRANCH}`]: ON_MAIN,
      [`gone|${MERGE}`]: TRACKS_MAIN,
      [`gone|${AHEAD}`]: exit(128),
      ...healthy('odd'),
      [`odd|${BRANCH}`]: exit(128),
      ...healthy('unset'),
      [`unset|${BRANCH}`]: ON_MAIN,
      [`unset|${MERGE}`]: exit(1),
    });
    const rows = flagsOf(diagnose(env, root, { runGit }));

    assert.deepEqual(rows['realm detached pushed'], ['no: HEAD is detached (not on a branch)', true]);
    assert.deepEqual(rows['realm gone pushed'], ['unknown (the count against its upstream failed: exit 128)', true]);
    assert.deepEqual(rows['realm odd pushed'], ['unknown (exit 128)', true]);
    assert.deepEqual(rows['realm unset pushed'], ['no: no upstream branch (git push -u origin main once)', true]);

    const asked = (name) => calls.filter((call) => path.basename(call.cwd) === name).map((call) => call.args.join(' ')).slice(3);
    assert.deepEqual(asked('detached'), [BRANCH], 'a detached HEAD has no branch to look an upstream up for');
    assert.deepEqual(asked('gone'), [BRANCH, MERGE, AHEAD]);
  } finally {
    cleanup();
  }
});

test('the pushed row against real git: a detached HEAD, then an upstream whose ref is gone', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root, ['HARNESS_REALMS=projects:push']);
    const realm = addRealm(vault, 'projects', 'none');
    const remote = path.join(root, 'remote.git');
    const git = (...args) => execFileSync('git', ['-C', realm, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('add', '.realm');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    git('remote', 'add', 'origin', pathToFileURL(remote).href);
    const pushed = () => flagsOf(diagnose(env, root))['realm projects pushed'];

    assert.deepEqual(pushed(), ['no: no upstream branch (git push -u origin main once)', true]);

    git('push', '-q', '-u', 'origin', 'main');
    assert.deepEqual(pushed(), ['yes', false]);

    git('checkout', '-q', '--detach');
    assert.deepEqual(pushed(), ['no: HEAD is detached (not on a branch)', true]);

    git('checkout', '-q', 'main');
    git('update-ref', '-d', 'refs/remotes/origin/main');
    assert.deepEqual(pushed(), ['unknown (the count against its upstream failed: exit 128)', true]);
  } finally {
    cleanup();
  }
});

test('clean and pushed rows: a realm no list names is held to the push rule', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root);
    addRealm(vault, 'projects');
    const { runGit } = scriptedGit({
      [`projects|${ORIGIN}`]: ok('https://github.com/o/projects.git\n'),
      [`projects|${COUNT}`]: ok('9\n'),
      [`projects|${STATUS}`]: ok(''),
      [`projects|${BRANCH}`]: ON_MAIN,
      [`projects|${MERGE}`]: TRACKS_MAIN,
      [`projects|${AHEAD}`]: ok('1\n'),
    });
    assert.deepEqual(flagsOf(diagnose(env, root, { runGit }))['realm projects pushed'], ['no: 1 commit ahead of its upstream', true]);
  } finally {
    cleanup();
  }
});

test('clean and pushed rows: when git does not answer they say so, count as problems, and ask nothing more', () => {
  const { root, cleanup } = scratch();
  try {
    const { vault, env } = vaultWith(root, ['HARNESS_REALMS=silent:push,slow:push,stuck:push,mute:push']);
    addRealm(vault, 'silent');
    addRealm(vault, 'slow');
    addRealm(vault, 'stuck');
    addRealm(vault, 'mute');
    const { runGit, calls } = scriptedGit({
      [`silent|${ORIGIN}`]: TIMED_OUT,
      [`slow|${ORIGIN}`]: exit(2),
      [`slow|${COUNT}`]: TIMED_OUT,
      [`stuck|${ORIGIN}`]: exit(2),
      [`stuck|${COUNT}`]: ok('2\n'),
      [`stuck|${STATUS}`]: TIMED_OUT,
      [`mute|${ORIGIN}`]: exit(2),
      [`mute|${COUNT}`]: ok('2\n'),
      [`mute|${STATUS}`]: ok(''),
      [`mute|${BRANCH}`]: TIMED_OUT,
    });
    const rows = flagsOf(diagnose(env, root, { runGit }));
    const SKIPPED = ['unknown (git did not answer)', true];
    for (const name of ['silent', 'slow']) {
      assert.deepEqual(rows[`realm ${name} clean`], SKIPPED);
      assert.deepEqual(rows[`realm ${name} pushed`], SKIPPED);
    }
    assert.deepEqual(rows['realm stuck clean'], ['unknown (ETIMEDOUT)', true]);
    assert.deepEqual(rows['realm stuck pushed'], SKIPPED);

    const asked = (name) => calls.filter((call) => path.basename(call.cwd) === name).map((call) => call.args.join(' '));
    assert.deepEqual(asked('silent'), [ORIGIN]);
    assert.deepEqual(asked('slow'), [ORIGIN, COUNT]);
    assert.deepEqual(asked('stuck'), [ORIGIN, COUNT, STATUS]);
    assert.deepEqual(rows['realm mute clean'], ['yes', false]);
    assert.deepEqual(rows['realm mute pushed'], ['unknown (ETIMEDOUT)', true]);
    assert.deepEqual(asked('mute'), [ORIGIN, COUNT, STATUS, BRANCH], 'no upstream lookup after the branch lookup went unanswered');
  } finally {
    cleanup();
  }
});

test('nightly ingest row: none yet, the age of the last success, stale past 36 hours, unreadable', () => {
  const { root, cleanup } = scratch();
  try {
    const stateFile = path.join(root, 'state', 'ingest-state.json');
    const { env } = vaultWith(root, [`HARNESS_INGEST_STATE_FILE=${stateFile}`]);
    const now = () => Date.parse('2026-10-02T12:00:00.000Z');
    const ingestRow = () => diagnose(env, root, { now }).find(([label]) => label === 'nightly ingest');
    const write = (body) => {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, typeof body === 'string' ? body : JSON.stringify(body));
    };

    assert.deepEqual(ingestRow(), ['nightly ingest', `${stateFile} (none yet: no complete ingest has finished on this machine)`, false]);

    write({ schema_version: 1, last_success: '2026-10-02T07:04:00+00:00', source: 'obsidian', path: '/vault', documents: 480, chunks_written: 3 });
    assert.deepEqual(ingestRow(), ['nightly ingest', `${stateFile}, last success 4h ago`, false]);

    write({ schema_version: 1, last_success: '2026-10-01T00:00:00+00:00' });
    assert.deepEqual(ingestRow(), ['nightly ingest', `${stateFile}, last success 36h ago`, false], 'exactly 36 hours is still healthy');

    write({ schema_version: 1, last_success: '2026-09-30T23:59:00+00:00' });
    assert.deepEqual(ingestRow(), ['nightly ingest', `${stateFile}, last success 36h ago (STALE: older than 36h)`, true]);

    write({ schema_version: 1 });
    assert.deepEqual(ingestRow(), ['nightly ingest', `${stateFile} (unreadable: no last_success timestamp)`, true]);

    write('{ "last_success": ');
    assert.deepEqual(ingestRow(), ['nightly ingest', `${stateFile} (unreadable: not JSON)`, true]);
  } finally {
    cleanup();
  }
});

test('the nightly ingest row follows ingest project, and its defaults are the ones the ingest package uses', () => {
  const { root, cleanup } = scratch();
  try {
    const { env } = vaultWith(root);
    const rows = diagnose(env, root);
    const labels = rows.map(([label]) => label);
    assert.equal(labels[labels.indexOf('ingest project') + 1], 'nightly ingest');
    const [, value] = rows.find(([label]) => label === 'nightly ingest');
    assert.ok(value.startsWith(path.join(root, '.claude', 'hooks', 'ingest-state.json')), value);

    const runstate = fs.readFileSync(path.resolve(path.dirname(DOCTOR), '..', 'ingest', 'src', 'ingest', 'runstate.py'), 'utf8');
    assert.match(runstate, /^ENV_STATE_FILE = "HARNESS_INGEST_STATE_FILE"$/m);
    assert.match(runstate, /^DEFAULT_STATE_RELATIVE = \("\.claude", "hooks", "ingest-state\.json"\)$/m);
    assert.match(runstate, /^DEFAULT_MAX_AGE_HOURS = 36$/m);
  } finally {
    cleanup();
  }
});
