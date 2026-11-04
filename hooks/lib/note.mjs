/**
 * Rendering a session note: the schema-v2 frontmatter, and the body.
 *
 * One design decision worth knowing about. `ingest` hashes the **body** to
 * decide whether to re-embed, so a change confined to frontmatter would update
 * the note on disk and change nothing in the store. The relational fields that
 * matter for retrieval — status, repo, branch, phase, tags — are therefore
 * mirrored into the body's fact table. A note whose status flips to
 * `superseded` is a new body, and the next ingest run notices.
 */

import {
  CAPTURED_BY_HOOK,
  GENERATOR_VERSION,
  MAX_COMMANDS_LISTED,
  MAX_FILES_LISTED,
  MAX_OUTCOME_CHARS,
  MAX_PROMPTS_RENDERED,
  MAX_PROMPT_CHARS,
  SCHEMA_VERSION,
} from './constants.mjs';
import { serializeFrontmatter } from './frontmatter.mjs';
import { redact, redactLiterals } from './redact.mjs';
import { humanDuration, normalizeLineBreaks, toPosix } from './text.mjs';
import { sessionTitle } from './title.mjs';

/** `session-<id>` — the stable `external_id` ingest keys on. */
export function noteId(sessionId, resumeIndex = 1) {
  const base = `session-${sessionId}`;
  return resumeIndex > 1 ? `${base}-r${resumeIndex}` : base;
}

/** The note's filename inside `<collection>/sessions/`. */
export function noteFilename(sessionId, resumeIndex = 1) {
  return resumeIndex > 1 ? `${sessionId}-r${resumeIndex}.md` : `${sessionId}.md`;
}

/**
 * A subagent's note id and filename.
 *
 * `<session_id>--<agent_id>`: the double dash cannot occur inside either half
 * (a session id is a UUID and an agent id is hex), so the pair is unambiguous
 * and the child sorts next to its parent in the folder. Stable for the note's
 * life, like every other id here, because it is what ingest keys on.
 */
export function childNoteId(sessionId, agentId) {
  return `session-${sessionId}--${normalizeAgentId(agentId)}`;
}

export function childNoteFilename(sessionId, agentId) {
  return `${sessionId}--${normalizeAgentId(agentId)}.md`;
}

/**
 * The agent id, however it arrived.
 *
 * `SubagentStop` reports `a0231c9e98b5b1c5c`; the transcript on disk is called
 * `agent-a0231c9e98b5b1c5c.jsonl`. Both must produce the same id or the
 * parent's back-filled `child_sessions` would not match the child's own note.
 */
export function normalizeAgentId(agentId) {
  return String(agentId ?? '').replace(/^agent-/, '');
}

/**
 * The schema-v2 frontmatter for one session.
 *
 * Every field in R-27.2 and R-27.3 is present on every note, including the ones
 * that could not be derived. An empty string means "not derivable from this
 * session", which is a different and more useful statement than a missing key —
 * and it keeps one type per field, which is what lets W-H2's `filter_metadata`
 * match without guessing.
 */
export function buildFields(ctx) {
  return {
    id: ctx.noteId,
    // A subagent supplies its own title so its note is distinguishable from its
    // parent's in a search result, where the title is most of what you see.
    title:
      ctx.title ||
      sessionTitle({
        date: ctx.date,
        collection: ctx.collection,
        prompt: ctx.titlePrompt ?? ctx.prompts[0]?.text,
        knownSecrets: ctx.knownSecrets,
      }),
    type: 'session',
    schema_version: SCHEMA_VERSION,
    collection: ctx.collection,
    collection_source: ctx.collectionSource,
    session_id: ctx.sessionId,
    date: ctx.date,
    started_at: ctx.startedAt,
    ended_at: ctx.endedAt,
    duration_minutes: Number.isFinite(ctx.durationMs) ? Math.round(ctx.durationMs / 60000) : 0,
    status: ctx.status,
    concluded_at: ctx.concludedAt,
    end_reason: ctx.endReason,
    repo: ctx.repo,
    branch: ctx.branch,
    worktree: ctx.worktree,
    repos_touched: ctx.reposTouched,
    cwd: toPosix(ctx.cwd),
    cwds_seen: ctx.cwdsSeen,
    phase: ctx.phase,
    tags: ctx.tags,
    supersedes: ctx.supersedes ?? [],
    resumed_from: ctx.resumedFrom ?? '',
    parent_session: ctx.parentSession,
    ...(ctx.ancestorSessions?.length ? { ancestor_sessions: ctx.ancestorSessions } : {}),
    child_sessions: ctx.childSessions,
    commits: ctx.commits,
    prs: ctx.prs,
    memory_files: ctx.memoryFiles,
    plan_file: ctx.planFile,
    docs_touched: ctx.docsTouched,
    artifacts: ctx.artifacts,
    files_modified: ctx.files.map((file) => file.path),
    prompt_count: ctx.prompts.length,
    command_count: ctx.commandCount,
    agent: ctx.agent ?? 'claude-code',
    ...Object.fromEntries(['runtime', 'provider', 'model', 'purpose', 'classification', 'data_classification', 'memory_excluded']
      .filter(key => ctx[key] !== undefined && ctx[key] !== '').map(key => [key, typeof ctx[key] === 'string' ? redact(ctx[key]).slice(0, 200) : ctx[key]])),
    agent_type: ctx.agentType ?? '',
    origin: ctx.origin ?? '',
    captured_by: ctx.capturedBy ?? CAPTURED_BY_HOOK,
    generator: ctx.generator ?? `session-capture.mjs ${GENERATOR_VERSION}`,
    tools_used: Object.fromEntries(ctx.toolCounts),
    // Placeholders: `withLinks` derives both after the merge, at the write.
    up: '',
    related: [],
    machine: ctx.machine ?? '',
    // SC-1: the session's searches and the vault notes they returned.
    retrievals: ctx.retrievals ?? [],
    retrieved: ctx.retrieved ?? [],
    // H-3: this render's classifier output, so the next merge knows which of
    // `tags` the hook put there and may replace (at most MAX_HOOK_TAGS).
    hook_tags: [...(ctx.tags ?? [])],
  };
}

