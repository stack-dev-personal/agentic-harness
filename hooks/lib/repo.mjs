/**
 * Git identity for a working directory, resolved by reading files.
 *
 * R-27.1 wants the repository identity rather than the folder name, and R-27.3
 * wants the branch and the worktree. All three are in `.git`, and reading them
 * costs a handful of `readFileSync` calls — where shelling out to `git` costs
 * 50–150 ms per invocation on Windows and can hang on a network drive. The one
 * thing that genuinely needs git (the commit list) lives in `git-log.mjs` and is
 * bounded and optional.
 *
 * Nothing here throws. An unreadable, missing or exotic `.git` yields empty
 * strings, and the caller falls back to the folder name with
 * `collection_source: folder`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isLocalPath, toPosix } from './text.mjs';

/** A cwd nested this deep below a repo root is not our problem. */
const MAX_WALK_UP = 40;

const EMPTY = Object.freeze({
  repoRoot: '',
  mainRoot: '',
  gitDir: '',
  commonDir: '',
  remoteUrl: '',
  repoFullName: '',
  repoSlug: '',
  branch: '',
  worktree: '',
});

/**
 * Resolve the repository containing `cwd`.
 *
 * `repoRoot` is the checkout the files are in (a worktree, when cwd is one);
 * `mainRoot` is the repository those worktrees belong to, which is where
 * `git log` has to run.
 */
export function resolveRepo(cwd) {
  const start = toPosix(cwd);
  // A path this platform does not read as absolute (a relative one, or a
  // Windows path read on Linux) would be walked up from the process's own
  // folder and end at its `./.git`: a checkout that has nothing to do with it.
  if (!start || !isLocalPath(start) || !path.isAbsolute(start)) return EMPTY;

  const found = findGitEntry(start);
  if (!found) return EMPTY;

  const { repoRoot, gitPath, isFile } = found;
  const gitDir = isFile ? readGitdirPointer(gitPath) : gitPath;
  if (!gitDir) return { ...EMPTY, repoRoot };

  const commonDir = resolveCommonDir(gitDir);
  const mainRoot = commonDir ? toPosix(path.dirname(commonDir)) : repoRoot;
  const worktree = commonDir === gitDir ? '' : path.basename(repoRoot);

  const remoteUrl = readOriginUrl(commonDir);
  const repoFullName = parseRepoFullName(remoteUrl);

  return Object.freeze({
    repoRoot,
    mainRoot,
    gitDir,
    commonDir,
    remoteUrl,
    repoFullName,
    repoSlug: repoFullName ? repoFullName.split('/').pop() : '',
    branch: readBranch(gitDir),
    worktree,
  });
}

function findGitEntry(start) {
  let current = start;
  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    if (!isLocalPath(current)) return null;
    const candidate = path.join(current, '.git');
    let stat = null;
    try {
      stat = fs.statSync(candidate);
    } catch {
      stat = null;
    }
    if (stat) {
      return { repoRoot: current, gitPath: toPosix(candidate), isFile: stat.isFile() };
    }
    const parent = toPosix(path.dirname(current));
    if (!parent || parent === current) return null;
    current = parent;
  }
  return null;
}

/** A worktree's `.git` is a file holding `gitdir: <absolute path>`. */
function readGitdirPointer(gitFilePath) {
  let raw;
  try {
    raw = fs.readFileSync(gitFilePath, 'utf8');
  } catch {
    return '';
  }
  const match = raw.match(/^\s*gitdir:\s*(.+?)\s*$/m);
  if (!match) return '';
  const pointer = toPosix(match[1]);
  const resolved = path.isAbsolute(pointer)
    ? pointer
    : toPosix(path.resolve(path.dirname(gitFilePath), pointer));
  // A `.git` file is content, and content does not get to name another host.
  return isLocalPath(resolved) ? resolved : '';
}

/**
 * The shared `.git` directory: for `…/.git/worktrees/name` that is `…/.git`.
 *
 * Git also writes a `commondir` file inside the worktree's git dir. Reading it
 * is the documented way; the path split is the fallback for the case where the
 * file is missing or holds a relative path we cannot resolve.
 */
function resolveCommonDir(gitDir) {
  const marker = '/worktrees/';
  const at = gitDir.lastIndexOf(marker);
  if (at === -1) return gitDir;

  try {
    const raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (raw) {
      const resolved = toPosix(path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw));
      if (isLocalPath(resolved) && fs.existsSync(resolved)) return resolved;
    }
  } catch {
    /* fall through to the path split */
  }
  return gitDir.slice(0, at);
}

function readOriginUrl(commonDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(commonDir, 'config'), 'utf8');
  } catch {
    return '';
  }

  // `[remote "origin"]` wins; any other remote is the fallback, because a repo
  // with exactly one differently-named remote still has one identity.
  const sections = raw.split(/^\s*\[/m);
  let fallback = '';
  for (const section of sections) {
    const header = section.match(/^remote\s+"([^"]+)"\]/);
    if (!header) continue;
    const url = section.match(/^\s*url\s*=\s*(.+?)\s*$/m);
    if (!url) continue;
    if (header[1] === 'origin') return url[1];
    if (!fallback) fallback = url[1];
  }
  return fallback;
}

/**
 * `owner/repo` from any remote URL shape git accepts, or `''`.
 *
 * Covers `https://host/owner/repo.git`, `git@host:owner/repo.git`,
 * `ssh://git@host/owner/repo` and a local path. A URL with credentials in it
 * loses them here — the identity is the path, never the userinfo.
 */
export function parseRepoFullName(remoteUrl) {
  const url = String(remoteUrl ?? '').trim();
  if (!url) return '';

  let pathPart = '';
  const scp = url.match(/^[A-Za-z0-9_.+-]+@[^:/]+:(.+)$/);
  if (scp) {
    pathPart = scp[1];
  } else {
    const scheme = url.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/i);
    pathPart = scheme ? scheme[1].replace(/^[^/]*\//, '') : toPosix(url);
  }

  const segments = pathPart
    .replace(/\.git$/i, '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return '';
  if (segments.length === 1) return segments[0];
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

/** Branch name from `HEAD`, or the short sha when the head is detached. */
function readBranch(gitDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return '';
  }
  const ref = raw.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (ref) return ref[1].trim();
  return /^[0-9a-f]{40}$/i.test(raw) ? raw.slice(0, 12) : '';
}
