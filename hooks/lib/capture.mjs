/**
 * Capturing a finished session: transcript in, one merged note on disk out.
 *
 * Lives beside the hook rather than inside it so the whole pipeline can be
 * driven from a test with a fixture transcript, a fixture vault and a stubbed
 * `git`. `session-capture.mjs` is the thin process wrapper around this, and
 * `subagent.mjs` is its sibling for `SubagentStop`.
 *
 * The analysis — repository, branch, files, tags, commits — is in
 * `analyse.mjs`, shared with the subagent path. What stays here is the part
 * that is specific to a *session*: its identity, its resume chain, and the
 * write.
 */

import path from 'node:path';

import { analyseTranscript } from './analyse.mjs';
import {
  BUDGET_MS,
  CAPTURED_BY_HOOK,
  MAIN_TRANSCRIPT_MAX_BYTES,
  MAX_CHILD_SESSIONS,
  RESERVE_MS,
  RESUME_REASON,
  SESSIONS_DIR,
  STATUS_ACTIVE,
  STATUS_CONCLUDED,
} from './constants.mjs';
import { runGitSync } from './git-log.mjs';
import { withLinks } from './links.mjs';
import { machineName } from './machine-env.mjs';
import { canonicalPath, pathWithin, entryPaths, sessionMemoryEligibility, memoryPolicyFields } from './memory-policy.mjs';
import {
  ACTION_CREATE,
  ACTION_MERGE,
  ACTION_NOOP,
  ACTION_RESUME,
  markSuperseded,
  planWrite,
} from './merge.mjs';
import { buildFields, childNoteId, noteFilename, noteId, renderBody, renderNote } from './note.mjs';
import { ensureIndex, persist, readNote, resolveChainHead, vaultAvailable } from './notes-io.mjs';
import { extractRetrievals, retrievedLinks } from './retrievals.mjs';
import { defaultStateDir, readSessionStartRecord } from './session-start.mjs';
import { isoDate, uniqueCapped, isSafeFilenameSegment } from './text.mjs';
import {
  extractOrigin,
  extractOutcome,
  extractPrompts,
  extractSubagentTools,
  extractTools,
  createAccumulator,
  knownSecrets,
  parentSessionFromPath,
  firstPromptText,
  readEntries,
  resolveTranscript,
} from './transcript.mjs';

/**
 * Capture one finished session.
 *
 * `touchedPaths` lists every note this call actually changed on disk, which is
 * not always just `notePath`: a resume also rewrites the note it supersedes.
 * It is what gets handed to the ingest, so a note that was rewritten byte for
 * byte is deliberately absent from it.
 *
 * @returns {{written: boolean, action: string, skip: string, notePath: string,
 *            touchedPaths: string[], vaultRoot: string, detail: string}}
 */
export function capture(options) {
  return captureSession({ ...options, agent: 'claude-code', runtime: 'claude-code' });
}

