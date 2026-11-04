# `hooks/` — session capture

One Claude Code or Codex session becomes one markdown note in the Obsidian
vault, so the RAG store can answer questions about work that already happened.

The source of truth is this directory. `~/.claude/hooks/` holds a byte-identical
deployed copy, installed by `node hooks/install.mjs`. Edit here, install, never
the other way round.

Codex points at this checkout directly through `~/.codex/hooks.json`; its
capture uses the shared schema and note writer. It keeps user prompts, final
answers, redacted command labels, touched file paths, and retrieval provenance.
Raw tool output is excluded; RAG result text is read only to extract document
identities and scores, as it is for Claude Code.

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume",
      "hooks": [{
        "type": "command",
        "command": "node C:/Users/you/agentic-harness/hooks/codex-session-start.mjs",
        "timeout": 5
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "node C:/Users/you/agentic-harness/hooks/codex-session-capture.mjs",
        "timeout": 3
      }]
    }]
  }
}
```

`codex-session-start.mjs` gives each new or resumed Codex chat the same start
brief Claude Code gets from `session-start.mjs` (Codex accepts the same output
JSON), and leaves the record that capture turns into a `session-start`
retrieval. Its log is `~/.codex/hooks/session-start.log`.

Trust both hooks through `/hooks` in the CLI or Settings > Hooks in desktop. On
Windows, run `scripts/register-codex-ingest.ps1` once. Codex ends detached
children when a hook exits, so the capture appends note paths to
`~/.harness/codex-ingest-queue.jsonl` and starts the scheduled ingest task.
The task also sweeps main Codex transcripts idle for at least six hours, then
retries pending notes daily at 03:15. Codex subagent rollouts are excluded from
that sweep because their user-role blocks contain inherited parent context.
Logs are in
`~/.codex/hooks/session-capture.log` and `ingest-queue.log`.

On macOS, run `python3 scripts/register-codex-ingest-macos.py --apply` from
the repository root. It installs a user LaunchAgent that drains the queue every
five minutes while logged in, including after login. Each run also snapshots
changed local desktop and terminal Codex transcripts, including open chats.
Snapshots remain active; SessionEnd still records closure. A persistent file
stamp skips unchanged transcripts, and failed indexing remains queued for retry.
This cadence does not require the chat-close hook to fire. Capture only queues notes
on macOS, so indexing does not depend on a detached hook child surviving chat
shutdown. The worker also runs the existing daily recovery sweep of main chats
idle for six hours. It does not synchronize Git realms or prune the database.
Run the installer without `--apply` to inspect the generated configuration.
The Node path is pinned to the installed version; rerun after removing that
Node version or moving the checkout.

```
hooks/
├── session-capture.mjs     the SessionEnd hook: stdin in, one note out
├── session-start.mjs       the SessionStart hook: a short brief in, before the first prompt
├── install.mjs             deploy to ~/.claude/hooks, verified by hash
├── doctor.mjs              what this machine resolved to; --strict exits 1 on a problem
├── migrate-sessions.mjs    one-time: v1 notes -> schema v2, right collection
├── rename-hubs.mjs         one-time: name each hub note after its folder
├── move-to-realm.mjs       one-time: harness history into the harness realm
├── untagged-sessions.mjs   the weekly `unclassified` review list
├── lib/                    one concern per file, no dependencies
└── tests/                  node --test, fixtures and golden notes
```

## What it writes

Two events, one entry point:

| Event | Note | Named |
| --- | --- | --- |
| `SessionEnd` | the session | `<session_id>.md` |
| `SubagentStop` | one worker | `<session_id>--<agent_id>.md` |

**One note per session**, named by the full session id, rewritten on every
`SessionEnd` — and one note per subagent beside it. The double dash cannot occur
inside either half (a session id is a UUID, an agent id is hex), so the pair is
unambiguous and a worker sorts next to the session that spawned it.

Frontmatter is schema v2 (`schema_version: 2`). The field names are frozen: the
retrieval side filters on them, so renaming one is a breaking change. Every
field is present on every note; a field that could not be derived is the **empty
string or an empty list**, never absent and never guessed.

| Group | Fields |
| --- | --- |
| Identity | `id`, `title`, `type`, `schema_version`, `session_id`, `date` |
| Location | `collection`, `collection_source`, `cwd`, `cwds_seen` |
| Time | `started_at`, `ended_at`, `duration_minutes` |
| Lifecycle | `status`, `concluded_at`, `end_reason`, `supersedes`, `resumed_from` |
| Git | `repo`, `branch`, `worktree`, `repos_touched`, `commits`, `prs` |
| Context | `phase`, `tags`, `hook_tags` (the tags the hook raised on its latest render; any other tag in `tags` is a hand tag), `parent_session`, `child_sessions` |
| Worker | `agent` (always `claude-code`), `agent_type` (the subagent's type; empty on a session note) |
| Work | `memory_files`, `plan_file`, `docs_touched`, `artifacts`, `files_modified` |
| Volume | `prompt_count`, `command_count`, `tools_used` |
| Retrieval | `retrievals` (each search the session ran, with its results), `retrieved` (the vault notes those searches returned) |
| Links | `up`, `related` (Obsidian wikilinks, derived afresh on every write) |
| Provenance | `origin` (the transcript's `entrypoint`: `cli`, `claude-desktop`, `sdk-py`, `sdk-cli`, or empty), `captured_by` (`hook`, `sweep`, `skill` or `migration`), `generator` (the writer and its version), `machine` (`HARNESS_MACHINE` from the machine file) |

`id` is `session-<session_id>`, which is the `external_id` ingest keys on. It
never changes, so a note that moves does not strand its row.

`title` is what a person reads, because the filename is a UUID:
`<date> · <collection> · <first six words of the first prompt>` for a session
(`2026-09-24 · agentic-harness · ultracode. You are the orchestrator for`) and
`<date> · <collection> · <agent type> · <first six words of the task>` for a
worker. Notes written before 2026-09-24 keep their old titles. The graph shows
`title` only with the Front Matter Title plugin (`docs/portable.md`).

`up` joins a note to the graph: a session links to its collection's hub,
`[[<realm>/<collection>/<collection>|<collection>]]`, the note named after its
folder; a worker links to its parent session, path-qualified as
`[[<realm>/<collection>/sessions/<parent-uuid>|<parent title>]]`. `related`
links the resume chain.

## The four rules

1. **Never block session exit.** Budget 1,200 ms inside SessionEnd's ~1.5 s.
   Everything optional checks the deadline first; the elapsed time is logged on
   every run. `tests/budget.test.mjs` holds it to that over 18 MB of transcript.
2. **Never fail loudly.** Every path exits 0. Failures go to
   `~/.claude/hooks/session-capture.log` and nowhere else.
3. **Never write a credential.** Only prompts, tool *inputs* and the closing
   assistant message (`## Outcome`) reach the note, all through `lib/redact.mjs`.
   The closing message is the one piece of model-written text: copied verbatim,
   quoted, capped at 2,000 characters, and additionally stripped of any value
   the session showed inside a secret shape elsewhere — a password repeated in
   prose has no shape for a rule to match. What this cannot catch is a secret
   that appeared *only* in tool output and is then repeated in prose; if a
   session did that, edit the note. The two narrow exceptions that read tool
   output — a PR number and an artifact URL — are documented at
   `scanToolResults` and keep one capture group each.
