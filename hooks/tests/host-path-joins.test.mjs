/**
 * Phase 2 of the container move: a relative tool path recorded by a Windows
 * session is joined to its working directory as Windows text.
 *
 * Node's own `path` on Linux calls `C:/work` relative and resolves it under the
 * process's folder, giving `/app/C:/work/src/a.mjs`. The policy refuses that
 * spelling (a drive named inside a path), so every Codex session with a
 * relative patch path was excluded, and a path into the protected folder was
 * only refused by accident.
 *
 * Also: the working directory a Codex turn records (`turn_context`) is the one
 * its relative paths are joined to and the one judged, natively too.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureCodex, extractCodexTurns } from '../codex-session-capture.mjs';
import { captureSession } from '../lib/capture.mjs';
import { joinHostPath } from '../lib/host-paths.mjs';

const ROOT = 'C:/Users/alex/private-work';
const CWD = 'C:\\Users\\alex\\projects\\app';
const FLAVOR = Object.freeze({
  HARNESS_HOST_PATH_FLAVOR: 'win32',
  HARNESS_HOST_HOME: 'C:/Users/alex',
  HARNESS_HOST_VAULT: 'C:/Users/alex/vault',
  HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([ROOT]),
});
const at = (seconds) => new Date(Date.UTC(2026, 10, 3, 12, 0, seconds)).toISOString();
const message = (role, text, timestamp, phase) => ({ timestamp, type: 'response_item',
  payload: { type: 'message', role, ...(phase ? { phase } : {}), content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const turnContext = (cwd, seconds = 2) => ({ timestamp: at(seconds), type: 'turn_context', payload: { cwd, model: 'any-model' } });

function patchRecord(file, seconds = 3) {
  const script = `await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch`)});`;
  return { timestamp: at(seconds), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: `p${seconds}`, input: script } };
}

const writes = (parsed) => parsed.entries.flatMap((entry) => entry.message?.content ?? [])
  .filter((block) => block?.name === 'Write').map((block) => block.input.file_path);

// ------------------------------------------------------------- the join

test('joinHostPath joins a relative path to a full cwd read by the policy\'s own rules, the file as written', () => {
  assert.equal(joinHostPath(CWD, 'src\\a.mjs'), 'C:\\Users\\alex\\projects\\app\\src\\a.mjs');
  assert.equal(joinHostPath('C:/work/', 'src/a.mjs'), 'C:\\work\\src/a.mjs');
  assert.equal(joinHostPath('C:/work', '..\\private\\a'), 'C:\\work\\..\\private\\a', 'no normalisation: the policy applies the `..`');
  assert.equal(joinHostPath('C:\\', 'a'), 'C:\\a');
  assert.equal(joinHostPath('\\\\srv\\share\\', 'a'), '\\\\srv\\share\\a');
  // A device-prefixed cwd (every Codex database thread) is read as the policy reads it.
  assert.equal(joinHostPath('\\\\?\\C:\\Users\\alex\\projects\\app', '.\\src\\a.mjs'), 'C:\\Users\\alex\\projects\\app\\.\\src\\a.mjs');
  assert.equal(joinHostPath('/c/Users/alex/app', 'a'), 'c:\\Users\\alex\\app\\a', 'drive letters compare without case');
});

test('joinHostPath leaves a path that names its own place, or a cwd that is not a full path, to the policy', () => {
  for (const own of ['C:\\x\\a', 'c:x', '\\x\\a', '/c/x', '\\\\server\\share\\a', '\\\\?\\C:\\a', '~\\a', '~', 'file://srv/share/x', 'FILE:x', '']) {
    assert.equal(joinHostPath(CWD, own), own, own);
  }
  for (const cwd of ['', ' C:\\Users\\alex', 'projects\\app', '/', 'C:', 'C:relative', '\\\\srv\\', '\\\\?\\GLOBALROOT\\x', '\\\\.\\X:\\..\\C:\\x']) {
    assert.equal(joinHostPath(cwd, 'private-work\\x'), 'private-work\\x', JSON.stringify(cwd));
  }
});

test('joinHostPath stays fast on a cwd made of a long run of separators', () => {
  const started = Date.now();
  joinHostPath(`C:${'\\'.repeat(100_000)}x`, 'a');
  joinHostPath(`C:\\x${'/'.repeat(100_000)}`, 'a');
  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
});

// -------------------------------------------------- the rollout parser

test('under a flavor a relative patch path is joined as Windows text, natively as before', () => {
  const records = [message('user', 'Patch it.', at(1)), patchRecord('src/a.mjs')];
  assert.deepEqual(writes(extractCodexTurns(records, CWD, { env: FLAVOR })), [`${CWD}\\src/a.mjs`]);
  assert.deepEqual(writes(extractCodexTurns(records, 'C:/work')), [path.resolve('C:/work', 'src/a.mjs')]);
});

test('a turn\'s own cwd is the one later relative paths join to, and the one later entries carry', () => {
  const other = 'C:\\Users\\alex\\projects\\lib';
  const records = [message('user', 'Patch it.', at(1)), turnContext(other), patchRecord('src/a.mjs')];
  const flavored = extractCodexTurns(records, CWD, { env: FLAVOR });
  assert.deepEqual(writes(flavored), [`${other}\\src/a.mjs`]);
  assert.equal(flavored.entries.at(-1).cwd, other);
  const nativeCwd = path.join(os.tmpdir(), 'turn-cwd');
  const native = extractCodexTurns([message('user', 'Patch it.', at(1)), turnContext(nativeCwd), patchRecord('src/a.mjs')], path.join(os.tmpdir(), 'session-cwd'));
  assert.deepEqual(writes(native), [path.resolve(nativeCwd, 'src/a.mjs')]);
});

// -------------------------------------------------------- end to end

function codexWorld(records, sessionCwd = CWD) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-joins-'));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);
  const sessionId = randomUUID();
  const transcriptPath = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(transcriptPath, [
    { timestamp: at(0), type: 'session_meta', payload: { cwd: sessionCwd } },
    message('user', 'Fix the app.', at(1)),
    ...records,
    message('assistant', 'Fixed.', at(9), 'final_answer'),
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const run = () => captureCodex({ input: { sessionId, transcriptPath, cwd: sessionCwd, hookEventName: 'SessionEnd', endReason: 'other' },
    vaultRoot, home: root, env: { ...FLAVOR, HARNESS_MEMORY_STATE_DIR: path.join(root, 'state') },
    stateDir: path.join(root, 'state', 'session-start'), runGit: () => ({ ok: false, stdout: '' }) });
  return { run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function outcome(records, sessionCwd) {
  const w = codexWorld(records, sessionCwd);
  try { return w.run(); } finally { w.cleanup(); }
}

test('in the container a Codex session with a relative patch path is captured, device-prefixed cwd included', () => {
  for (const [cwd, file] of [[CWD, 'src/a.mjs'], [`\\\\?\\${CWD}`, './src/a.mjs'], [`\\\\?\\${CWD}`, '..\\lib\\b.mjs']]) {
    const result = outcome([patchRecord(file)], cwd);
    assert.equal(result.written, true, `${cwd} + ${file}: ${result.action} ${result.skip}`);
  }
});

test('in the container a relative patch path that climbs into the protected folder excludes the session', () => {
  for (const climb of ['..\\..\\private-work\\brief.md', '../../private-work/brief.md', '..\\..\\PRIVATE-WORK\\x', '..\\..\\PRIVAT~1\\x']) {
    for (const cwd of [CWD, `\\\\?\\${CWD}`]) {
      const result = outcome([patchRecord(climb)], cwd);
      assert.equal(result.action, 'excluded', `${cwd} + ${climb}: ${result.skip}`);
    }
  }
});

test('a turn that moved into the protected folder excludes the session, whatever its paths say', () => {
  const result = outcome([turnContext('C:\\Users\\alex\\private-work'), patchRecord('brief.md')]);
  assert.equal(result.action, 'excluded', result.skip);
});

test('a file URL in a patch is still refused, not hidden behind the cwd', () => {
  const result = outcome([patchRecord('file://srv/share/private/x')]);
  assert.equal(result.action, 'excluded', result.skip);
});

// ---------------------- a turn's folder is judged even with no tool path

const PROTECTED_TURNS = Object.freeze([
  'C:\\Users\\alex\\private-work',
  'C:\\Users\\alex\\PRIVAT~1',
  'c:\\USERS\\ALEX\\PRIVATE-WORK\\sub',
  '/c/Users/alex/private-work',
  '\\\\?\\C:\\Users\\alex\\private-work',
]);
const chatOnly = (turnCwd) => [turnContext(turnCwd), message('user', 'Summarise.', at(3)), message('assistant', 'Done.', at(4), 'final_answer')];
const shellOnly = (turnCwd) => [turnContext(turnCwd), { timestamp: at(3), type: 'response_item',
  payload: { type: 'function_call', name: 'shell_command', call_id: 's1', arguments: JSON.stringify({ cmd: 'type secret.md' }) } }];

test('a turn in the protected folder that only chats or runs a shell command excludes the session', () => {
  for (const turnCwd of PROTECTED_TURNS) {
    for (const [label, records] of [['chat', chatOnly(turnCwd)], ['shell', shellOnly(turnCwd)]]) {
      const result = outcome(records);
      assert.equal(result.action, 'excluded', `${label} in ${turnCwd}: ${result.skip}`);
    }
  }
});

test('a protected turn followed by a turn back out still excludes the session', () => {
  const result = outcome([...shellOnly('C:\\Users\\alex\\private-work'), turnContext(CWD, 5), patchRecord('src/a.mjs', 6)]);
  assert.equal(result.action, 'excluded', result.skip);
});

test('a protected turn folder with no entry after it still excludes the session', () => {
  const protectedTurn = 'C:\\Users\\alex\\private-work';
  const cases = [
    [turnContext(protectedTurn, 3), turnContext(CWD, 4)],
    [message('assistant', 'Hello.', at(2), 'final_answer'), turnContext(protectedTurn, 3), turnContext(CWD, 4), message('user', 'Again.', at(5))],
    [message('assistant', 'Hello.', at(2), 'final_answer'), turnContext(protectedTurn, 3)],
  ];
  for (const records of cases) {
    const result = outcome(records);
    assert.equal(result.action, 'excluded', `${records.length} records: ${result.skip}`);
  }
});

test('a relative turn folder is judged against the session folder', () => {
  const result = outcome(chatOnly('..\\private-work'), 'C:\\Users\\alex\\projects');
  assert.equal(result.action, 'excluded', result.skip);
});

test('a turn folder text cannot place refuses the session', () => {
  for (const turnCwd of ['\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\x', 'file:///C:/Users/alex/private-work', 'C:\\Users\\alex\u0000x']) {
    const result = outcome(chatOnly(turnCwd));
    assert.equal(result.action, 'excluded', `${JSON.stringify(turnCwd)}: ${result.skip}`);
  }
});

test('an ordinary second turn folder is captured', () => {
  const result = outcome(chatOnly('C:\\Users\\alex\\projects\\lib'));
  assert.equal(result.written, true, `${result.action}: ${result.skip}`);
});

test('natively, any runtime\'s entry folder inside a protected folder excludes the session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-cwd-'));
  try {
    const app = path.join(root, 'app');
    const privateWork = path.join(root, 'private-work');
    const vaultRoot = path.join(root, 'vault');
    for (const dir of [app, privateWork, vaultRoot]) fs.mkdirSync(dir);
    const entries = [
      { type: 'user', timestamp: at(1), cwd: app, origin: { kind: 'human' }, message: { content: 'Start here.' } },
      { type: 'user', timestamp: at(2), cwd: privateWork, origin: { kind: 'human' }, message: { content: 'Now summarise this.' } },
      { type: 'assistant', timestamp: at(3), cwd: privateWork, message: { content: [{ type: 'text', text: 'Done.' }] } },
    ];
    const env = { USERPROFILE: root, HARNESS_MEMORY_STATE_DIR: path.join(root, 'state'), HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([privateWork]) };
    for (const runtime of ['claude-code', 'codex', 'hermes']) {
      const result = captureSession({ input: { sessionId: `${runtime}-entry-cwd`, cwd: app, endReason: 'resume' }, vaultRoot, entries, env,
        agent: runtime, runtime, stateDir: path.join(root, 'state', 'session-start'), runGit: () => ({ ok: false, stdout: '' }) });
      assert.equal(result.action, 'excluded', `${runtime}: ${result.skip}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
