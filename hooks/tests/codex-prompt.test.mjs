import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanPrompt, humanText } from '../lib/codex-prompt.mjs';

test('every block Codex injects into a user turn is not a human prompt', () => {
  for (const injected of [
    '<environment_context>\n  <cwd>C:/repo</cwd>\n</environment_context>',
    '<external_codex_apps_open_page>page</external_codex_apps_open_page>',
    '<turn_aborted>aborted</turn_aborted>',
    '<system_reminder>x</system_reminder>',
    '<user_instructions>be terse</user_instructions>',
    '<user_shell_command>git status</user_shell_command>',
    '<INSTRUCTIONS>be terse</INSTRUCTIONS>',
    '# AGENTS.md instructions for C:/repo\n\n<INSTRUCTIONS>be terse</INSTRUCTIONS>',
    '# AGENTS.md instructions\n\n<INSTRUCTIONS>be terse</INSTRUCTIONS>',
    '<skill>\n<name>release-notes</name>\n<path>C:/skills/release-notes/SKILL.md</path>\n</skill>',
    '<codex_internal_context kind="handoff">x</codex_internal_context>',
    '<guardian_tool_descriptions>x</guardian_tool_descriptions>',
    '  \n<skill>\n<name>leading whitespace</name>\n</skill>',
  ]) assert.equal(humanPrompt(injected), '', injected.slice(0, 40));
});

test('a human prompt that merely mentions a tag or AGENTS.md is kept', () => {
  assert.equal(humanPrompt('What changed today?'), 'What changed today?');
  assert.equal(humanPrompt('Why does <skill> show up in my notes?'), 'Why does <skill> show up in my notes?');
  assert.equal(humanPrompt('# AGENTS.mdx is a different file'), '# AGENTS.mdx is a different file');
  assert.equal(humanPrompt('<skills> is not a block Codex writes'), '<skills> is not a block Codex writes');
  assert.equal(humanPrompt(''), '');
});

test('a question reply keeps only the answers', () => {
  const reply = '<send_user_message_question_reply>[{"answer":"Yes"},{"answer":" "},{"answer":"Ship it"}]</send_user_message_question_reply>';
  assert.equal(humanPrompt(reply), 'Yes\nShip it');
  assert.equal(humanPrompt('<send_user_message_question_reply>not json</send_user_message_question_reply>'), '');
});

test('humanText joins the text blocks of one block type before judging', () => {
  assert.equal(humanText([{ type: 'text', text: 'First' }, { type: 'localImage', path: 'a.png' }, { type: 'text', text: 'Second' }], 'text'), 'First\nSecond');
  assert.equal(humanText([{ type: 'input_text', text: '<skill>\n<name>x</name>\n</skill>' }], 'input_text'), '');
  assert.equal(humanText('not an array', 'text'), '');
});
