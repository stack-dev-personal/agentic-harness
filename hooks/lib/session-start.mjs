/**
 * SC-2 -> SC-1: what the SessionStart brief injected, as one retrieval entry.
 *
 * The SessionStart hook (unit H-b) writes
 * `~/.harness/state/session-start/<session_id>.json`:
 *
 *   {at, session_id, cwd, realm, collection, collection_source,
 *    source: "status" | "outcomes" | "none", external_ids: [...], tokens}
 *
 * `realm` and `collection` also file the session when it has no note yet
 * (`readSessionStartPlacement`, used by filing.mjs).
 *
 * The hook writes it with `writeSessionStartRecord` (at the end of this
 * file), so the shape written and the shape read are checked in one place.
 * Capture reads it here and records it as one `channel: session-start` entry
 * of the note's `retrievals:` list (SC-1), so an injected brief is counted
 * the same way as a search the agent chose to run (R-P1).
 *
 * Rules, the hook's own: never throw, fail open to `record: null` with a
 * reason, and never put a byte of the file into that reason (the brief may
 * quote a note). The session id is checked against the UUID shape before any
 * path is built from it. Nothing is ever deleted: the nightly job sweeps the
 * folder after 7 days (lib/state-sweep.mjs), and a note re-captured inside
 * that window still sees its record.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AREAS, COLLECTION_FROM_FOLDER, COLLECTION_FROM_GIT } from './constants.mjs';
import { slugify } from './text.mjs';

/** How the hook's placement was decided, as a note's `collection_source` says it. */
const COLLECTION_SOURCES = Object.freeze([COLLECTION_FROM_GIT, COLLECTION_FROM_FOLDER]);

/** Overrides `~/.harness/state` — the tests use it; a VM may too. */
export const STATE_DIR_ENV_VAR = 'HARNESS_STATE_DIR';
const DEFAULT_STATE_SEGMENTS = Object.freeze(['.harness', 'state']);
export const SESSION_START_DIR = 'session-start';
const RECORD_SUFFIX = '.json';

export const SESSION_START_CHANNEL = 'session-start';
export const SESSION_START_TOOL = 'session-start';

/** A brief lists a handful of notes; anything past these is not a brief. */
export const MAX_EXTERNAL_IDS = 50;
export const MAX_EXTERNAL_ID_CHARS = 512;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_LABEL_CHARS = 256;

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** The stores an id may already name; anything else is a vault path. */
const KNOWN_SOURCES = Object.freeze(['obsidian', 'claude-mem', 'hermes']);
const DEFAULT_SOURCE = 'obsidian';
/** Where the brief came from (SC-2 `source`), not a store. */
const BRIEF_SOURCES = Object.freeze(['status', 'outcomes', 'none']);

export const REASON_OK = 'ok';

/** `<HARNESS_STATE_DIR or ~/.harness/state>/session-start`. */
export function defaultStateDir(env = process.env, home = os.homedir()) {
  const root = env?.[STATE_DIR_ENV_VAR] || path.join(home, ...DEFAULT_STATE_SEGMENTS);
  return path.join(root, SESSION_START_DIR);
}

/**
 * One external id as an SC-1 result: `source:external_id`, no `@similarity`
 * (the brief ranks nothing). An id that already names a known store keeps it.
 */
export function toResultRef(externalId) {
  const id = String(externalId).slice(0, MAX_EXTERNAL_ID_CHARS);
  const named = KNOWN_SOURCES.some((source) => id.startsWith(`${source}:`));
  return named ? id : `${DEFAULT_SOURCE}:${id}`;
}

/**
 * Read one session's start record. Returns `{ record, reason }`: `record` is
 * one SC-1 entry or `null`, and `reason` says why in words that never quote
 * the file.
 */
export function readSessionStartRecord({ sessionId, env = process.env, stateDir = defaultStateDir(env) } = {}) {
  try {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return refuse('bad session id');
    if (typeof stateDir !== 'string' || !stateDir) return refuse('bad state dir');

    const loaded = loadJson(path.join(stateDir, `${sessionId}${RECORD_SUFFIX}`));
    if (!loaded.ok) return refuse(loaded.reason);
    return toRetrieval(loaded.value, sessionId);
  } catch (error) {
    // Nothing above should throw; if it does, the note is still written.
    return refuse(`unexpected ${error?.code || error?.name || 'error'}`);
  }
}

function refuse(reason) {
  return { record: null, reason };
}

/**
 * Where the SessionStart hook placed this session: `{area, collection,
 * collectionSource}`, or null when there is no record or it names no folder
 * a note could be written in. The host computed it with the session's own
 * checkout in reach, which is why filing asks it before the path-text rules.
 * `collectionSource` is '' in records written before it was kept.
 */
