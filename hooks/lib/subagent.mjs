/**
 * Capturing a finished subagent: one note per agent, linked to its parent.
 *
 * A worker launched with the Agent tool does real work — it edits files, runs
 * commands, opens PRs — but it shares its parent's `session_id` and never fires
 * `SessionEnd`, so until now none of that had a note of its own. `SubagentStop`
 * is the event that closes the gap.
 *
 * Two things make the linkage work in both directions, whichever order the
 * events arrive in:
 *
 *   - the child note records `parent_session` = the parent's `session_id`, and
 *     the id it is filed under is derived from that pair, so it is stable;
 *   - the parent's `child_sessions` is merged here if the parent note already
 *     exists, and back-filled from the `subagents/` directory when the parent's
 *     own `SessionEnd` runs. A child that stops before its parent is listed by
 *     the back-fill; a child that stops after is listed by this merge.
 *
 * The collection is the parent's, from the directory the parent transcript
 * declares (see `placeWorker`). Everything else — branch, tags, redaction, the
 * deadline, exit 0 — is the session rules applied unchanged.
 */

import fs from 'node:fs';
import path from 'node:path';

import { analyseTranscript } from './analyse.mjs';
import { placeSession } from './collection.mjs';
import {
  BUDGET_MS,
  CAPTURED_BY_HOOK,
  MAX_CHILD_SESSIONS,
  MAX_LABEL_CHARS,
  RESERVE_MS,
  SESSIONS_DIR,
  SUBAGENT_BUDGET_BYTES,
  SUBAGENTS_DIR,
  STATUS_CONCLUDED,
  STATUS_ACTIVE,
  RESUME_REASON,
} from './constants.mjs';
import { runGitSync } from './git-log.mjs';
import { withLinks } from './links.mjs';
import { machineName } from './machine-env.mjs';
import { entryPaths, sessionMemoryEligibility } from './memory-policy.mjs';
import { mergeFields } from './merge.mjs';
import {
  buildFields,
  childNoteFilename,
  childNoteId,
  normalizeAgentId,
  renderBody,
  renderNote,
} from './note.mjs';
import { ensureIndex, findNotesByName, persist, readNote, resolveChainHead, vaultAvailable } from './notes-io.mjs';
import { redact } from './redact.mjs';
import { extractRetrievals, retrievedLinks } from './retrievals.mjs';
import { derivePhase, withPhaseTag } from './tags.mjs';
import { isoDate, toPosix, uniqueCapped } from './text.mjs';
import { extractOrigin, extractOutcome, extractPrompts, extractTools, createAccumulator, firstPromptText, knownSecrets, readEntries } from './transcript.mjs';
import { TITLE_SEPARATOR, workerTitle } from './title.mjs';
import { parentTranscriptBeside, readTranscriptHead } from './transcript-head.mjs';

/**
 * Capture one finished subagent.
 *
 * `touchedPaths` lists every note this call actually changed on disk: the
 * worker's own note, and the parent note when this run added the link to it.
 * A note that re-rendered byte-identically is absent from it — `SubagentStop`
 * fires at every stop point of a multi-turn worker, and re-ingesting an
 * unchanged note costs a whole process and a 130 MB model load to learn nothing.
 *
 * `log` receives the lines worth a human's attention that are not the outcome
 * itself — a duplicate copy left in another collection, a stray note the
 * parser cannot read. The outcome is still the caller's to log.
 *
 * @returns {{written: boolean, action: string, skip: string, notePath: string,
 *            touchedPaths: string[], vaultRoot: string, detail: string}}
 */
