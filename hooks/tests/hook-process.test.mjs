/**
 * The hook as Claude Code actually runs it: a process, a JSON payload on stdin,
 * an exit code.
 *
 * Everything else here calls `capture()` directly. This file is the check that
 * the wrapper around it holds the three promises that matter at session exit —
 * always exit 0, always log, never hang on a Windows pipe.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DISABLE_ENV_VAR, LOG_ENV_VAR, VAULT_ENV_VAR } from '../lib/constants.mjs';
import {
  ENV_ENABLED,
  ENV_PROJECT_DIR,
  ENV_RUN_LOG,
  ENV_UV_BIN,
} from '../lib/enqueue-ingest.mjs';
import { createSandbox, installTranscript } from './helpers/sandbox.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', 'session-capture.mjs');
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Run the hook exactly as settings.json does, but pointed at the sandbox.
 *
 * `payload` is stringified unless it is already a string, so a test can feed the
 * hook bytes that are not JSON at all without hand-copying this call.
 */
function runHook(sandbox, payload, extraEnv = {}) {
  const logPath = path.join(sandbox.root, 'session-capture.log');
  let status = 0;
  try {
    execFileSync(process.execPath, [HOOK], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        USERPROFILE: sandbox.root,
        HARNESS_MACHINE_ENV: path.join(sandbox.root, 'absent.env'),
        HARNESS_MEMORY_START_WORKER: '0',
        [VAULT_ENV_VAR]: sandbox.vaultRoot,
        [LOG_ENV_VAR]: logPath,
        [ENV_ENABLED]: '0', // the real hook is under test; no detached ingest
        ...extraEnv,
      },
    });
  } catch (err) {
    status = typeof err?.status === 'number' ? err.status : 1;
  }
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  return { status, log };
}

test('the hook writes a note, logs the elapsed milliseconds, and exits 0', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installTranscript(sandbox, 'plain-main', SESSION_ID);
    const { status, log } = runHook(sandbox, {
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      cwd: `${sandbox.root}/repos/bb2dash`,
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });

    assert.equal(status, 0);
    assert.match(log, /projects\/bb2dash\/sessions\/11111111-1111-4111-8111-111111111111\.md/);
    assert.match(log, / ms=\d+$/m, 'the log must record the elapsed milliseconds');

    const note = path.join(
      sandbox.vaultRoot,
      'projects/bb2dash/sessions',
      `${SESSION_ID}.md`,
    );
    assert.ok(fs.existsSync(note));
    assert.match(fs.readFileSync(note, 'utf8'), /^schema_version: 2$/m);
  } finally {
    sandbox.cleanup();
  }
});

test('malformed stdin exits 0 and says so in the log', () => {
  const sandbox = createSandbox();
  try {
    const { status, log } = runHook(sandbox, 'this is not json');

    assert.equal(status, 0);
    assert.match(log, /stdin was not JSON/);
  } finally {
    sandbox.cleanup();
  }
});

test('the kill switch stops the hook without stopping the session', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installTranscript(sandbox, 'plain-main', SESSION_ID);
    const { status } = runHook(
      sandbox,
      {
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
        cwd: `${sandbox.root}/repos/bb2dash`,
        reason: 'clear',
      },
      { [DISABLE_ENV_VAR]: '0' },
    );

    assert.equal(status, 0);
    assert.equal(
      fs.existsSync(path.join(sandbox.vaultRoot, 'projects/bb2dash/sessions', `${SESSION_ID}.md`)),
      false,
    );
  } finally {
    sandbox.cleanup();
  }
});

test('a session with no transcript is a logged skip, not a failure', () => {
  const sandbox = createSandbox();
  try {
    const { status, log } = runHook(sandbox, {
      session_id: '00000000-0000-4000-8000-000000000000',
      transcript_path: `${sandbox.root}/projects/fixture/does-not-exist.jsonl`,
      cwd: `${sandbox.root}/repos/bb2dash`,
      reason: 'logout',
    });
    assert.equal(status, 0);
    assert.match(log, /no transcript found/);
  } finally {
    sandbox.cleanup();
  }
});