4. **Never write an empty note.** No user prompts means nothing to remember.

## Collection: the repository, not the folder

`bb2dash-wt-sl` is a worktree, not a project. The collection is resolved by a
list of rules kept as data, `ROUTING_RULES` in `lib/collection.mjs`; the first
that places the session wins:

0. a cwd inside one of Claude Code's own folders, `~/.claude/projects/<encoded>/`
   or a scratchpad under `<tmp>/claude/<encoded>/`, is first decoded back to the
   cwd it was made for (`lib/claude-paths.mjs`, guided by the directories on
   disk), and the repository is resolved again from there;
1. `class-folder`: a path segment that names an existing folder under
   `vault/classes/` → `classes/<course id>`, `collection_source: folder`;
2. `harness`: the `emstacho-su/agentic-harness` repo (worktrees included, a
   deleted one by its folder name), `~/.claude` or `~/.harness` →
   `harness/agentic-harness`, only while the vault holds `harness/.realm`;
3. `container`: `~/projects` itself → `projects/misc`;
4. `git`: the git remote of `cwd`, resolved through a worktree to its main
   repository → `projects/<repo slug>`, `collection_source: git`;
5. `folder`: the folder name, preferring an ancestor that already owns a vault
   folder in any area → `collection_source: folder`.

The directory those steps are applied to is the one the **transcript declares**
in its first record, not the stdin `cwd`. The stdin `cwd` is wherever the
session was when it ended — the vault, the home folder, another repository it
`cd`'d into — and filing by it put a session that started in `bb2dash` under
`vault`, away from its own workers. The stdin `cwd` stays on the note as `cwd`
(provenance), `cwds_seen` is unchanged, and the stdin `cwd` decides the
collection only when the transcript carries no `cwd` at all. A resumed session
follows the same rule, so its `-r2` note lands beside the note it continues.
`repo`, `branch` and `commits` come from that same directory, for sessions and
workers alike, so a note can never say `collection_source: git` with `repo: ''`.

Step 2 reads `.git/config` and `.git/HEAD` directly rather than shelling out:
`git` costs 50–150 ms per invocation on Windows and can hang on a network path.
The only subprocess is one bounded `git log` for `commits`, and it is skipped
entirely when the clock is short.

That subprocess goes through `lib/spawn.mjs`, which exists for one reason:
`execFileSync('git', …, { cwd: repoRoot })` resolves the program against the
child's working directory **before `PATH`** on Windows, so a `git.exe` sitting
in a checkout root would run at session exit with output swallowed and the
window hidden. The repository is therefore passed as `git -C <path>` and the
process starts in the user's home directory with
`NoDefaultCurrentDirectoryInExePath` set.

## Merge, never rewrite

Stack edits these notes. The hook therefore reads the note back, merges, and
writes:

- **lists grow** — a tag, commit or PR in the note stays in the note;
- **scalars only improve** — a derived value replaces an empty one, never the
  reverse;
- **`status` ratchets** — `active` → `concluded` → `superseded`, one way.

A note whose frontmatter will not parse is **not written**. Refusing is the only
safe answer to "somebody hand-edited this into a shape I do not understand".
A 0-byte or frontmatter-less file at the target path is different: it is what
Obsidian leaves when someone follows a link before its note exists, so the hook
treats it as absent and writes over it.

### Subagents

A worker launched with the Agent tool does real work but shares its parent's
`session_id` and never fires `SessionEnd`, so its edits used to disappear into
the parent's note as a handful of file paths. `SubagentStop` gives it a note of
its own, with `parent_session` set to the session that spawned it and
`agent_type` recording what kind of worker it was. Branch, tags and redaction
are the session rules applied unchanged.

