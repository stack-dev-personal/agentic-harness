/**
 * Turning a transcript into the facts a note is made of.
 *
 * Shared by the two things that write notes: a finished session
 * (`capture.mjs`) and a finished subagent (`subagent.mjs`). Both answer the same
 * questions — which repository, which branch, which files, which tags, which
 * commits — from the same evidence, so they ask them in one place rather than
 * two that drift.
 *
 * Order of business, and why: every cheap and certain thing happens first
 * (tools, paths, collection), the one subprocess happens last and only if the
 * clock allows. A note missing its `commits:` is worth having; a note that
 * never got written because `git log` was slow is not.
 */

import {
  MAX_ARTIFACTS,
  MAX_CWDS_SEEN,
  MAX_DOCS_TOUCHED,
  MAX_FILES_LISTED,
  MAX_MEMORY_FILES,
  MAX_PRS,
  MAX_REPOS_TOUCHED,
  RESERVE_MS,
} from './constants.mjs';
import { placeSession } from './collection.mjs';
import { fileSession } from './filing.mjs';
import { collectCommits, runGitSync } from './git-log.mjs';
import { classifyPaths, makeRepoResolver } from './paths.mjs';
import { classify } from './tags.mjs';
import { toPosix, uniqueCapped } from './text.mjs';
import { createAccumulator, extractTools, scanToolResults } from './transcript.mjs';
import { readTranscriptHead } from './transcript-head.mjs';

/**
 * Analyse one transcript.
 *
 * @param {object} args
 * @param {object[]} args.entries    parsed JSONL entries
 * @param {object[]} args.prompts    from `extractPrompts`
 * @param {string} args.cwd          the working directory the hook reported;
 *                                   kept as the note's `cwd` (provenance)
 * @param {string} [args.transcriptPath] the file the entries came from; its
 *                                   first record's `cwd` decides the collection,
 *                                   repository, branch and commits
 * @param {string} args.vaultRoot
 * @param {number} args.deadlineAt
 * @param {function} [args.runGit]
 * @param {object} [args.env]        a host path flavor here means no checkout is read
 * @param {object} [args.filing]     `{sessionId, briefSessionId, ancestors, stateDir}`:
 *                                   file by an existing note, record or parent first
 *                                   (filing.mjs); throws FilingConflictError
 * @param {object} [args.into]      an accumulator to add to, when a caller has
 *                                   already folded subagent transcripts into one
 * @returns everything a note context needs, except the session's own identity.
 */
export function analyseTranscript({
  entries,
  prompts,
  cwd,
  transcriptPath = '',
  vaultRoot,
  deadlineAt,
  runGit = runGitSync,
  into = null,
  env = process.env,
  filing = null,
}) {
  const accumulator = into ?? createAccumulator();
  if (!into) extractTools(entries, accumulator);
  scanToolResults(entries, accumulator);

  const timing = deriveTiming(entries);
  const cwdsSeen = uniqueCapped(entries.map((entry) => toPosix(entry.cwd)).filter(Boolean), MAX_CWDS_SEEN);
  const effectiveCwd = cwd || cwdsSeen[cwdsSeen.length - 1] || '';

  // Everything the note says about *where* — collection, repository, branch,
  // commits — comes from one directory, so it can never claim a git collection
  // with no repository. The stdin cwd is only provenance, kept as `cwd`.
  const placementCwd = declaredCwd(transcriptPath, cwdsSeen) || effectiveCwd;
  // For a Claude Code folder (`~/.claude/projects/<encoded>/…`, a scratchpad)
  // the rules read the decoded cwd, and the repository comes from there too.
  // A session's own note, start record or parent comes before the rules
  // (filing.mjs); a caller that places its note itself passes no `filing`.
  const filed = filing ? fileSession({ ...filing, cwd: placementCwd, vaultRoot, env }) : null;
  const { placement, repo } = filed ? { placement: filed, repo: filed.repo } : placeSession({ cwd: placementCwd, vaultRoot, env });
  const { area, collection, collectionSource } = placement;
  const branch = repo.branch || lastBranchSeen(accumulator) || '';

  const paths = classifyPaths(sortedFiles(accumulator), {
    repoFor: makeRepoResolver({ env }),
    maxFiles: MAX_FILES_LISTED,
    maxDocs: MAX_DOCS_TOUCHED,
    maxMemory: MAX_MEMORY_FILES,
    maxRepos: MAX_REPOS_TOUCHED,
  });

  const readPaths = classifyPaths(sortedEntries(accumulator.filesRead), {
    repoFor: makeRepoResolver({ env }),
    maxFiles: MAX_FILES_LISTED,
    maxDocs: MAX_DOCS_TOUCHED,
    maxMemory: MAX_MEMORY_FILES,
    maxRepos: MAX_REPOS_TOUCHED,
  });

  const { tags, phase } = classify({
    files: paths.files,
    filesRead: readPaths.files,
    docsTouched: paths.docsTouched,
    commandTexts: accumulator.commandTexts,
    promptTexts: prompts.map((prompt) => prompt.text),
    skills: [...accumulator.skills],
    toolNames: [...accumulator.toolCounts.keys()],
    branch,
    repo: repo.repoFullName,
  });

  const git = deriveCommits({ repo, timing, runGit, deadlineAt });

  return {
    accumulator,
    timing,
    cwdsSeen,
    cwd: effectiveCwd,
    repo,
    area,
    collection,
    collectionSource,
    branch,
    paths,
    tags,
    phase,
    commits: git.shas,
    prs: uniqueCapped([...accumulator.prNumbers, ...git.prs], MAX_PRS),
    artifacts: uniqueCapped(accumulator.artifacts, MAX_ARTIFACTS),
    toolCounts: sortedToolCounts(accumulator),
  };
}

