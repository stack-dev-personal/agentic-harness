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
import path from 'node:path';
import test from 'node:test';

import { routeSession } from '../lib/collection.mjs';
import { makeRepoResolver } from '../lib/paths.mjs';
import { resolveRepo } from '../lib/repo.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

const FLAVOR = Object.freeze({ HARNESS_HOST_PATH_FLAVOR: 'win32' });
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
