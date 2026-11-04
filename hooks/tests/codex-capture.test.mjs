import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { captureCodex, extractCodexTurns, humanPrompt, literalArgument } from '../codex-session-capture.mjs';
import { analyseTranscript } from '../lib/analyse.mjs';
import { drainCodexIngest, queueCodexIngest, TASK_NAME } from '../lib/codex-ingest-queue.mjs';
import { sweepCodex } from '../lib/codex-sweep.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { writeSessionStartRecord } from '../lib/session-start.mjs';
import { extractRetrievals } from '../lib/retrievals.mjs';
import { extractPrompts } from '../lib/transcript.mjs';

const at = (seconds) => new Date(Date.UTC(2026, 10, 3, 12, 0, seconds)).toISOString();
const message = (role, text, timestamp, phase) => ({
  timestamp, type: 'response_item',
  payload: { type: 'message', role, ...(phase ? { phase } : {}),
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});

test('macOS SessionEnd queues notes for launchd without a detached ingest', { skip: process.platform !== 'darwin' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mac-queue-'));
  try {
    const vaultRoot = path.join(root, 'vault');
    const cwd = path.join(root, 'demo');
    fs.mkdirSync(path.join(vaultRoot, 'projects', 'demo', 'sessions'), { recursive: true });
    fs.mkdirSync(cwd);
    const sessionId = randomUUID();
    const transcriptPath = path.join(root, 'rollout.jsonl');
    fs.writeFileSync(transcriptPath, [
      { timestamp: at(0), type: 'session_meta', payload: { cwd } },
      message('user', 'Capture the macOS session.', at(1)),
      message('assistant', 'Session captured.', at(2), 'final_answer'),
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../codex-session-capture.mjs', import.meta.url))], {
      input: JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath,
        cwd, hook_event_name: 'SessionEnd', reason: 'other' }),
      encoding: 'utf8', timeout: 3000,
      env: { ...process.env, HOME: root, USERPROFILE: root, HARNESS_MACHINE_ENV: path.join(root, 'missing.env'),
        HARNESS_VAULT: vaultRoot, HARNESS_INGEST_ON_CAPTURE: '1',
        HARNESS_CODEX_CAPTURE_LOG: path.join(root, 'capture.log') },
    });
    assert.equal(result.status, 0, result.stderr);
    const queued = fs.readFileSync(path.join(root, '.harness', 'codex-ingest-queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(queued.includes(path.join(vaultRoot, 'projects', 'demo', 'sessions', `codex-${sessionId}.md`)));
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'hooks', 'ingest-on-capture.log')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex parsing keeps human prompts and final answers, not machine context or tool output', () => {
  const records = [
    message('user', '<environment_context>private machine data</environment_context>', at(1)),
    message('user', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>', at(2)),
    message('user', 'What did we decide?', at(3)),
    { timestamp: at(4), type: 'response_item', payload: { type: 'function_call_output', output: 'raw-secret-from-tool' } },
    message('assistant', 'Working on it', at(5), 'commentary'),
    message('assistant', 'The decision was recorded.', at(6), 'final_answer'),
  ];
  const parsed = extractCodexTurns(records, 'C:/work');
  assert.deepEqual(parsed.entries.map((entry) => entry.type), ['user', 'assistant']);
  assert.equal(parsed.entries[0].message.content, 'What did we decide?');
  assert.equal(parsed.entries[1].message.content[0].text, 'The decision was recorded.');
  assert.ok(!JSON.stringify(parsed.entries).includes('raw-secret-from-tool'));
});

test('Codex code-mode activity becomes the shared commands, files, and retrieval records', () => {
  const cwd = 'C:/work/demo';
  const fixture = fs.readFileSync(new URL('./fixtures/rag-results/search-one.txt', import.meta.url), 'utf8');
  const records = [
    message('user', 'Find ledger invariants.', at(1)),
    { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call',
      name: 'exec', call_id: 'c1', input: 'const r=await tools.mcp__rag__search_context({query:"ledger invariants"}); text(r);' } },
    { timestamp: at(3), type: 'response_item', payload: { type: 'custom_tool_call_output',
      call_id: 'c1', output: [{ type: 'input_text', text: JSON.stringify({ content: [{ type: 'text', text: fixture }] }) }] } },
    { timestamp: at(4), type: 'response_item', payload: { type: 'custom_tool_call',
      name: 'exec', call_id: 'c2', input: 'await tools.exec_command({cmd:"git status --short"}); await tools.apply_patch("*** Update File: C:/work/demo/a.md\\n");' } },
    { timestamp: at(5), type: 'response_item', payload: { type: 'custom_tool_call_output',
      call_id: 'c2', output: [{ type: 'input_text', text: 'raw-secret-from-tool' }] } },
    message('assistant', 'The ledger is consistent.', at(6), 'final_answer'),
  ];
  const parsed = extractCodexTurns(records, cwd);
  const prompts = extractPrompts(parsed.entries);
  const facts = analyseTranscript({ entries: parsed.entries, prompts, cwd, vaultRoot: 'C:/vault',
    deadlineAt: Date.now() + 1000, runGit: () => ({ status: 0, stdout: '' }) });
  const searches = extractRetrievals(parsed.entries);
  assert.equal(facts.accumulator.commandCount, 1);
  assert.equal(facts.accumulator.commands[0], 'git status --short');
  assert.equal(facts.paths.files.length, 1);
  assert.equal(searches.records.length, 1);
  assert.equal(searches.records[0].query, 'ledger invariants');
  assert.equal(searches.hits.length, 1);
  assert.ok(!JSON.stringify(parsed.entries).includes('raw-secret-from-tool'));
});

test('Codex capture writes a redacted vault note, replays safely, and chains a resumed chat', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-capture-'));
  try {
    const vaultRoot = path.join(root, 'vault');
    const cwd = path.join(root, 'demo');
    fs.mkdirSync(path.join(vaultRoot, 'projects', 'demo', 'sessions'), { recursive: true });
    fs.mkdirSync(cwd);
    const sessionId = randomUUID();
    const transcriptPath = path.join(root, 'rollout.jsonl');
    const records = [
      { timestamp: at(0), type: 'session_meta', payload: { cwd, originator: 'codex_desktop' } },
      message('user', 'Remember API_KEY=very-secret-value-12345 while finding the decision.', at(1)),
      { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call',
        name: 'exec', call_id: 'rag-1', input: 'const r=await tools.mcp__rag__search_context({query:"ledger invariants"}); text(r);' } },
      { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call_output',
        call_id: 'rag-1', output: [{ type: 'input_text', text: JSON.stringify({ content: [{ type: 'text',
          text: fs.readFileSync(new URL('./fixtures/rag-results/search-one.txt', import.meta.url), 'utf8') }] }) }] } },
      { timestamp: at(2), type: 'response_item', payload: { type: 'function_call_output', output: 'raw-tool-secret-98765' } },
      message('assistant', 'I found API_KEY=very-secret-value-12345 in the old note.', at(3), 'final_answer'),
    ];
    const saveTranscript = () => fs.writeFileSync(transcriptPath, records.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    saveTranscript();
    const input = { sessionId, transcriptPath, cwd, hookEventName: 'SessionEnd', endReason: 'other' };
    const first = captureCodex({ input, vaultRoot });
    assert.equal(first.action, 'create');
    const sessionDir = path.join(vaultRoot, 'projects', 'demo', 'sessions');
    const basePath = path.join(sessionDir, `codex-${sessionId}.md`);
    const raw = fs.readFileSync(basePath, 'utf8');
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.fields.agent, 'codex');
    assert.equal(parsed.fields.origin, 'codex_desktop');
    assert.equal(parsed.fields.prompt_count, 1);
    assert.equal(parsed.fields.retrievals.length, 1);
    assert.ok(!raw.includes('very-secret-value-12345'));
    assert.ok(!raw.includes('raw-tool-secret-98765'));

    const replay = captureCodex({ input, vaultRoot });
    assert.equal(replay.action, 'noop');
    const sweepReplay = captureCodex({ input, vaultRoot, capturedBy: 'sweep' });
    assert.equal(sweepReplay.action, 'noop');
    records.push(message('user', 'What is next?', at(4)));
    records.push(message('assistant', 'Run the migration.', at(5), 'final_answer'));
    saveTranscript();
    const resumed = captureCodex({ input, vaultRoot });
    assert.equal(resumed.action, 'resume');
    assert.ok(fs.existsSync(path.join(sessionDir, `codex-${sessionId}-r2.md`)));
    assert.equal(parseFrontmatter(fs.readFileSync(basePath, 'utf8')).fields.status, 'superseded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SessionEnd command accepts Codex hook JSON on stdin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-'));
  try {
    const vaultRoot = path.join(root, 'vault');
    const cwd = path.join(root, 'demo');
    fs.mkdirSync(path.join(vaultRoot, 'projects', 'demo', 'sessions'), { recursive: true });
    fs.mkdirSync(cwd);
    const sessionId = randomUUID();
    const transcriptPath = path.join(root, 'rollout.jsonl');
    fs.writeFileSync(transcriptPath, [
      { timestamp: at(0), type: 'session_meta', payload: { cwd } },
      message('user', 'Record this result.', at(1)),
      message('assistant', 'Recorded.', at(2), 'final_answer'),
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const payload = { session_id: sessionId, transcript_path: transcriptPath,
      cwd, hook_event_name: 'SessionEnd', reason: 'other' };
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../codex-session-capture.mjs', import.meta.url))], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 3000,
      env: { ...process.env, HARNESS_VAULT: vaultRoot,
        HARNESS_INGEST_ON_CAPTURE: '0', HARNESS_CODEX_CAPTURE_LOG: path.join(root, 'capture.log') },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.existsSync(path.join(vaultRoot, 'projects', 'demo', 'sessions', `codex-${sessionId}.md`)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex ingest queue hands a vault note to a scheduled task and drains it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ingest-'));
  try {
    const vaultRoot = path.join(root, 'vault');
    const note = path.join(vaultRoot, 'projects', 'demo', 'sessions', 'codex-test.md');
    const project = path.join(root, 'ingest');
    const uv = path.join(root, 'uv.exe');
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.mkdirSync(project);
    fs.writeFileSync(note, '# Test\n');
    fs.writeFileSync(uv, '');
    const env = { ...process.env, USERPROFILE: root, HARNESS_VAULT: vaultRoot,
      HARNESS_INGEST_PROJECT: project, HARNESS_UV_BIN: uv };
    const calls = [];
    const fakeRun = (command, args) => { calls.push({ command, args }); return { status: 0 }; };
    const queued = queueCodexIngest({ notePaths: [note], vaultRoot, env, run: fakeRun });
    assert.equal(queued.queued, true);
    assert.ok(calls[0].args.includes(TASK_NAME));
    const drained = drainCodexIngest({ env, run: fakeRun });
    assert.equal(drained.ingested, 1);
    assert.ok(calls[1].args.includes(note));
    assert.equal(drainCodexIngest({ env, run: fakeRun }).ingested, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('daily Codex sweep recovers idle main chats and excludes active chats and subagents', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sweep-'));
  try {
    const sessions = path.join(home, '.codex', 'sessions', '2026', '11', '03');
    const vaultRoot = path.join(home, 'vault');
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(path.join(vaultRoot, 'projects', 'demo', 'sessions'), { recursive: true });
    const mainId = randomUUID();
    const childId = randomUUID();
    const activeId = randomUUID();
    const write = (id, source) => {
      const file = path.join(sessions, `rollout-2026-11-03T12-00-00-${id}.jsonl`);
      fs.writeFileSync(file, [
        { timestamp: at(0), type: 'session_meta', payload: { id, cwd: path.join(home, 'demo'), source,
          ...(typeof source === 'object' ? { parent_thread_id: mainId } : {}) } },
        message('user', 'Record this result.', at(1)),
        message('assistant', 'Recorded.', at(2), 'final_answer'),
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      return file;
    };
    fs.mkdirSync(path.join(home, 'demo'));
    const main = write(mainId, 'vscode');
    const child = write(childId, { subagent: { other: 'worker' } });
    write(activeId, 'vscode');
    const now = Date.now();
    const old = new Date(now - 7 * 60 * 60 * 1000);
    fs.utimesSync(main, old, old);
    fs.utimesSync(child, old, old);
    const first = sweepCodex({ home, vaultRoot, capture: captureCodex, now });
    assert.equal(first.eligible, 1);
    assert.equal(first.written, 1);
    assert.equal(first.touchedPaths.length, 1);
    assert.ok(first.touchedPaths[0].endsWith(`codex-${mainId}.md`));
    const second = sweepCodex({ home, vaultRoot, capture: captureCodex, now: now + 1000 });
    assert.equal(second.due, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex capture records the SessionStart brief as a retrieval, as Claude Code capture does', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-brief-'));
  try {
    const vaultRoot = path.join(root, 'vault');
    const cwd = path.join(root, 'demo');
    const stateDir = path.join(root, 'state', 'session-start');
    fs.mkdirSync(path.join(vaultRoot, 'projects', 'demo', 'sessions'), { recursive: true });
    fs.mkdirSync(cwd);
    const sessionId = '01a1a2cd-6e87-7c32-b28b-1a73010add69';
    const written = writeSessionStartRecord({ stateDir, record: { at: at(0), sessionId, cwd,
      realm: 'projects', collection: 'demo', source: 'status', externalIds: ['status-demo'], tokens: 42 } });
    assert.equal(written.ok, true, written.reason);
    const transcriptPath = path.join(root, 'rollout.jsonl');
    fs.writeFileSync(transcriptPath, [
      { timestamp: at(0), type: 'session_meta', payload: { cwd } },
      message('user', 'Where does the demo stand?', at(1)),
      message('assistant', 'It is on track.', at(2), 'final_answer'),
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const outcome = captureCodex({ input: { sessionId, transcriptPath, cwd,
      hookEventName: 'SessionEnd', endReason: 'other' }, vaultRoot, stateDir });
    assert.equal(outcome.action, 'create');
    const fields = parseFrontmatter(fs.readFileSync(
      path.join(vaultRoot, 'projects', 'demo', 'sessions', `codex-${sessionId}.md`), 'utf8')).fields;
    assert.equal(fields.retrievals.length, 1);
    assert.equal(fields.retrievals[0].channel, 'session-start');
    assert.deepEqual(fields.retrievals[0].results, ['obsidian:status-demo']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sweepFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sweep-throttle-'));
  const sessions = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  for (const id of [randomUUID(), randomUUID()]) {
    const file = path.join(sessions, `rollout-${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ timestamp: at(0), type: 'session_meta', payload: { id } })}\n`);
    fs.utimesSync(file, old, old);
  }
  return home;
}

test('Codex sweep: one bad transcript is logged but does not defeat the 20-hour throttle', () => {
  const home = sweepFixture();
  try {
    let calls = 0;
    const capture = () => {
      calls += 1;
      if (calls === 1) throw new Error('corrupt transcript');
      return { written: false, action: 'skip', skip: 'transcript unreadable or empty', touchedPaths: [] };
    };
    const first = sweepCodex({ home, vaultRoot: path.join(home, 'vault'), capture });
    assert.equal(first.due, true);
    assert.equal(first.errors, 2);
    const second = sweepCodex({ home, vaultRoot: path.join(home, 'vault'), capture, now: Date.now() + 1000 });
    assert.equal(second.due, false, 'the marker was written despite per-transcript errors');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex sweep: an unavailable vault stops the sweep and leaves it due for the next run', () => {
  const home = sweepFixture();
  try {
    let calls = 0;
    const capture = () => {
      calls += 1;
      return { written: false, action: 'skip', skip: 'vault unavailable', touchedPaths: [] };
    };
    const first = sweepCodex({ home, vaultRoot: path.join(home, 'vault'), capture });
    assert.equal(calls, 1, 'no point trying the rest once the vault is gone');
    assert.equal(first.blocked, true);
    const second = sweepCodex({ home, vaultRoot: path.join(home, 'vault'), capture, now: Date.now() + 1000 });
    assert.equal(second.due, true, 'no marker, so the next run retries');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('code-mode apply_patch keeps only file names, never the patch body', () => {
  // The script text exactly as Codex records it: one JS string literal with escaped newlines.
  const script = String.raw`await tools.apply_patch("*** Begin Patch\n*** Update File: src/a.mjs\n@@\n-old\n+PATCH-BODY-SECRET\n`
    + String.raw`*** Add File: C:\\work\\new.md\n+hello\n*** End Patch");`;
  const parsed = extractCodexTurns([
    message('user', 'Patch it.', at(1)),
    { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'p1', input: script } },
  ], 'C:/work');
  const writes = parsed.entries.flatMap((entry) => entry.message?.content ?? [])
    .filter((block) => block?.name === 'Write').map((block) => block.input.file_path);
  // The escaped backslashes decode to one each; a drive path is only absolute on Windows.
  const added = String.raw`C:\work\new.md`;
  assert.deepEqual(writes, [path.resolve('C:/work', 'src/a.mjs'),
    path.isAbsolute(added) ? added : path.resolve('C:/work', added)]);
  const kept = JSON.stringify(parsed.entries.map((entry) => entry.message?.content).flat()
    .filter((block) => block?.name !== 'exec'));
  assert.ok(!kept.includes('PATCH-BODY-SECRET'));
});

test('literalArgument decodes string literals and refuses anything else', () => {
  assert.equal(literalArgument(String.raw`"a\nb")`), 'a\nb');
  assert.equal(literalArgument(String.raw`'it\'s "q""')`), 'it\'s "q""');
  assert.equal(literalArgument('`line1\nline2`)'), 'line1\nline2');
  assert.equal(literalArgument(String.raw`"C:\work")`), null, 'an escape JSON lacks fails closed');
  assert.equal(literalArgument('`${x}`)'), null);
  assert.equal(literalArgument('patchText)'), null);
});

test('Codex-injected user blocks are not human prompts', () => {
  assert.equal(humanPrompt('# AGENTS.md instructions for C:/repo\n\n<INSTRUCTIONS>be terse</INSTRUCTIONS>'), '');
  assert.equal(humanPrompt('<user_instructions>be terse</user_instructions>'), '');
  assert.equal(humanPrompt('<user_shell_command>git status</user_shell_command>'), '');
  assert.equal(humanPrompt('What changed today?'), 'What changed today?');
});

test('Codex capture fails closed when the transcript head is not session_meta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-head-'));
  try {
    const transcriptPath = path.join(root, 'rollout.jsonl');
    fs.writeFileSync(transcriptPath, `${JSON.stringify(message('user', 'Hello', at(1)))}\n`);
    const outcome = captureCodex({ input: { sessionId: randomUUID(), transcriptPath, cwd: root,
      hookEventName: 'SessionEnd', endReason: 'other' }, vaultRoot: path.join(root, 'vault') });
    assert.equal(outcome.written, false);
    assert.match(outcome.skip, /^transcript head /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('queueCodexIngest reports a queue write failure instead of throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-queue-fail-'));
  try {
    const vaultRoot = path.join(root, 'vault');
    const note = path.join(vaultRoot, 'n.md');
    fs.mkdirSync(vaultRoot);
    fs.writeFileSync(note, '# n\n');
    const notAFolder = path.join(root, 'profile-is-a-file');
    fs.writeFileSync(notAFolder, '');
    const lines = [];
    const result = queueCodexIngest({ notePaths: [note], vaultRoot, env: { USERPROFILE: notAFolder },
      log: (line) => lines.push(line), run: () => ({ status: 0 }) });
    assert.equal(result.queued, false);
    assert.match(result.reason, /^queue write failed/);
    assert.equal(lines.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one failing queue file does not block the others', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-poison-'));
  try {
    const vaultRoot = path.join(root, 'vault');
    const good = path.join(vaultRoot, 'good.md');
    const bad = path.join(vaultRoot, 'bad.md');
    const project = path.join(root, 'ingest');
    const uv = path.join(root, 'uv.exe');
    fs.mkdirSync(vaultRoot);
    fs.mkdirSync(project);
    for (const file of [good, bad, uv]) fs.writeFileSync(file, '');
    const queueDir = path.join(root, '.harness');
    fs.mkdirSync(queueDir);
    fs.writeFileSync(path.join(queueDir, 'codex-ingest-queue.jsonl.processing-1'), `${JSON.stringify(bad)}\n`);
    fs.writeFileSync(path.join(queueDir, 'codex-ingest-queue.jsonl.processing-2'), `${JSON.stringify(good)}\n`);
    const env = { USERPROFILE: root, HARNESS_VAULT: vaultRoot, HARNESS_INGEST_PROJECT: project,
      HARNESS_UV_BIN: uv, HARNESS_MACHINE_ENV: path.join(root, 'absent.env') };
    const fakeRun = (command, args) => ({ status: args.includes(bad) ? 1 : 0, stderr: 'rejected' });
    const result = drainCodexIngest({ env, run: fakeRun });
    assert.equal(result.ingested, 1);
    assert.deepEqual(result.failed, ['codex-ingest-queue.jsonl.processing-1']);
    assert.deepEqual(fs.readdirSync(queueDir), ['codex-ingest-queue.jsonl.processing-1']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex sweep leaves chats that already have a note to their own SessionEnd', () => {
  const home = sweepFixture();
  const vaultRoot = path.join(home, 'vault');
  try {
    const ids = fs.readdirSync(path.join(home, '.codex', 'sessions')).map((name) => name.slice('rollout-'.length, -'.jsonl'.length));
    const sessions = path.join(vaultRoot, 'projects', 'demo', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `codex-${ids[0]}.md`), '---\ntype: session\n---\n');
    const seen = [];
    const capture = ({ input }) => {
      seen.push(input.sessionId);
      return { written: false, action: 'skip', skip: 'no human prompts', touchedPaths: [] };
    };
    const result = sweepCodex({ home, vaultRoot, capture });
    assert.deepEqual(seen, [ids[1]]);
    assert.equal(result.eligible, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex sweep stops at its time budget and stays due', () => {
  const home = sweepFixture();
  try {
    let tick = 0;
    const clock = () => (tick += 1000);
    const capture = () => ({ written: false, action: 'skip', skip: 'no human prompts', touchedPaths: [] });
    const first = sweepCodex({ home, vaultRoot: path.join(home, 'vault'), capture, budgetMs: 1500, clock });
    assert.equal(first.truncated, true);
    assert.equal(sweepCodex({ home, vaultRoot: path.join(home, 'vault'), capture, now: Date.now() + 1000 }).due, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
