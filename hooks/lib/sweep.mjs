/**
 * The nightly transcript sweep: every session the hook never saw.
 *
 * `SessionEnd` only fires for a session that exits cleanly under the user's
 * settings. Four kinds do not: SDK-spawned workers (review agents), sessions
 * killed with their terminal, desktop-app sessions that predate the hook, and
 * cloud sessions pulled down with `claude --teleport`. Their transcripts are on
 * disk all the same. This module walks `~/.claude/projects/`, finds transcripts
 * with no note in the vault, and feeds each through the **same** capture code
 * the hook runs — `capture()` and `captureSubagent()` — so a swept note is
 * indistinguishable from a hooked one except for `captured_by: sweep`.
 *
 * Rules inherited from the hook: never throw out of a candidate, never guess a
 * field, never write an empty note. One rule of its own: never touch a
 * transcript that is still changing. A file modified inside the idle window is
 * a live session, and its own `SessionEnd` will do a better job.
 */

import fs from 'node:fs';
import path from 'node:path';

import { capture } from './capture.mjs';
import { routeSession } from './collection.mjs';
import { acquireRealmLock, describeHolder, holderAgeMinutes, lockPathFor, REALM_LOCK_STALE_MS, releaseRealmLock } from './realm-lock.mjs';
import { realmRootFor } from './realm-sync.mjs';
import { defaultStateDir } from './session-start.mjs';
import {
  AREAS,
  CAPTURED_BY_SWEEP,
  SESSION_END_EVENT,
  SESSIONS_DIR,
  SUBAGENT_STOP_EVENT,
  SUBAGENTS_DIR,
  SWEEP_BUDGET_MS,
  SWEEP_EXCLUDED_CWD_SEGMENTS,
  SWEEP_GIT_TIMEOUT_MS,
} from './constants.mjs';
import { runGitSync } from './git-log.mjs';

/**
 * `git log` at sweep scale. The hook's 400 ms ceiling exists because it runs
 * on the way out of a session; the sweep runs at 03:00 with nobody waiting,
 * and a timed-out log would leave `commits: []` on a note nothing revisits.
 */
export function sweepGit(args, options = {}) {
  return runGitSync(args, { ...options, timeoutMs: SWEEP_GIT_TIMEOUT_MS });
}
import { parseHookInput } from './stdin.mjs';
import { captureSubagent } from './subagent.mjs';
import { toPosix } from './text.mjs';
import { readTranscriptHead } from './transcript-head.mjs';

const TRANSCRIPT_SUFFIX = '.jsonl';
const NOTE_SUFFIX = '.md';
const AGENT_PREFIX = 'agent-';

// --------------------------------------------------------------- the vault

/**
 * Every session that already has its *own* note, from the filenames alone.
 *
 * `<id>.md` and `<id>-r2.md` count. `<id>--<agent>.md` does **not**: a worker
 * note is written by `SubagentStop` long before the session ends, and a
 * session killed with its terminal leaves exactly that — worker notes and no
 * parent — which is one of the cases the sweep exists for. Re-capturing the
 * workers alongside the parent is idempotent because `captureSubagent` looks
 * the worker's filename up across the whole vault and merges into the note it
 * finds, wherever it sits. Merging only a note in the parent's own folder was
 * not enough: an older hook filed workers by the directory they stopped in, and
 * on 2026-09-24 eight worker notes existed twice, once in each collection.
 * A session id never ends in `-r<digits>`, so the strip cannot eat into it.
 *
 * An empty `<id>.md` does not count either, at the cost of one `stat` per
 * session note. Following a worker's `up` link before its parent is captured
 * makes Obsidian create the parent's file with nothing in it; counted as a
 * note, it would hide that session from every sweep after. Any other content
 * counts: this is a filename index, and the capture decides what a file holds.
 */
export function indexNotedSessions(vaultRoot) {
  const noted = new Set();
  for (const area of AREAS) {
    for (const collection of readDirNames(path.join(vaultRoot, area))) {
      const sessionsDir = path.join(vaultRoot, area, collection, SESSIONS_DIR);
      for (const name of readDirNames(sessionsDir)) {
        const sessionId = sessionIdFromNoteName(name);
        if (sessionId && statFile(path.join(sessionsDir, name))?.size > 0) noted.add(sessionId);
      }
    }
  }
  return noted;
}

/** The session a *session* note is for; `''` for a worker note or a non-note. */
export function sessionIdFromNoteName(name) {
  if (!name.endsWith(NOTE_SUFFIX)) return '';
  const stem = name.slice(0, -NOTE_SUFFIX.length);
  if (stem.includes('--')) return '';
  return stem.replace(/-r\d+$/, '');
}

