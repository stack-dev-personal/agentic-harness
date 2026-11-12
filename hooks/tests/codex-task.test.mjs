import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEncryptedTask, placeholderTask } from '../lib/codex-task.mjs';

const TOKEN = `gAAAAABq${'x7Kp_Q-2mZ'.repeat(12)}==`;

test('a Fernet-shaped spawn prompt is recognised as encrypted', () => {
  assert.equal(isEncryptedTask(TOKEN), true);
  assert.equal(isEncryptedTask(`  ${TOKEN}\n`), true, 'surrounding whitespace does not hide it');
});

test('readable prompts and short look-alikes are not encrypted', () => {
  assert.equal(isEncryptedTask('Verify the shared queue.'), false);
  assert.equal(isEncryptedTask('gAAAAAB'), false, 'too short to be a token');
  assert.equal(isEncryptedTask(`Decode ${TOKEN} please`), false, 'a token inside prose is a prompt');
  assert.equal(isEncryptedTask(`${TOKEN.slice(0, 60)} ${TOKEN.slice(60)}`), false, 'a token never contains spaces');
  assert.equal(isEncryptedTask(''), false);
  assert.equal(isEncryptedTask(undefined), false);
});

test('the placeholder names the task by its agent path, then nickname, then id', () => {
  assert.equal(placeholderTask({ agentPath: '/root/verify_queue', agentNickname: 'Hume', id: 't1' }),
    'Delegated Codex task verify_queue: assignment not recorded by Codex');
  assert.equal(placeholderTask({ agentPath: 'C:\\root\\verify_queue', id: 't1' }),
    'Delegated Codex task verify_queue: assignment not recorded by Codex');
  assert.equal(placeholderTask({ agentPath: '', agentNickname: 'Hume', id: 't1' }),
    'Delegated Codex task Hume: assignment not recorded by Codex');
  assert.equal(placeholderTask({ id: 't1' }), 'Delegated Codex task t1: assignment not recorded by Codex');
});
