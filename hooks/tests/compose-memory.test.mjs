import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { composeService } from './helpers/compose-service.mjs';

const REPO = path.join(import.meta.dirname, '..', '..');
const compose = fs.readFileSync(path.join(REPO, 'compose.yaml'), 'utf8');
const memory = composeService(compose, 'harness-memory');

/** Each bind as {source, target, readOnly}, in the order written. */
function binds(block) {
  const result = [];
  for (const match of block.matchAll(/- type: bind\n((?: {8}.*\n?)+)/g)) {
    const body = match[1];
    result.push({
      source: /source: (.+)/.exec(body)?.[1].trim(),
      target: /target: (.+)/.exec(body)?.[1].trim(),
      readOnly: /read_only: true/.test(body),
    });
  }
  return result;
}

test('harness-memory starts only by its profile and runs the loop', () => {
  assert.match(memory, /^ {4}profiles: \[memory\]$/m);
  assert.match(memory, /^ {4}command: \["node", "hooks\/memory-loop\.mjs"\]$/m);
  assert.match(memory, /^ {4}restart: unless-stopped$/m);
  assert.match(memory, /node", "\/app\/hooks\/memory-worker\.mjs", "--health"/);
  assert.doesNotMatch(memory, /^ {4}build:/m, 'harness-jobs builds the image; two builds of one tag race');
});

test('harness-memory holds the database secret and nothing else', () => {
  const secrets = /^ {4}secrets:\n((?: {6}- .+\n?)+)/m.exec(memory)?.[1].trim().split('\n').map((line) => line.replace(/^\s*- /, ''));
  assert.deepEqual(secrets, ['harness_database_url']);
  assert.doesNotMatch(memory, /VAULT_REALM_PAT|vault_realm_pat|GH_TOKEN|claude_oauth_token/);
});

test('transcripts and machine.env are read-only; only state and the vault are writable', () => {
  const mounts = binds(memory);
  const byTarget = Object.fromEntries(mounts.map((mount) => [mount.target, mount]));
  for (const target of ['/home/harness/.claude/projects', '/home/harness/.codex/sessions', '/home/harness/.codex/archived_sessions',
    '/home/harness/.harness/machine.env']) assert.equal(byTarget[target]?.readOnly, true, `${target} is not read-only`);
  assert.equal(byTarget['/home/harness/.harness']?.readOnly, false);
  assert.equal(byTarget['/vault']?.readOnly, false);
  assert.deepEqual(mounts.map((mount) => mount.target).sort(), [
    '/home/harness/.claude/projects', '/home/harness/.codex/archived_sessions', '/home/harness/.codex/sessions',
    '/home/harness/.harness', '/home/harness/.harness/machine.env', '/vault',
  ], 'no other host folder: no checkouts, no Codex database or login, no Hermes');
  const machineEnv = mounts.findIndex((mount) => mount.target === '/home/harness/.harness/machine.env');
  const state = mounts.findIndex((mount) => mount.target === '/home/harness/.harness');
  assert.ok(machineEnv > state, 'the read-only machine.env is mounted over the writable folder, after it');
});

test('an unset host path falls back to a folder that is never created', () => {
  for (const variable of ['CLAUDE_PROJECTS_DIR', 'CODEX_DIR', 'HARNESS_STATE_DIR_HOST']) {
    assert.match(memory, new RegExp(`\\$\\{${variable}:-\\./\\.memory-unset/[a-z-]+\\}`), `${variable} has no inert fallback`);
  }
  assert.equal((memory.match(/create_host_path: false/g) || []).length, 5, 'every host bind except the vault refuses to create its source');
});

test('the worker judges Windows paths and is told the host home and vault', () => {
  assert.match(memory, /HARNESS_HOST_PATH_FLAVOR: \$\{HARNESS_HOST_PATH_FLAVOR:-win32\}/);
  assert.match(memory, /HARNESS_HOST_HOME: \$\{HARNESS_HOST_HOME:-\}/);
  assert.match(memory, /HARNESS_HOST_VAULT: \$\{HARNESS_HOST_VAULT:-\}/);
  // machine.env names host paths; the service's own values must win for every path the worker reads.
  for (const [key, value] of [['HARNESS_VAULT', '/vault'], ['HARNESS_INGEST_PROJECT', '/app/ingest'], ['FASTEMBED_CACHE_DIR', '/cache/fastembed']]) {
    assert.match(memory, new RegExp(`^ {6}${key}: ${value.replace(/\//g, '\\/')}$`, 'm'), `${key} is not set to ${value}`);
  }
});

test('a stop gives the running worker time to finish its step and release the lock', () => {
  const grace = /^ {4}stop_grace_period: (\d+)s$/m.exec(memory);
  assert.ok(grace && Number(grace[1]) >= 120, 'stop_grace_period under two minutes');
});