A worker is filed under its **parent's** collection: the `cwd` the parent
transcript (`<session_id>.jsonl`, beside the `subagents/` folder) declares in
its first records, never the directory the worker happened to be in when it
stopped. The worker's own directory stays on the note as `cwd` / `cwds_seen`.
When the parent transcript cannot be read or names no `cwd`, the worker's own
transcript's first `cwd` decides, and its stdin `cwd` only when that is missing
too. And a note already filed for that worker in any collection is merged into
where it sits, by the hook and by the nightly sweep alike, rather than copied.
On 2026-09-24 eight worker notes existed twice: the hook had filed them by the
folder the worker had `cd`'d into (`vault`, `estac`, another repo), the sweep
beside their parent.

Copies are never deleted, but they are reported. Every capture looks for the
worker's filename in every collection, and each copy it does not merge into is
logged: `duplicate worker note left at <area>/<collection>/sessions/<name>;
merged into <home>`. A stray copy the parser cannot read does not block the
capture: `existing note unreadable at <path>; writing beside the parent`, and a
fresh note is written in the parent's collection. An unreadable note at that
home path is refused, exactly as for a session note. A worker is linked into
the head of its parent's resume chain (`<id>-r2.md` once it exists), never the
superseded base note.

A worker's `up` names its parent by path, not by the bare `[[<uuid>]]`. A worker
usually stops while its parent is still running, and Obsidian creates the target
of a link that is followed before its note exists: a bare link put that file at
the vault root, a path-qualified one puts it in the parent's `sessions/` folder,
where the parent's `SessionEnd` then writes over it.

The link holds whichever order the events arrive in, and both orders really
happen:

- **worker stops first** (the usual case) — the parent's own `SessionEnd`
  back-fills `child_sessions` by reading the `subagents/` directory;
- **worker stops after the parent was captured** — the `SubagentStop` run merges
  the child into the parent note's `child_sessions`.

`child_sessions` holds the **child note ids** (`session-<session_id>--<agent_id>`),
which are the ingest `external_id`s, so a search follows the link straight to the
worker's own note.

A worker is captured when it has a prompt **or** any tool use: some are handed
their task entirely through the parent's `Agent` call, and for those the task
text comes from the `agent-<id>.meta.json` file beside the transcript. A worker
with no transcript on disk is skipped — Claude Code does not persist one for
every agent, and no transcript means no note.

### Resume chains

| What happened | What the hook does |
| --- | --- |
| `SessionEnd` with `reason: resume` | note stays `active` |
| any other reason | note becomes `concluded`, `concluded_at` set |
| a stale `SessionEnd` replayed over a concluded note | **nothing at all** |
| real new activity after the note concluded | a new `<id>-r2.md`, with `resumed_from` and `supersedes`; the earlier note becomes `superseded` |

The chain walks both ways: backwards by following `resumed_from`, forwards by
filtering for the note whose `resumed_from` names this one.

## Tags

`docs/tags.md` is the controlled vocabulary and the only place new terms are
added. At most five hook-applied tags; manual tags are uncapped and never
removed. A session the classifier cannot place gets exactly
`tags: [unclassified]` and shows up in:

```bash
node hooks/untagged-sessions.mjs
```

It reads the vault from `HARNESS_VAULT` (the shell, then the machine file
`~/.harness/machine.env`); `--vault <path>` names another.

## Running it

```bash
cd hooks && npm test          # node --test, no dependencies
npm run goldens               # regenerate the approval fixtures, then read the diff
node install.mjs --dry-run    # what would change in ~/.claude/hooks
node install.mjs              # copy, then verify every file by SHA-256
```

What it deploys is not a hand-kept list: the installer starts from the two
entry points, `session-capture.mjs` and `session-start.mjs`, and follows their
relative imports, so a new `lib/` module a hook imports is deployed with it and
a repo tool no hook imports is not. `tests/install.test.mjs` walks the same
graph on its own and imports both installed entry points from a scratch folder.

The installer also registers the hooks in `~/.claude/settings.json`:
`session-capture.mjs` for `SessionEnd` and `SubagentStop`, `session-start.mjs`
for `SessionStart`. That file is the user's — permissions, model, plugins,
other tools' hooks — so the write is a read-merge-write that touches only those
three events, keeps an existing entry's own `timeout`, `statusMessage` and
`matcher`, leaves another tool's entry for the same event alone, and changes
nothing on a second run. An entry is ours when it runs the same two files,
whatever the slashes or case. It writes through a temporary file and renames,
because a half-written `settings.json` is read by every session.

It registers `~/.claude/hooks/<script>`, never a worktree path:
a worktree gets deleted, and a hook that goes with it takes every future
session's note along. `--target` without a matching `--settings` is refused for
the same reason; `--skip-settings` deploys the files alone.

Environment:

| Variable | Effect |
| --- | --- |
| `HARNESS_VAULT` | vault root; the tests use it to stay out of the real one |
| `HARNESS_SESSION_CAPTURE` | `0`/`off`/`false`/`no` disables the hook |
| `HARNESS_SESSION_CAPTURE_LOG` | log destination |
| `HARNESS_PARENT_SESSION` | records the session that spawned this one |

`HARNESS_PARENT_SESSION` exists because Agent-tool subagents share their
parent's `session_id` and never fire `SessionEnd` of their own. A worker run as
a separate `claude` process is the only kind that gets its own note, and this is
how it says who spawned it. When the transcript itself lives under
`<parent>/subagents/`, `parent_session` is derived from the path instead.

## The SessionStart brief

`session-start.mjs` (R-H4) runs when a session starts or resumes and hands
Claude a short brief on where the project stands, before the first prompt. It
places the session with capture's own rules, so the brief is about the same
realm and collection the session's note will be filed under, and returns as
`additionalContext`, at most ~1,500 tokens (`lib/start-brief.mjs`), the first
of these that exists:

1. the collection's `status.md`, the body below its frontmatter;
2. the `## Outcome` sections of the five newest main sessions of that
   collection (not workers, not superseded notes), newest first;