/** Canonical capture entry point. Native adapters provide normalized entries. */
export function captureSession({
  input,
  vaultRoot,
  projectsRoot,
  startedAtMs = Date.now(),
  deadlineAt = startedAtMs + BUDGET_MS,
  runGit = runGitSync,
  capturedBy = CAPTURED_BY_HOOK,
  stateDir = defaultStateDir(process.env),
  entries: suppliedEntries,
  agent = 'unknown', runtime = agent, model = '', provider = '', origin,
  generator, parentSession, childSessions, promptTask,
  briefSessionId = input.sessionId,
  env = process.env,
}) {
  const skip = (reason) => ({ written: false, action: 'skip', skip: reason, notePath: '', touchedPaths: [], vaultRoot, detail: '' });
  if (!isSafeFilenameSegment(input.sessionId)) return skip('invalid session id');
  if ((parentSession || input.parentSession) && !isSafeFilenameSegment(parentSession || input.parentSession)) return skip('invalid parent session id');

  input = { ...input, runtime, parentSession: parentSession ?? input.parentSession };
  const eligibility = sessionMemoryEligibility({ input, env });
  if (!eligibility.allowed) return { ...skip(eligibility.reason), action: 'excluded' };
  const transcriptPath = suppliedEntries ? input.transcriptPath || '' : resolveTranscript({
    declaredPath: input.transcriptPath,
    sessionId: input.sessionId,
    cwd: input.cwd,
    projectsRoot,
    deadlineAt,
  });
  if (!suppliedEntries && !transcriptPath) return skip('no transcript found');

  const entries = suppliedEntries ?? readEntries(transcriptPath, MAIN_TRANSCRIPT_MAX_BYTES, deadlineAt - RESERVE_MS);
  if (entries.length === 0) return skip('transcript unreadable or empty');

  const prompts = extractPrompts(entries);
  if (prompts.length === 0) return skip('no user prompts (trivial session)');

  if (!vaultAvailable(vaultRoot)) return skip(`vault root unavailable (${vaultRoot})`);

  // A subagent's edits are the session's edits, so its transcripts are folded
  // into the same accumulator before anything is derived from it.
  const accumulator = createAccumulator();
  extractTools(entries, accumulator);
  const subagents = suppliedEntries ? { agentIds: [], filesRead: 0 } : extractSubagentTools({
    transcriptPath,
    sessionId: input.sessionId,
    into: accumulator,
    deadlineAt: deadlineAt - RESERVE_MS,
  });

  const touched = sessionMemoryEligibility({ input, env, paths: [...entryPaths(entries), ...accumulator.files.keys(), ...accumulator.filesRead.keys()] });
  if (!touched.allowed) return { ...skip(touched.reason), action: 'excluded' };

  const facts = analyseTranscript({
    entries,
    prompts,
    cwd: input.cwd,
    transcriptPath,
    vaultRoot,
    deadlineAt,
    runGit,
    into: accumulator,
  });

  const concluded = input.endReason !== RESUME_REASON;

  // R-P1: this transcript's own searches (workers record theirs on their own
  // notes) plus what the SessionStart brief injected, when it left a record.
  const secrets = knownSecrets(prompts, accumulator);
  const searches = extractRetrievals(entries, { secrets });
  const brief = readSessionStartRecord({ sessionId: briefSessionId, stateDir });
  const retrievals = brief.record ? [brief.record, ...searches.records] : searches.records;

  const context = {
    sessionId: input.sessionId,
    noteId: noteId(input.sessionId),
    collection: facts.collection,
    collectionSource: facts.collectionSource,
    date: isoDate(facts.timing.endedAt) || isoDate(new Date().toISOString()),
    cwd: facts.cwd,
    cwdsSeen: facts.cwdsSeen,
    endReason: input.endReason,
    startedAt: facts.timing.startedAt,
    endedAt: facts.timing.endedAt,
    durationMs: facts.timing.durationMs,
    status: concluded ? STATUS_CONCLUDED : STATUS_ACTIVE,
    concludedAt: concluded ? facts.timing.endedAt : '',
    repo: facts.repo.repoFullName,
    branch: facts.branch,
    worktree: facts.repo.worktree,
    reposTouched: facts.paths.reposTouched,
    phase: facts.phase,
    tags: facts.tags,
    supersedes: [],
    resumedFrom: '',
    parentSession: parentSession ?? (input.parentSession || parentSessionFromPath(transcriptPath)),
    ancestorSessions: Array.isArray(input.ancestorSessions) ? [...input.ancestorSessions] : [],
    // The child note ids, which are the ingest external_ids, so a search can
    // follow the link straight to the worker's own note. The `SubagentStop`
    // hook writes those notes; this back-fill is what makes the list complete
    // even for children that ended before their parent's note existed.
    childSessions: uniqueCapped(
      childSessions ?? subagents.agentIds.map((agentId) => childNoteId(input.sessionId, agentId)),
      MAX_CHILD_SESSIONS,
    ),
    agentType: input.agentType || '',
    origin: origin ?? extractOrigin(entries),
    agent, runtime, model: model || entries.findLast(entry => typeof entry.message?.model === 'string')?.message?.model || '', provider, generator,
    ...memoryPolicyFields(input),
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
    titlePrompt: promptTask || (suppliedEntries ? prompts[0]?.text : firstPromptText(transcriptPath, prompts, MAIN_TRANSCRIPT_MAX_BYTES)),
    outcome: extractOutcome(entries),
    knownSecrets: secrets,
    retrievals,
    retrieved: retrievedLinks(searches.hits, { vaultRoot, deadlineAt: deadlineAt - RESERVE_MS }),
    commands: accumulator.commands,
    commandCount: accumulator.commandCount,
    agents: accumulator.agents,
    skills: [...accumulator.skills],
    toolCounts: facts.toolCounts,
    subagentFilesRead: subagents.filesRead,
    transcriptPath,
  };

  const sessionsDir = path.join(vaultRoot, facts.area, facts.collection, SESSIONS_DIR);
  return writeNote({ context, sessionsDir, area: facts.area, collection: facts.collection, vaultRoot });
}

// -------------------------------------------------------------- the write