export function captureSubagent({
  input,
  vaultRoot,
  projectsRoot,
  startedAtMs = Date.now(),
  deadlineAt = startedAtMs + BUDGET_MS,
  runGit = runGitSync,
  capturedBy = CAPTURED_BY_HOOK,
  log = () => {},
  env = process.env,
}) {
  const skip = (reason) => ({ written: false, action: 'skip', skip: reason, notePath: '', touchedPaths: [], vaultRoot, detail: '' });
  input = { ...input, runtime: 'claude-code' };
  const policy = sessionMemoryEligibility({ input, env });
  if (!policy.allowed) return { ...skip(policy.reason), action: 'excluded' };

  const agentId = normalizeAgentId(input.agentId);
  if (!agentId) return skip('no agent_id');

  const transcriptPath = resolveAgentTranscript({ input, agentId, projectsRoot });
  if (!transcriptPath) return skip(`no subagent transcript for ${agentId}`);

  const entries = readEntries(transcriptPath, SUBAGENT_BUDGET_BYTES, deadlineAt - RESERVE_MS);
  if (entries.length === 0) return skip('subagent transcript unreadable or empty');

  if (!vaultAvailable(vaultRoot)) return skip(`vault root unavailable (${vaultRoot})`);

  const accumulator = createAccumulator();
  extractTools(entries, accumulator);
  const touched = sessionMemoryEligibility({ input, env, paths: [...entryPaths(entries), ...accumulator.files.keys(), ...accumulator.filesRead.keys()] });
  if (!touched.allowed) return { ...skip(touched.reason), action: 'excluded' };

  const meta = readAgentMeta(transcriptPath);
  const prompts = agentPrompts(entries, meta);

  // A worker that only ran tools still did the work, and its task prompt lives
  // in the parent's Agent call rather than in its own transcript. So the bar is
  // "did anything happen", not "was there a prompt" — but an empty transcript
  // is still not a note.
  if (prompts.length === 0 && accumulator.toolCounts.size === 0) {
    return skip('subagent did nothing (no prompt, no tool use)');
  }

  const facts = analyseTranscript({
    entries,
    prompts,
    cwd: input.cwd,
    transcriptPath,
    vaultRoot,
    deadlineAt,
    runGit,
    into: accumulator,
    env,
  });

  const agentType = redact(String(input.agentType || meta.agentType || '')).slice(0, MAX_LABEL_CHARS);

  const date = isoDate(facts.timing.endedAt) || isoDate(new Date().toISOString());

  const placement = placeWorker({ input, agentId, agentTranscriptPath: transcriptPath, facts, vaultRoot, log, env });
  const { current, notePath: targetPath } = placement;
  if (current.error) {
    return { written: false, action: 'skip', skip: `existing note unreadable: ${current.error}`, notePath: targetPath, touchedPaths: [], vaultRoot, detail: '' };
  }

  const inherited = inheritFromParent(facts, placement);
  const secrets = knownSecrets(prompts, accumulator);
  const searches = extractRetrievals(entries, { secrets, includeSidechain: true });

  const context = {
    sessionId: input.sessionId,
    noteId: childNoteId(input.sessionId, agentId),
    title: workerTitle({
      date,
      collection: placement.collection,
      agentType: agentType || agentId,
      // The task, from the head when the transcript was read from its tail; the
      // Agent call's description when no prompt line survives there.
      prompt: firstPromptText(transcriptPath, prompts, SUBAGENT_BUDGET_BYTES) || meta.description,
      knownSecrets: secrets,
    }),
    collection: placement.collection,
    collectionSource: placement.collectionSource,
    date,
    cwd: facts.cwd,
    cwdsSeen: facts.cwdsSeen,
    // A subagent does not "end a session"; it stops. The frozen enum has no
    // term for that, and `other` is the documented catch-all.
    endReason: 'other',
    startedAt: facts.timing.startedAt,
    endedAt: facts.timing.endedAt,
    durationMs: facts.timing.durationMs,
    // A stopped subagent is finished by definition: nothing resumes one.
    status: input.endReason === RESUME_REASON ? STATUS_ACTIVE : STATUS_CONCLUDED,
    concludedAt: input.endReason === RESUME_REASON ? '' : facts.timing.endedAt,
    repo: inherited.repo,
    branch: facts.branch,
    worktree: facts.repo.worktree,
    reposTouched: facts.paths.reposTouched,
    phase: inherited.phase,
    tags: inherited.tags,
    supersedes: [],
    resumedFrom: '',
    parentSession: input.sessionId,
    childSessions: [],
    agentType,
    agent: 'claude-code', runtime: 'claude-code',
    origin: extractOrigin(entries),
    machine: machineName(env),
    capturedBy,
    commits: facts.commits,
    prs: facts.prs,
    memoryFiles: facts.paths.memoryFiles,
    planFile: facts.paths.planFile,
    docsTouched: facts.paths.docsTouched,
    artifacts: facts.artifacts,
    files: facts.paths.files,
    prompts,
    // A worker's transcript is all sidechain; its closing message is its report.
    outcome: extractOutcome(entries, { includeSidechain: true }),
    knownSecrets: secrets,
    // R-P1: the worker's own searches; the parent note records only its own.
    retrievals: searches.records,
    retrieved: retrievedLinks(searches.hits, { vaultRoot, deadlineAt: deadlineAt - RESERVE_MS }),
    commands: accumulator.commands,
    commandCount: accumulator.commandCount,
    agents: accumulator.agents,
    skills: [...accumulator.skills],
    toolCounts: facts.toolCounts,
    subagentFilesRead: 0,
    transcriptPath,
  };

  // Read for its title, which labels this worker's `up` link. The link into
  // the parent below reads it again: the parent's own SessionEnd may write it
  // in between, and writing back this copy would undo that capture.
  const parent = readParentHead(placement.parentSessionsDir, input.sessionId);

  // The same merge rule as a session note: lists grow, scalars only improve,
  // and a tag added by hand survives. A subagent's note is rewritten if the
  // same agent id stops twice.
  const fields = withLinks(
    current.fields ? mergeFields(current.fields, buildFields(context)) : buildFields(context),
    placement.area,
    placement.collection,
    {
      area: placement.parentArea,
      collection: placement.parentCollection,
      title: parentTitle(parent.note, placement, date),
    },
  );
  const merged = { ...context, previousBody: current.body };
  const result = persist(targetPath, renderNote(fields, renderBody(merged, fields)));
  if (!result.ok) {
    return { written: false, action: 'skip', skip: `write failed (${result.error})`, notePath: targetPath, touchedPaths: [], vaultRoot, detail: '' };
  }

  // A worker can be the first note in its collection: its parent may file elsewhere.
  // `SubagentStop` fires at every stop of a multi-turn worker; only the first can matter.
  const index = current.fields ? { ok: true } : ensureIndex(vaultRoot, placement.area, placement.collection);
  const linked = linkIntoParent({
    parent: readParentHead(placement.parentSessionsDir, input.sessionId),
    area: placement.parentArea,
    childId: fields.id,
  });

  return {
    written: true,
    action: current.fields ? 'merge' : 'create',
    skip: '',
    notePath: targetPath,
    // The parent note counts too when this run added the link: `child_sessions`
    // is frontmatter, so nothing else would ever carry it to the store.
    touchedPaths: [
      ...(result.changed ? [targetPath] : []),
      ...(linked.notePath ? [linked.notePath] : []),
    ],
    vaultRoot,
    detail:
      `${vaultRelative(vaultRoot, targetPath)} ` +
      `agent_type=${agentType || 'unknown'} placed_by=${placement.basis} parent=${linked.status}` +
      (result.changed ? '' : ' (identical on disk)') +
      (index.ok ? '' : ` (index not written: ${index.error})`) +
      (current.stub ? ' (replaced stub)' : ''),
  };
}

