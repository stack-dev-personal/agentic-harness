/**
 * Which vault folder a captured session is written to.
 *
 * The routing rules (collection.mjs) decide from the session's working
 * directory, and their best rule reads the checkout's git remote. The jobs
 * container cannot read the host's checkouts, and even on the host a rule can
 * change its answer after a note exists (a vault folder created, a realm
 * moved), which used to start a second note for the same session elsewhere.
 * So the rules come last:
 *
 *   1. the folder of an existing note for this session, anywhere in the vault;
 *   2. the session-start record, written by the host with the checkout in reach;
 *   3. the same two for the parent session, then older ancestors, for a
 *      delegated thread that never fired a start hook of its own;
 *   4. the routing rules on the path text.
 *
 * A session id with notes in two folders is a conflict this cannot settle
 * without picking one at random: it throws, and the capture is refused and
 * counted as an error until somebody merges the copies.
 *
 * The repository (branch, commits) always comes from the rules' own lookup,
 * which under a host path flavor is empty.
 */

import path from 'node:path';

import { routeSession } from './collection.mjs';
import { COLLECTION_FROM_FOLDER, COLLECTION_FROM_GIT } from './constants.mjs';
import { noteFilename } from './note.mjs';
import { findNotesByName, readNote } from './notes-io.mjs';
import { readSessionStartPlacement } from './session-start.mjs';
import { isSafeFilenameSegment } from './text.mjs';

export const FILED_BY_NOTE = 'note';
export const FILED_BY_RECORD = 'record';
export const FILED_BY_PARENT = 'parent';
export const FILED_BY_RULES = 'rules';

const SOURCES = Object.freeze([COLLECTION_FROM_GIT, COLLECTION_FROM_FOLDER]);
/** Codex delegation chains are bounded at 128 by the adapter; this is the same bound. */
const MAX_ANCESTORS = 128;

export class FilingConflictError extends Error {
  constructor(sessionId, copies) {
    const folders = copies.map((copy) => `${copy.area}/${copy.collection}`).join(', ');
    super(`session ${sessionId} has notes in ${copies.length} folders (${folders}); merge them by hand`);
    this.name = 'FilingConflictError';
    this.folders = copies.map((copy) => `${copy.area}/${copy.collection}`);
  }
}

/** The `collection_source` a note on disk records, or '' when it says none we know. */
function recordedSource(notePath) {
  const { fields } = readNote(notePath);
  const value = fields?.collection_source;
  return SOURCES.includes(value) ? value : '';
}

/** Steps 1 and 2 for one session id: its own note, else its own record. */
function placedBySession({ sessionId, briefSessionId, vaultRoot, stateDir }) {
  if (!isSafeFilenameSegment(sessionId)) return null;
  const copies = findNotesByName(vaultRoot, noteFilename(sessionId));
  if (copies.length > 1) throw new FilingConflictError(sessionId, copies);
  if (copies.length === 1) {
    const [{ area, collection, notePath }] = copies;
    return { area, collection, collectionSource: recordedSource(notePath), basis: FILED_BY_NOTE };
  }
  const record = readSessionStartPlacement({ sessionId: briefSessionId, stateDir });
  return record ? { ...record, basis: FILED_BY_RECORD } : null;
}

/**
 * Place one session.
 *
 * @param {object} args
 * @param {string} args.sessionId        the id its note is named by (`codex-<id>` for Codex)
 * @param {string} [args.briefSessionId] the id its session-start record is keyed by
 * @param {Array<{sessionId: string, briefSessionId?: string}>} [args.ancestors] parent first
 * @param {string} args.cwd              the directory the routing rules read
 * @param {string} args.vaultRoot
 * @param {string} [args.stateDir]       the session-start record folder
 * @param {object} [args.env]
 * Remaining arguments (`home`, `tmp`, `resolveRepoFor`, `holdsHarness`) go to `routeSession`.
 * @returns {{area: string, collection: string, collectionSource: string, rule: string,
 *            routedCwd: string, repo: object, basis: string}}
 * @throws {FilingConflictError} when the session, or the ancestor that would place it, has two notes
 */
export function fileSession({
  sessionId, briefSessionId = sessionId, ancestors = [], cwd, vaultRoot, stateDir, env = process.env,
  home, tmp, resolveRepoFor, holdsHarness,
}) {
  const rules = routeSession({ cwd, vaultRoot, env, home, tmp, resolveRepoFor, holdsHarness });
  const settle = (found, basis) => {
    const sameFolder = found.area === rules.area && found.collection === rules.collection;
    const collectionSource = found.collectionSource || (sameFolder ? rules.collectionSource : COLLECTION_FROM_FOLDER);
    return { ...rules, area: found.area, collection: found.collection, collectionSource, basis };
  };

  const own = placedBySession({ sessionId, briefSessionId, vaultRoot, stateDir });
  if (own) return settle(own, own.basis);
  const seen = new Set([sessionId]);
  for (const ancestor of ancestors.slice(0, MAX_ANCESTORS)) {
    if (!ancestor?.sessionId || seen.has(ancestor.sessionId)) continue;
    seen.add(ancestor.sessionId);
    const found = placedBySession({ sessionId: ancestor.sessionId, briefSessionId: ancestor.briefSessionId ?? ancestor.sessionId, vaultRoot, stateDir });
    if (found) return settle(found, FILED_BY_PARENT);
  }
  return { ...rules, basis: FILED_BY_RULES };
}

/** `area/collection/sessions`, the folder a placement writes its notes in. */
export function sessionsFolder(vaultRoot, placement, sessionsDir) {
  return path.join(vaultRoot, placement.area, placement.collection, sessionsDir);
}