// ---------------------------------------------------------- the transcripts

/**
 * The top-level transcripts under `projectsRoot`, partitioned.
 *
 * Only `<project dir>/<session id>.jsonl` is a candidate: worker transcripts
 * live under `<session id>/subagents/` and are reached through their parent.
 * Candidates come back oldest first, so a run cut short by `--limit` still
 * makes progress through the backlog in a stable order.
 *
 * @returns {{candidates: Array<{sessionId: string, transcriptPath: string, mtimeMs: number}>,
 *            skippedNoted: number, skippedActive: number}}
 */
export function listCandidateTranscripts({ projectsRoot, noted, minIdleMs, now = Date.now(), only = null }) {
  const candidates = [];
  let skippedNoted = 0;
  let skippedActive = 0;

  for (const dir of readDirNames(projectsRoot)) {
    const projectDir = path.join(projectsRoot, dir);
    for (const name of readDirNames(projectDir)) {
      if (!name.endsWith(TRANSCRIPT_SUFFIX)) continue;
      const sessionId = name.slice(0, -TRANSCRIPT_SUFFIX.length);
      if (only && !only.has(sessionId)) continue;

      const transcriptPath = path.join(projectDir, name);
      const stat = statFile(transcriptPath);
      if (!stat) continue;

      if (noted.has(sessionId)) {
        skippedNoted += 1;
      } else if (now - stat.mtimeMs < minIdleMs) {
        skippedActive += 1;
      } else {
        candidates.push({ sessionId, transcriptPath: toPosix(transcriptPath), mtimeMs: stat.mtimeMs });
      }
    }
  }

  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.sessionId.localeCompare(b.sessionId));
  return { candidates, skippedNoted, skippedActive };
}

/** The worker transcripts beside a session's own, by Claude Code's layout. */
export function listSubagentTranscripts(transcriptPath, sessionId) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, SUBAGENTS_DIR);
  return readDirNames(dir)
    .filter((name) => name.startsWith(AGENT_PREFIX) && name.endsWith(TRANSCRIPT_SUFFIX))
    .sort()
    .map((name) => ({
      agentId: name.slice(AGENT_PREFIX.length, -TRANSCRIPT_SUFFIX.length),
      agentTranscriptPath: toPosix(path.join(dir, name)),
    }));
}

// --------------------------------------------------------------- the sweep

/**
 * Capture one session and every worker it left behind.
 *
 * The payload is built exactly as Claude Code would have written it to stdin
 * and goes through `parseHookInput`, so the session id is held to the same
 * filename allow-list. Nothing here throws: a candidate that fails is one
 * result with `action: 'error'`, and the next candidate still runs.
 */
export function sweepOne({
  candidate,
  vaultRoot,
  projectsRoot,
  runGit = sweepGit,
  budgetMs = SWEEP_BUDGET_MS,
  excludes = SWEEP_EXCLUDED_CWD_SEGMENTS,
  log = () => {},
  stateDir = defaultStateDir(process.env),
}) {
  const base = { sessionId: candidate.sessionId, transcriptPath: candidate.transcriptPath };
  try {
    // The budget is per session and starts here, not when the run started:
    // the deadline checks inside capture() read the live clock.
    const now = Date.now();
    const head = readTranscriptHead(candidate.transcriptPath);
    // The project directory name is Claude Code's own sanitised cwd, so the
    // exclusion holds even when the transcript's head carries no `cwd`.
    const projectDirName = path.basename(path.dirname(candidate.transcriptPath));
    const excluded = excludedBy(head.cwd, excludes, projectDirName);
    if (excluded) return { ...base, action: 'skip', detail: `excluded cwd (${excluded})`, touchedPaths: [], children: [] };

    const parsed = parseHookInput(
      JSON.stringify({
        session_id: candidate.sessionId,
        transcript_path: candidate.transcriptPath,
        cwd: head.cwd,
        hook_event_name: SESSION_END_EVENT,
        reason: 'other',
      }),
      {},
    );
    if (!parsed.ok) return { ...base, action: 'skip', detail: parsed.error, touchedPaths: [], children: [] };

    const session = capture({
      input: parsed.value,
      vaultRoot,
      projectsRoot,
      startedAtMs: now,
      deadlineAt: now + budgetMs,
      runGit,
      capturedBy: CAPTURED_BY_SWEEP,
      stateDir,
    });

    const children = listSubagentTranscripts(candidate.transcriptPath, candidate.sessionId).map((worker) =>
      sweepWorker({ worker, head, candidate, vaultRoot, projectsRoot, runGit, budgetMs, log }),
    );

    return {
      ...base,
      action: session.written ? session.action : 'skip',
      detail: session.written ? session.detail : session.skip,
      touchedPaths: [...session.touchedPaths, ...children.flatMap((child) => child.touchedPaths)],
      children,
    };
  } catch (err) {
    return { ...base, action: 'error', detail: err?.stack || err?.message || String(err), touchedPaths: [], children: [] };
  }
}

