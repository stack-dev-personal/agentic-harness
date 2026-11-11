/**
 * Phase 2 of the container move: a session path this process cannot place
 * on its own disk is never used to probe a checkout.
 *
 * In the jobs container a Windows cwd such as `C:/Users/alex/proj` is a
 * relative path to Linux. Walking it up for `.git` ended at `./.git`, the
 * checkout of whatever folder the worker happened to run in.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { routeSession } from '../lib/collection.mjs';
import { hostSettings } from '../lib/host-settings.mjs';
import { makeRepoResolver } from '../lib/paths.mjs';
import { resolveRepo } from '../lib/repo.mjs';
import { writeSessionStartRecord } from '../lib/session-start.mjs';
import { discoverMemorySessions, runMemoryWorker } from '../memory-worker.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

const FLAVOR = Object.freeze({ HARNESS_HOST_PATH_FLAVOR: 'win32', HARNESS_HOST_HOME: 'C:\\Users\\alex',
  HARNESS_HOST_VAULT: 'C:/Users/alex/vault' });
/** A Windows path, which only Windows reads as absolute. */
const WINDOWS_CWD = 'C:/Users/alex/proj/src';

function insideCheckout(sandbox, work) {
  const previous = process.cwd();
  process.chdir(path.join(sandbox.root, 'repos', 'bb2dash'));
  try { return work(); } finally { process.chdir(previous); }
}

test('a relative path never resolves the checkout the process runs in', () => {
  const sandbox = createSandbox();
  try {
    insideCheckout(sandbox, () => {
      assert.ok(fs.existsSync('.git'), 'the fixture puts a checkout in the process cwd');
      assert.equal(resolveRepo('sub/dir').repoRoot, '');
      assert.equal(resolveRepo('sub/dir').repoFullName, '');
    });
  } finally {
    sandbox.cleanup();
  }
});

test('a Windows path read on another platform resolves no checkout', { skip: process.platform === 'win32' }, () => {
  const sandbox = createSandbox();
  try {
    insideCheckout(sandbox, () => {
      assert.equal(resolveRepo(WINDOWS_CWD).repoRoot, '');
      assert.equal(makeRepoResolver()(`${WINDOWS_CWD}/a.mjs`), null);
    });
  } finally {
    sandbox.cleanup();
  }
});

test('under a host path flavor the routing rules never ask for a repository', () => {
  const sandbox = createSandbox();
  try {
    const refuse = () => { throw new Error('repository lookup under a flavor'); };
    const routed = routeSession({ cwd: WINDOWS_CWD, vaultRoot: sandbox.vaultRoot, env: FLAVOR,
      home: 'C:/Users/alex', resolveRepoFor: refuse, holdsHarness: false });
    assert.equal(routed.rule, 'folder');
    assert.equal(routed.repo.repoFullName, '');
  } finally {
    sandbox.cleanup();
  }
});

test('under a host path flavor the per-file repository resolver resolves nothing', () => {
  const sandbox = createSandbox();
  try {
    const real = path.join(sandbox.root, 'repos', 'bb2dash', 'a.mjs');
    assert.ok(makeRepoResolver()(real), 'natively the fixture checkout resolves');
    assert.equal(makeRepoResolver({ env: FLAVOR })(real), null);
  } finally {
    sandbox.cleanup();
  }
});

// ------------------------------------------------- the host's home folder

test('under a flavor the harness and container rules read the host home, not this process home', () => {
  const sandbox = createSandbox();
  try {
    const route = (cwd) => routeSession({ cwd, vaultRoot: sandbox.vaultRoot, env: FLAVOR, home: '/root', holdsHarness: true });
    assert.equal(route('C:/Users/alex/.harness/state').rule, 'harness');
    assert.equal(route('c:/users/ALEX/.claude').collection, 'agentic-harness');
    const container = route('C:/Users/alex/projects');
    assert.deepEqual([container.rule, container.collection], ['container', 'misc']);
    assert.notEqual(route('/root/.harness').rule, 'harness', 'the container home names nothing');
  } finally {
    sandbox.cleanup();
  }
});

test('under a flavor a Claude Code state folder is not decoded against this disk', () => {
  const sandbox = createSandbox();
  try {
    const cwd = 'C:/Users/alex/.claude/projects/C--Users-alex-proj/memory';
    const routed = routeSession({ cwd, vaultRoot: sandbox.vaultRoot, env: FLAVOR, holdsHarness: true });
    assert.equal(routed.routedCwd, cwd);
    assert.equal(routed.rule, 'harness');
  } finally {
    sandbox.cleanup();
  }
});

