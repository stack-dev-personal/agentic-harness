/**
 * The steps of one realm's sync, in order: preflight → stage and commit →
 * merge-pull → push (R-B1, R-B2, R-B4).
 *
 * Each step asks git one thing at a time and returns a small frozen record:
 * the word it adds to the realm's line (`committed`, `pulled`, …), notes, or
 * a `stop` that ends the realm with an outcome and an error. `runRealmSteps`
 * strings them together; `realm-sync.mjs` wraps it in the lock.
 *
 * What is never asked of git: rebase, stash, reset, checkout, clean, a forced
 * push or a `+` refspec, or `add -A`. A failed pull is only ever undone with
 * `merge --abort`, and only when MERGE_HEAD says a merge is there to abort.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isSyncPath, livePathspecs, scanRealm, SYNC_PATHSPECS } from './realm-guard.mjs';
import { isStaged, parsePorcelainZ, splitBySyncPath } from './realm-status.mjs';

/** `git pull` and `git push` reach the network; the rest does not, but `git status` on a
 * 1,900-note realm takes 24 s over a Docker Desktop bind mount, so the local budget is 90 s. */
export const SYNC_FETCH_TIMEOUT_MS = 120_000;
export const SYNC_GIT_TIMEOUT_MS = 90_000;

/** How many paths one note or error names before `…N more`. */
const PATHS_SHOWN = 3;

/** `git remote get-url` exits 2 when the remote does not exist; anything else is a real failure. */
export const NO_SUCH_REMOTE_STATUS = 2;
/**
 * The ignore rules the sync lists with: the realm's own `.gitignore`,
 * `.git/info/exclude` and `core.excludesFile`, exactly as `git add` applies them.
 */
const STANDARD_EXCLUDES = Object.freeze(['--exclude-standard']);
/** `scheme://anything@` up to the host: the user part of a url, where a token hides. */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i;
/** The remote a branch without an upstream is checked against: the name `git clone` gives. */
const DEFAULT_REMOTE = 'origin';
/** `git symbolic-ref -q` exits 1, quietly, when HEAD is detached. */
const DETACHED_HEAD_STATUS = 1;

const PULL_ARGS = Object.freeze(['pull', '--no-rebase', '--ff', '--no-autostash', '--no-edit', '--quiet']);
const MERGE_HEAD_ARGS = Object.freeze(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);

/**
 * What git, the credential helpers and ssh (in BatchMode) print when a
 * credential is missing or refused, with prompts turned off. Matched over the
 * stderr tail. `(publickey` is left open: ssh lists every method it tried,
 * as in `(publickey,password)`.
 */
