/**
 * The installer's payload is the whole hook, or the deployed copy is broken.
 *
 * A module missing from the payload fails quietly and totally: the deployed
 * `session-capture.mjs` throws `ERR_MODULE_NOT_FOUND` on import, the hook
 * writes nothing, and the only evidence is a line in a log nobody reads. (It
 * happened once, when `PAYLOAD` was a hand-kept list: `lib/spawn.mjs` was
 * added and not listed.) The installer now walks the entry points' imports
 * itself; this test walks them independently and compares, and then imports
 * the installed copies from a scratch folder, which is the check that counts.
 *
 * Every run here uses a scratch `--target`, and either `--skip-settings` or a
 * scratch `--settings` beside it: the real ~/.claude is never touched.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(HERE, '..');
const INSTALLER = path.join(HOOKS_DIR, 'install.mjs');
const ENTRY_POINTS = Object.freeze(['session-capture.mjs', 'session-start.mjs', 'memory-worker.mjs']);
const FAKE_NODE = 'C:/Program Files/nodejs/node.exe';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-install-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function install(args) {
  return execFileSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8', timeout: 60_000 });
}

/** What the installer would deploy, read from a dry run into an empty folder. */
function payloadPaths() {
  const { root, cleanup } = scratch();
  try {
    const output = install(['--dry-run', '--target', root, '--skip-settings']);
    return [...output.matchAll(/^ {2}add\s+(\S+)\s*$/gm)].map((match) => match[1]).sort();
  } finally {
    cleanup();
  }
}

const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * Every module the entry points reach, transitively.
 *
 * This — not "every file in lib/" — is what the deployed copy needs. The
 * migration and back-fill modules live in `lib/` too but run from the repo, so
 * listing them would deploy code the hooks never load.
 */
function runtimeClosure(entries = ENTRY_POINTS) {
  const seen = new Set();
  const queue = [...entries];

  while (queue.length) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);

    const source = fs.readFileSync(path.join(HOOKS_DIR, relative), 'utf8');
    for (const match of [...source.matchAll(RELATIVE_IMPORT), ...source.matchAll(DYNAMIC_IMPORT)]) {
      const resolved = path
        .relative(HOOKS_DIR, path.resolve(path.dirname(path.join(HOOKS_DIR, relative)), match[1]))
        .replace(/\\/g, '/');
      queue.push(resolved);
    }
  }
  return [...seen].sort();
}

test('the payload is exactly what the two entry points import, transitively', () => {
  const payload = payloadPaths();
  for (const entry of ENTRY_POINTS) assert.ok(payload.includes(entry), `${entry} is not in the payload`);
  assert.deepEqual(payload, runtimeClosure(), "the installer's payload and the hooks' import graph disagree");
});

test('the SessionStart hook and its brief builder are deployed', () => {
  const payload = payloadPaths();
  for (const name of ['session-start.mjs', 'lib/start-brief.mjs', 'lib/session-start.mjs', 'lib/collection.mjs']) {
    assert.ok(payload.includes(name), `${name} is not deployed`);
  }
});

test('the payload deploys no module the hooks do not load', () => {
  // Repo tools belong in the checkout, not in ~/.claude/hooks.
  const payload = new Set(payloadPaths());
  for (const name of ['lib/migrate.mjs', 'lib/backfill.mjs', 'lib/claude-config.mjs', 'lib/settings.mjs', 'doctor.mjs']) {
    assert.ok(!payload.has(name), `${name} is a repo tool and should not be deployed`);
  }
});

test('a dry-run install into an empty folder reports the whole payload and writes nothing', () => {
  const { root, cleanup } = scratch();
  try {
    const output = install(['--dry-run', '--target', root, '--skip-settings']);
    assert.match(output, new RegExp(`${runtimeClosure().length} file\\(s\\) would change`));
    assert.equal(fs.readdirSync(root).length, 0, 'a dry run must not write');
  } finally {
    cleanup();
  }
});

