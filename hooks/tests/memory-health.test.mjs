import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runMemoryWorker, workerSide } from '../memory-worker.mjs';

test('the health file names the machine and side that wrote it', async () => {
  for (const [flag, side] of [[undefined, 'host'], ['1', 'container']]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-health-'));
    try {
      fs.mkdirSync(path.join(home, 'vault'));
      const env = { USERPROFILE: home, HARNESS_VAULT: path.join(home, 'vault'), HARNESS_MACHINE_ENV: path.join(home, 'absent.env'),
        HARNESS_MACHINE: 'devbox', ...(flag ? { HARNESS_JOBS_CONTAINER: flag } : {}) };
      await runMemoryWorker({ home, env, candidates: [], drain: () => ({ failed: [], ingested: 0 }), queue: () => ({ queued: true }) });
      const health = JSON.parse(fs.readFileSync(path.join(home, '.harness', 'memory-health.json'), 'utf8'));
      assert.equal(health.writer, `devbox (${side})`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('workerSide reads only the exact container flag', () => {
  assert.equal(workerSide({ HARNESS_JOBS_CONTAINER: '1' }), 'container');
  assert.equal(workerSide({ HARNESS_JOBS_CONTAINER: '0' }), 'host');
  assert.equal(workerSide({}), 'host');
});