/**
 * The markdown body. Extracted, never summarised: no model runs at session end.
 * The one piece of model-written text is the closing message, copied verbatim.
 */
export function renderBody(ctx, fields) {
  const lines = [];
  lines.push(`# ${fields.title}`);
  lines.push('');
  lines.push(summaryLine(ctx, fields));
  lines.push('');

  lines.push('## What I asked for');
  lines.push('');
  ctx.prompts.slice(0, MAX_PROMPTS_RENDERED).forEach((prompt, index) => {
    const text = redact(normalizeLineBreaks(prompt.text)).slice(0, MAX_PROMPT_CHARS);
    lines.push(`${index + 1}. ${text.replace(/\n+/g, '\n   ')}`);
    lines.push('');
  });
  if (ctx.prompts.length > MAX_PROMPTS_RENDERED) {
    lines.push(`_…and ${ctx.prompts.length - MAX_PROMPTS_RENDERED} more prompts._`);
    lines.push('');
  }

  if (ctx.files.length) {
    lines.push('## Files created or modified');
    lines.push('');
    for (const file of ctx.files.slice(0, MAX_FILES_LISTED)) {
      lines.push(`- \`${file.path}\`${file.count > 1 ? ` (${file.count} edits)` : ''}`);
    }
    if (ctx.files.length > MAX_FILES_LISTED) {
      lines.push(`- _…and ${ctx.files.length - MAX_FILES_LISTED} more._`);
    }
    lines.push('');
  }

  if (fields.command_count) {
    lines.push('## Commands run');
    lines.push('');
    lines.push(`${fields.command_count} shell invocation${fields.command_count === 1 ? '' : 's'}. Sample:`);
    lines.push('');
    const seen = new Set();
    for (const label of ctx.commands) {
      if (seen.size >= MAX_COMMANDS_LISTED) break;
      if (seen.has(label)) continue;
      seen.add(label);
      lines.push(`- ${label}`);
    }
    lines.push('');
  }

  if (ctx.agents.length || ctx.skills.length) {
    lines.push('## Delegated work');
    lines.push('');
    for (const agent of ctx.agents.slice(0, 25)) lines.push(`- Agent: ${agent}`);
    for (const skill of ctx.skills.slice(0, 25)) lines.push(`- Skill: ${skill}`);
    lines.push('');
  }

  lines.push(...renderOutcome(ctx.outcome, ctx.knownSecrets));

  lines.push(
    ...renderFacts(fields, {
      transcriptPath: ctx.transcriptPath,
      subagentFilesRead: ctx.subagentFilesRead,
    }),
  );

  return `${lines.join('\n')}${keptFrom(ctx.previousBody)}`;
}

/**
 * `## Outcome`: the session's closing assistant message, or nothing.
 *
 * Quoted line by line. The message is markdown in its own right, and an unquoted
 * `## Session facts` or `#` heading inside it would restructure the note — for
 * the chunker's breadcrumbs and for anything that splits the body on a heading.
 * `knownSecrets` are values the session showed inside a secret shape elsewhere;
 * prose repeats them with no shape at all, so they are removed literally.
 * Redacted before it is cut, so a secret straddling the cap cannot survive as a
 * prefix the rules no longer match.
 */