test('a real install into a scratch target copies and verifies every file, and each entry imports', () => {
  const { root, cleanup } = scratch();
  try {
    // --skip-settings is not optional here: without it the test registers a
    // hook pointing at this temp folder in the real ~/.claude/settings.json,
    // and every run leaves another one behind. It did, thirteen times.
    const output = install(['--target', root, '--skip-settings']);
    assert.match(output, /verified byte-identical/);

    for (const relative of runtimeClosure()) {
      const installed = path.join(root, relative);
      assert.ok(fs.existsSync(installed), `not installed: ${relative}`);
      assert.equal(
        fs.readFileSync(installed, 'utf8'),
        fs.readFileSync(path.join(HOOKS_DIR, relative), 'utf8'),
        `not byte-identical: ${relative}`,
      );
    }

    // The point of the payload: the installed copies import cleanly on their
    // own. session-start.mjs only runs main() when it is the process's script.
    for (const relative of ['lib/capture.mjs', 'session-start.mjs']) {
      const url = pathToFileURL(path.join(root, relative)).href;
      execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
        timeout: 60_000,
      });
    }
  } finally {
    cleanup();
  }
});

// ----------------------------------------------------------- registration, end to end

/** A scratch `.claude` with a settings.json holding the user's keys and another tool's SessionStart hook. */
function claudeHome(root) {
  const claude = path.join(root, '.claude');
  const target = path.join(claude, 'hooks');
  const settingsFile = path.join(claude, 'settings.json');
  fs.mkdirSync(claude, { recursive: true });
  const existing = {
    model: 'claude-fable-5-1[1m]',
    permissions: { allow: ['Read'] },
    hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'plugin-banner.exe' }] }] },
  };
  fs.writeFileSync(settingsFile, `${JSON.stringify(existing, null, 2)}\n`);
  return { target, settingsFile, existing, args: ['--target', target, '--settings', settingsFile, '--node', FAKE_NODE] };
}

test('install registers SessionStart for session-start.mjs beside the capture hooks, once', () => {
  const { root, cleanup } = scratch();
  try {
    const home = claudeHome(root);
    const first = install(home.args);
    assert.match(first, /settings SessionStart: registering/);
    assert.match(first, /settings SessionEnd: registering/);

    const settings = JSON.parse(fs.readFileSync(home.settingsFile, 'utf8'));
    assert.equal(settings.model, home.existing.model);
    assert.deepEqual(settings.permissions, home.existing.permissions);
    assert.deepEqual(settings.hooks.SessionStart[0], home.existing.hooks.SessionStart[0], "another tool's entry is kept");
    const ours = settings.hooks.SessionStart[1];
    assert.equal(ours.matcher, 'startup|resume');
    assert.equal(ours.hooks[0].command, `"${FAKE_NODE}" "${home.target.replace(/\\/g, '/')}/session-start.mjs"`);
    assert.equal(ours.hooks[0].timeout, 5);
    assert.match(settings.hooks.SessionEnd[0].hooks[0].command, /session-capture\.mjs"$/);
    assert.ok(fs.existsSync(`${home.settingsFile}.bak`), 'the previous settings.json is kept as .bak');

    const before = fs.readFileSync(home.settingsFile, 'utf8');
    const second = install(home.args);
    for (const event of ['SessionEnd', 'SubagentStop', 'SessionStart']) {
      assert.match(second, new RegExp(`settings ${event}: already registered`));
    }
    assert.equal(fs.readFileSync(home.settingsFile, 'utf8'), before, 'a second run changes nothing');
  } finally {
    cleanup();
  }
});

test('a dry run says it would register SessionStart and writes neither files nor settings', () => {
  const { root, cleanup } = scratch();
  try {
    const home = claudeHome(root);
    const before = fs.readFileSync(home.settingsFile, 'utf8');
    const output = install(['--dry-run', ...home.args]);
    assert.match(output, /add\s+session-start\.mjs/);
    assert.match(output, /add\s+lib\/start-brief\.mjs/);
    assert.match(output, /settings SessionStart: registering/);
    assert.equal(fs.readFileSync(home.settingsFile, 'utf8'), before);
    assert.ok(!fs.existsSync(home.target), 'a dry run must not create the target');
  } finally {
    cleanup();
  }
});
