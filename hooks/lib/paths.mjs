/**
 * Turning the raw list of edited files into the fields R-27.3 asks for.
 *
 * The v1 note listed absolute Windows paths, and on a long session most of them
 * were scratchpad files: `files_modified` was dominated by
 * `AppData/Local/Temp/claude/…`, which links a session to nothing. Here the list
 * is filtered to real work and made repo-relative, and the paths that carry
 * their own meaning — a plan file, an auto-memory file, a doc — are lifted into
 * their own fields.
 */

import path from 'node:path';

import { hostPathFlavor } from './host-paths.mjs';
import { resolveRepo } from './repo.mjs';
import { isLocalPath, toPosix, uniqueCapped } from './text.mjs';

/**
 * Paths that are machinery rather than work.
 *
 * `.claude/projects/` holds transcripts and auto-memory: the transcripts are
 * this note's own raw material and the memory files are lifted into
 * `memory_files`, so neither belongs in `files_modified`.
 *
 * The scratchpad rules name the shape Claude Code actually writes —
 * `…/Temp/claude/<project>/<session>/scratchpad/…` — rather than excluding the
 * whole system temp directory. Broad is tempting and wrong: it would also
 * discard a repository someone checked out under `Temp`, which is exactly what
 * this suite does.
 */
const NOISE_PATTERNS = [
  // A path on another host is not a file this session edited in any sense worth
  // recording, and resolving one would hand that host an SMB authentication.
  /^[\\/]{2}[^\\/]/,
  /\/Temp\/claude\//i,
  /\/scratchpad\//i,
  /\/\.claude\/projects\//i,
  /\/node_modules\//,
  /\/\.venv\//,
  /\/__pycache__\//,
  /\/\.git\//,
  /\/dist\//,
  /\/build\//,
  /\/\.next\//,
];

const MEMORY_FILE = /\/\.claude\/projects\/[^/]+\/memory\/(.+)\.md$/i;
const PLAN_FILE = /\/\.claude\/plans\/(.+)\.md$/i;

/** Is this path machinery we never want listed? */
export function isNoisePath(candidate) {
  const posix = toPosix(candidate);
  if (!posix) return true;
  return NOISE_PATTERNS.some((re) => re.test(posix));
}

/**
 * A memoised `dir -> repo` resolver.
 *
 * A session touches sixty files in a handful of directories; without the cache
 * that is sixty walks up the tree, with it a handful.
 */
export function makeRepoResolver({ env = process.env } = {}) {
  // Session paths from another host name no checkout on this disk.
  if (hostPathFlavor(env)) return () => null;
  const cache = new Map();
  return function repoFor(filePath) {
    const dir = toPosix(path.dirname(toPosix(filePath)));
    if (!dir || !isLocalPath(dir)) return null;
    if (cache.has(dir)) return cache.get(dir);
    const repo = resolveRepo(dir);
    const result = repo.repoRoot ? repo : null;
    cache.set(dir, result);
    return result;
  };
}

/**
 * Path relative to its own repository checkout, or the absolute POSIX path when
 * the file lives outside every repository.
 */
export function toRepoRelative(filePath, repo) {
  const posix = toPosix(filePath);
  const root = toPosix(repo?.repoRoot ?? '');
  if (!root) return posix;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return posix.toLowerCase().startsWith(prefix.toLowerCase()) ? posix.slice(prefix.length) : posix;
}

/**
 * Split the raw edited-file list into the note's path fields.
 *
 * @param {Array<[string, number]>} entries  `[absolutePath, editCount]`, most-edited first
 * @param {object} options
 * @param {function} options.repoFor         from `makeRepoResolver()`
 * @param {number} options.maxFiles
 * @param {number} options.maxDocs
 * @param {number} options.maxMemory
 * @param {number} options.maxRepos
 */
export function classifyPaths(entries, { repoFor, maxFiles, maxDocs, maxMemory, maxRepos }) {
  const memoryFiles = [];
  const docsTouched = [];
  const reposTouched = [];
  const files = [];
  let planFile = '';

  for (const [raw, count] of entries) {
    const posix = toPosix(raw);
    if (!posix) continue;

    const memory = posix.match(MEMORY_FILE);
    if (memory) {
      memoryFiles.push(path.basename(memory[1]));
      continue;
    }
    const plan = posix.match(PLAN_FILE);
    if (plan) {
      if (!planFile) planFile = path.basename(plan[1]);
      continue;
    }
    if (isNoisePath(posix)) continue;

    const repo = repoFor(posix);
    const relative = toRepoRelative(posix, repo);
    if (repo?.repoSlug) reposTouched.push(repo.repoSlug);
    if (relative.startsWith('docs/')) docsTouched.push(relative);
    files.push({ path: relative, count: Number.isFinite(count) ? count : 1, repo: repo?.repoSlug ?? '' });
  }

  return {
    files: dedupeFiles(files, maxFiles),
    docsTouched: uniqueCapped(docsTouched, maxDocs),
    memoryFiles: uniqueCapped(memoryFiles, maxMemory),
    reposTouched: uniqueCapped(reposTouched, maxRepos).sort(),
    planFile,
  };
}

/**
 * Two worktrees of one repo produce the same relative path for the same file.
 * That is the point — but it means the same entry can arrive twice, so the edit
 * counts are summed rather than the later one winning.
 */
function dedupeFiles(files, cap) {
  const merged = new Map();
  for (const file of files) {
    const existing = merged.get(file.path);
    if (existing) merged.set(file.path, { ...existing, count: existing.count + file.count });
    else merged.set(file.path, file);
  }
  const sorted = [...merged.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return Number.isInteger(cap) ? sorted.slice(0, cap) : sorted;
}
