/**
 * Cutover baseline for Codex rollouts (Phase 4 of the container move).
 *
 * The host captured Codex threads from its SQLite history; the container reads
 * the rollout files instead, and their fingerprints differ. Left alone, the
 * container's first run would recapture every thread, and a few milliseconds
 * of clock difference between the sources reads as new activity: concluded
 * notes fork into `-r2`, active ones are rewritten. Measured 2026-11-11: 69
 * forks and 27 rewrites of 126 notes.
 *
 * The baseline records a rollout's current fingerprint as captured when the
 * thread already has a note and the rollout holds no turn after the note's
 * `ended_at` (beyond a small tolerance). Nothing is captured or written to the
 * vault; only the checkpoint entries are returned for the caller to save.
 */
import path from 'node:path';

import { extractCodexTurns } from '../codex-session-capture.mjs';
import { deriveTiming } from './analyse.mjs';
import { MAIN_TRANSCRIPT_MAX_BYTES, SESSIONS_DIR } from './constants.mjs';
import { readNote, resolveChainHead } from './notes-io.mjs';
import { sessionMemoryEligibility } from './memory-policy.mjs';
import { readEntries } from './transcript.mjs';

/** Clock drift between the SQLite history and the rollout of the same turn. */
export const BASELINE_TOLERANCE_MS = 2_000;
const READ_BUDGET_MS = 10_000;

/**
 * The `ended_at` a capture of this rollout would write, in milliseconds; NaN
 * when unreadable. Computed the way the capture computes it (the same entries,
 * `deriveTiming`), so reasoning, tool output and token-count events after the
 * last turn do not count. On the measured corpus this matched every note the
 * database wrote to the millisecond, while "the last record" ran up to hours
 * ahead. A new prompt always arrives in a later turn, so the time alone tells
 * whether the rollout holds activity the note lacks.
 */
export function rolloutEndedAtMs(file, { cwd = '', env = process.env } = {}) {
  try {
    const records = readEntries(file, MAIN_TRANSCRIPT_MAX_BYTES, Date.now() + READ_BUDGET_MS);
    if (!records.length) return NaN;
    return Date.parse(deriveTiming(extractCodexTurns(records, cwd, { env }).entries).endedAt);
  } catch {
    return NaN;
  }
}

function existingNote(candidate, vaultRoot) {
  let placement;
  try { placement = candidate.place(); } catch { return null; } // two notes for one id: capture reports it
  if (placement?.basis !== 'note') return null;
  const head = resolveChainHead(path.join(vaultRoot, placement.area, placement.collection, SESSIONS_DIR), candidate.sessionId);
  const note = readNote(head.path);
  return note.fields ? { path: head.path, endedAt: Date.parse(note.fields.ended_at) } : null;
}

/**
 * @returns {{checkpoints: object, counts: {candidates, baselined, newer, noNote, excluded, unreadable}}}
 */
export function baselineCodex({ candidates, vaultRoot, env = process.env, toleranceMs = BASELINE_TOLERANCE_MS }) {
  const counts = { candidates: 0, baselined: 0, newer: 0, noNote: 0, excluded: 0, unreadable: 0 };
  const checkpoints = {};
  for (const candidate of candidates) {
    if (candidate.runtime !== 'codex' || candidate.sourceKind === 'sqlite') continue;
    counts.candidates += 1;
    if (!sessionMemoryEligibility({ input: { ...candidate.input, runtime: 'codex' }, env }).allowed) { counts.excluded += 1; continue; }
    const note = existingNote(candidate, vaultRoot);
    if (!note) { counts.noNote += 1; continue; }
    const last = rolloutEndedAtMs(candidate.input?.transcriptPath, { cwd: candidate.input?.cwd, env });
    if (!Number.isFinite(last) || !Number.isFinite(note.endedAt)) { counts.unreadable += 1; continue; }
    if (last > note.endedAt + toleranceMs) { counts.newer += 1; continue; }
    checkpoints[`${candidate.runtime}:${candidate.sessionId}`] = { fingerprint: candidate.fingerprint, paths: [note.path] };
    counts.baselined += 1;
  }
  return { checkpoints, counts };
}