/**
 * The directory a transcript declares it started in: its first record's `cwd`.
 *
 * The stdin `cwd` is wherever the session was when it ended — the vault, the
 * home folder, another repository it `cd`'d into — so a session that started
 * in `bb2dash` and ended in the vault used to file itself under `vault`, away
 * from its own workers, with no repository and no commits. Where the transcript
 * says it started is where the session belongs.
 *
 * Read from the head of the file, because a transcript over the read budget is
 * parsed tail-first and its parsed entries no longer begin at the start. The
 * first `cwd` among the parsed entries stands in when the head carries none or
 * no file was named. `''` when the transcript declares no directory at all, and
 * the caller falls back to the stdin `cwd`.
 */
function declaredCwd(transcriptPath, cwdsSeen) {
  const fromHead = transcriptPath ? readTranscriptHead(transcriptPath).cwd : '';
  return fromHead || cwdsSeen[0] || '';
}

/**
 * When the session started and ended.
 *
 * Ordered by parsed instant rather than by string. Every timestamp Claude Code
 * writes today is `YYYY-MM-DDTHH:MM:SS.sssZ`, for which a lexical sort happens
 * to be chronological — but comparing the numbers costs the same and does not
 * depend on that staying true. The duration is clamped, because a negative one
 * is nonsense that `Number.isFinite` would happily pass into the frontmatter.
 */
export function deriveTiming(entries) {
  let startedAt = '';
  let endedAt = '';
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const stamp = entry?.timestamp;
    if (typeof stamp !== 'string' || !stamp) continue;
    const at = Date.parse(stamp);
    if (!Number.isFinite(at)) continue;
    if (at < earliest) {
      earliest = at;
      startedAt = stamp;
    }
    if (at > latest) {
      latest = at;
      endedAt = stamp;
    }
  }

  const durationMs = startedAt && endedAt ? Math.max(0, latest - earliest) : Number.NaN;
  return { startedAt, endedAt, durationMs };
}

function deriveCommits({ repo, timing, runGit, deadlineAt }) {
  if (!repo.mainRoot || !timing.startedAt) return { shas: [], prs: [] };
  if (Date.now() > deadlineAt - RESERVE_MS) return { shas: [], prs: [] };
  const result = collectCommits({
    repoRoot: repo.mainRoot,
    since: timing.startedAt,
    until: timing.endedAt,
    runGit,
  });
  return { shas: result.shas, prs: result.prs };
}

function sortedFiles(accumulator) {
  return sortedEntries(accumulator.files);
}

/** Most-touched first; ties by path, never by chance. Tolerates an accumulator built before `filesRead` existed. */
function sortedEntries(counts) {
  return [...(counts ?? new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sortedToolCounts(accumulator) {
  return [...accumulator.toolCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function lastBranchSeen(accumulator) {
  const branches = [...accumulator.branches];
  return branches.length ? branches[branches.length - 1] : '';
}