test('with the enqueue enabled, the real process asks for an ingest and says so', () => {
  // Every other test here forces the enqueue off, so nothing ran the actual
  // hook process with it on — the one configuration the machine uses.
  //
  // `uv` is process.execPath: the enqueue only requires an absolute path to a
  // file that exists, and node started with `--directory` prints a bad-option
  // error and exits. No ingest can run, no model is loaded, and the child's
  // output goes to a run log outside the sandbox so tearing the sandbox down
  // cannot race a still-exiting child.
  const sandbox = createSandbox();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'enqueue-process-'));
  try {
    const transcriptPath = installTranscript(sandbox, 'plain-main', SESSION_ID);
    const runLog = path.join(outside, 'ingest-on-capture.log');

    // The enqueue refuses when the project directory is not there, so it has to
    // exist. A pyproject.toml makes it look like the uv project it stands in for.
    const projectDir = path.join(outside, 'ingest-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'pyproject.toml'), '[project]\nname = "stub"\n', 'utf8');

    const { status, log } = runHook(
      sandbox,
      {
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
        cwd: `${sandbox.root}/repos/bb2dash`,
        hook_event_name: 'SessionEnd',
        reason: 'clear',
      },
      {
        [ENV_ENABLED]: '1',
        [ENV_UV_BIN]: process.execPath,
        [ENV_PROJECT_DIR]: projectDir,
        [ENV_RUN_LOG]: runLog,
      },
    );

    assert.equal(status, 0, 'the enqueue must never cost the session its clean exit');
    const pending = path.join(sandbox.root, '.harness', 'memory-ingest-queue.jsonl');
    assert.ok(fs.existsSync(pending), 'the hook hands work to the durable queue');
    const queued = fs.readFileSync(pending, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(queued.length, 1);
    assert.match(queued[0].note, /^projects\/[^/]+\/sessions\/11111111-1111-4111-8111-111111111111\.md$/);
    assert.equal(fs.existsSync(runLog), false, 'capture does not start an untracked detached ingest');
  } finally {
    sandbox.cleanup();
    try {
      fs.rmSync(outside, { recursive: true, force: true });
    } catch {
      /* a child still holding the run log open is not this test's problem */
    }
  }
});

test('a missing ingest project leaves captured work queued for later retry', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installTranscript(sandbox, 'plain-main', SESSION_ID);
    const { status, log } = runHook(
      sandbox,
      {
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
        cwd: `${sandbox.root}/repos/bb2dash`,
        reason: 'clear',
      },
      {
        [ENV_ENABLED]: '1',
        [ENV_UV_BIN]: process.execPath,
        [ENV_PROJECT_DIR]: path.join(sandbox.root, 'no-such-project'),
      },
    );

    assert.equal(status, 0);
    // On a slow runner the hook can reach its deadline before the enqueue step,
    // and that is the other correct refusal: either way nothing is spawned.
    assert.ok(fs.existsSync(path.join(sandbox.root, '.harness', 'memory-ingest-queue.jsonl')));
    assert.match(log, / ms=\d+$/m, 'the note itself was still captured and timed');
  } finally {
    sandbox.cleanup();
  }
});

// ------------------------------------------------ per-machine redaction (H-6)

test("the hook installs the machine's extra redaction rules before it captures", () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installTranscript(sandbox, 'plain-main', SESSION_ID);
    const rulesFile = path.join(sandbox.root, 'redact-extra.json');
    fs.writeFileSync(rulesFile, JSON.stringify({ rules: [{ name: 'codename', pattern: 'retrieval polish', flags: 'i' }] }), 'utf8');

    const { status } = runHook(
      sandbox,
      {
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
        cwd: `${sandbox.root}/repos/bb2dash`,
        hook_event_name: 'SessionEnd',
        reason: 'clear',
      },
      { HARNESS_REDACT_EXTRA: rulesFile, HARNESS_MACHINE_ENV: path.join(sandbox.root, 'no-machine.env') },
    );

    assert.equal(status, 0);
    const note = fs.readFileSync(path.join(sandbox.vaultRoot, 'projects/bb2dash/sessions', `${SESSION_ID}.md`), 'utf8');
    assert.ok(note.includes('[REDACTED:codename]'), 'the extra rule reached the note');
    assert.ok(!/retrieval polish/i.test(note));
  } finally {
    sandbox.cleanup();
  }
});

test('a broken extras file is logged, and the note is still written with the built-in rules', () => {
  const sandbox = createSandbox();
  try {
    const transcriptPath = installTranscript(sandbox, 'plain-main', SESSION_ID);
    const rulesFile = path.join(sandbox.root, 'redact-extra.json');
    fs.writeFileSync(rulesFile, '{ "rules": [', 'utf8');

    const { status, log } = runHook(
      sandbox,
      {
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
        cwd: `${sandbox.root}/repos/bb2dash`,
        hook_event_name: 'SessionEnd',
        reason: 'clear',
      },
      { HARNESS_REDACT_EXTRA: rulesFile, HARNESS_MACHINE_ENV: path.join(sandbox.root, 'no-machine.env') },
    );

    assert.equal(status, 0);
    assert.match(log, /redact-extra: .*not valid JSON/);
    assert.ok(fs.existsSync(path.join(sandbox.vaultRoot, 'projects/bb2dash/sessions', `${SESSION_ID}.md`)));
  } finally {
    sandbox.cleanup();
  }
});