3. nothing.

It always ends with one line naming the filter to search with:
`mcp__rag__search_context` with `collection: "<collection>"`.

It is registered with matcher `startup|resume`, so `clear`, `compact` and
`fork` get no brief, and a 5 s timeout, which is only Claude Code's backstop:
the hook gives up at 2 s by itself. It fails open. Bad input, any error, and
anything slower than 2 s all give an empty `additionalContext` and exit 0, with
the reason in the log. A session never waits on it and never sees an error
from it.

What it injected is recorded for capture at
`<HARNESS_STATE_DIR, default ~/.harness/state>/session-start/<session_id>.json`
(SC-2). The capture hook turns that file into one `channel: session-start` entry
in the note's `retrievals:` list, so a brief counts like a search the agent chose
to run.

The log is `~/.claude/hooks/session-start.log`. Every run writes a
`debug input-keys:` line (the input's key names, sorted, never a value), then
either `start <session> <realm>/<collection> source=… ids=… tokens=… ms=…` or
`empty: <reason> ms=…`. The text of the brief never reaches the log, because it
quotes vault notes. `node hooks/doctor.mjs` shows how long ago the last line was
written, and whether `SessionStart` is registered for the installed script.

The input field that says why the session started is spelled differently in
different sources (`source`, `startup_reason`), so nothing reads it: the
matcher does the filtering. Its real name is confirmed at L2 from the
`debug input-keys:` line of the first live run.

| Variable | Effect |
| --- | --- |
| `HARNESS_SESSION_START` | `0`/`off`/`false`/`no` disables the hook (it answers empty) |
| `HARNESS_SESSION_START_LOG` | log destination, default `~/.claude/hooks/session-start.log` |
| `HARNESS_STATE_DIR` | where the start record goes, default `~/.harness/state` |
| `HARNESS_VAULT` | vault root the brief is read from, as for capture |

## claude-config: `~/.claude` as a private repo (R-H5)

`~/.claude` is half of the harness (CLAUDE.md, rules, skills) and also holds
live credentials, every prompt ever typed and per-project memory. So it travels
through a private repo, `emstacho-su/claude-config`, built from an allowlist and
nothing else: `CLAUDE.md`, `rules/`, `skills/`, `skill-vault/`, and a generated
`settings.template.json` holding only `hooks` and `permissions`, with the home
folder written as `{{HOME}}`. A denylist (`.credentials.json`, `history.jsonl`,
`projects/`, `settings.json`, `.env*`, `node_modules/`, SSH and TLS keys, logs, …) is
refused on every path segment even inside an allowlisted folder (`daemon*`, the
daemon's state, only at the top of `~/.claude`). The lists and the
planning are `lib/claude-config.mjs`; two CLIs sit on top.

```bash
node hooks/export-config.mjs --list-findings   # every secret-scan finding, with the entry that would accept it
node hooks/export-config.mjs --dry-run         # the file list: new, changed, deleted, refused, skipped
node hooks/export-config.mjs --apply           # mirror into ~/claude-config and commit (never pushes)
node hooks/install.mjs --config --dry-run      # what placing ~/claude-config into ~/.claude would change
node hooks/install.mjs --config --apply        # do it (bootstrap step 7)
```

Both take `--config-repo <dir>` (default `~/claude-config`); the exporter takes
`--source <claudeDir>` and the installer `--target <claudeDir>` (default
`~/.claude`) and `--node <node.exe>`.

**Export.** The clone must already exist; creating the GitHub repo is live
step L2, so a folder that is not the top of a git checkout is refused with the
`gh repo create emstacho-su/claude-config --private` and `git clone` lines to
run once it is approved. The scan runs first, over every file it would copy and
the template it would write, with the capture hook's rules (`lib/redact.mjs`);
any finding the exceptions list does not cover prints `path:line rule` (never
the value) and stops the run with nothing copied. `--apply` then copies new and
changed files (each read back by SHA-256), deletes files inside the clone's
allowlisted folders that the source no longer exports (never anything in
`~/.claude`), writes the template and a `.gitattributes` of `* -text`, and runs
`git add -A` and `git commit`. It refuses first if the clone holds anything at
its top level beyond the allowlist, `.git` and the meta files (`README.md`,
`.gitignore`, `.gitattributes`, `.scan-exceptions.json`), and if the source has
no allowlisted files at all, which would otherwise read as "delete everything".
The push is L2's, by hand.

**Exceptions.** `<clone>/.scan-exceptions.json` is a JSON list of
`{"path", "rule", "line", "sha256"}` (plus an optional `"reason"`), where
`sha256` is of the file's whole content. A finding is excepted only when all
four match, so any edit to the file brings it back for another read.
`--list-findings` prints each finding followed by its would-be entry; Stack
reads them and pastes the ones he accepts. No tool writes this file. The
`.gitattributes` exists for it: without `* -text`, git's line-ending conversion
would change the bytes, and with them the hash, between this machine and the next.

**The pre-commit hook.** `--apply` installs `.git/hooks/pre-commit` in the
clone (idempotent; a pre-commit hook that is not ours is never overwritten, the
run refuses instead, and so does a `core.hooksPath` that points outside the
clone's `.git`). It runs `export-config.mjs --pre-commit`, which reads the
staged tree with one `git cat-file --batch` and refuses the commit on a staged
path outside the allowlist, a denylisted path, a symlink or submodule, or a
secret finding that `.scan-exceptions.json` does not cover. The exceptions are
read from the staged tree too: an exception that is written but not staged
accepts nothing. A rule that throws is itself a finding (`<rule>:error`), and a
UTF-16 file is read as UTF-16 as well as bytes, so neither passes unscanned. A commit made by hand is held to the same rules as an export. The hook
finds node and this checkout by the absolute paths baked in when it was
installed: `process.execPath`, and the MAIN checkout of the repo
`export-config.mjs` ran from (found through `git rev-parse --git-common-dir`; an
export run from a worktree says so and bakes in the main checkout, because a
worktree gets deleted). `HARNESS_REPO` set at export time is baked in instead;
`HARNESS_NODE` and `HARNESS_REPO` override both at commit time. If the script is
not there, the hook refuses the commit: a gate that cannot run must not pass.

**Install.** `install.mjs --config` walks the clone through the same
allowlist and denylist (`planInstall`), scans it again with the same exceptions,
and refuses the whole apply on a finding, a denylisted path in the repo, or a
write that would pass through a link. Files it overwrites are copied first to
`~/.claude/config-backup-<stamp>/`; nothing in `~/.claude` is ever deleted.
The template is rendered for this home and merged into `~/.claude/settings.json`
add-only: a hook entry is added when no entry for that event runs the same
hook (recognised by `hookIdentity` in `lib/settings.mjs`, the one rule the
installer, the merge and doctor share: a node hook by its script, whatever node,
slashes or case; any other command by its whole text), a permissions list gains the rules it lacks, a permissions
setting this machine lacks is added and one it has is kept; every other key is
left alone. A template hook whose node path does not exist here is rewritten to
`--node` (default: the node running the installer). The write is a temporary
file and a rename, with the old file in the backup folder. A second run changes
nothing.

`node hooks/doctor.mjs` has a `claude-config` row: no clone is informational; a
clone whose origin is not `emstacho-su/claude-config` (or has none) is a
problem; otherwise it shows the last commit's age and whether
`.scan-exceptions.json` exists.

## The one-time migration

```bash
node hooks/migrate-sessions.mjs --vault "<a copy of the vault>" --dry-run   # rehearse
node hooks/migrate-sessions.mjs --vault "<the vault>" --backup "<scratch>"  # then run
```

Moves every v1 note to `<session_id>.md` in the collection its `cwd` resolves
to, back-fills `branch` / `commits` / `prs` / `phase` from `git log` and
`gh pr list` over the session's window, and retires the folders in
`COLLECTION_OVERRIDES` once they are empty. A move that would overwrite is
refused. It never runs `ingest`.

Checkouts that no longer exist are handled by an explicit table in
`lib/migrate.mjs` — `bb2dash-retrieval → bb2dash` — because nothing on disk can
resolve them and inferring a project from a folder name is exactly the bug this
stream exists to fix.

## The hub rename

```bash
node hooks/rename-hubs.mjs --dry-run [--vault <dir>]   # list the moves and link rewrites
node hooks/rename-hubs.mjs --apply   [--vault <dir>]
node hooks/rename-hubs.mjs --check   [--vault <dir>]   # 0 broken hub links, or exit 2
```

Names each collection's hub note after its folder, `<collection>/<collection>.md`,
with one `git mv` per realm (a plain rename for a hub the realm does not track
yet), and rewrites every `up:` link that names a hub and nothing else: one
textual edit of that line, never a re-serialised block. `type: index` and the
UUID `id` stay, so ingest sees a metadata update. A second run changes nothing.
`--check` verifies the result: every hub link resolves, or it exits 2; a worker
link whose parent session is not captured yet is only reported as pending,
because that is the ordinary state of a worker note.

Without `--vault` the vault is `HARNESS_VAULT`, from the shell or from
`~/.harness/machine.env`, and every run prints the one it used on its first
line: the old OneDrive folder still exists and holds no hubs, so a run against
it would look exactly like a clean one. Ran live on home-pc 2026-09-27:
19 moves, 348 rewrites, `--check` 0 broken.

## The harness realm move

```bash
node hooks/move-to-realm.mjs --plan-only [--vault <dir>]   # preview, before the realm exists
node hooks/move-to-realm.mjs --dry-run   [--vault <dir>]   # one line per note: from -> to (reason)
node hooks/move-to-realm.mjs --apply     [--vault <dir>]
```

Re-resolves every note in `projects/{agentic-harness,claude,memory,projects,remote}`
with the rules above (a worker follows its parent) and moves it there: written to
the new folder first, removed from the old one after; one sync commits both
realms. Only `collection:`, `up:` and the ` — <collection>` end of `title:` are
edited, line by line (`lib/frontmatter-lines.mjs`); the `id` stays, so ingest
sees a metadata update. Hubs of the emptied collections go to
`~/.claude-archive/<date>-vault-hubs/`. It refuses without `harness/.realm`,
with `harness` missing from `HARNESS_REALMS`, or with a realm lock held, and a
second run finds nothing to move. The runbook is in `docs/portable.md`.

## Tests

`npm test` runs the suite with no dependencies and no network:

| File | What it holds |
| --- | --- |
| `golden.test.mjs` | six fixtures render byte-exact notes; schema field order |
| `resume.test.mjs` | end → stale replay → resume, and the manual tag surviving |
| `redaction.test.mjs` | a credential-seeded fixture, plus each rule |
| `budget.test.mjs` | < 1,200 ms over 18 MB, with the real `git log` |
| `migrate.test.mjs` | the migration, its dry run, and its refusals |
| `tags.test.mjs` | every tag is in `docs/tags.md`, or exactly `unclassified` |
| `hook-process.test.mjs` | the real process: exit 0, a log line, a live enqueue, the W-H2 seam |
| `spawn.test.mjs` | `git` and `gh` never resolve against a directory a repository controls |
| `subagent.test.mjs` | a worker's note, and the parent link in both event orders |
| `settings.test.mjs` | the settings merge keeps every key and hook it does not own; one script per event; the SessionStart status doctor reports |
| `unc.test.mjs` | no path that resolves onto another host is ever touched |
| `install.test.mjs` | the deploy payload is exactly both entry points' transitive imports; SessionStart registered once, end to end in a scratch folder |
| `enqueue-ingest.test.mjs` | the detached `ingest --only` start: argv array, several notes in one spawn, absolute `uv`, kill switch, never throws |
| `claude-config*.test.mjs` | R-H5: allowlist, denylist, secret scan, template; the exceptions match, the mirror plan, the settings merge |
| `export-config.test.mjs` | export into a temp clone: scan first, exceptions by hash, mirror and delete inside the clone only, commit and never push, the pre-commit hook |
| `install-config.test.mjs` | `install.mjs --config`: dry run, backups, never deletes, refusals, settings merge idempotent |

The golden notes are approval tests. When one changes, read the diff: it is a
change to what `ingest` stores and what retrieval can filter on.

---

## Ingest on capture

`SessionEnd` hooks share a ~1.5 s budget, and `session-capture.mjs` keeps
itself inside 1,200 ms of it. A vault ingest loads a 130 MB ONNX model and
opens a TLS connection to Postgres — seconds of work. So the hook does not run
the ingest. It starts one and returns.

```
SessionEnd
  └─ session-capture.mjs writes vault/projects/<c>/sessions/<id>.md
       └─ enqueueIngest()  ~10 ms
            └─ detached: uv --directory <project> run ingest
                          --source obsidian --path <vault>
                          --only <note> [--only <note> …]
                 └─ stdout + stderr -> ~/.claude/hooks/ingest-on-capture.log
```

**Every note the capture touched, in one process.** A capture rarely changes
just one file: a resume rewrites the note it supersedes (`status: superseded`),
and a `SubagentStop` rewrites its parent's `child_sessions`. Both of those are
frontmatter-only edits, which nothing else would ever carry into the store. The
outcome therefore carries `touchedPaths`, and `--only` is repeatable on the
ingest side, so all of them go to one child — each ingest process loads a
130 MB embedding model, and one process per note would pay that per note.

**A note that did not change is not enqueued.** `persist` compares the rendered
text with what is on disk and skips a write that would change nothing, leaving
`touchedPaths` empty; the enqueue then logs `no note changed on disk` and
spawns nothing. This matters because `SubagentStop` fires at *every* stop point
of a multi-turn worker, not once at the end — nine firings for one worker is
normal — and a re-render with nothing new in the transcript is byte-identical.
When the transcript *has* grown, the note really is different and the ingest
really is needed, so it still runs.

Two costs this does not solve, both bounded by the nightly reconcile:

- N workers stopping at once still means N detached ingest processes, each
  loading its own copy of the model. The enqueue batches within one hook
  invocation, not across concurrent ones.
- A capture that runs past its deadline skips the enqueue (rule 1), and if the
  *next* capture then re-renders the same bytes there is nothing new to enqueue,
  so that note waits for the nightly run. The hook has no memory across
  processes, so it cannot know the store never saw it. This is the same fallback
  every other enqueue refusal relies on — a missing `uv`, a missing project, the
  kill switch — and the log says which one happened.

Three properties make that safe to do on session exit:

- **Detached and unreferenced.** `spawn(..., { detached: true })` followed by
  `child.unref()` lets Node exit while the child keeps running. Its output goes
  to a log file rather than a pipe, because an unread pipe buffer would tie the
  parent's lifetime back to the child.
- **An argument array, never a shell string.** The note path is derived from the
  session's working directory and can contain anything. It is passed as one
  element of an `argv` array with `shell: false`, so no quoting rule can turn a
  filename into a command. There is a test that enqueues a note literally named
  ``a b & rm -rf $(x) `y`.md``.
- **`uv` is always an absolute path, and the child is given no `cwd`.** On
  Windows, libuv resolves a command name with no directory separator against the
  child's working directory *before* it looks at `PATH` — so spawning a bare
  `uv` with `cwd` set to the project directory would let a `uv.exe` dropped in
  there win over the real one, and `shell: false` does not help (it stops the
  shell re-parsing arguments, which is a different problem). `resolveUv` returns
  the standalone install, else an explicit `PATH` search, else **null** and a
  `NO_UV` refusal; the project is passed with `uv --directory` instead. There is
  an `isAbsolute` check immediately before the spawn so the invariant cannot be
  lost in a later edit.
- **It cannot throw.** Every path returns a result object and logs the reason.
  A capture hook that raises on session exit is worse than no capture hook.

The enqueue refuses, and says so in `session-capture.log`, when the note is
outside the vault, is not markdown, or when the ingest project directory does
not exist. `ingest --only` re-validates all of it on the other side.

### What it costs

Measured on this machine, calling `enqueueIngest` against the live vault:

| | ms |
| --- | ---: |
| Warm (`uv.exe` already in the OS image cache) | 9 – 16 |
| First spawn after a reboot | ~2,800 |

The warm number is the one that matters and it is comfortably inside the hook's
1,200 ms deadline. The cold number is Windows validating `uv.exe` on
`CreateProcess`, which is charged to the caller — so the first session ended
after a reboot can see a noticeably slower exit. If that ever becomes annoying,
`HARNESS_INGEST_ON_CAPTURE=0` turns the enqueue off and the nightly reconcile
picks the note up instead.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HARNESS_INGEST_ON_CAPTURE` | on | `0`, `false`, `off` or `no` disables the enqueue |
| `HARNESS_INGEST_PROJECT` | `~/agentic-harness/ingest` | The uv project to run `ingest` from |
| `HARNESS_UV_BIN` | `~/.local/bin/uv.exe`, else the first `uv` on `PATH` | The `uv` executable; never a bare name |
| `HARNESS_INGEST_LOG` | `~/.claude/hooks/ingest-on-capture.log` | Where the detached run's output lands |

The default project directory is the **main checkout**, never a worktree:
worktrees are deleted when their branch merges, and a hook pointing into a
deleted one would fail quietly every night.

The child is spawned with `HARNESS_INGEST_ON_CAPTURE=0` in its own environment,
so a hook firing inside the ingest process can never start a second one.

### Where the hook calls it

`session-capture.mjs` imports `enqueueIngest` and calls it once, in `main()`,
immediately after the note is written successfully and before the final
`log(...)` line. The call does not await and cannot throw, and it sits behind
`if (Date.now() < DEADLINE_AT)` like every other optional step — a session
already over budget logs `ingest-enqueue skipped: over budget` and leaves the
note to the nightly reconcile. `hook-process.test.mjs` counts the call sites
rather than merely finding one, so a second call added anywhere fails the test.

### Deploying

`node hooks/install.mjs` copies this library with the rest of the hook tree to
`~/.claude/hooks/lib/`; there is no separate step.

**Reinstall after any schema change.** The sweep runs from the checkout while
the hook runs from the deployed copy, so a new frontmatter field or a
`GENERATOR_VERSION` bump that is not installed leaves two schemas writing the
same vault. `node hooks/install.mjs` is part of landing such a change, and the
installer says `all N verified byte-identical` when the two agree.

### Reading the logs

```bash
tail -20 ~/.claude/hooks/session-capture.log      # the hook: note written, enqueue started
tail -40 ~/.claude/hooks/ingest-on-capture.log    # the detached run: what it embedded
```

`session-capture.log` records one line per session:

```
ingest-enqueue spawn requested for projects/bb2dash/sessions/<id>.md (pid=48120)
```

**"requested", not "started"** — and the wording is the point. All this process
can know is that the spawn was accepted: a child that fails to start reports it
through an asynchronous `error` event, and the hook calls `process.exit(0)`
before the next tick. The one failure it *can* see for itself is a spawn that
comes back without a `pid`, which is how libuv reports a synchronous
`CreateProcess` failure; that is logged as `spawn returned no pid`. Everything
else — including whether the ingest got anywhere — is in the run log. Otherwise
the line names the reason there was no spawn: the kill switch, a missing `uv` or
project, a note outside the vault, the deadline, or `no note changed on disk`.

`ingest-on-capture.log` holds the ingest run's own report — the document count,
the chunks written, and any failure. It rotates once to `.1` past 256 KB.

---

## The nightly transcript sweep

`SessionEnd` fires only for a session that exits cleanly under the user's
settings. The audit on 2026-09-16 found that of 124 sizeable transcripts on this
machine, 13 had a note. The rest were:

| What | Why the hook never ran |
| --- | --- |
| SDK-spawned review workers (`entrypoint: sdk-py` / `sdk-cli`) | started by `/code-review`, `/security-review` and workflow runs; they do not reach the user hook |
| desktop-app sessions from before 2026-09-09 | the hook did not exist yet |
| sessions killed with their terminal | no clean exit, no `SessionEnd` |
| cloud sessions pulled down with `claude --teleport` | the transcript arrives after the fact |

The sweep closes all four at once by feeding every un-noted transcript through
the **same** `capture()` and `captureSubagent()` the hook uses:

```bash
node hooks/sweep-transcripts.mjs --dry-run                 # list the backlog, write nothing
node hooks/sweep-transcripts.mjs --limit 5 --ingest        # first real run, then read the notes
node hooks/sweep-transcripts.mjs                           # the whole backlog
node hooks/sweep-transcripts.mjs --session <id> --ingest   # one teleported session, by hand
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--min-idle-hours` | 6 | a transcript modified more recently is a live session and is left to its own `SessionEnd` |
| `--limit` | none | cap on sessions captured this run; the rest wait for the next night |
| `--session <id>` | | only this id; repeatable |
| `--exclude <text>` | `claude-mem/observer-sessions` | skip a cwd containing this; repeatable, always in addition to the built-in list |
| `--dry-run` | | list candidates, write nothing |
| `--ingest` | | one detached `ingest --only` over every note touched (the nightly run omits it: a full ingest follows) |

Notes written this way carry `captured_by: sweep`; the hook's carry `hook`. Both
carry `origin`, the `entrypoint` the transcript declares, so an SDK worker's
note is distinguishable from a human session. `ingest` uses it: a session whose
`origin` starts with `sdk` stays in the vault and is left out of the search index
(see [../ingest/README.md](../ingest/README.md)). Neither field is ever
inferred: a transcript with no `entrypoint` gets `origin: ''`, and an SDK
worker's `parent_session` stays empty because nothing in its transcript names
one.

Behaviour worth knowing:

- **A swept session is `concluded`.** If it is resumed the next morning, its
  real `SessionEnd` produces a `-r2` note through the ordinary resume chain.
  That is the designed path, not a bug.
- **Worker notes come with the parent.** `<id>/subagents/agent-*.jsonl` beside
  a swept transcript each become a `<id>--<agent>.md` note with
  `parent_session` set, and the parent's `child_sessions` lists them.
- **Nothing throws.** A garbage transcript is a logged skip and the next
  candidate runs. Exit code 1 only if a candidate raised, which the tests hold
  at never.
- **It is not deployed to `~/.claude/hooks`.** It runs from the main checkout,
  like the ingest project, and the nightly script is told where with `-HooksDir`.

`scripts/nightly-ingest.ps1` runs it as step 0, before the conclude sweep and
the full ingest, so a note written tonight is embedded tonight:

```powershell
./scripts/nightly-ingest.ps1 -TranscriptSweep DryRun -SweepMode DryRun   # prove the wiring
./scripts/nightly-ingest.ps1 -TranscriptSweep Skip                       # the old two-step run
```

Its log is `~/.claude/hooks/transcript-sweep.log` (override with
`HARNESS_TRANSCRIPT_SWEEP_LOG`), one line per session and per worker, with the
summary the CLI prints at the end.

---

## Cloud sessions: /checkpoint

A claude.ai/code session runs on Anthropic's machines. No transcript reaches this computer,
the user-level hook never runs there, and there is no export API on this plan. So the one
surface the hook and the sweep cannot reach is covered by a **skill that runs inside the
session**, invoked by Stack only when the session is worth keeping:

```
/checkpoint            file under the repository's project (from the git remote)
/checkpoint ist323     file as classwork for that course
```

Three parts:

| Part | Where | What it does |
| --- | --- | --- |
| `skills/checkpoint/SKILL.md` | committed into each repo as `.claude/skills/checkpoint/` | Claude writes a four-section body (asked for, done, decisions, next), runs the builder, commits `.harness/sessions/<id>.md`, pushes |
| `skills/checkpoint/build-note.mjs` | same | the frontmatter, **from git and the argument only**: repo, branch, commits past `main`, files changed, `captured_by: skill`, `origin: cloud`. Refuses a body missing a heading. Carries its own copy of the serializer; a test pins it to `lib/frontmatter.mjs` |
| `hooks/collect-checkpoints.mjs` | this checkout, nightly step 0b | fetches each tracked repo, reads every `.harness/sessions/*.md` off every branch, validates and redacts, files into the vault |

```bash
node hooks/install-checkpoint.mjs --repo C:/Users/estac/projects/bb2dash   # then commit there
node hooks/collect-checkpoints.mjs --dry-run                                # what would be filed
node hooks/collect-checkpoints.mjs --repo <path> --no-fetch                 # one repo, refs already on disk
```

What the collector accepts is deliberately narrow, because a note is model-written text
that arrived through git: `type: session`, `captured_by: skill`, a `session_id` that passes
the filename allow-list, `id` equal to `session-<session_id>`, a non-empty collection. The
body goes through `lib/redact.mjs` before it is written. A class argument must name a folder
the vault already has; otherwise the note is filed under `misc` and the log says why. A
project from the git remote is created on demand, as the hook does.

Fidelity, stated plainly: the body is Claude's own account, bounded by what is still in its
context. The frontmatter is a record; the body is a recollection. That is why every such
note says `captured_by: skill`, and why its id is `cp-<session id or UUID>`: a session later
pulled down with `claude --teleport` gets a transcript named by the raw id, so the sweep still
writes its fuller note beside this one instead of skipping it as already noted.

The id is `cp-` plus whatever the sandbox exposes (`CLAUDE_CODE_REMOTE_SESSION_ID`, or the
`ccr:session_id` claim of `CLAUDE_CODE_SESSION_ACCESS_TOKEN`), else `cp-` plus a fresh UUID.

**Verified in a real cloud session on 2026-09-17** (bb2dash): `node` is present in the sandbox
and the builder ran; the sandbox exposes the session id (the note came out as
`cp-cse_…`, not a UUID); the push landed on a `claude/<name>` branch the session created; and
the commit author was `noreply@anthropic.com`. The collector filed it as
`projects/bb2dash/sessions/cp-cse_….md` and the store returned it with `origin: cloud`.
One caveat from the same run: the slash menu only lists the skill in a session created after the
skill reached the branch; a session started from an older snapshot does not see it. If `node`
is missing in the sandbox the skill hand-writes the same frontmatter from a template; the
collector validates both identically.

### Twice a day, not just at 03:00

The nightly job collects checkpoints as step 0b, but a session checkpointed at noon should
not wait until tomorrow. `scripts/register-checkpoint-collect.ps1` registers
`AgenticHarness-CheckpointCollect`, which runs `node hooks/collect-checkpoints.mjs --ingest`
at 12:00 and 18:00 (`-Times` to change) and starts a detached ingest for every note it filed.
Register it once, from a prompt that may create scheduled tasks:

```powershell
./scripts/register-checkpoint-collect.ps1                 # 12:00 and 18:00
./scripts/register-checkpoint-collect.ps1 -Times @('09:00','13:00','17:00')
./scripts/register-checkpoint-collect.ps1 -Unregister
```

### The trust boundary, stated

The collector reads notes from **every branch** of the tracked repositories, because a cloud
session pushes to its own branch and nothing merges it first. So whoever can push to
`bb2dash` or `agentic-harness` can put a note in front of the collector. Three things bound
what that can do:

- **Written once, never merged.** The first copy of an id is the note; a later copy is
  refused, and an id that already belongs to a hook- or sweep-written note is refused. Nothing
  from git can change a note the vault already holds.
- **Only the v2 fields, with `status`, `type`, `schema_version` and `captured_by` pinned** by the
  collector, so a note cannot mark another session superseded or smuggle keys.
- **`--author <email>`** (repeatable) restricts collection to commits by that author. Cloud
  sessions commit as `noreply@anthropic.com` (verified 2026-09-17), and a checkpoint run from a
  local terminal commits as the machine's git identity, so the allow-list that covers both is
  `register-checkpoint-collect.ps1 -Authors @('noreply@anthropic.com', '<your git email>')`.
  Note what that does and does not buy: it excludes a collaborator's hand-made commits, but any
  cloud session on the repository commits under the same Anthropic identity.

What a forged note can still do is exist: one more `captured_by: skill` note, redacted, in the
collection it names. That is the accepted residual risk for two repositories with one committer.
