/**
 * One writer at a time per realm (R-B3).
 *
 * The nightly sync holds the lock for stage → commit → pull → push; the
 * checkpoint collector holds it while it writes notes into the realm. Two of
 * them interleaving would stage half of each other's work and can corrupt the
 * index, so the second one to arrive stands down.
 *
 * The lock is a small JSON file under the realm's `.git/`, created with an
 * exclusive open (`wx`), which is atomic on NTFS and ext4. No handle is kept
 * open: the file's existence is the lock. A holder older than the stale window
 * is presumed dead and taken over by renaming its file aside — rename is
 * atomic, so of two contenders only one wins it.
 *
 * There is no PID liveness check. Windows reuses PIDs quickly and a probe that
 * fails with EPERM says nothing either way; age is the only honest signal.
 *
 * One race is left. A taker renames the stale file aside, finds a fresh lock
 * in its hands (written after it judged), and puts that lock back. Between the
 * rename and the put-back the path is empty, and a third contender can create
 * its own lock there. The put-back then fails with EEXIST and two writers
 * believe they hold the realm. The taker keeps the aside copy — the only copy
 * of the fresh holder's lock — and reports the lock as contended rather than
 * held. The fresh holder's release will find a token that is not its own and
 * leave the third one's lock alone. It needs three writers inside one rename,
 * against a realm with two writers a night.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REALM_LOCK_FILENAME = 'harness-sync.lock';

/**
 * More than three times the worst-case sync hold (~9.5 min: eight 30 s git
 * calls plus two 120 s network calls). Shared by the sync and the collector,
 * so neither can judge the other's live lock stale.
 */
export const REALM_LOCK_STALE_MS = 30 * 60_000;

/** Passes through create → judge → take over before giving up on a busy lock. */
const ACQUIRE_MAX_PASSES = 3;

/** Antivirus and the indexer briefly hold files on Windows; an unlink then fails with these. */
const TRANSIENT_UNLINK_CODES = Object.freeze(['EBUSY', 'EPERM']);
const UNLINK_RETRIES = 3;
const UNLINK_RETRY_DELAY_MS = 50;

const NOT_A_CHECKOUT = 'not a git checkout';
const CONTENDED = 'lock contended';

const MINUTE_MS = 60_000;

/**
 * What `<realmRoot>/.git` is: 'directory' (a plain checkout), 'file' (a
 * worktree or submodule pointer), or 'none'. Only a directory may be locked
 * and synced.
 *
 * @returns {'directory'|'file'|'none'}
 */
export function gitDirKind(realmRoot) {
  try {
    return fs.statSync(path.join(realmRoot, '.git')).isDirectory() ? 'directory' : 'file';
  } catch {
    return 'none'; // No .git (or unreadable): not a checkout.
  }
}

/**
 * `<realmRoot>/.git/harness-sync.lock`, or '' when `.git` is not a directory:
 * a `.git` file (worktree, submodule) or no `.git` at all means no lock applies.
 */
export function lockPathFor(realmRoot) {
  return gitDirKind(realmRoot) === 'directory' ? path.join(realmRoot, '.git', REALM_LOCK_FILENAME) : '';
}

/**
 * `sync --push, pid 4242, since 2026-09-23T02:29:00.000Z`: the one way the
 * sync and the collector name a lock holder. Unknown parts are spelled out.
 */
export function describeHolder(holder) {
  if (!holder) return 'an unreadable lock file';
  return `${holder.owner || 'unknown owner'}, pid ${holder.pid ?? 'unknown'}, since ${holder.startedAt || 'unknown'}`;
}

/** How old a holder's lock is, in whole minutes, rounded. */
export function holderAgeMinutes(holder) {
  return Math.round(holder.ageMs / MINUTE_MS);
}

function errorOf(err) {
  return err?.code || err?.message || 'unknown';
}

/** Block the thread for `ms`. Lock work is synchronous end to end. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read a lock file into `{ ok, text, token, holder }`. When the JSON or its
 * startedAt cannot be trusted, the file's mtime stands in for the start time.
 * A negative age (the clock went back) is kept as is and so counts as fresh.
 */
function readHolder(lockPath, now) {
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (err) {
    return Object.freeze({ ok: false, code: errorOf(err) });
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null; // Unparseable: judged by mtime below.
  }
  const startedMs = Date.parse(body?.startedAt ?? '');
  const valid = Number.isFinite(startedMs);
  const holder = Object.freeze({
    pid: Number.isInteger(body?.pid) ? body.pid : null,
    owner: typeof body?.owner === 'string' ? body.owner : '',
    startedAt: valid ? new Date(startedMs).toISOString() : '',
    ageMs: now.getTime() - (valid ? startedMs : mtimeMs),
  });
  const token = typeof body?.token === 'string' ? body.token : '';
  return Object.freeze({ ok: true, text, token, holder });
}

/** Best effort: a leftover `.stale-*` copy is harmless, so a failed removal does not fail the lock. */
function removeAside(aside) {
  try {
    fs.rmSync(aside, { force: true });
  } catch {
    // EBUSY/EPERM from a scanner holding the file; the copy is inert.
  }
}

function held(holder) {
  return Object.freeze({ ok: false, reason: 'held', holder });
}

function failed(error) {
  return Object.freeze({ ok: false, reason: 'error', error });
}

