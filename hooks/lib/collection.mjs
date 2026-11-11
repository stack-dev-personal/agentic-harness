/**
 * Which vault folder a session belongs in (R-27.1, R-H2).
 *
 * The rule that matters: **the collection is the repository, not the folder.**
 * Before this, a session run in `bb2dash-wt-sl` filed itself under a collection
 * called `bb2dash-wt-sl`, so one project's history scattered across as many
 * "projects" as it had worktrees. Every worktree of `emstacho-su/bb2dash` now
 * resolves to `bb2dash`.
 *
 * First, a cwd inside one of Claude Code's own folders (`~/.claude/projects/
 * <encoded>/…`, a scratchpad under `<tmp>/claude/<encoded>/…`) is decoded back
 * to the cwd it was made for, and the repository is resolved again from there
 * (claude-paths.mjs). Then the first rule of ROUTING_RULES that places it wins:
 *   1. class-folder — cwd passes through a directory that exists under
 *      `vault/classes/`, so `…/.fall2026/ist352` is `classes/ist352`;
 *   2. harness — the harness repo (worktrees included, deleted ones by their
 *      folder name), `~/.claude` or `~/.harness` go to `harness/agentic-harness`,
 *      when this vault holds the `harness` realm; without it they fall through
 *      to the rules below, as before the realm existed;
 *   3. container — `~/projects` itself, the folder of projects, is `misc`;
 *   4. git — `https://github.com/emstacho-su/bb2dash.git` is
 *      `projects/bb2dash`, flagged `collection_source: git`;
 *   5. folder — the folder name, flagged `collection_source: folder`, preferring
 *      an ancestor that already owns a vault folder (in whichever area it is)
 *      so a session run in `agentic-harness/ingest` is not filed under `ingest`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decodeClaudeStateCwd } from './claude-paths.mjs';
import {
  AREA_CLASSES,
  AREA_HARNESS,
  AREA_PROJECTS,
  AREAS,
  COLLECTION_FROM_FOLDER,
  COLLECTION_FROM_GIT,
  REALM_MARKER,
} from './constants.mjs';
import { hostPathFlavor } from './host-paths.mjs';
import { resolveRepo } from './repo.mjs';
import { slugify, toPosix } from './text.mjs';

const MAX_WALK_UP = 40;
/** The identity of a path that names no checkout: `resolveRepo`'s empty answer. */
const NO_REPO = resolveRepo('');
const FALLBACK_COLLECTION = 'misc';

/** The harness's own repository, and the collection its history is filed under. */
export const HARNESS_REPO_FULL_NAME = 'emstacho-su/agentic-harness';
export const HARNESS_COLLECTION = 'agentic-harness';
/** Folders under home that hold the harness itself: its config and its machine file. */
const HARNESS_HOME_DIRS = Object.freeze(['.claude', '.harness']);
/** Folders under home that hold projects rather than being one. */
const CONTAINER_HOME_DIRS = Object.freeze(['projects']);

const isUnder = (cwd, dir) => {
  const [a, b] = [cwd.toLowerCase(), dir.toLowerCase()];
  return a === b || a.startsWith(`${b}/`);
};
const homeDir = (home, name) => `${toPosix(home).replace(/\/+$/, '')}/${name}`;

/**
 * The rules, in order. Each takes `{cwd, repo, vaultRoot, home, holdsHarness}` and returns
 * `{area, collection, collectionSource}` or null to pass.
 */
