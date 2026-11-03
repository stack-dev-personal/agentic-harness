/**
 * The Codex SessionStart hook: the same brief Claude Code gets, answered in the
 * shape Codex's `session-start.command.output` schema accepts, and logged under
 * `~/.codex/hooks/` rather than Claude's folder.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { STATE_DIR_ENV_VAR } from '../lib/session-start.mjs';
import { LOG_ENV_VAR, SESSION_START_EVENT } from '../lib/start-brief.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

const HOOK = fileURLToPath(new URL('../codex-session-start.mjs', import.meta.url));
/** Codex thread ids are UUIDv7. */
const SESSION = '01a1a2cd-6e87-7c32-b28b-1a73010add69';

function setup(t) {
  const sandbox = createSandbox();
  t.after(() => sandbox.cleanup());
  const vault = sandbox.vaultRoot;
  fs.mkdirSync(path.join(vault, 'harness', 'agentic-harness', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'harness', '.realm'), 'harness\n', 'utf8');
  fs.writeFileSync(
    path.join(vault, 'harness', 'agentic-harness', 'status.md'),
    "---\nid: 'status-agentic-harness'\ntype: status\n---\n\n# Status\n\n- CODEX-BRIEF-MARKER in progress\n",
    'utf8',
  );
  const home = path.join(sandbox.root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HARNESS_VAULT: vault,
    [STATE_DIR_ENV_VAR]: path.join(sandbox.root, 'state'),
    HARNESS_MACHINE_ENV: path.join(sandbox.root, 'absent-machine.env'),
    USERPROFILE: home,
    HOME: home,
  };
  return { sandbox, home, env, stateDir: path.join(sandbox.root, 'state', 'session-start') };
}

/** Every field Codex's `session-start.command.input` schema marks required. */
function codexPayload(sandbox) {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: `${sandbox.root}/.codex/sessions/rollout-${SESSION}.jsonl`,
    cwd: `${sandbox.root}/repos/agentic-harness`,
    hook_event_name: 'SessionStart',
    model: 'gpt-test',
    permission_mode: 'default',
    source: 'startup',
  });
}

function spawnHook(input, env) {
  const { [LOG_ENV_VAR]: _ignored, ...inherited } = process.env;
  return spawnSync(process.execPath, [HOOK], {
    input, encoding: 'utf8', timeout: 30_000, env: { ...inherited, ...env },
  });
}

test('Codex SessionStart: the brief comes back in the shape Codex accepts', (t) => {
  const { sandbox, env, stateDir } = setup(t);
  const result = spawnHook(codexPayload(sandbox), env);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  // Codex's output schema sets additionalProperties: false at both levels.
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(parsed.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, SESSION_START_EVENT);
  assert.match(parsed.hookSpecificOutput.additionalContext, /CODEX-BRIEF-MARKER/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /mcp__rag__search_context/);
  assert.ok(fs.existsSync(path.join(stateDir, `${SESSION}.json`)), 'the record capture reads is written');
});

test('Codex SessionStart logs under ~/.codex/hooks, not Claude Code\'s folder', (t) => {
  const { sandbox, home, env } = setup(t);
  const result = spawnHook(codexPayload(sandbox), env);
  assert.equal(result.status, 0, result.stderr);
  const log = fs.readFileSync(path.join(home, '.codex', 'hooks', 'session-start.log'), 'utf8');
  assert.match(log, /debug input-keys: /);
  assert.doesNotMatch(log, /CODEX-BRIEF-MARKER/, 'the brief never reaches the log');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'hooks', 'session-start.log')), false);
});

test('Codex SessionStart: garbage on stdin is still the valid empty answer', (t) => {
  const { env } = setup(t);
  const result = spawnHook('{{{ not json', env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, '');
});