/** `placed_by=` in the log line: which rule decided where the note went. */
const PLACED_BY_PARENT = 'parent';
const PLACED_BY_OWN_CWD = 'own-cwd';
const PLACED_BY_EARLIER_NOTE = 'earlier-note';

/** A note that is not there yet: what a fresh capture starts from. */
const NO_NOTE = Object.freeze({ fields: null, body: '', error: '', stub: false });

/**
 * Where a worker's note is filed, and the note already there.
 *
 * A worker belongs to its session, so it files where its session does: the
 * collection comes from the directory the parent transcript declares, never
 * from wherever the worker had `cd`'d to when it stopped. On 2026-09-24 eight
 * worker notes on the live vault existed twice — the hook had filed them under
 * `vault`, `estac` or another repo by the worker's own directory, and the sweep
 * beside their parent. A parent transcript that cannot be read, or declares no
 * `cwd`, falls back to the directory the worker's own transcript declares.
 *
 * Every other copy of the note is looked for, whatever is at home, and each one
 * not merged into is logged — never deleted: a second copy is the bug this
 * exists to stop, and somebody has to hear it is still there. The parent note
 * is still looked for in the parent's collection, because that is where the
 * session files itself.
 *
 * The parent's own folder travels with the placement, apart from the worker's:
 * a worker merged into an older copy elsewhere still links up to, and is
 * linked into, the parent where the parent files.
 *
 * @returns {{area: string, collection: string, collectionSource: string,
 *            notePath: string, current: object, parentArea: string,
 *            parentCollection: string, parentSessionsDir: string,
 *            parentStartedAt: string, parentRepo: string,
 *            parentPhase: string, basis: string}}
 */