export const ROUTING_RULES = Object.freeze([
  Object.freeze({
    name: 'class-folder',
    place: ({ cwd, vaultRoot }) => {
      const collection = matchClassFolder(cwd, vaultRoot);
      return collection ? { area: AREA_CLASSES, collection, collectionSource: COLLECTION_FROM_FOLDER } : null;
    },
  }),
  Object.freeze({
    name: 'harness',
    place: ({ cwd, repo, vaultRoot, home, holdsHarness }) => {
      if (!holdsHarness) return null;
      if (repo?.repoFullName?.toLowerCase() === HARNESS_REPO_FULL_NAME) {
        return { area: AREA_HARNESS, collection: HARNESS_COLLECTION, collectionSource: COLLECTION_FROM_GIT };
      }
      // A worktree deleted before its session was captured has no .git to read;
      // the folder walk-up still names the harness (`agentic-harness-wt-h1`).
      const inHarnessHome = HARNESS_HOME_DIRS.some((name) => isUnder(cwd, homeDir(home, name)));
      const namesHarness = inHarnessHome || fromFolder(cwd, vaultRoot).collection === HARNESS_COLLECTION;
      return namesHarness ? { area: AREA_HARNESS, collection: HARNESS_COLLECTION, collectionSource: COLLECTION_FROM_FOLDER } : null;
    },
  }),
  Object.freeze({
    name: 'container',
    place: ({ cwd, home }) => {
      const isContainer = CONTAINER_HOME_DIRS.some((name) => cwd.toLowerCase() === homeDir(home, name).toLowerCase());
      return isContainer ? { area: AREA_PROJECTS, collection: FALLBACK_COLLECTION, collectionSource: COLLECTION_FROM_FOLDER } : null;
    },
  }),
  Object.freeze({
    name: 'git',
    place: ({ repo }) => {
      const collection = slugify(repo?.repoSlug ?? '');
      return collection ? { area: AREA_PROJECTS, collection, collectionSource: COLLECTION_FROM_GIT } : null;
    },
  }),
  Object.freeze({
    name: 'folder',
    place: ({ cwd, vaultRoot }) => ({ ...fromFolder(cwd, vaultRoot), collectionSource: COLLECTION_FROM_FOLDER }),
  }),
]);

/**
 * Where a session is filed, and why: the rule that placed it and the cwd that
 * rule read (the decoded one, for a Claude Code folder).
 *
 * @param {object} args
 * @param {string} args.cwd        the session's working directory
 * @param {string} args.vaultRoot  vault root; folders in it steer the rules
 * @param {object} [args.repo]     the result of `resolveRepo(cwd)`, when the caller has it
 * @param {string} [args.home]     home directory (tests pass a scratch one)
 * @param {string} [args.tmp]      temp directory, parent of Claude Code's scratchpads
 * @param {function} [args.resolveRepoFor]  cwd -> repo, for a decoded cwd
 * @param {boolean} [args.holdsHarness]  whether the harness rule applies; by
 *   default, whether `vaultRoot` holds `harness/.realm`. move-to-realm's
 *   `--plan-only` passes true to preview the move before the realm exists.
 * @returns {{area: string, collection: string, collectionSource: string, rule: string, routedCwd: string, repo: object}}
 */
export function routeSession({
  cwd,
  vaultRoot,
  repo,
  home = os.homedir(),
  tmp = os.tmpdir(),
  resolveRepoFor = resolveRepo,
  holdsHarness = holdsHarnessRealm(vaultRoot),
  env = process.env,
}) {
  // Session paths from another host name no checkout on this disk: the rules
  // read the path text alone, whatever repository a caller supplies.
  const foreign = Boolean(hostPathFlavor(env));
  const repoOf = foreign ? () => NO_REPO : resolveRepoFor;
  const decoded = decodeClaudeStateCwd(cwd, { home, tmp });
  const shared = { vaultRoot, home, holdsHarness };
  // The repository of the cwd the rules read: resolved here only when the caller
  // did not already, or when decoding moved to another folder.
  const context = decoded
    ? { ...shared, cwd: decoded, repo: repoOf(decoded) }
    : { ...shared, cwd: toPosix(cwd), repo: foreign ? NO_REPO : repo ?? repoOf(cwd) };
  for (const rule of ROUTING_RULES) {
    const placed = rule.place(context);
    if (placed) return { ...placed, rule: rule.name, routedCwd: context.cwd, repo: context.repo };
  }
  throw new Error('unreachable: the folder rule always places a session');
}

/**
 * The placement and the repository it was decided from, resolved once from
 * `cwd`. For a Claude Code folder that is the decoded cwd's repository, so a
 * note filed `collection_source: git` always carries that repo, branch and
 * commits.
 */
