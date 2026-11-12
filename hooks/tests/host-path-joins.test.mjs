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

test('under a flavor Codex capture never opens the host\'s Codex database, even when it is there', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-no-db-'));
  try {
    const vaultRoot = path.join(root, 'vault');
    fs.mkdirSync(vaultRoot);
    fs.mkdirSync(path.join(root, '.codex'));
    // Not a database: opening it fails, so a capture that opened it would not be written.
    fs.writeFileSync(path.join(root, '.codex', 'state_5.sqlite'), 'not a database');
    const sessionId = randomUUID();
    const transcriptPath = path.join(root, 'rollout.jsonl');
    fs.writeFileSync(transcriptPath, [
      { timestamp: at(0), type: 'session_meta', payload: { cwd: CWD } },
      message('user', 'Fix the app.', at(1)),
      message('assistant', 'Fixed.', at(9), 'final_answer'),
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    const result = captureCodex({ input: { sessionId, transcriptPath, cwd: CWD, hookEventName: 'SessionEnd', endReason: 'other' },
      vaultRoot, home: root, env: { ...FLAVOR, HARNESS_MEMORY_STATE_DIR: path.join(root, 'state') },
      stateDir: path.join(root, 'state', 'session-start'), runGit: () => ({ ok: false, stdout: '' }) });
    assert.equal(result.written, true, `${result.action}: ${result.skip}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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

// ------------------------- a shell call's workdir is a folder the session was in

const shellCall = (name, args, seconds = 3) => ({ timestamp: at(seconds), type: 'response_item',
  payload: { type: 'function_call', name, call_id: `w${seconds}`, arguments: JSON.stringify(args) } });
const codeModeShell = (workdirLiteral, seconds = 3) => ({ timestamp: at(seconds), type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'exec', call_id: `c${seconds}`,
    input: `await tools.exec_command({cmd:"type notes.md", workdir:${workdirLiteral}});` } });
const folders = (parsed) => parsed.entries.map((entry) => entry.cwd);
/** Each workdir the parser hands the policy, with the folder it is judged from (the turn's). */
const workdirUses = (parsed) => parsed.entries.flatMap((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : [])
  .filter((block) => block?.name === 'Workdir').map((block) => ({ path: block.input.path, cwd: entry.cwd })));

test('a shell call\'s workdir goes to the policy as recorded, from the turn\'s folder, and is no folder of the note', () => {
  const other = 'C:\\Users\\alex\\projects\\lib';
  const parsed = extractCodexTurns([message('user', 'Look.', at(1)), turnContext(other),
    shellCall('exec_command', { cmd: 'type a.md', workdir: '..\\lib' })], CWD, { env: FLAVOR });
  assert.deepEqual(workdirUses(parsed), [{ path: '..\\lib', cwd: other }]);
  assert.deepEqual([...new Set(folders(parsed))], [CWD, other], 'cwds_seen lists only folders the transcript declared');
  const native = extractCodexTurns([shellCall('exec_command', { cmd: 'ls', workdir: 'lib' })], path.join(os.tmpdir(), 'app'));
  assert.deepEqual(workdirUses(native), [{ path: 'lib', cwd: path.join(os.tmpdir(), 'app') }]);
});

test('a workdir that is not a non-empty string is ignored, and arguments that are not an object do not throw', () => {
  for (const workdir of [undefined, '', 42, null, ['C:\\x'], { path: 'C:\\x' }]) {
    assert.deepEqual(workdirUses(extractCodexTurns([shellCall('exec_command', { cmd: 'ls', workdir })], CWD, { env: FLAVOR })), [], JSON.stringify(workdir));
  }
  for (const raw of ['null', '[]', '"text"', '7', 'not json']) {
    const record = { timestamp: at(3), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'n', arguments: raw } };
    assert.doesNotThrow(() => extractCodexTurns([record], CWD, { env: FLAVOR }), raw);
  }
});

test('every workdir literal in a code-mode script is judged: decoys, comments, quoted keys, any call form, far from the call', () => {
  const judged = (script) => workdirUses(extractCodexTurns([{ timestamp: at(3), type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: script } }], CWD, { env: FLAVOR })).map((use) => use.path);
  // A decoy before the real key no longer hides it: every key is read, the real one included.
  assert.deepEqual(judged('await tools.exec_command({cmd:"echo workdir: \'C:/tmp\'", workdir:"C:\\\\x"});'), ['C:\\x']);
  assert.deepEqual(judged('/* workdir: "C:/tmp" */ tools.exec_command({cmd:"ls", workdir:"C:/y"});'), ['C:/y']);
  assert.deepEqual(judged('tools.exec_command({cmd:"ls", workdir:"C:/a"}); /* workdir: "C:/b", */'), ['C:/a', 'C:/b'], 'one that reads as a whole value counts too');
  assert.deepEqual(judged('tools["exec_command"]({"workdir": "C:/a"}); tools.shell_command({command:"dir", \'workdir\':`C:/b`});'), ['C:/a', 'C:/b']);
  assert.deepEqual(judged(`tools.exec_command({cmd:"${'x'.repeat(3000)}", workdir:"C:/far"});`), ['C:/far']);
  assert.deepEqual(judged('tools.exec_command({cmd:"ls", workdir:"C:\\\\Users\\\\alex\\\\" + "private-work"});'), ['C:\\Users\\alex\\private-work'],
    'literals joined with + are one folder');
  assert.deepEqual(judged('tools.exec_command({cmd:"ls", working_directory:"C:/w"});'), ['C:/w']);
});

test('comments, parentheses, long chains and a lone $ do not hide a workdir literal', () => {
  const judged = (value) => workdirUses(extractCodexTurns([{ timestamp: at(3), type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: `tools.exec_command({cmd:"ls", workdir${value}});` } }], CWD, { env: FLAVOR })).map((use) => use.path);
  const target = 'C:/Users/alex/private-work';
  for (const value of [
    ': "C:/Users/alex/" + /* j */ "private-work"', ': "C:/Users/alex/" + // j\n "private-work"', ': "C:/Users/alex/" /* c */ + "private-work"',
    ' /* k */ : "C:/Users/alex/private-work"', ': /* v */ "C:/Users/alex/private-work"', ': // v\n"C:/Users/alex/private-work"',
    ': ("C:/Users/alex/private-work")', ': ("C:/Users/alex/" + "private-work")', ': "C:/Users/alex/" + ("private-work")',
    `: "C:/Users/alex/"${' + ""'.repeat(200)} + "private-work"`,
  ]) assert.deepEqual(judged(value), [target], value);
  assert.deepEqual(judged(': `C:/Users/alex/private-work/$/..`'), ['C:/Users/alex/private-work/$/..'], 'a $ not opening ${ is text');
});

test('a line comment ends at every JavaScript line terminator', () => {
  const judged = (script) => workdirUses(extractCodexTurns([{ timestamp: at(3), type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: script } }], CWD, { env: FLAVOR })).map((use) => use.path);
  for (const end of ['\r', '\u2028', '\u2029', '\r\n']) {
    assert.deepEqual(judged(`tools.exec_command({cmd:"ls", workdir: // note${end}"C:/Users/alex/private-work"});`), ['C:/Users/alex/private-work'], JSON.stringify(end));
    assert.deepEqual(judged(`tools.exec_command({workdir // note${end}: "C:/Users/alex/private-work"});`), ['C:/Users/alex/private-work'], JSON.stringify(end));
    assert.deepEqual(judged(`tools.exec_command({workdir: "C:/Users/alex/" // x${end}+ "private-work"});`), ['C:/Users/alex/private-work'], JSON.stringify(end));
  }
});

test('an escape that only repeats its character reads as that character, as in JavaScript', () => {
  const judged = (literal) => workdirUses(extractCodexTurns([{ timestamp: at(3), type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: `tools.exec_command({workdir: ${literal}});` } }], CWD, { env: FLAVOR })).map((use) => use.path);
  assert.deepEqual(judged(String.raw`"C:/Users/alex/\private-work"`), ['C:/Users/alex/private-work']);
  assert.deepEqual(judged(String.raw`'C:/Users/alex/private\-work'`), ['C:/Users/alex/private-work']);
  assert.deepEqual(judged(String.raw`"a\vb"`), ['a\u000bb']);
  assert.deepEqual(judged(String.raw`"C:\\x"`), ['C:\\x'], 'a real escape keeps its meaning');
  assert.deepEqual(judged(String.raw`"a\x41"`), [], 'a hex escape is still not read');
});

test('a patch that renames a file into the protected folder excludes the session', () => {
  for (const indent of ['', ' ']) {
    const patchText = ['*** Begin Patch', '*** Update File: src/a.md', `${indent}*** Move to: C:/Users/alex/private-work/a.md`, '@@', '-a', '+b', '*** End Patch'].join('\n');
    const result = outcome([{ timestamp: at(3), type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'p', input: `await tools.apply_patch(${JSON.stringify(patchText)});` } }]);
    assert.equal(result.action, 'excluded', JSON.stringify(indent));
  }
});

test('a patch file header indented with spaces or a tab still names its file', () => {
  for (const indent of ['  ', String.fromCharCode(9), ' ']) {
    const patchText = ['*** Begin Patch', `${indent}*** Add File: C:/Users/alex/private-work/x.md`, '+hello', '*** End Patch'].join('\n');
    const result = outcome([{ timestamp: at(3), type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'p', input: `await tools.apply_patch(${JSON.stringify(patchText)});` } }]);
    assert.equal(result.action, 'excluded', JSON.stringify(indent));
  }
});

test('a raw control character in a literal is read as JavaScript reads it, in a workdir and in a patch', () => {
  const tab = String.fromCharCode(9);
  const one = String.fromCharCode(1);
  const judged = (literal) => workdirUses(extractCodexTurns([{ timestamp: at(3), type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: `tools.exec_command({workdir: ${literal}});` } }], CWD, { env: FLAVOR })).map((use) => use.path);
  assert.deepEqual(judged(`"C:/Users/alex/private-work/${tab}x"`), [`C:/Users/alex/private-work/${tab}x`]);
  assert.deepEqual(judged(`'a${one}b'`), [`a${one}b`]);
  assert.deepEqual(judged(String.raw`"C:/Users/alex/private-work/\8"`), ['C:/Users/alex/private-work/8'], 'an 8 escape is 8 in sloppy JavaScript');
  const patchText = ['*** Begin Patch', '*** Add File: C:/Users/alex/private-work/x.go', `+${tab}func main() {}`, '*** End Patch'].join('\n');
  const patch = `await tools.apply_patch(${'`'}${patchText}${'`'});`;
  const result = outcome([{ timestamp: at(3), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'p', input: patch } }]);
  assert.equal(result.action, 'excluded', 'a tab-indented patch still names its files');
});