test('the host settings are required and checked under a flavor, and ignored without one', () => {
  assert.equal(hostSettings({}), null);
  assert.equal(hostSettings({ HARNESS_HOST_HOME: 'nonsense' }), null);
  assert.deepEqual(hostSettings(FLAVOR), { flavor: 'win32', home: 'C:/Users/alex', vault: 'C:/Users/alex/vault' });
  const without = (key) => { const env = { ...FLAVOR }; delete env[key]; return env; };
  assert.throws(() => hostSettings(without('HARNESS_HOST_HOME')), /HARNESS_HOST_HOME/);
  assert.throws(() => hostSettings(without('HARNESS_HOST_VAULT')), /HARNESS_HOST_VAULT/);
  for (const bad of ['Users/alex', '/home/alex', 'C:', 'C:relative', '\\\\?\\GLOBALROOT\\x', 'C:/Users/alex/../bob']) {
    assert.throws(() => hostSettings({ ...FLAVOR, HARNESS_HOST_HOME: bad }), /HARNESS_HOST_HOME/, bad);
  }
  assert.throws(() => hostSettings({ ...FLAVOR, HARNESS_HOST_PATH_FLAVOR: 'darwin' }), /HARNESS_HOST_PATH_FLAVOR/);
});

test('routing under a flavor with no host home refuses rather than guessing', () => {
  const env = { HARNESS_HOST_PATH_FLAVOR: 'win32', HARNESS_HOST_VAULT: 'C:/v' };
  assert.throws(() => routeSession({ cwd: WINDOWS_CWD, vaultRoot: '/nowhere', env, holdsHarness: false }), /HARNESS_HOST_HOME/);
});

test('a worker under a flavor with no host home logs why and fails, never captures', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-worker-host-'));
  try {
    const lines = [];
    const env = { HARNESS_HOST_PATH_FLAVOR: 'win32', HARNESS_MEMORY_EXCLUDED_ROOTS: '[]', HARNESS_HOST_VAULT: 'C:/Users/alex/vault' };
    const result = await runMemoryWorker({ home, env, log: line => lines.push(line), candidates: [] });
    assert.deepEqual(result, { disabled: true, failed: 1 });
    assert.ok(lines.some(line => /memory worker blocked: .*HARNESS_HOST_HOME/.test(line)), lines.join('\n'));
    assert.equal(fs.existsSync(path.join(home, '.harness', 'memory-worker.lock')), false, 'blocked before any state is touched');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ------------------------------- runtimes a flavored worker does not read

test('under a flavor Hermes and the Codex database are off by design, reported as not installed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-worker-runtimes-'));
  try {
    const hermesHome = path.join(home, 'hermes');
    fs.mkdirSync(hermesHome);
    fs.mkdirSync(path.join(home, '.codex'));
    // Not a database: opening it natively fails, so a skipped open is visible.
    fs.writeFileSync(path.join(home, '.codex', 'state_5.sqlite'), 'not a database');
    const env = { ...FLAVOR, HARNESS_MEMORY_EXCLUDED_ROOTS: '[]', HARNESS_HERMES_HOME: hermesHome };
    const found = await discoverMemorySessions({ home, vaultRoot: path.join(home, 'vault'), stateDir: home, env, log: () => {} });
    assert.deepEqual(found.capabilities.find((item) => item.runtime === 'hermes'),
      { runtime: 'hermes', available: false, installed: false, reason: 'not read under a host path flavor' });
    assert.deepEqual(found.capabilities.find((item) => item.runtime === 'codex'), { runtime: 'codex', available: true });
    assert.equal(found.length, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ------------------------------------- the preview shows where each session files

test('--preview lists where each session would be filed, and only that an excluded one is excluded', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-preview-'));
  try {
    const filed = '55555555-5555-4555-8555-555555555555';
    const hidden = '66666666-6666-4666-8666-666666666666';
    const demo = path.join(home, 'demo');
    const privateWork = path.join(home, 'private-work');
    const projects = path.join(home, '.claude', 'projects', 'demo');
    for (const dir of [demo, privateWork, projects, path.join(home, 'vault')]) fs.mkdirSync(dir, { recursive: true });
    const transcript = (cwd) => [
      { type: 'user', cwd, timestamp: new Date().toISOString(), message: { content: 'Record the decision.' } },
      { type: 'assistant', cwd, timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'Recorded.' }] } },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n';
    fs.writeFileSync(path.join(projects, `${filed}.jsonl`), transcript(demo));
    fs.writeFileSync(path.join(projects, `${hidden}.jsonl`), transcript(path.join(privateWork, 'briefs')));
    const stateRoot = path.join(home, 'state');
    writeSessionStartRecord({ stateDir: path.join(stateRoot, 'session-start'), record: { at: new Date().toISOString(), sessionId: filed,
      cwd: demo, realm: 'classes', collection: 'ist323', collectionSource: 'folder', source: 'none', externalIds: [], tokens: 0 } });
    const env = { USERPROFILE: home, HARNESS_VAULT: path.join(home, 'vault'), HARNESS_MACHINE_ENV: path.join(home, 'absent.env'),
      HARNESS_STATE_DIR: stateRoot, HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([privateWork]), HARNESS_MEMORY_STATE_DIR: path.join(home, 'exclusions') };
    const result = await runMemoryWorker({ home, env, preview: true, log: () => {} });
    const byId = Object.fromEntries(result.candidates.map((item) => [item.sessionId, item]));
    assert.deepEqual(byId[filed], { runtime: 'claude-code', sessionId: filed, area: 'classes', collection: 'ist323', basis: 'record' });
    assert.deepEqual(byId[hidden], { runtime: 'claude-code', sessionId: hidden, excluded: true });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
