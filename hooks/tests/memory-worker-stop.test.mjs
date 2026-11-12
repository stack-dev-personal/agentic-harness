import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const WORKER = pathToFileURL(path.join(import.meta.dirname, '..', 'memory-worker.mjs')).href;

// SIGTERM to a child process is POSIX behaviour; on Windows it is TerminateProcess and no handler runs.
// The worker's run is synchronous, so a stop takes effect when the run yields:
// it ends the process then, and never with the lock still held.
test('a stop during a run releases the worker lock before the process exits', { skip: process.platform === 'win32' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-stop-'));
  try {
    fs.mkdirSync(path.join(home, 'vault'));
    const script = path.join(home, 'run.mjs');
    fs.writeFileSync(script, `
      import { installStopHandler, runMemoryWorker } from ${JSON.stringify(WORKER)};
      installStopHandler();
      const env = { USERPROFILE: ${JSON.stringify(home)}, HARNESS_VAULT: ${JSON.stringify(path.join(home, 'vault'))},
        HARNESS_MACHINE_ENV: ${JSON.stringify(path.join(home, 'absent.env'))} };
      const busy = { runtime: 'claude-code', sessionId: 'slow', fingerprint: 'x', input: {}, capture: () => {
        console.log('capturing');
        // Synchronous work, as a capture is: the handler runs when it yields.
        const until = Date.now() + 1500; while (Date.now() < until) { /* busy */ }
        return { written: false, action: 'skip', skip: 'test' };
      } };
      await runMemoryWorker({ home: ${JSON.stringify(home)}, env, candidates: [busy, busy, busy],
        drain: () => ({ failed: [], ingested: 0 }), queue: () => ({ queued: true }) });
      console.log('finished');
    `);
    const child = spawn(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    await new Promise((resolve) => child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('capturing')) resolve(); }));
    assert.ok(fs.existsSync(path.join(home, '.harness', 'memory-worker.lock')), 'the run holds the lock');
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.on('exit', (exitCode, signal) => resolve(exitCode ?? signal)));
    assert.ok(code === 143 || code === 0, `the process exits on its own terms, not killed mid-run (${code})`);
    assert.equal(fs.existsSync(path.join(home, '.harness', 'memory-worker.lock')), false, 'the lock is released');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