test('nesting, length or work the reader will not finish refuses the session instead of judging nothing', () => {
  const run = (value) => outcome([{ timestamp: at(3), type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: `tools.exec_command({cmd:"ls", workdir: ${value}});` } }]);
  const deep = `${'('.repeat(200)}"C:/Users/alex/private-work"${')'.repeat(200)}`;
  assert.equal(run(deep).skip, 'memory path policy could not be verified');
  assert.equal(run(`"C:/Users/alex/private-work/${'a'.repeat(40_000)}"`).skip, 'memory path policy could not be verified');
  assert.equal(run(`${'('.repeat(30)}"C:/Users/alex/private-work"${')'.repeat(30)}`).skip, 'protected path touched', 'ordinary nesting is read');
});

test('scripts shaped to make the reader re-read itself stay fast', () => {
  const read = (script) => {
    const started = Date.now();
    extractCodexTurns([{ timestamp: at(3), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: script } }], CWD, { env: FLAVOR });
    return Date.now() - started;
  };
  for (const script of [`${'//workdir:\n"a"+'.repeat(60_000)}"a"`, `${'workdir/*'.repeat(60_000)}`, `${'workdir: /*'.repeat(30_000)}*/"x"`,
    `${'workdir//'.repeat(60_000)}`, `${'workdir:("a"+'.repeat(20_000)}"a"${')'.repeat(20_000)}`,
    '//workdir\n'.repeat(100_000), `${'//workdir:\n'.repeat(50_000)}${'""+'.repeat(50_000)}""`, `${'""+//workdir:\n'.repeat(60_000)}""`,
    `${'//workdir:\n'.repeat(30_000)}${'(""+'.repeat(30)}""${')'.repeat(30)}`,
    `${'//workdir:\n'.repeat(30_000)}"${'a'.repeat(360_000)}`, `${'//workdir:\n'.repeat(30_000)}\`${'a'.repeat(360_000)}`,
    `${'//workdir:\n'.repeat(30_000)}"${'a'.repeat(360_000)}${String.fromCharCode(92)}x41"`,
    `${'//workdir:\n'.repeat(30_000)}((((\`${'a'.repeat(360_000)}`]) {
    const ms = read(script);
    assert.ok(ms < 3000, `${script.slice(0, 24)}… took ${ms} ms`);
  }
});

