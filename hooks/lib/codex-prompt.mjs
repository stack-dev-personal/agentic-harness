/**
 * Which Codex user turns a person typed. Shared by the SQLite and rollout
 * adapters, so the same thread gives the same prompts from either source.
 *
 * Codex writes machine context into user turns: the working folder, AGENTS.md
 * text, skill bodies, `!` shell runs, internal handoff context. None of it is a
 * prompt. A turn that starts with one of these blocks is dropped whole, as it
 * always was; a person's text that only mentions a tag is kept.
 */

const INJECTED_TAGS = [
  'environment_context', 'external_codex_apps_open_page', 'turn_aborted', 'system_reminder',
  'user_instructions', 'user_shell_command', 'INSTRUCTIONS', 'skill', 'codex_internal_context',
  'guardian_tool_descriptions',
];

// A tag opens the turn and is followed by `>` or attributes; AGENTS.md text is
// headed `# AGENTS.md instructions`, with or without ` for <folder>`.
const INJECTED_USER_BLOCK = new RegExp(`^\\s*(?:<(?:${INJECTED_TAGS.join('|')})[\\s>]|# AGENTS\\.md instructions\\b)`);
const QUESTION_REPLY = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/;

/** The person's words in one user turn, or '' when Codex wrote it. */
export function humanPrompt(text) {
  if (!text || INJECTED_USER_BLOCK.test(text)) return '';
  const reply = text.match(QUESTION_REPLY);
  if (!reply) return text;
  try {
    const answers = JSON.parse(reply[1]);
    return Array.isArray(answers)
      ? answers.map((item) => item?.answer).filter((value) => typeof value === 'string' && value.trim()).join('\n')
      : '';
  } catch {
    return '';
  }
}

/** The text blocks of one type in a turn's content, joined, then judged. */
export function humanText(content, type) {
  if (!Array.isArray(content)) return '';
  const text = content.filter((block) => block?.type === type && typeof block.text === 'string')
    .map((block) => block.text).join('\n').trim();
  return humanPrompt(text);
}
