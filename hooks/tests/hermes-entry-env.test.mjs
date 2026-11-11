/**
 * The Hermes capture file run as a command reads machine.env like every other
 * host hook, so the protected folders and the worker-start switch there apply.
 * The live Hermes path (hermes/bridge.mjs) already did; this entry point did
 * not, and a protected session sent to it would have been captured.
 *
 * Spawns node, so it runs on Linux only: on Windows a child process can open a
 * console window on the user's screen.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../hermes-session-capture.mjs', import.meta.url));
const at = (seconds) => new Date(Date.UTC(2026, 10, 3, 12, 0, seconds)).toISOString();

test('the Hermes entry point applies the protected folders from machine.env', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-entry-'));
  try {
    const protectedDir = path.join(root, 'private-work');
    const vaultRoot = path.join(root, 'vault');
    fs.mkdirSync(protectedDir);
    fs.mkdirSync(vaultRoot);
    const machineEnv = path.join(root, 'machine.env');
    fs.writeFileSync(machineEnv, `HARNESS_MEMORY_EXCLUDED_ROOTS=${JSON.stringify([protectedDir])}\nHARNESS_VAULT=${vaultRoot}\nHARNESS_MEMORY_START_WORKER=0\n`);
    const snapshot = { session_id: 'entry-check', cwd: path.join(protectedDir, 'briefs'), messages: [
      { role: 'user', content: 'Summarise the brief.', timestamp: at(1) },
      { role: 'assistant', content: 'Done.', timestamp: at(2) },
    ] };
    const run = spawnSync(process.execPath, [ENTRY], { input: JSON.stringify(snapshot), encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, HARNESS_MACHINE_ENV: machineEnv, HARNESS_MEMORY_STATE_DIR: path.join(root, 'state') } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).action, 'excluded', run.stdout);
    assert.deepEqual(fs.readdirSync(vaultRoot), [], 'nothing written to the vault');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