export const CREDENTIAL_FAILURE =
  /terminal prompts disabled|could not read (username|password)|authentication failed|interactivity has been disabled|permission denied \(publickey|host key verification failed|batchmode|invalid username or (password|token)|returned error: 40[13]/i;
const OVERWRITTEN_BY_MERGE = /would be overwritten by merge/;
const PUSH_REJECTED = /rejected|fetch first|non-fast-forward/;

/** Files under `.git/` that mean an operation is half done, and what to call it. */
const IN_PROGRESS = Object.freeze([
  ['MERGE_HEAD', 'a merge'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
]);

// ------------------------------------------------------------------ helpers

function halt(outcome, error, notes = []) {
  return Object.freeze({ stop: Object.freeze({ outcome, error }), notes: Object.freeze([...notes]) });
}

function step(word, notes = []) {
  return Object.freeze({ step: word, notes: Object.freeze([...notes]) });
}

/** One git call with the realm's cwd, identity env and stderr capture. */
export function git(ctx, args, timeoutMs = SYNC_GIT_TIMEOUT_MS) {
  return ctx.runGit(args, { cwd: ctx.dir, timeoutMs, env: ctx.env, captureStderr: true });
}

/** `exit 128: fatal: …`, or just the code when git said nothing. */
export function describe(result) {
  const code = result.error || (result.status != null ? `exit ${result.status}` : 'failed');
  return result.stderr ? `${code}: ${result.stderr}` : code;
}

/** NUL-separated output (`-z`) into paths, as they are on disk. */
export function splitZ(stdout) {
  return Object.freeze(String(stdout ?? '').split('\0').filter(Boolean));
}

/**
 * `a; b; c; …N more`: the first `shown` of `paths`, joined by `separator`.
 * `total` is for a caller that kept only a sample: it counts what `paths` left out.
 */
export function namePaths(paths, separator = '; ', { shown = PATHS_SHOWN, total = paths.length } = {}) {
  const named = paths.slice(0, shown);
  const more = total - named.length;
  return more > 0 ? `${named.join(separator)}${separator}…${more} more` : named.join(separator);
}

/** `https://x:token@github.com/o/r.git` → `https://github.com/o/r.git`. A token never reaches a report. */
export function redactRemoteUrl(url) {
  return String(url ?? '').replace(URL_USERINFO, '$1');
}

// ---------------------------------------------------------------- preflight

/** A half-done git operation, or an index.lock, found without running git; null when there is none. */
export function inProgress(dir) {
  const gitDir = path.join(dir, '.git');
  for (const [marker, what] of IN_PROGRESS) {
    if (fs.existsSync(path.join(gitDir, marker))) return halt('conflict', `${what} is in progress; resolve it by hand`).stop;
  }
  if (fs.existsSync(path.join(gitDir, 'index.lock'))) {
    return halt('error', '.git/index.lock exists: another git is running, or one crashed; remove it by hand if none is').stop;
  }
  return null;
}

/**
 * `origin/main` → `{ remote: 'origin', branch: 'main' }`, split at the first
 * `/`: a remote name holds none, a branch may (`hub/notes/main`). Null when
 * there is no remote part, as for an upstream that is a local branch.
 */
export function parseUpstream(text) {
  const name = String(text ?? '').trim();
  const slash = name.indexOf('/');
  if (slash <= 0 || slash === name.length - 1) return null;
  return Object.freeze({ remote: name.slice(0, slash), branch: name.slice(slash + 1) });
}

/** The checked-out branch, or a stop for a detached HEAD or a failed call. */
function currentBranch(ctx) {
  const head = git(ctx, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = head.ok ? head.stdout.trim() : '';
  if (branch) return Object.freeze({ branch });
  if (!head.ok && head.status !== DETACHED_HEAD_STATUS) return halt('error', `git symbolic-ref failed (${describe(head)})`);
  return halt('error', 'detached HEAD; check out a branch by hand');
}

/** No upstream: in order when there is no origin at all (a realm kept on one machine), an error when there is. */
function withoutUpstream(ctx, branch) {
  const origin = git(ctx, ['remote', 'get-url', DEFAULT_REMOTE]);
  if (origin.ok) return halt('error', `no upstream on ${DEFAULT_REMOTE}; run git push -u ${DEFAULT_REMOTE} ${branch} once by hand`);
  if (origin.status === NO_SUCH_REMOTE_STATUS) return Object.freeze({ branch, hasRemote: false, upstream: null });
  return halt('error', `git remote get-url failed (${describe(origin)})`);
}

/**
 * The branch, its upstream `{ remote, branch }`, and whether there is a
 * remote to pull from. The upstream is asked first, because it names the
 * remote to check and to push to. A remote without an upstream is an error
 * here, before anything is staged: the pull would fail after the commit and
 * leave the night half done.
 *
 * @returns {{branch: string, hasRemote: boolean, upstream: {remote: string, branch: string} | null} | {stop: {outcome: string, error: string}}}
 */
export function preflight(ctx) {
  const head = currentBranch(ctx);
  if (head.stop) return head;
  const answer = git(ctx, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!answer.ok) return withoutUpstream(ctx, head.branch);
  const upstream = parseUpstream(answer.stdout);
  if (!upstream) return halt('error', `upstream '${answer.stdout.trim()}' is not a remote branch; set one with git branch -u <remote>/<branch>`);
  const remote = git(ctx, ['remote', 'get-url', upstream.remote]);
  if (!remote.ok) return halt('error', `git remote get-url ${upstream.remote} failed (${describe(remote)})`);
  return Object.freeze({ branch: head.branch, hasRemote: true, upstream });
}

// ------------------------------------------------------------ stage, commit

/**
 * Read the working tree: what changed on the sync paths, what changed off
 * them (named, not staged), and whether a person staged something off them
 * by hand — a commit would carry that along, so the realm is refused.
 */
function readStatus(ctx) {
  const status = git(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!status.ok) return halt('error', `git status failed (${describe(status)})`);
  let records;
  try {
    records = parsePorcelainZ(status.stdout);
  } catch (err) {
    return halt('error', err.message);
  }
  const { sync, leftover } = splitBySyncPath(records, isSyncPath);
  const handStaged = leftover.filter(isStaged);
  if (handStaged.length > 0) {
    return halt('refused', `staged by hand outside the sync paths: ${namePaths(handStaged.map(recordName))}; run git restore --staged`);
  }
  const notes = leftover.length > 0 ? [`not staged: ${namePaths(leftover.map(recordName))}`] : [];
  return Object.freeze({ changed: sync.length > 0, notes: Object.freeze(notes) });
}

/** `from -> to` for a rename or copy (ASCII, like the step separator), the path otherwise. */
function recordName(record) {
  return record.from ? `${record.from} -> ${record.path}` : record.path;
}

/**
 * Every path the add could take on the sync paths: tracked, and untracked
 * but not ignored. `excludeArgs` are the ignore rules (the realm's own by
 * default); `ctx.env` may point git at another GIT_DIR. `-z`: names come back
 * as they are on disk, not C-quoted.
 *
 * @returns {{candidates: readonly string[]} | {stop: {outcome: string, error: string}, notes: readonly string[]}}
 */
export function listSyncCandidates(ctx, { excludeArgs = STANDARD_EXCLUDES, timeoutMs = SYNC_GIT_TIMEOUT_MS } = {}) {
  const listed = git(ctx, ['ls-files', '-z', '--cached', '--others', ...excludeArgs, '--', ...SYNC_PATHSPECS], timeoutMs);
  if (!listed.ok) return halt('error', `git ls-files failed (${describe(listed)})`);
  return Object.freeze({ candidates: splitZ(listed.stdout) });
}

const describeEntry = (entry) => `${entry.path}: ${entry.reason}`;

/**
 * The guard over `candidates` (R-A3, R-A4): a refusal stops with every
 * `reported:` note kept; otherwise the candidates and those notes.
 */
export function guardCandidates(ctx, candidates) {
  const { refused, reported } = scanRealm(candidates, (relPath) => ctx.stat(path.join(ctx.dir, relPath)));
  const notes = reported.length > 0 ? [`reported: ${reported.map(describeEntry).join('; ')}`] : [];
  if (refused.length > 0) {
    return halt('refused', `${refused.length} path(s) refused: ${namePaths(refused.map(describeEntry))}`, notes);
  }
  return Object.freeze({ candidates, notes: Object.freeze(notes) });
}

/** Every path the add could take goes through the guard before anything is staged. */
function guardSyncPaths(ctx) {
  const listed = listSyncCandidates(ctx);
  return listed.stop ? listed : guardCandidates(ctx, listed.candidates);
}

/** Stage the live sync pathspecs, then check the index holds only what the guard saw. */
function stageScanned(ctx, candidates, notes) {
  const added = git(ctx, ['add', '--all', '--', ...livePathspecs(candidates)]);
  if (!added.ok) return halt('error', `git add failed (${describe(added)})`, notes);
  const cached = git(ctx, ['diff', '--cached', '--name-only', '-z']);
  if (!cached.ok) return halt('error', `git diff --cached failed (${describe(cached)})`, notes);
  const staged = splitZ(cached.stdout);
  const scanned = new Set(candidates);
  const unscanned = staged.filter((relPath) => !scanned.has(relPath));
  if (unscanned.length > 0) {
    return halt('error', `${namePaths(unscanned)} appeared during the run and was never scanned; nothing committed`, notes);
  }
  return Object.freeze({ staged });
}

/**
 * Stage the sync paths and commit them. Step word: `committed`, `clean`
 * (nothing on the sync paths changed), or `would-commit` in a dry run.
 */
export function stageAndCommit(ctx) {
  const status = readStatus(ctx);
  if (status.stop) return status;
  if (!status.changed) return step('clean', status.notes);
  const guard = guardSyncPaths(ctx);
  if (guard.stop) return halt(guard.stop.outcome, guard.stop.error, [...guard.notes, ...status.notes]);
  const notes = [...guard.notes, ...status.notes];
  if (ctx.dryRun) return step('would-commit', notes);

  const staged = stageScanned(ctx, guard.candidates, notes);
  if (staged.stop) return staged;
  if (staged.staged.length === 0) return step('clean', notes);
  const message = `harness: sync${ctx.machine ? ` from ${ctx.machine}` : ''} ${ctx.clock().toISOString()}`;
  const committed = git(ctx, ['commit', '--quiet', '-m', message]);
  if (!committed.ok) return halt('error', `git commit failed (${describe(committed)})`, notes);
  return step('committed', notes);
}

// --------------------------------------------------------------------- pull

function mergeHeadPresent(ctx) {
  return git(ctx, MERGE_HEAD_ARGS).ok;
}

/** Why a pull from `remote` failed that left no merge behind. */
export function classifyPullFailure(result, remote = DEFAULT_REMOTE) {
  const tail = result.stderr ?? '';
  if (CREDENTIAL_FAILURE.test(tail)) return `credential missing or rejected for ${remote}: ${tail}`;
  if (OVERWRITTEN_BY_MERGE.test(tail)) return 'local changes outside the sync paths block the merge';
  return `pull failed (${result.error || `exit ${result.status}`}): ${tail}`;
}

/** Why a push to `remote` failed. A rejection is ordinary: someone pushed between our pull and our push. */
export function classifyPushFailure(result, remote = DEFAULT_REMOTE) {
  const tail = result.stderr ?? '';
  if (CREDENTIAL_FAILURE.test(tail)) return `credential missing or rejected for ${remote}: ${tail}`;
  if (PUSH_REJECTED.test(tail)) return 'push rejected: the remote moved since the pull; the next run merges it';
  return `push failed (${result.error || `exit ${result.status}`}): ${tail}`;
}

/** Name the conflicted files, abort the merge, and check it is really gone. */
function abortConflict(ctx) {
  const unmerged = git(ctx, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const files = unmerged.ok ? splitZ(unmerged.stdout) : [];
  const where = files.length > 0 ? namePaths(files) : 'files git did not name';
  const aborted = git(ctx, ['merge', '--abort']);
  if (!aborted.ok || mergeHeadPresent(ctx)) {
    return halt('error', `merge conflict in ${where}; merge --abort failed (${describe(aborted)}); resolve it by hand`);
  }
  return halt('conflict', `merge conflict in ${where}; merge aborted, the local commit stays`);
}

/**
 * Merge the remote in. MERGE_HEAD is checked first on any failure, whatever
 * stderr says: a merge left in progress must be aborted before anything else
 * is reported. Step word: `pulled`, `no-remote`, or `would-pull`.
 */
export function pullMerge(ctx) {
  if (!ctx.hasRemote) return step('no-remote');
  if (ctx.dryRun) return step('would-pull');
  const pulled = git(ctx, PULL_ARGS, SYNC_FETCH_TIMEOUT_MS);
  if (pulled.ok) return step('pulled');
  if (mergeHeadPresent(ctx)) return abortConflict(ctx);
  return halt('error', classifyPullFailure(pulled, ctx.upstream.remote));
}

// --------------------------------------------------------------------- push

/**
 * Push what the remote does not have yet, to the upstream branch (which may
 * be named differently from the local one). `stepsSoFar` are the words the
 * earlier steps added. Step word: `pushed`, `up-to-date`, `kept-local`,
 * `no-remote`, or `would-push`.
 *
 * A dry run counts too: `rev-list` is local and read-only. It cannot count a
 * commit the dry run only said it would make, so that one is `would-push`.
 */
export function pushAhead(ctx, stepsSoFar = []) {
  if (!ctx.hasRemote) return step('no-remote');
  if (ctx.policy !== 'push') return step('kept-local');
  if (ctx.dryRun && stepsSoFar.includes('would-commit')) return step('would-push');
  const ahead = git(ctx, ['rev-list', '--count', '@{u}..HEAD']);
  const count = ahead.ok ? Number.parseInt(ahead.stdout.trim(), 10) : Number.NaN;
  if (!Number.isInteger(count)) return halt('error', `git rev-list failed (${ahead.ok ? `unreadable count '${ahead.stdout.trim()}'` : describe(ahead)})`);
  if (count === 0) return step('up-to-date');
  if (ctx.dryRun) return step('would-push');
  const { remote, branch } = ctx.upstream;
  const pushed = git(ctx, ['push', '--quiet', remote, `HEAD:refs/heads/${branch}`], SYNC_FETCH_TIMEOUT_MS);
  return pushed.ok ? step('pushed') : halt('error', classifyPushFailure(pushed, remote));
}

// ----------------------------------------------------------------- sequence

/**
 * Run one realm's steps. `ctx` is `{ dir, mode, policy, dryRun, machine,
 * clock, env, runGit, stat }`; it is never changed. `clock()` is read when
 * the commit message is written, not before.
 *
 * @returns {{steps: readonly string[], outcome: string, error: string, notes: readonly string[]}}
 */
export function runRealmSteps(ctx) {
  const blocked = inProgress(ctx.dir);
  if (blocked) return draft([], blocked, []);
  const pre = preflight(ctx);
  if (pre.stop) return draft([], pre.stop, pre.notes);
  const repo = Object.freeze({ ...ctx, branch: pre.branch, hasRemote: pre.hasRemote, upstream: pre.upstream });
  const sequence = ctx.mode === 'push' ? [stageAndCommit, pullMerge, pushAhead] : [stageAndCommit, pullMerge];
  let steps = [];
  let notes = [];
  for (const runStep of sequence) {
    const done = runStep(repo, steps);
    notes = [...notes, ...done.notes];
    if (done.stop) return draft(steps, done.stop, notes);
    steps = [...steps, done.step];
  }
  return draft(steps, null, notes);
}

function draft(steps, stop, notes) {
  return Object.freeze({
    steps: Object.freeze([...steps]),
    outcome: stop ? stop.outcome : 'ok',
    error: stop ? stop.error : '',
    notes: Object.freeze([...notes]),
  });
}