export function renderOutcome(outcome, knownSecrets = []) {
  // Literals first: a rule that rewrote half of a known value would leave the
  // other half unmatched.
  const text = redact(redactLiterals(normalizeLineBreaks(outcome).trim(), knownSecrets));
  if (!text) return [];

  const truncated = text.length > MAX_OUTCOME_CHARS;
  const quoted = text
    .slice(0, MAX_OUTCOME_CHARS)
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'));

  const lines = ['## Outcome', '', "_The assistant's closing message, verbatim._", '', ...quoted, ''];
  if (truncated) lines.push(`_…truncated at ${MAX_OUTCOME_CHARS} characters._`, '');
  return lines;
}

/**
 * The line the generated body ends with. Anything a person writes below it is
 * theirs, and survives every rewrite.
 */
export const HANDWRITTEN_MARKER =
  '_Generated mechanically by `session-capture.mjs` at session end — extracted, not summarised. ' +
  'Tool output is never copied; prompts and commands are redacted for secrets._';

/**
 * Whatever a person added below the generated marker in the previous note.
 *
 * `merge.mjs` protects the frontmatter with real care — "a tag, a line of
 * context, a field of his own" — but the body was rebuilt from scratch on every
 * capture, so a paragraph typed into an `active` note vanished the moment the
 * session resumed and ended. Everything above the marker is machine-generated
 * and is regenerated; everything below it is kept verbatim.
 */
function keptFrom(previousBody) {
  const text = String(previousBody ?? '');
  if (!text) return '';
  const at = text.lastIndexOf(HANDWRITTEN_MARKER);
  if (at === -1) return '';
  const tail = text.slice(at + HANDWRITTEN_MARKER.length).replace(/^\n+/, '');
  return tail.trim() ? `\n${tail.replace(/\s+$/, '')}\n` : '';
}

/**
 * The `## Session facts` section, as lines.
 *
 * Shared with the one-time migration, which replaces a v1 note's facts table
 * with this one — and in doing so changes the body, which is what makes
 * `ingest` notice that the note's metadata is new. (`content_hash` is computed
 * over the body alone, so a frontmatter-only edit is invisible to it.)
 */
export function renderFacts(fields, { transcriptPath = '', subagentFilesRead = 0 } = {}) {
  const lines = ['## Session facts', '', '| Field | Value |', '| --- | --- |'];
  for (const [label, value] of factRows(fields, { transcriptPath, subagentFilesRead })) {
    lines.push(`| ${label} | ${value} |`);
  }
  lines.push('');
  lines.push(
    '_Generated mechanically by `session-capture.mjs` at session end — extracted, not summarised. ' +
      'Tool output is never copied; prompts and commands are redacted for secrets._',
  );
  lines.push('');
  return lines;
}

function summaryLine(ctx, fields) {
  const prompts = fields.prompt_count;
  const commands = fields.command_count;
  const files = fields.files_modified.length;
  return (
    `Working directory \`${toPosix(ctx.cwd)}\`. Ran ${humanDuration(ctx.durationMs)}, ` +
    `${prompts} prompt${prompts === 1 ? '' : 's'}, ` +
    `${commands} shell command${commands === 1 ? '' : 's'}, ` +
    `${files} file${files === 1 ? '' : 's'} touched. Ended: ${fields.end_reason}.`
  );
}

/**
 * The rows that mirror frontmatter into the body.
 *
 * Only fields whose change should trigger a re-embed are here; a list of sixty
 * file paths is already in the body above, and repeating the whole frontmatter
 * would make every note twice as long for no retrieval gain.
 */
function factRows(fields, { transcriptPath, subagentFilesRead }) {
  const rows = [
    ['Session id', `\`${fields.session_id}\``],
    ['Status', fields.status],
    ['Collection', `\`${fields.collection}\` (from ${fields.collection_source})`],
    ['Repo', fields.repo || '—'],
    ['Branch', fields.branch || '—'],
    ['Worktree', fields.worktree || '—'],
    ['Phase', fields.phase || '—'],
    ['Tags', fields.tags.length ? fields.tags.map((tag) => `\`${tag}\``).join(', ') : '—'],
    ['Started', fields.started_at || 'unknown'],
    ['Ended', fields.ended_at || 'unknown'],
    ['End reason', fields.end_reason],
  ];
  if (fields.resumed_from) rows.push(['Resumed from', `\`${fields.resumed_from}\``]);
  if (fields.parent_session) rows.push(['Parent session', `\`${fields.parent_session}\``]);
  if (fields.agent_type) rows.push(['Agent type', `\`${fields.agent_type}\``]);
  if (fields.commits.length) rows.push(['Commits', fields.commits.length]);
  if (fields.prs.length) rows.push(['PRs', fields.prs.map((pr) => `#${pr}`).join(', ')]);
  rows.push(['Transcript', `\`${toPosix(transcriptPath)}\``]);
  rows.push(['Subagent transcripts read', subagentFilesRead]);
  return rows;
}

/** Frontmatter block, blank line, body. The exact bytes the goldens compare. */
export function renderNote(fields, body) {
  return `${serializeFrontmatter(fields)}\n\n${body}`;
}