function placeWorker({ input, agentId, agentTranscriptPath, facts, vaultRoot, log, env }) {
  const fromParent = parentPlacement({ input, agentTranscriptPath, vaultRoot, env });
  const home = fromParent
    ? { area: fromParent.area, collection: fromParent.collection, collectionSource: fromParent.collectionSource }
    : { area: facts.area, collection: facts.collection, collectionSource: facts.collectionSource };
  const parentSessionsDir = path.join(vaultRoot, home.area, home.collection, SESSIONS_DIR);
  const filename = childNoteFilename(input.sessionId, agentId);
  const atHome = {
    ...home,
    parentArea: home.area,
    parentCollection: home.collection,
    parentSessionsDir,
    parentStartedAt: fromParent?.timestamp ?? '',
    parentRepo: fromParent?.repo ?? '',
    parentPhase: fromParent?.phase ?? '',
    notePath: path.join(parentSessionsDir, filename),
    basis: fromParent ? PLACED_BY_PARENT : PLACED_BY_OWN_CWD,
  };

  const strays = findNotesByName(vaultRoot, filename).filter((copy) => !samePath(copy.notePath, atHome.notePath));
  const { placement, claimed } = chooseTarget({ atHome, homeExists: fs.existsSync(atHome.notePath), strays, vaultRoot, log });
  if (!placement.current.error) {
    const target = vaultRelative(vaultRoot, placement.notePath);
    for (const stray of strays.filter((copy) => copy !== claimed)) {
      log(`duplicate worker note left at ${vaultRelative(vaultRoot, stray.notePath)}; merged into ${target}`);
    }
  }
  return placement;
}

/**
 * The note this capture merges into, and the stray copy it has dealt with.
 *
 * The home copy wins when it exists; an unreadable one there is the caller's
 * refusal to write, exactly as for a session note. Otherwise the first stray,
 * in sorted order, is merged into where it sits and keeps describing its
 * folder. A stray the parser cannot read is left alone and a fresh note is
 * written at home: a hand-edited note elsewhere must not cost this worker's.
 * A stray that is only a stub — an empty file Obsidian made when a link was
 * followed — is not a note to merge into either, and is left the same way.
 *
 * @returns {{placement: object, claimed: object|null}}
 */