export function writeNote({ context, sessionsDir, area, collection, vaultRoot }) {
  if (!isSafeFilenameSegment(context.sessionId) || !pathWithin(canonicalPath(vaultRoot), canonicalPath(sessionsDir))) {
    return { written: false, action: 'skip', skip: 'invalid session id or vault destination', touchedPaths: [], vaultRoot };
  }
  const next = buildFields(context);
  // The head of the chain, not the base note: once an `-r2` exists it is the
  // one that carries the session's current state, and planning against the
  // superseded base would fork a new note on every later SessionEnd.
  const head = resolveChainHead(sessionsDir, context.sessionId);
  const targetPath = head.path;
  if (!pathWithin(canonicalPath(vaultRoot), canonicalPath(targetPath))) return { written: false, action: 'skip', skip: 'note target outside vault', touchedPaths: [], vaultRoot };

  const current = readNote(targetPath);
  if (current.error) {
    // An unreadable note is a note somebody may have hand-edited into a shape
    // this parser does not know. Refusing to write is the only safe answer.
    return { written: false, action: 'skip', skip: `existing note unreadable: ${current.error}`, notePath: targetPath, touchedPaths: [], vaultRoot, detail: '' };
  }

  const plan = planWrite(current.fields, next);
  if (plan.action === ACTION_NOOP) {
    return { written: false, action: ACTION_NOOP, skip: plan.reason, notePath: targetPath, touchedPaths: [], vaultRoot, detail: '' };
  }

  if (plan.action === ACTION_RESUME) {
    return writeResumeNote({ context, sessionsDir, area, collection, vaultRoot, previous: current, plan, previousPath: targetPath, index: head.nextIndex });
  }

  const fields = withLinks(plan.fields, area);
  // The previous body carries anything Stack typed below the generated marker;
  // `renderBody` regenerates the machine sections and re-appends the rest.
  const merged = { ...context, previousBody: current.body };
  const result = persist(targetPath, renderNote(fields, renderBody(merged, fields)));
  if (!result.ok) {
    return { written: false, action: 'skip', skip: `write failed (${result.error})`, notePath: targetPath, touchedPaths: [], vaultRoot, detail: '' };
  }

  // The note links `up` to its collection index; a collection this write just
  // created has none. Only a note's first write can be its collection's first
  // note. A failure costs a ghost node, not the session.
  const index = plan.action === ACTION_CREATE ? ensureIndex(vaultRoot, area, collection) : { ok: true };

  return {
    written: true,
    action: plan.action === ACTION_CREATE ? ACTION_CREATE : ACTION_MERGE,
    skip: '',
    notePath: targetPath,
    // Empty when the re-render came out byte-identical: the note on disk is
    // already what the store holds, so an ingest would only re-confirm a hash.
    touchedPaths: result.changed ? [targetPath] : [],
    vaultRoot,
    detail:
      `${area}/${collection}/${SESSIONS_DIR}/${path.basename(targetPath)}` +
      (result.changed ? '' : ' (identical on disk)') +
      (index.ok ? '' : ` (index not written: ${index.error})`) +
      (current.stub ? ' (replaced stub)' : ''),
  };
}

/**
 * A resume that arrives after the note settled becomes a new note, and the note
 * it continues is marked `superseded` (R-27.2, Stack 2026-09-14). Ids never
 * change meaning, so a row already in the store stays the row it was.
 */
function writeResumeNote({ context, sessionsDir, area, collection, vaultRoot, previous, plan, previousPath, index }) {
  if (index === 0) {
    return { written: false, action: 'skip', skip: 'resume chain is implausibly long', notePath: '', touchedPaths: [], vaultRoot, detail: '' };
  }

  const fields = withLinks({ ...plan.fields, id: noteId(context.sessionId, index) }, area);
  const resumedContext = { ...context, noteId: fields.id };
  const targetPath = path.join(sessionsDir, noteFilename(context.sessionId, index));

  const written = persist(targetPath, renderNote(fields, renderBody(resumedContext, fields)));
  if (!written.ok) {
    return { written: false, action: 'skip', skip: `write failed (${written.error})`, notePath: targetPath, touchedPaths: [], vaultRoot, detail: '' };
  }

  // Only after the successor exists: a crash between the two leaves a complete
  // note and a stale status, never a superseded note with no successor.
  const flipped = persist(previousPath, renderNote(withLinks(markSuperseded(previous.fields), area), previous.body));

  return {
    written: true,
    action: ACTION_RESUME,
    skip: '',
    notePath: targetPath,
    // Both notes changed, and both have to be re-ingested: the predecessor's
    // `status: superseded` is a frontmatter-only edit, which is exactly the
    // change the store used to miss.
    touchedPaths: [
      ...(written.changed ? [targetPath] : []),
      ...(flipped.ok && flipped.changed ? [previousPath] : []),
    ],
    vaultRoot,
    detail:
      `${area}/${collection}/${SESSIONS_DIR}/${path.basename(targetPath)} ` +
      `supersedes=${path.basename(previousPath)}${flipped.ok ? '' : ' (status flip failed)'}`,
  };
}