function sweepWorker({ worker, head, candidate, vaultRoot, projectsRoot, runGit, budgetMs, log }) {
  const now = Date.now();
  const parsed = parseHookInput(
    JSON.stringify({
      session_id: candidate.sessionId,
      transcript_path: candidate.transcriptPath,
      cwd: head.cwd,
      hook_event_name: SUBAGENT_STOP_EVENT,
      reason: 'other',
      agent_id: worker.agentId,
      agent_transcript_path: worker.agentTranscriptPath,
    }),
    {},
  );
  if (!parsed.ok) return { agentId: worker.agentId, action: 'skip', detail: parsed.error, touchedPaths: [] };

  const outcome = captureSubagent({
    input: parsed.value,
    vaultRoot,
    projectsRoot,
    startedAtMs: now,
    deadlineAt: now + budgetMs,
    runGit,
    capturedBy: CAPTURED_BY_SWEEP,
    log: (line) => log(`  note ${candidate.sessionId}--${worker.agentId}: ${line}`),
  });
  return {
    agentId: worker.agentId,
    action: outcome.written ? outcome.action : 'skip',
    detail: outcome.written ? outcome.detail : outcome.skip,
    touchedPaths: outcome.touchedPaths,
  };
}

/**
 * The whole sweep: index the vault, list the backlog, capture each candidate.
 *
 * `dryRun` stops after listing. `limit` caps how many candidates are captured
 * this run; the rest wait for the next night. `only` restricts the walk to the
 * named session ids, which is how a single teleported session is picked up by
 * hand. The summary counts are what the CLI prints and the nightly log keeps.
 */
export function runSweep({
  projectsRoot,
  vaultRoot,
  minIdleMs,
  limit = 0,
  only = null,
  dryRun = false,
  now = Date.now(),
  log = () => {},
  runGit = sweepGit,
  excludes = SWEEP_EXCLUDED_CWD_SEGMENTS,
  stateDir = defaultStateDir(process.env),
}) {
  // A missing root is a configuration error, not a candidate that failed: a
  // mistyped --projects would otherwise report "nothing to do", and a mistyped
  // --vault would have capture() grow a brand-new vault at the typo.
  for (const [name, root] of [['projectsRoot', projectsRoot], ['vaultRoot', vaultRoot]]) {
    if (!isDirectory(root)) throw new Error(`${name} is not a directory: ${root}`);
  }

  const noted = indexNotedSessions(vaultRoot);
  const listed = listCandidateTranscripts({ projectsRoot, noted, minIdleMs, now, only });
  const selected = limit > 0 ? listed.candidates.slice(0, limit) : listed.candidates;

  const results = dryRun
    ? []
    : selected.map((candidate) => {
        const result = underRealmLocks({ candidate, vaultRoot, excludes, log }, () =>
          sweepOne({ candidate, vaultRoot, projectsRoot, runGit, excludes, log, stateDir }));
        log(`${result.action} ${result.sessionId} ${result.detail}`);
        for (const child of result.children) {
          log(`  ${child.action} ${result.sessionId}--${child.agentId} ${child.detail}`);
        }
        return result;
      });

  const isWrite = (action) => action !== 'skip' && action !== 'error' && action !== ACTION_DEFERRED;
  return {
    dryRun,
    noted: noted.size,
    scanned: listed.candidates.length + listed.skippedNoted + listed.skippedActive,
    skippedNoted: listed.skippedNoted,
    skippedActive: listed.skippedActive,
    candidates: listed.candidates,
    selected: selected.length,
    written: results.filter((result) => isWrite(result.action)).length,
    skipped: results.filter((result) => result.action === 'skip').length,
    errors: results.filter((result) => result.action === 'error').length,
    deferred: results.filter((result) => result.action === ACTION_DEFERRED).length,
    childNotes: results.reduce((sum, result) => sum + result.children.filter((c) => isWrite(c.action)).length, 0),
    touchedPaths: results.flatMap((result) => result.touchedPaths),
    results,
  };
}

// -------------------------------------------------------------- realm lock

/** A candidate bound for a realm the sync holds: filed on the next run, not a failure. */
export const ACTION_DEFERRED = 'deferred';
/** The owner the sweep writes into a realm lock, so the sync's log can name who holds it. */
export const SWEEP_LOCK_OWNER = 'transcript sweep';