function chooseTarget({ atHome, homeExists, strays, vaultRoot, log }) {
  const [earlier] = strays;
  if (homeExists || !earlier) return { placement: { ...atHome, current: readNote(atHome.notePath) }, claimed: null };

  const current = readNote(earlier.notePath);
  if (current.error || current.stub) {
    const what = current.stub ? 'empty stray left' : 'existing note unreadable';
    log(`${what} at ${vaultRelative(vaultRoot, earlier.notePath)}; writing beside the parent`);
    return { placement: { ...atHome, current: NO_NOTE }, claimed: earlier };
  }
  const placement = {
    ...atHome,
    area: earlier.area,
    collection: earlier.collection,
    collectionSource: String(current.fields?.collection_source ?? '') || atHome.collectionSource,
    notePath: earlier.notePath,
    current,
    basis: PLACED_BY_EARLIER_NOTE,
  };
  return { placement, claimed: earlier };
}

/** The same file, however it is spelled: `path.relative` folds case on Windows. */
function samePath(a, b) {
  return path.relative(a, b) === '';
}

/** `<area>/<collection>/sessions/<name>`, the form every log line uses. */
function vaultRelative(vaultRoot, notePath) {
  return toPosix(path.relative(vaultRoot, notePath));
}

/**
 * A worker's repo, phase and tags, with what its own transcript could not say
 * taken from its parent (brief 101 H-1): a worker whose own sources yield no
 * phase takes the phase its parent's checkout branch yields, and one whose own
 * `cwd` yields no repo (a workflow agent's Claude Code folder) takes the
 * repo of the parent transcript's `cwd`. Its own always wins.
 */
function inheritFromParent(facts, placement) {
  const ownPhase = facts.phase;
  const phase = ownPhase || placement.parentPhase || '';
  return {
    repo: facts.repo.repoFullName || placement.parentRepo || '',
    phase,
    tags: ownPhase ? facts.tags : withPhaseTag(facts.tags, phase),
  };
}

/**
 * The collection the parent session files under, from the `cwd` its own
 * transcript declares, and the `timestamp` its first record carries (`''`
 * when none does); `null` when no parent transcript declares a `cwd`.
 * With it, the repo that `cwd` resolves to and the phase its checkout's
 * branch yields (`''` each when there is none), for a worker to inherit.
 *
 * The transcript beside the worker's `subagents/` folder is asked first, then
 * the payload's `transcript_path`, which on `SubagentStop` is the session's.
 * Both are compared in posix form, so one file named twice — once built here,
 * once in the payload's Windows spelling — is read once, and the worker's own
 * transcript is never taken for its parent's. `readHead` is injectable so a
 * test can count the reads.
 */
export function parentPlacement({ input, agentTranscriptPath, vaultRoot, readHead = readTranscriptHead, env = process.env }) {
  const own = toPosix(agentTranscriptPath);
  const named = [parentTranscriptBeside(agentTranscriptPath, input.sessionId), input.transcriptPath].map(toPosix);
  const candidates = [...new Set(named)].filter((candidate) => candidate && candidate !== own);
  for (const candidate of candidates) {
    const { cwd, timestamp = '' } = readHead(candidate);
    if (!cwd) continue;
    const { placement, repo } = placeSession({ cwd, vaultRoot, env });
    const repoFullName = repo?.repoFullName ?? '';
    return {
      area: placement.area,
      collection: placement.collection,
      collectionSource: placement.collectionSource,
      timestamp,
      repo: repoFullName,
      phase: derivePhase({ branch: repo?.branch ?? '', repo: repoFullName }),
    };
  }
  return null;
}

/**
 * The parent session's note as it stands: the head of its resume chain, as for
 * the session's own write — once `-r2` exists the base note is superseded, and
 * a link to it, or into it, is a link to history.
 *
 * @returns {{path: string, note: object}} `note` is what `readNote` returns.
 */
function readParentHead(sessionsDir, sessionId) {
  const parentPath = resolveChainHead(sessionsDir, sessionId).path;
  return { path: parentPath, note: readNote(parentPath) };
}

