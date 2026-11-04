import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverClaudeSessions, discoverCodexSessions } from '../lib/runtime-adapters.mjs';
import { checkpointSessions } from '../lib/memory-checkpoints.mjs';
import { capture } from '../lib/capture.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

test('native Claude and Codex files receive the same active checkpoint lifecycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-native-'));
  try {
    const cwd = path.join(root, 'demo');
    const vaultRoot = path.join(root, 'vault');
    fs.mkdirSync(cwd); fs.mkdirSync(vaultRoot);
    const claudeDir = path.join(root, '.claude', 'projects', 'demo');
    const codexDir = path.join(root, '.codex', 'sessions');
    fs.mkdirSync(claudeDir, { recursive: true }); fs.mkdirSync(codexDir, { recursive: true });
    const at = '2026-11-03T12:00:00Z';
    const question = 'Record the common memory decision.';
    const answer = 'Use the shared store.';
    fs.writeFileSync(path.join(claudeDir, 'claude-test.jsonl'), [
      { type: 'user', cwd, timestamp: at, message: { content: question } },
      { type: 'assistant', cwd, timestamp: at, message: { content: [{ type: 'text', text: answer }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    const codex = [
      { type: 'session_meta', timestamp: at, payload: { id: 'codex-test', cwd, source: 'vscode' } },
      { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] } },
      { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] } },
    ];
    fs.writeFileSync(path.join(codexDir, 'rollout-codex-test.jsonl'), codex.map(JSON.stringify).join('\n') + '\n');
    const options = { home: root, vaultRoot, env: {} };
    const result = checkpointSessions({ candidates: [...discoverClaudeSessions(options), ...discoverCodexSessions(options)], vaultRoot, stateDir: path.join(root, 'state') });
    assert.equal(result.written, 2);
    for (const note of result.touchedPaths) {
      const raw = fs.readFileSync(note, 'utf8');
      assert.equal(parseFrontmatter(raw).fields.status, 'active');
      assert.match(raw, /Use the shared store/);
    }
    const blockedInput = { sessionId: 'claude-test', transcriptPath: path.join(claudeDir, 'claude-test.jsonl'), cwd,
      memory_excluded: true, hookEventName: 'SessionEnd', endReason: 'resume' };
    const env = { USERPROFILE: root };
    assert.equal(capture({ input: blockedInput, vaultRoot, env }).action, 'excluded');
    const recovery = discoverClaudeSessions({ ...options, env })[0].capture({ deadlineAt: Date.now() + 1000 });
    assert.equal(recovery.action, 'excluded', 'recovery retains the original session exclusion');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex child capture uses the explicit delegated assignment and omits inherited parent context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-child-'));
  try {
    const directory = path.join(root, '.codex', 'sessions');
    const vaultRoot = path.join(root, 'vault');
    const cwd = path.join(root, 'demo');
    fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(vaultRoot); fs.mkdirSync(cwd);
    const before = '2026-11-03T12:00:00Z';
    const after = '2026-11-03T12:01:00Z';
    const parent = [
      { type: 'session_meta', timestamp: before, payload: { id: 'parent', cwd, source: 'vscode' } },
      { type: 'response_item', timestamp: before, payload: { type: 'function_call', name: 'spawn_agent',
        arguments: JSON.stringify({ task_name: 'child', message: 'Verify the shared queue.' }) } },
    ];
    const child = [
      { type: 'session_meta', timestamp: after, payload: { id: 'child', cwd, parent_thread_id: 'parent',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent', agent_path: '/root/child' } } } } },
      { type: 'response_item', timestamp: before, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Inherited earlier answer.' }] } },
      { type: 'response_item', timestamp: after, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inherited parent question must stay out.' }] } },
      { type: 'response_item', timestamp: after, payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'The queue is verified.' }] } },
    ];
    for (const [id, records] of [['parent', parent], ['child', child]]) fs.writeFileSync(path.join(directory, `rollout-${id}.jsonl`), records.map(JSON.stringify).join('\n') + '\n');
    const candidates = discoverCodexSessions({ home: root, vaultRoot, env: { USERPROFILE: root } });
    const result = candidates.find(c => c.sessionId === 'codex-child').capture({ deadlineAt: Date.now() + 1000 });
    assert.equal(result.written, true);
    const raw = fs.readFileSync(result.notePath, 'utf8');
    assert.match(raw, /Verify the shared queue/);
    assert.match(raw, /The queue is verified/);
    assert.doesNotMatch(raw, /Inherited/);
    assert.equal(parseFrontmatter(raw).fields.parent_session, 'codex-parent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