test('a value the reader cannot finish is not judged as a part of itself', () => {
  const judged = (value) => workdirUses(extractCodexTurns([{ timestamp: at(3), type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: `tools.exec_command({cmd:"ls", workdir: ${value}});` } }], CWD, { env: FLAVOR })).map((use) => use.path);
  for (const value of ['"C:/Users/alex/".concat("private-work")', '"C:/x-".slice(0,-1)', '"C:/Users/alex/" + dir', '"C:/a" + 1',
    '["C:", "x"].join("/")', 'String.raw`C:\\x`', '`C:/${dir}`']) {
    assert.deepEqual(judged(value), [], value);
  }
});

test('a script with a great many workdir keys is read without overflowing, one use per distinct folder', () => {
  const script = `${'tools.exec_command({cmd:"ls", workdir:"C:/same"});'.repeat(200_000)}tools.exec_command({workdir:"C:/other"});`;
  let parsed;
  assert.doesNotThrow(() => { parsed = extractCodexTurns([{ timestamp: at(3), type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: script } }], CWD, { env: FLAVOR }); });
  assert.deepEqual(workdirUses(parsed).map((use) => use.path), ['C:/same', 'C:/other']);
});

test('a local shell call\'s working directory is judged too', () => {
  const record = { timestamp: at(3), type: 'response_item', payload: { type: 'local_shell_call', call_id: 'l1', status: 'completed',
    action: { type: 'exec', command: ['cmd', '/c', 'type notes.md'], working_directory: 'C:\\Users\\alex\\private-work' } } };
  const parsed = extractCodexTurns([record], CWD, { env: FLAVOR });
  assert.deepEqual(workdirUses(parsed), [{ path: 'C:\\Users\\alex\\private-work', cwd: CWD }]);
  assert.equal(outcome([record]).action, 'excluded');
});