export function placeSession({ cwd, vaultRoot, home, tmp, resolveRepoFor = resolveRepo, holdsHarness, env }) {
  const placement = routeSession({ cwd, vaultRoot, home, tmp, resolveRepoFor, holdsHarness, env });
  return { placement, repo: placement.repo };
}

/** `routeSession` without the why: what a note's placement fields need. */
export function deriveCollection(args) {
  const { area, collection, collectionSource } = routeSession(args);
  return { area, collection, collectionSource };
}

/** Whether this vault holds the `harness` realm: `harness/.realm` names it, as realm-sync reads it. */
export function holdsHarnessRealm(vaultRoot) {
  if (!vaultRoot) return false;
  try {
    return fs.readFileSync(path.join(vaultRoot, AREA_HARNESS, REALM_MARKER), 'utf8').trim() === AREA_HARNESS;
  } catch {
    return false;
  }
}

/**
 * The deepest path segment that already names a folder under `vault/classes/`.
 *
 * Data-driven on purpose: the course ids are the ones the vault already uses
 * (`ist323`, `geo103`), so adding a class is creating its folder, not editing
 * the hook.
 */
function matchClassFolder(cwd, vaultRoot) {
  const segments = toPosix(cwd).split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    for (const slug of [slugify(segments[i]), courseSlug(segments[i])]) {
      if (slug && vaultFolderExists(vaultRoot, AREA_CLASSES, slug)) return slug;
    }
  }
  return '';
}

/**
 * bb2dash's course id — `IST.323`, `GEO.103.lecture` — as the vault spells it.
 *
 * bb2dash files what it harvests under `course context/<course id>`, and a
 * session opened there is work for that class. The mapping is the one
 * `export-materials` uses to file the same course's notes (`collection_for_course`
 * in `ingest/materials/render.py`), so both arrive at the same folder. Still
 * keyed on the vault: a course with no `classes/` folder is not matched.
 */
const COURSE_ID = /^([a-z]{2,4})\.(\d{3})(?:\.[a-z]+)?$/i;

function courseSlug(segment) {
  const match = COURSE_ID.exec(segment);
  return match ? `${match[1]}${match[2]}`.toLowerCase() : '';
}

/**
 * A folder named `<project>-wt-<anything>` is one of `<project>`'s worktrees,
 * **when `<project>` already owns a vault folder**. Rule 2 normally settles a
 * worktree through its `.git` file, but a worktree deleted before its session
 * was captured (the nightly sweep sees these) has nothing on disk to read, and
 * this is the naming convention every worktree on this machine follows. Keyed
 * on the vault like the class rule, so a name that merely looks like one is
 * still filed under itself.
 */
const WORKTREE_SUFFIX = /^(.+?)-wt-.+$/;

function ownedVaultFolder(vaultRoot, slug) {
  if (!slug) return null;
  // The worktree's project first: a stray `projects/<project>-wt-x/` folder
  // (one an earlier capture created before this rule existed) must not keep
  // winning over the project it belongs to.
  const worktree = WORKTREE_SUFFIX.exec(slug);
  for (const candidate of worktree ? [worktree[1], slug] : [slug]) {
    const area = AREAS.find((each) => vaultFolderExists(vaultRoot, each, candidate));
    if (area) return { area, collection: candidate };
  }
  return null;
}

/** The nearest ancestor that owns a vault folder, in the area it is in; else the cwd's own name, in projects. */
function fromFolder(cwd, vaultRoot) {
  let current = toPosix(cwd);
  for (let depth = 0; depth < MAX_WALK_UP && current; depth += 1) {
    const owned = ownedVaultFolder(vaultRoot, slugify(path.basename(current)));
    if (owned) return owned;
    const parent = toPosix(path.dirname(current));
    if (!parent || parent === current) break;
    current = parent;
  }
  return { area: AREA_PROJECTS, collection: slugify(path.basename(toPosix(cwd))) || FALLBACK_COLLECTION };
}

function vaultFolderExists(vaultRoot, area, slug) {
  if (!vaultRoot) return false;
  try {
    return fs.statSync(path.join(vaultRoot, area, slug)).isDirectory();
  } catch {
    return false;
  }
}