/**
 * Run one candidate's capture under the lock of every realm it may write to
 * (R-100, H-10), the way the checkpoint collector does: a realm whose lock is
 * held (by the nightly sync, mid stage → commit → pull → push) is left for the
 * next run, and every lock taken here is given back before the next candidate,
 * so a long backlog never holds a realm for longer than one session's capture.
 *
 * The realm is the one the session's own cwd routes to, decided by the same
 * rules the capture uses. A transcript whose head names no cwd cannot be routed
 * before it is read, so it takes every realm's lock. A vault that is not a
 * realm checkout has no lock, and the capture runs as before. An excluded cwd
 * is skipped by `sweepOne` without a lock.
 */
function underRealmLocks({ candidate, vaultRoot, excludes, log }, work) {
  const head = readTranscriptHead(candidate.transcriptPath);
  const projectDirName = path.basename(path.dirname(candidate.transcriptPath));
  if (excludedBy(head.cwd, excludes, projectDirName)) return work();
  return withRealmLocks({ cwd: head.cwd, vaultRoot, log }, work,
    (name, acquired) => deferredResult(candidate, name, acquired, log));
}

/**
 * Run `work` holding the lock of every realm a session from `cwd` may write
 * to; when one is held, release what was taken and return
 * `onDeferred(realmName, acquired)` instead. Shared with the Codex sweep.
 */
export function withRealmLocks({ cwd, vaultRoot, log = () => {}, owner = SWEEP_LOCK_OWNER }, work, onDeferred) {
  const taken = [];
  try {
    for (const { root, name } of realmsFor(cwd, vaultRoot)) {
      const acquired = acquireRealmLock(root, { owner, pid: process.pid, now: new Date() });
      if (!acquired.ok) return onDeferred(name, acquired);
      if (acquired.takenOver) {
        log(`realm ${name}: took over a stale lock from ${describeHolder(acquired.takenOver)} (${holderAgeMinutes(acquired.takenOver)} min old)`);
      }
      taken.push({ name, lock: { lockPath: acquired.lockPath, token: acquired.token } });
    }
    return work();
  } finally {
    for (const { name, lock } of taken) {
      const released = releaseRealmLock(lock);
      if (!released.ok) log(`realm ${name}: lock not released (${released.error}); it goes stale in ${REALM_LOCK_STALE_MS / 60_000} min`);
    }
  }
}

/** The lockable realm roots a session from `cwd` may write to, deduplicated, in AREAS order. */
function realmsFor(cwd, vaultRoot) {
  let areas = AREAS;
  if (cwd) {
    try {
      areas = [routeSession({ cwd, vaultRoot }).area];
    } catch {
      areas = AREAS; // Unroutable: every realm, as for a head with no cwd.
    }
  }
  const seen = new Set();
  const realms = [];
  for (const area of areas) {
    const root = realmRootFor(vaultRoot, area);
    if (!root || !lockPathFor(root) || seen.has(root)) continue;
    seen.add(root);
    realms.push({ root, name: area });
  }
  return realms;
}

function deferredResult(candidate, name, acquired, log) {
  const why = acquired.reason === 'held'
    ? `realm ${name} is locked by ${describeHolder(acquired.holder)}`
    : `realm ${name}: lock error (${acquired.error})`;
  log(`${why}; its notes wait for the next run`);
  return {
    sessionId: candidate.sessionId,
    transcriptPath: candidate.transcriptPath,
    action: ACTION_DEFERRED,
    detail: why,
    touchedPaths: [],
    children: [],
  };
}

/**
 * The first excluded segment that `cwd` contains, or that `projectDirName`
 * contains in Claude Code's sanitised spelling (`claude-mem/observer-sessions`
 * becomes `claude-mem-observer-sessions` in a project directory name). `''`
 * when neither matches. Compared case-insensitively as posix paths.
 */
export function excludedBy(cwd, excludes, projectDirName = '') {
  const cwdHaystack = toPosix(cwd).toLowerCase();
  const dirHaystack = String(projectDirName).toLowerCase();
  for (const segment of excludes ?? []) {
    if (!segment) continue;
    const needle = toPosix(segment).toLowerCase();
    if (cwdHaystack && cwdHaystack.includes(needle)) return segment;
    if (dirHaystack && dirHaystack.includes(sanitizeSegment(needle))) return segment;
  }
  return '';
}

/** Claude Code's own scheme for a project directory name, applied to a fragment. */
function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9]+/g, '-');
}

function isDirectory(dir) {
  try {
    return Boolean(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ fs bits

function readDirNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}