export function readSessionStartPlacement({ sessionId, env = process.env, stateDir = defaultStateDir(env) } = {}) {
  try {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null;
    if (typeof stateDir !== 'string' || !stateDir) return null;
    const loaded = loadJson(path.join(stateDir, `${sessionId}${RECORD_SUFFIX}`));
    if (!loaded.ok) return null;
    const raw = loaded.value;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.session_id !== sessionId) return null;
    const { realm, collection } = raw;
    if (!AREAS.includes(realm) || typeof collection !== 'string' || !collection || slugify(collection) !== collection) return null;
    const collectionSource = COLLECTION_SOURCES.includes(raw.collection_source) ? raw.collection_source : '';
    return { area: realm, collection, collectionSource };
  } catch {
    return null;
  }
}

/** lstat first: a directory, a symlink or a huge file is not a record. */
function loadJson(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: false, reason: 'no record' };
    return { ok: false, reason: `unreadable record (${error?.code || 'error'})` };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not a file' };
  if (stat.size > MAX_RECORD_BYTES) return { ok: false, reason: 'record too large' };

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, reason: `unreadable record (${error?.code || 'error'})` };
  }
  try {
    // The parser's message quotes the text; it is dropped on purpose.
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'bad json' };
  }
}

function toRetrieval(raw, sessionId) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return refuse('not an object');
  if (raw.session_id !== sessionId) return refuse('session id mismatch');
  if (!isIsoTimestamp(raw.at)) return refuse('bad at');
  const ids = raw.external_ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return refuse('bad external_ids');

  const record = {
    at: raw.at,
    channel: SESSION_START_CHANNEL,
    tool: SESSION_START_TOOL,
    query: '',
    filters: buildFilters(raw),
    results: ids.filter((id) => id.length > 0).slice(0, MAX_EXTERNAL_IDS).map(toResultRef),
    chunks: [],
  };
  return { record, reason: REASON_OK };
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && ISO_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

/** Only the fields that pass their check; an absent key beats a wrong value. */
function buildFilters(raw) {
  const filters = {};
  if (BRIEF_SOURCES.includes(raw.source)) filters.source = raw.source;
  if (isLabel(raw.collection)) filters.collection = raw.collection;
  if (isLabel(raw.realm)) filters.realm = raw.realm;
  if (Number.isSafeInteger(raw.tokens) && raw.tokens >= 0) filters.tokens = raw.tokens;
  return filters;
}

function isLabel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LABEL_CHARS;
}

// ------------------------------------------------------------------ writing

/**
 * Write one session's start record (SC-2), for the SessionStart hook.
 *
 * Takes the record in camelCase and writes exactly the SC-2 keys, so the
 * shape the hook writes and the shape `readSessionStartRecord` checks live in
 * this one file. Held to the reader's own rules: a UUID session id before any
 * path is built, an ISO `at`, a known `source`, string ids capped as the
 * reader caps them. Written to a temp file beside the target and renamed over
 * it, so a capture never reads half a record. Never throws: returns
 * `{ ok, reason, path }`, and `reason` never quotes the record.
 */
export function writeSessionStartRecord({ record, stateDir = defaultStateDir(process.env) } = {}) {
  try {
    const checked = toStoredRecord(record);
    if (!checked.ok) return { ok: false, reason: checked.reason, path: '' };
    if (typeof stateDir !== 'string' || !stateDir) return { ok: false, reason: 'bad state dir', path: '' };
    return writeAtomically(path.join(stateDir, `${checked.value.session_id}${RECORD_SUFFIX}`), checked.value);
  } catch (error) {
    return { ok: false, reason: `unexpected ${error?.code || error?.name || 'error'}`, path: '' };
  }
}

function toStoredRecord(record) {
  if (record === null || typeof record !== 'object') return { ok: false, reason: 'not an object' };
  const { at, sessionId, cwd, realm, collection, collectionSource, source, externalIds, tokens } = record;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return { ok: false, reason: 'bad session id' };
  if (!isIsoTimestamp(at)) return { ok: false, reason: 'bad at' };
  if (!BRIEF_SOURCES.includes(source)) return { ok: false, reason: 'bad source' };
  if (!Number.isSafeInteger(tokens) || tokens < 0) return { ok: false, reason: 'bad tokens' };
  if (!Array.isArray(externalIds)) return { ok: false, reason: 'bad external_ids' };

  const ids = externalIds
    .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_EXTERNAL_ID_CHARS)
    .slice(0, MAX_EXTERNAL_IDS);
  const value = {
    at,
    session_id: sessionId,
    cwd: typeof cwd === 'string' ? cwd : '',
    realm: isLabel(realm) ? realm : '',
    collection: isLabel(collection) ? collection : '',
    collection_source: COLLECTION_SOURCES.includes(collectionSource) ? collectionSource : '',
    source,
    external_ids: ids,
    tokens,
  };
  return { ok: true, value };
}

function writeAtomically(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
    return { ok: true, reason: REASON_OK, path: file };
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* the temp file is not a .json; the sweep would not take it, but it harms nothing */
    }
    return { ok: false, reason: `write failed (${error?.code || error?.name || 'error'})`, path: file };
  }
}