/**
 * What to do after putting a fresh lock back that we moved aside by mistake.
 * `wrote` says whether the exclusive write succeeded; `code` is its error code
 * when it did not. Only a successful put-back makes the aside copy redundant:
 * on EEXIST a third contender took the empty path, and on any other failure
 * the lock is nowhere else, so the copy stays either way (see the module note).
 *
 * @returns {{keepAside: boolean, result: object}} frozen
 */
export function putBackOutcome({ wrote, code = '', holder = null }) {
  if (wrote) return Object.freeze({ keepAside: false, result: held(holder) });
  const error = code === 'EEXIST' ? CONTENDED : code || 'unknown';
  return Object.freeze({ keepAside: true, result: failed(error) });
}

/** Put a fresh lock's text back with an exclusive write; frozen `{ wrote, code }`. */
function putBack(lockPath, text) {
  try {
    fs.writeFileSync(lockPath, text, { flag: 'wx' });
    return Object.freeze({ wrote: true, code: '' });
  } catch (err) {
    return Object.freeze({ wrote: false, code: errorOf(err) });
  }
}

/**
 * Move a stale lock aside and make sure it was the one we judged. Returns
 * `{ step: 'retry' }` to loop, `{ step: 'done', result }` to stop.
 */
function evictStale(lockPath, judged, { pid, now }) {
  const aside = `${lockPath}.stale-${pid}-${now.getTime()}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch (err) {
    if (err?.code === 'ENOENT') return { step: 'retry' }; // Another contender won the rename.
    return { step: 'done', result: failed(errorOf(err)) };
  }
  const moved = readHolder(aside, now);
  if (moved.ok && moved.token !== judged.token) {
    // We grabbed a fresh lock someone wrote after we judged. Put it back.
    const outcome = putBackOutcome({ ...putBack(lockPath, moved.text), holder: moved.holder });
    if (!outcome.keepAside) removeAside(aside);
    return { step: 'done', result: outcome.result };
  }
  removeAside(aside);
  return { step: 'retry' };
}

/**
 * Take the realm's lock, or say who holds it. Results are frozen:
 * `{ ok: true, lockPath, token, takenOver }`, `{ ok: false, reason: 'held', holder }`
 * or `{ ok: false, reason: 'error', error }`.
 */
export function acquireRealmLock(realmRoot, { owner, pid = process.pid, now = new Date(), staleMs = REALM_LOCK_STALE_MS } = {}) {
  const lockPath = lockPathFor(realmRoot);
  if (!lockPath) return failed(NOT_A_CHECKOUT);
  return acquirePathLock(lockPath, { owner, pid, now, staleMs });
}

/** Reuse the same atomic lock for the memory worker outside a git realm. */
export function acquirePathLock(lockPath, { owner, pid = process.pid, now = new Date(), staleMs = REALM_LOCK_STALE_MS } = {}) {
  const token = randomUUID();
  const text = `${JSON.stringify({ pid, owner: String(owner ?? ''), startedAt: now.toISOString(), token })}\n`;
  let takenOver = null;
  for (let pass = 0; pass < ACQUIRE_MAX_PASSES; pass += 1) {
    try {
      fs.writeFileSync(lockPath, text, { flag: 'wx' });
      return Object.freeze({ ok: true, lockPath, token, takenOver });
    } catch (err) {
      if (err?.code !== 'EEXIST') return failed(errorOf(err));
    }
    const current = readHolder(lockPath, now);
    if (!current.ok) {
      if (current.code === 'ENOENT') continue; // Released between our create and our read.
      return failed(current.code);
    }
    if (current.holder.ageMs <= staleMs) return held(current.holder);
    const evicted = evictStale(lockPath, current, { pid, now });
    if (evicted.step === 'done') return evicted.result;
    takenOver = current.holder;
  }
  return failed(CONTENDED);
}

/** Unlink with a short retry for the transient Windows sharing errors. */
function unlinkWithRetry(lockPath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.unlinkSync(lockPath);
      return Object.freeze({ ok: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return Object.freeze({ ok: true });
      if (!TRANSIENT_UNLINK_CODES.includes(err?.code) || attempt >= UNLINK_RETRIES) {
        return Object.freeze({ ok: false, error: errorOf(err) });
      }
      sleepSync(UNLINK_RETRY_DELAY_MS);
    }
  }
}

/**
 * Give the lock back. Only a file carrying our token is removed: if ours was
 * taken over as stale, the file now belongs to someone else and stays.
 */
export function releaseRealmLock({ lockPath, token }) {
  const current = readHolder(lockPath, new Date());
  if (!current.ok) {
    return current.code === 'ENOENT' ? Object.freeze({ ok: true }) : Object.freeze({ ok: false, error: current.code });
  }
  if (current.token !== token) return Object.freeze({ ok: false, error: 'not ours' });
  return unlinkWithRetry(lockPath);
}

/**
 * Who holds the lock, without touching it. Dry runs use this. A lock file that
 * exists but cannot be read counts as held by someone unknown, never as free.
 */
export function peekRealmLock(realmRoot, { now = new Date(), staleMs = REALM_LOCK_STALE_MS } = {}) {
  const free = Object.freeze({ held: false, holder: null, stale: false });
  const lockPath = lockPathFor(realmRoot);
  if (!lockPath) return free;
  const current = readHolder(lockPath, now);
  if (!current.ok) return current.code === 'ENOENT' ? free : Object.freeze({ held: true, holder: null, stale: false });
  return Object.freeze({ held: true, holder: current.holder, stale: current.holder.ageMs > staleMs });
}