/**
 * The label on a worker's `up` link: the parent note's own title when there is
 * one, else `<date> · <collection>` — the date the parent session started, or
 * the worker's own when no parent transcript said. The fallback is the usual
 * case, because a worker normally stops before its parent is captured.
 */
function parentTitle(parentNote, placement, workerDate) {
  const title = String(parentNote.fields?.title ?? '').trim();
  if (title) return title;
  const date = isoDate(placement.parentStartedAt) || workerDate;
  return `${date}${TITLE_SEPARATOR}${placement.parentCollection}`;
}

/**
 * Add this child to the parent note's `child_sessions`, if the parent note is
 * already there. `parent` is `readParentHead`'s result, read just before
 * this call so the write-back starts from the note as it stands.
 *
 * It usually is not — a worker normally stops long before the session that
 * spawned it — and that is fine: the parent's own `SessionEnd` back-fills the
 * list from the `subagents/` directory. This covers the other order, where the
 * parent note already exists because the session was captured earlier.
 *
 * @returns {{status: string, notePath: string}} `notePath` is set only when this
 *          call actually changed the parent note, so the caller knows whether it
 *          has to be re-ingested.
 */
function linkIntoParent({ parent, area, childId }) {
  const untouched = (status) => ({ status, notePath: '' });

  const { note } = parent;
  if (!note.fields || note.error) {
    return untouched(note.error ? 'unreadable' : 'not yet written');
  }

  const existing = Array.isArray(note.fields.child_sessions) ? note.fields.child_sessions : [];
  if (existing.includes(childId)) return untouched('already linked');

  const fields = withLinks(
    { ...note.fields, child_sessions: uniqueCapped([...existing, childId], MAX_CHILD_SESSIONS) },
    area,
  );
  const written = persist(parent.path, renderNote(fields, note.body));
  if (!written.ok) return untouched('link failed');
  return { status: 'linked', notePath: written.changed ? parent.path : '' };
}

/**
 * Where the agent's transcript is.
 *
 * The payload's `agent_transcript_path` is trusted when it exists; otherwise it
 * is reconstructed from the session transcript's own directory, which is where
 * Claude Code writes it: `<session-id>/subagents/agent-<agent-id>.jsonl`.
 */
function resolveAgentTranscript({ input, agentId, projectsRoot }) {
  if (input.agentTranscriptPath && fs.existsSync(input.agentTranscriptPath)) return input.agentTranscriptPath;

  const candidates = [];
  if (input.transcriptPath) {
    candidates.push(path.join(path.dirname(input.transcriptPath), input.sessionId, SUBAGENTS_DIR));
  }
  if (projectsRoot && input.cwd) {
    candidates.push(path.join(projectsRoot, sanitize(input.cwd), input.sessionId, SUBAGENTS_DIR));
  }

  for (const dir of candidates) {
    const file = path.join(dir, `agent-${agentId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return '';
}

/** Claude Code's own scheme for a project directory name. */
function sanitize(cwd) {
  return String(cwd).replace(/\\/g, '/').replace(/[^a-zA-Z0-9]+/g, '-');
}

/** `agent-<id>.meta.json` beside the transcript: the agent type and its task. */
function readAgentMeta(transcriptPath) {
  const metaPath = transcriptPath.replace(/\.jsonl$/, '.meta.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * What the worker was asked to do.
 *
 * Its own transcript opens with the task prompt as a sidechain turn, which
 * `extractPrompts` finds. When it does not — some workers are handed their task
 * entirely through the parent's `Agent` tool input — the `description` from the
 * meta file beside the transcript is the same text, and is used instead.
 */
function agentPrompts(entries, meta) {
  const found = extractPrompts(entries);
  if (found.length) return found;

  const description = redact(String(meta.description ?? '')).trim();
  if (!description) return [];
  return [{ text: description, timestamp: '', cwd: '' }];
}