test('a drive-relative or rooted workdir is placed from the turn\'s folder, as Codex places it', () => {
  // The turn moved to C:\Users\alex; `C:private-work` is then the protected folder.
  assert.equal(outcome([turnContext('C:\\Users\\alex'), shellCall('exec_command', { cmd: 'type a', workdir: 'C:private-work' })]).action, 'excluded');
  // Session on D:, turn on C:: a rooted workdir is on the turn's drive.
  for (const workdir of ['\\Users\\alex\\private-work', '/Users/alex/private-work']) {
    const result = outcome([turnContext('C:\\Users\\alex\\projects'), shellCall('exec_command', { cmd: 'type a', workdir })], 'D:\\work\\app');
    assert.equal(result.action, 'excluded', `${workdir}: ${result.skip}`);
  }
});

test('in the container a shell call whose workdir is the protected folder excludes the session', () => {
  for (const workdir of [...PROTECTED_TURNS, '..\\..\\private-work', '..\\..\\PRIVAT~1\\case']) {
    for (const name of ['exec_command', 'shell_command', 'shell']) {
      const result = outcome([shellCall(name, { cmd: 'type notes.md', command: 'type notes.md', workdir })]);
      assert.equal(result.action, 'excluded', `${name} in ${workdir}: ${result.skip}`);
    }
  }
});

test('in the container a code-mode shell call with a literal protected workdir excludes the session, any quote style', () => {
  for (const literal of ['"C:\\\\Users\\\\alex\\\\private-work"', '\'C:/Users/alex/private-work/case\'', '`../../private-work`']) {
    const result = outcome([codeModeShell(literal)]);
    assert.equal(result.action, 'excluded', `${literal}: ${result.skip}`);
  }
});

test('a workdir that text cannot place refuses the session', () => {
  for (const workdir of ['\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\x', 'file:///C:/Users/alex/private-work']) {
    const result = outcome([shellCall('exec_command', { cmd: 'dir', workdir })]);
    assert.equal(result.action, 'excluded', `${workdir}: ${result.skip}`);
  }
});

test('an ordinary workdir is captured, and the note does not repeat it', () => {
  const w = codexWorld([shellCall('exec_command', { cmd: 'npm test', workdir: 'C:\\Users\\alex\\projects\\lib-ghp_notatoken' })]);
  try {
    const result = w.run();
    assert.equal(result.written, true, `${result.action}: ${result.skip}`);
    const raw = fs.readFileSync(result.notePath, 'utf8');
    assert.doesNotMatch(raw, /lib-ghp_notatoken/, 'model-written folder text stays out of the note');
    assert.doesNotMatch(raw, /Workdir/, 'a folder judged for the policy is not a tool the session used');
  } finally { w.cleanup(); }
});

test('natively, a shell call whose workdir is inside a protected folder excludes the session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-native-'));
  try {
    const app = path.join(root, 'app');
    const privateWork = path.join(root, 'private-work');
    const vaultRoot = path.join(root, 'vault');
    for (const dir of [app, privateWork, vaultRoot]) fs.mkdirSync(dir);
    const transcriptPath = path.join(root, 'rollout.jsonl');
    fs.writeFileSync(transcriptPath, [
      { timestamp: at(0), type: 'session_meta', payload: { cwd: app } },
      message('user', 'Read the brief.', at(1)),
      shellCall('exec_command', { cmd: 'cat brief.md', workdir: path.join(privateWork, 'case') }),
      message('assistant', 'Summarised.', at(9), 'final_answer'),
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    const env = { USERPROFILE: root, HARNESS_MEMORY_STATE_DIR: path.join(root, 'state'), HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([privateWork]) };
    const result = captureCodex({ input: { sessionId: randomUUID(), transcriptPath, cwd: app, hookEventName: 'SessionEnd', endReason: 'other' },
      vaultRoot, home: root, env, stateDir: path.join(root, 'state', 'session-start'), runGit: () => ({ ok: false, stdout: '' }) });
    assert.equal(result.action, 'excluded', result.skip);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
