import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { judgeHealth, runMemoryWorker, workerSide } from '../memory-worker.mjs';

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

test('health is red when stale, failed, missing, or written by the other side', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const fresh = { checkedAt: '2026-11-12T11:55:00Z', failed: 0, writer: 'devbox (container)' };
  const container = { HARNESS_JOBS_CONTAINER: '1' };
  assert.equal(judgeHealth(fresh, { env: container, now }).failed, 0);
  assert.equal(judgeHealth({ ...fresh, checkedAt: '2026-11-12T11:40:00Z' }, { env: container, now }).failed, 1, 'older than 15 minutes');
  assert.equal(judgeHealth({ ...fresh, failed: 2 }, { env: container, now }).failed, 2);
  // The host keeps the shared file fresh while the container captures nothing (busy, or a second worker).
  assert.equal(judgeHealth({ ...fresh, writer: 'devbox (host)' }, { env: container, now }).failed, 1);
  assert.equal(judgeHealth({ ...fresh, writer: undefined }, { env: container, now }).failed, 1, 'a file from before the writer field');
  assert.equal(judgeHealth({ ...fresh, writer: 'devbox (host)' }, { env: {}, now }).failed, 0, 'the host has no side rule');
  assert.equal(judgeHealth(null, { env: container, now }).failed, 1, 'no health file yet');
});

test('workerSide reads only the exact container flag', () => {
  assert.equal(workerSide({ HARNESS_JOBS_CONTAINER: '1' }), 'container');
  assert.equal(workerSide({ HARNESS_JOBS_CONTAINER: '0' }), 'host');
  assert.equal(workerSide({}), 'host');
});
