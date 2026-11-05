# The harness on more than one machine

The harness used to assume one machine: a vault in OneDrive, one always-reachable
Supabase project, Windows Task Scheduler. It now runs on any machine that can run
Node, `uv` and git, with its own vault and its own Postgres, and moves notes
between machines by git. This page is the model and the runbooks.

## The model

```
realm  = one git repo of notes (projects, classes, work-vm, …). Unit of sync policy.
vault  = a machine's folder holding the realms it is allowed to have, side by side.
store  = that machine's Postgres: Supabase, or a local pgvector container.
hub    = wherever the realm remotes live: private GitHub repos today, a homelab later.
```

- **Only markdown travels.** Chunks and embeddings are derived; every machine rebuilds
  its own store from the notes it holds (one full `ingest`, minutes on CPU).
- **A realm is marked by a committed `.realm` file** holding its name, at the vault root
  (the whole vault is one realm) or in a top-level folder named after it. Notes outside
  every realm are skipped; a folder not named after its marker is refused.
- **Prune is scoped to realms, and to this machine.** A nightly `--prune` deletes only
  rows of the realms it just walked, and never a row whose note names another machine
  (`machine:`), so two clones of one realm that have not synced yet cannot delete each
  other's sessions. Rows from before realms existed are swept only by `--prune-legacy`,
  on one machine.
- **Machine file.** `~/.harness/machine.env` says what this machine is:

  ```
  HARNESS_MACHINE=home-pc                          # written into every note as machine:
  HARNESS_VAULT=C:/Users/you/vault                 # the folder holding the realms
  HARNESS_REALMS=projects:push,classes:push,harness:push   # realms this machine may hold, and whether each may leave it
  HARNESS_INGEST_PROJECT=C:/Users/you/agentic-harness/ingest
  DATABASE_URL=postgresql://harness:harness@localhost:5433/harness   # this machine's store
  DATABASE_SSL=disable                             # local Postgres only
  HARNESS_GIT_EMAIL=you@example.edu                # author/committer of unattended realm commits
  ```

  The hook, the sweep, the collector, the nightly scripts and `ingest` all read it; the
  shell always wins; the repo `.env` (secrets) wins over it too. `HARNESS_REALMS` is an
  allowlist: a realm on disk that it does not name stops the run.
- **Local store.** A machine without Supabase runs `db/docker-compose.yml`: the image is
  pinned to `pgvector/pgvector:0.8.6-pg17`, not the moving `pg17` tag, so two machines
  (and one machine after a `docker pull`) run the same pgvector. Two settings are there
  for HNSW index builds: `maintenance_work_mem=512MB`, because a build that falls out of
  the 64 MB default is about 4x slower, and `shm_size: 1g`, because a parallel build works
  in shared memory and Docker gives a container only 64 MB of `/dev/shm`. The data sits
  in a named volume, never a bind mount on a Windows drive, which fails Postgres'
  ownership checks. The backup is a dump, not a volume copy, because a volume copy is only
  consistent with the container stopped and a dump restores across Postgres major
  versions: `scripts/backup-store.ps1` (or `.sh`) runs `pg_dump -Fc` through
  `docker exec harness-postgres` into `~\backups\harness-store` by default, writes to a
  `.partial` file, checks it is non-empty and starts with `PGDMP`, then renames it and
  keeps the newest 14 (`-Keep`). `-DryRun` prints the command. It never starts Docker or
  the container; exit 0 is a good dump, 1 a good dump whose pruning failed, 2 no backup.
  `HARNESS_STORE_CONTAINER` and `HARNESS_STORE_DB` override the names, from the shell or
  the machine file. The dump folder must be an ordinary host folder, outside Docker's
  VHDX: a dump inside the disk it backs up is lost with it. Restore, from cmd or bash
  (PowerShell 5.1 has no `<`):

  ```
  docker exec -i harness-postgres pg_restore -U harness -d harness --clean --if-exists < <file>
  ```
- **Nightly:** commit and merge-pull every realm → sweep transcripts → collect
  checkpoints → conclude stale sessions → ingest with realm-scoped prune → commit,
  merge-pull and push the `push` realms. A merge that conflicts is aborted with the local
  commit kept and reported (exit 2). Nothing is ever forced, rebased or stashed; see
  *Sync, lock and schedule*.
- **Redaction** happens at write time on every machine; a `local` realm never leaves
  it; the VM's machine file never carries the Supabase URL.

`node hooks/doctor.mjs` prints what every tier resolved to. Run it before trusting a
new machine to the nightly job.

## Realm repo hygiene

Every realm repo is born with three committed files, written by
`hooks/lib/realm-init.mjs` (`writeRealmFiles(dir, name)`), and the first commit is
preceded by `git add --renormalize .`:

```
.realm            the realm's name; realm-sync keys on it
.gitattributes    * text=auto
                  *.md text eol=lf
.gitignore        .obsidian/workspace.json          (projects only — see below)
                  .obsidian/workspace-mobile.json
                  .obsidian/plugins/*/
                  .trash/
                  .DS_Store
                  Thumbs.db
```

- **Line endings are the repo's policy, not each machine's.** A committed
  `.gitattributes` overrides every contributor's `core.autocrlf`; markdown is LF in the
  index whatever a machine does on checkout. Check: `git ls-files --eol | grep '\.md' |
  grep -v 'i/lf'` prints nothing.
- **Per-device Obsidian state never enters git, and neither do Obsidian's settings.**
  `.obsidian` stays at the vault root, outside every realm, untracked (decided
  2026-09-23). Obsidian opens `C:\Users\estac\vault` as one vault with `projects/`,
  `classes/`, `daily/` and `templates/` side by side, so its settings folder belongs to
  the vault, not to a realm. What travels between machines is the notes in the realms and
  the store each machine rebuilds from them; Obsidian settings play no part in that, and
  each machine keeps its own. The `projects` `.gitignore` keeps the narrower
  `workspace.json` / `plugins/*/` rules above, which are harmless; every other realm
  ignores `.obsidian/` wholesale. Nothing under `.obsidian` is expected inside a realm.
  `workspace.json` changes every session and is the top source of spurious conflicts,
  which is why the rules exist at all. Opening and closing Obsidian must leave
  `git status --porcelain` empty in every realm.
- **Names one platform rejects are refused before they are committed.** Before anything
  is staged, `sync-realms.mjs` (either mode) lists what `git add` would take and
  refuses the realm (exit 2, nothing staged, the path named) if any path contains
  `< > : " | ? *`, a backslash or a control character, has a segment ending in a space
  or a period, is a Windows device name (`CON`, `NUL`, `COM0`-`COM9`, `LPT0`-`LPT9`,
  with or without an extension), is not in Unicode NFC, or differs only by case from
  another path in the realm (one file on Windows and macOS, two on Linux).
  Git for Windows refuses such paths at checkout, which blocks the whole pull on the
  other machine; an NFD name committed from a Mac can only be fixed by removing and
  re-adding. A case-only rename is two steps, because Windows and macOS do not see the
  change: `git mv note.md note.tmp.md && git mv note.tmp.md Note.md`.
- **Attachments have a size ceiling and a home.** A file over 25 MiB is refused the same
  way: GitHub rejects over 100 MB and one such commit blocks every later push until
  history is rewritten. Anything over 5 MiB is reported on a `reported:` line but still
  committed; so is a path over 200 characters, which a default Git for Windows fails to
  check out once the vault prefix is added. Any non-markdown outside
  `<realm>/attachments/` other than the three policy files and `.obsidian/*.json` is not
  staged and is named on a `not staged:` line; move it into `attachments/` if it should
  travel. The rules live in `hooks/lib/realm-guard.mjs`. Deleting a note is an ordinary
  edit: it is staged as a deletion, never refused.

## Sync, lock and schedule

`hooks/sync-realms.mjs --pull` and `--push` run the same sequence per realm; `--pull`
stops before the push:

1. take the realm's lock, `<realm>/.git/harness-sync.lock`;
2. refuse if a merge or rebase is already in progress;
3. `git status --porcelain=v1 -z`, then the guard above over
   `git ls-files … -- <pathspecs>`;
4. `git add --all -- <pathspecs>`, then
   `git commit -m "harness: sync from <machine> <iso>"`;
5. `git pull --no-rebase --ff --no-autostash --no-edit`;
6. push mode and a `push` realm only: `git push origin HEAD:refs/heads/<branch>`.

The pathspecs are exactly `:(glob)**/*.md`, `:(glob).obsidian/*.json`, `attachments/`,
`.realm`, `.gitignore` and `.gitattributes`. Only the ones that match something are
passed, because `git add` exits 128 on a pathspec that matches nothing. Anything else in
the realm (a stray `.env`, a `.pptx` outside `attachments/`) is never staged and is named
on a `not staged:` line; a file someone staged by hand outside that set makes the sync
refuse the realm (exit 2) rather than commit it. A merge that conflicts is
`git merge --abort`ed and reported; the local commit stays, and nothing is forced,
rebased or stashed.

One line per realm, then one line per note:

```
projects: committed -> pulled -> pushed
classes: clean -> pulled -> up-to-date
projects: committed -> conflict (merge with origin/main conflicts in note.md; aborted, local commit kept)
projects: locked (held by sync --push, pid 4242, since 2026-09-23T03:00:05.000Z)
projects: reported: …
projects: not staged: …
projects: lock: taken over from sync --push, pid 4242, since … (31 min old)
projects: identity: git config (set HARNESS_MACHINE and HARNESS_GIT_EMAIL)
```

Exit 2 on a conflict, an error, a refusal or a held lock.

- **One writer per realm.** The lock file holds `{pid, owner, startedAt, token}`. The
  sync holds it for the whole sequence; the checkpoint collector holds it per realm while
  it writes notes there. A held lock makes the sync exit 2 and makes the collector defer
  that realm's notes to its next run (`deferred=N` in its summary, exit 0). A lock older
  than 30 minutes, more than three times the worst-case sync hold, is taken over and
  logged. A realm that is not a git checkout has no lock and is not synced.
- **Schedule.** 03:00 nightly (the sync runs at the start as `--pull` and at the end as
  `--push`); the collector at 12:00 and 18:00. `StartWhenAvailable` catch-up runs can
  land on top of each other, which happened on 2026-09-23; that is why the lock exists.
- **Identity and credentials.** `GIT_AUTHOR_*` and `GIT_COMMITTER_*` come from
  `HARNESS_MACHINE` and `HARNESS_GIT_EMAIL`; if either is unset, git's own config applies
  and the `identity:` note says so. Every git call runs with `GCM_INTERACTIVE=never` and
  `GIT_TERMINAL_PROMPT=0`, so a missing or expired credential is an exit-2 line
  containing the word `credential`, never a prompt nobody sees. An SSH remote gets
  `GIT_SSH_COMMAND=ssh -o BatchMode=yes` unless `GIT_SSH_COMMAND` or `GIT_SSH` is already
  set in the environment (that variable overrides a `core.sshCommand` in git config, so a
  machine that picks its ssh through git config should set it in the environment too).
  The push goes to the branch's configured upstream, not to a branch of the local name.

## Runbook: a second machine (the Windows dev VM)

One command does the middle of this runbook: `scripts/bootstrap.ps1` (Windows PowerShell 5.1)
or `scripts/bootstrap.sh` (Linux, macOS, Git Bash), R-H6. Around it sit the steps it cannot
do for you, each marked **MANUAL** below: installing the tools, the machine file, a realm that
exists on no remote yet, the Obsidian plugin, the scheduled jobs and the push credential.

1. **MANUAL: install per-user** Node 22+, `uv`, git, Claude Code, Docker Desktop, and start
   Docker Desktop. The bootstrap's preflight stops if `git`, `uv`, `node`, `npm` or `docker`
   is not found (`uv` is also looked for in `~/.local/bin`).
2. **MANUAL: clone the repo**, the one clone the bootstrap cannot do for itself:
   `git clone https://github.com/emstacho-su/agentic-harness.git ~/agentic-harness`. The
   bootstrap's own clone step then sees a clone of the right remote and skips it; run from a
   copy elsewhere, it would clone it there. A folder at `~/agentic-harness` that is a clone of
   another remote, or not a clone at all, stops the run rather than being touched.
3. **MANUAL: write `~/.harness/machine.env`** (above): `HARNESS_MACHINE=work-vm`,
   `HARNESS_REALMS=work-vm:push`, `HARNESS_GIT_EMAIL` set to the **work account's** address
   (so unattended realm commits carry this machine's name and the identity that owns the
   remote), `DATABASE_URL` and `DATABASE_SSL=disable` for the local store, and where the
   realms come from: `HARNESS_REALM_REMOTE_BASE=https://github.com/<work-account>` clones
   realm `<r>` from `<base>/vault-<r>.git`; `HARNESS_REALM_REMOTE_<R>` (the name upper-cased,
   `-` as `_`, e.g. `HARNESS_REALM_REMOTE_WORK_VM`) names one realm's URL and wins over the
   base, which is how the home PC lists `work-vm:local` from the work account next to its own
   realms. `HARNESS_VAULT` defaults to `~/vault`. The bootstrap stops at preflight when the
   file is missing.
4. The vault and its realm. The dev VM holds only `work-vm`; there is no `projects` clone on
   it (decision 7: the internship work has no cross-section with the personal projects, so
   nothing personal needs to be there). A realm that exists on its remote is cloned by the
   bootstrap into `~/vault/<realm>` (the clone already carries its `.realm`); one already on
   disk is skipped.
   - **MANUAL: a realm that exists on no remote yet** is made the way Phase C made the home
     ones, before the bootstrap, with the job identity in the shell for that step:
     `mkdir ~/vault/work-vm`, then
     `node hooks/init-realm.mjs --vault C:/Users/<you>/vault --realm work-vm --dry-run`, then
     the same without `--dry-run` (policy files, `git init -b main`, the guard, one baseline
     commit), then `--remote https://github.com/<work-account>/vault-work-vm.git` and
     `git push -u origin main`. A realm with neither a folder nor a remote setting stops the
     bootstrap at its realms step, naming the setting to add.
   - **MANUAL, per machine: Front Matter Title** (R-N3), when you first open `~/vault` in
     Obsidian (Open another vault › Open folder as vault). Settings › Community plugins ›
     Browse, install [Front Matter Title](https://github.com/snezhig/obsidian-front-matter-title)
     and enable it; in its settings turn on the Graph and Explorer features, so both show a
     note's frontmatter `title` rather than its UUID filename. It is manual because
     `.obsidian/` is untracked and each machine keeps its own (see the rules above), so no
     sync or install script carries it.
5. **Run the bootstrap**, dry first:

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File ~/agentic-harness/scripts/bootstrap.ps1 -DryRun
   powershell -NoProfile -ExecutionPolicy Bypass -File ~/agentic-harness/scripts/bootstrap.ps1
   ```

   (`bash ~/agentic-harness/scripts/bootstrap.sh --dry-run`, then without, elsewhere.) The dry
   run prints every step and its exact command and runs nothing; it only looks at whether each
   clone target exists and, for one that does, asks git for its origin. The real run prints
   each command before it runs it and stops at the first failure with
   `bootstrap: step <n> <name> failed (exit <code>)`; fix that and run it again, since every
   step is safe to repeat and a second run on a finished machine skips every clone and ends
   at doctor. The steps:

   | n | step | what it runs |
   |---|---|---|
   | 0 | preflight | the machine file exists; `git`, `uv`, `node`, `npm`, `docker` found |
   | 1 | clone | `git clone -- <agentic-harness> ~/agentic-harness`, skipped when it is already a clone of it |
   | 2 | uv-sync | `uv sync` in `ingest/` |
   | 3 | mcp-build | `npm ci`, then `npm run build`, in `mcp-server/` |
   | 4 | store | `docker compose up -d --wait --wait-timeout 120` in `db/`, then `docker exec harness-postgres pg_isready -U harness -d harness` |
   | 5 | embed-migrate | in `ingest/`: `uv run ingest embed-check`, `uv run ingest db migrate --dry-run`, `uv run ingest db migrate` |
   | 6 | realms | `git clone -- <remote> ~/vault/<realm>` for each realm `HARNESS_REALMS` names that is not on disk |
   | 7 | config | `git clone -- https://github.com/emstacho-su/claude-config.git ~/claude-config` (skipped when present), then `node hooks/install.mjs --config --apply --config-repo ~/claude-config` (R-H5). Pass `-SkipConfig` (`--skip-config` to `bootstrap.sh`) when this machine's account cannot read the private `claude-config` repo, e.g. the work VM until Phase E; the step prints `skipped (--skip-config)` and the run goes on |
   | 8 | install | `node hooks/install.mjs --register-mcp` |
   | 9 | doctor | `node hooks/doctor.mjs --strict`; exit 1 (any row doctor marks as a problem) fails the run |

   The clones in steps 6 and 7 run as you, so git may open its credential prompt; the account
   signed in must be able to read the realm's remote and the private `claude-config` repo.
   `HARNESS_STORE_CONTAINER` and `HARNESS_STORE_DB` rename the container and database in step
   4, as they do for the backup. It ends with one `MANUAL:` line per step of this runbook it
   leaves to you.
6. What the bootstrap's steps rest on, and what to read in their output:
   - The store uses the compose file as committed (the pinned `pgvector/pgvector:0.8.6-pg17`,
     `maintenance_work_mem=512MB`, `shm_size: 1g`; see *Local store* above). Do not change the
     tag to `pg17` locally: the pin is what makes this machine's pgvector the same as the next
     one's. `--wait` holds until the container's healthcheck passes.
   - `uv run ingest embed-check` runs before the first ingest; like every subcommand it reads
     the machine file, so `HARNESS_MACHINE` and `FASTEMBED_CACHE_DIR` come from there. It
     embeds the ten texts in `ingest/eval/embeddings.json` and must exit 0 (every cosine ≥
     0.999 against the references recorded on home-pc); exit 1 names the worst text, exit 2 is
     a file or model mismatch. On anything but 0 the bootstrap stops before the migrate: an
     ingest on this machine would write vectors that do not match the other machine's. It
     needs the model, so on a machine without that egress do step 9 first.
   - **MANUAL: read the Node-side embedder too.** `npm run verify:embedder` in `mcp-server/`
     prints the cosine per reference text and the minimum (a report, not a gate); read its
     minimum, because `search_context` embeds queries on the Node side.
   - `uv run ingest db migrate --dry-run` shows 6 pending on a fresh store; the migrate after
     it applies them, and shows 0 on a second run.
   - `install.mjs --register-mcp` copies the hook, registers it in `settings.json`, and
     registers the `rag` MCP server. The registration carries only the *path* to the repo
     `.env` (`HARNESS_ENV_FILE`); the server reads the secret itself at start.
     `claude mcp get` prints a server's env block in clear text, so a connection string must
     never be put there.
7. **MANUAL: register the nightly job**: `powershell -File scripts/register-nightly-ingest.ps1`
   (reads the machine file). On Linux/macOS: cron or launchd running
   `scripts/nightly-ingest.sh`. For the first night pass `-RealmSync DryRun`, read the
   log, then re-register with `-RealmSync Apply`; the switch is a re-registration, not a
   script edit (step 12 of the home migration below does the same). A Mac that only
   captures and indexes (no nightly ingest of its own) still needs its realms pushed:
   `python3 scripts/register-realm-sync-macos.py --apply` installs a daily 03:30 LaunchAgent
   for `hooks/sync-realms.mjs --push`.

   **On home-pc (containers):** the nightly job and the checkpoint collector run in the
   `harness-jobs` container instead of Task Scheduler, on that machine only. Every other
   machine, the work VM included, keeps the host scheduler above; `nightly-ingest.ps1` and
   the two `register-*.ps1` scripts stay as they are, as the fallback; and the weekly curator
   below stays a host task everywhere.
   - What runs. `compose.yaml` and `docker/jobs/Dockerfile` build one service whose process is
     `node hooks/scheduler.mjs`. It starts `scripts/nightly-ingest.sh` at 03:00 and
     `collect-checkpoints.mjs --ingest` at 12:00 and 18:00, New York time, one job at a time.
     `docker compose exec harness-jobs node hooks/scheduler.mjs --run-now nightly` (or
     `collect`) runs one now; it exits 75 if a job is already running.
   - What does not run there. The container's nightly skips the transcript sweep and the
     session-start state sweep (the image sets `HARNESS_JOBS_CONTAINER=1`; the log says so in
     one line). Sessions run on the host, and a sweep from a container that cannot see their
     working directories would file notes under the wrong collection with their git details
     lost, so the host's SessionEnd hook stays the only capture path. No transcripts folder
     is mounted. With no `HARNESS_CHECKPOINT_REPOS` the checkpoint collection is skipped the
     same way, since the collector's default checkouts do not exist in the container.
   - Catch-up. The scheduler does not wait for a timer to fire at 03:00. Every 30 seconds it
     compares the clock with each job's `last_run_at` in `/state/scheduler.json` (the
     `job-state` volume), so a laptop that slept through a window runs the job once on wake,
     and several missed windows are still one run. `last_run_at` is written before the job
     starts, so a restart mid-run does not run it a second time in the same window.
   - No cron library: node-cron's `missedExecutionTolerance` is how late a tick may fire and still count, not catch-up, so a run missed while the machine slept would be dropped.
   - Settings. The compose file reads paths and names from the environment (an umbrella
     repo's `.env`), never a secret: `VAULT_DIR` (the folder holding the realm checkouts,
     mounted at `/vault`, the only host bind), `SECRETS_DIR`, and `HARNESS_MACHINE`,
     `HARNESS_GIT_EMAIL` and `HARNESS_REALMS` with the values the machine file has, and
     optionally `HARNESS_CHECKPOINT_REPOS` and `HARNESS_CHECKPOINT_AUTHORS` (comma-separated
     checkout paths inside the container, and author emails). The container works in the same checkouts as the
     host, so it writes notes and realm commits under the same machine name.
   - Secrets are two files in `SECRETS_DIR`, mounted under `/run/secrets`:
     `harness_database_url` (the entrypoint exports `DATABASE_URL` from it) and
     `vault_realm_pat`, a fine-grained token with Contents read and write on the realm
     repositories only, which git reads at the moment it pushes. Without the token a push
     fails with the `credential` line, as in step 8.
   - Never both schedulers at once. Before the container's first night, disable the two
     tasks (`Disable-ScheduledTask -TaskName AgenticHarness-NightlyIngest`, and the same for
     `AgenticHarness-CheckpointCollect`); `Enable-ScheduledTask` is the way back. If one does
     fire while the other is running, the realm lock, a file inside the checkout both of them
     see, makes the second stand down (exit 2, `locked`).
   - First start and first night. A container with no state runs the nightly at once, not
     at the next 03:00: it reconciles the realms' notes (`sweep-concluded`) and ingests into
     the store straight away. Until `REALM_SYNC=apply` is set it commits and pushes nothing (the compose
     file's default is `dryrun`, which only prints what the sync would do). Read
     `docker compose logs harness-jobs` the next morning, then set `REALM_SYNC=apply` and
     `docker compose up -d`. `docker compose ps` shows the service healthy while
     `ingest --health` passes: a complete ingest within the last 36 hours.

   Then the store backup (R-D3): `powershell -File scripts/backup-store.ps1 -DryRun` prints
   the `pg_dump` command and writes nothing; run it once live and check a
   `harness-<yyyyMMdd-HHmmss>.dump` appears in `~\backups\harness-store`. Schedule it daily
   after the nightly, e.g. 04:00, as `powershell -NoProfile -File
   <repo>\scripts\backup-store.ps1 -Keep 14` (Task Scheduler; cron or launchd with
   `scripts/backup-store.sh` elsewhere). There is no register script for it, so this is a
   hand-made task. The script never starts Docker or the container, so a night when
   Docker Desktop is not running is an exit 2 with no backup, never a half-written file.
   Then the weekly curator (the memory sprint's Phase C), Sunday 04:30, after the nightly
   and the backup. Stack registers it, typed in Claude Code with the `!` prefix:
   `! powershell -NoProfile -File C:/Users/estac/agentic-harness/scripts/register-weekly-curate.ps1`
   (with `-DryRun` for a first week that calls no judge and writes nothing; going live is
   a re-registration without it). On Linux/macOS, cron or launchd, e.g.
   `30 4 * * 0 /path/to/agentic-harness/scripts/weekly-curate.sh`. The task carries no
   settings: `weekly-curate.ps1|sh` reads these from the machine file at each run, the
   environment winning, and refuses a bad value, named by its key, before any stage runs:
   - `CURATE_MODEL`: the judge model for the stages that call it (extract, ledger,
     history, report).
   - `CURATE_MAX_CALLS`: their judge-call budget per run, a positive integer.
   - `CURATE_MAX_TOKENS`: their token budget per run, a positive integer.
   - `CURATE_GIT`: `apply` (the default) or `skip`, which gives `--no-git` to every stage
     that reads git.
   - `CURATE_STAGES`: the stages to run, space- or comma-separated, from `inventory extract
     ledger status history report retrievals`; default `all`, always in that order.
   It logs to `~/.claude/hooks/weekly-curate.log` (`HARNESS_WEEKLY_LOG`) and writes
   `retrievals-<date>.json` and `retrievals-dashboard.html` to `~/.harness/reports/`
   (`HARNESS_REPORTS_DIR`). Its first run is step L7 of
   `docs/memory-sprint-orchestration.md` and waits for Stack's "go"; until then the task is
   not registered.
8. **MANUAL: the push credential.** The VM and the work laptop use a separate **work GitHub
   account**; `vault-work-vm` is created under it (private), and `emstacho-su` is added as
   a read collaborator so the home PC can pull it (the home PC then lists `work-vm:local`
   in its own machine file). On the VM, create a fine-grained PAT of the work account
   scoped to `vault-work-vm` only (Contents: read and write) with an expiry, and store it
   once with
   `printf 'protocol=https\nhost=github.com\nusername=<work-account>\npassword=<PAT>\n' | git credential approve`.
   A fine-grained PAT reaches only the repositories its own account owns, which is why
   each realm lives under the account of the machine that writes it and why the VM holds
   no personal realm. Put the expiry in the calendar: when it lapses the nightly log shows
   the `credential` line and nothing hangs, because the sync never lets git prompt.
9. The embedding model (130 MB) downloads on first use. On a machine without that
   egress, copy `~/.cache/fastembed` (Python) and `mcp-server/.fastembed-cache` (Node)
   from a machine that has them; the two layouts differ and both are needed.
10. Names to scrub beyond the built-in rules: see `hooks/lib/redact.mjs`; a per-machine
   extra-rules file is on the roadmap, not built yet.

## Runbook: migrating the home vault into realms

The home vault today: `C:\Users\estac\OneDrive - Syracuse University\vault`, holding
`projects/`, `classes/`, `daily/`, `templates/` and `.obsidian/`, no git. Git and OneDrive
on the same folder corrupt each other (`CONTEXT.md`), so the vault leaves OneDrive
entirely: it is copied to `C:\Users\estac\vault`, `projects` and `classes` become realms,
and their new private remotes become the backup. A second copy,
`C:\Users\estac\vault-archive-2026-09-23`, read-only and outside OneDrive, is the 21-day
safety copy. `daily/`, `templates/` and `.obsidian/` come along
in the copy but stay at the vault root, outside every realm, and are not ingested.

Measured 2026-09-23, read-only: 762 files in 66 folders, 8.9 MB, 754 of them `.md`; one
non-markdown file, `classes/ist466/ethics-case/Group 3 IST466.pptx` (4.9 MB); 0 names
the guard would refuse. Every file is hydrated (no OneDrive placeholders, so nothing
copies as zero bytes), and every entry is a cloud-files reparse point, which robocopy
reads as ordinary content. SHA-256 over the whole vault takes about 8 s.
`C:\Users\estac\vault` and `~/.harness` do not exist yet. Obsidian's registered vault is
the OneDrive path. Both scheduled tasks bake the OneDrive path into their actions
(`-VaultPath` for the nightly, `--vault` for the collector), which is why step 9
re-registers them. `emstacho-su/vault-projects` and `emstacho-su/vault-classes` do not
exist; `emstacho-su/vault` (May 2026, an older layout) is private and not archived.

How to run it: every step has a dry run; read its output, then run the live command. Nothing
in steps 0-12 deletes, force-pushes or rebases; the only deletions are the day-21 ones. Nothing under OneDrive is written or deleted by
the runbook: the untick in step 3 is the only OneDrive action, and it is yours. The
archive is kept for 21 days, then removed along with the OneDrive folder online (day 21,
below). Steps marked MANUAL are yours, because nothing in the harness can click through
OneDrive or Obsidian. Commands are PowerShell, run from
`C:\Users\estac\agentic-harness`. Between step 2 and step 7 the hook still resolves the
OneDrive vault, and after step 3 that folder is no longer on this PC, so do not end other
Claude Code sessions in that window.

0. **Rehearse the rollback** (R-C4). Before anything live, make a scratch copy and run
   the *Rollback* section below verbatim against it (the swaps are listed there). This
   also proves `verify-copy.ps1`:

   ```
   robocopy "C:\Users\estac\OneDrive - Syracuse University\vault" C:\tmp\vault-rehearsal /E /COPY:DAT /DCOPY:T /R:2 /W:2 /NP
   powershell -File scripts/verify-copy.ps1 -Source "C:\Users\estac\OneDrive - Syracuse University\vault" -Destination C:\tmp\vault-rehearsal
   ```

   Expect `identical (762 files, <bytes> bytes, SHA256, <s> s)` and exit 0. Then change
   one byte in one copied note, re-run, expect exit 1 and `hash differs: <that note>`, and
   put the byte back. Record the timings in the rollback table. Everything this step
   writes is under `C:\tmp`, apart from the two throwaway rehearsal tasks it removes again.

1. **Stop the writers.** Close Obsidian.
   - Dry run: `Get-ScheduledTask -TaskName AgenticHarness-* | Select-Object TaskName, State`
     shows both tasks `Ready`.
   - Live:

     ```
     Disable-ScheduledTask -TaskName AgenticHarness-NightlyIngest
     Disable-ScheduledTask -TaskName AgenticHarness-CheckpointCollect
     ```

     The same `Get-ScheduledTask` now shows both `Disabled`.

2. **Copy, never move** (R-C1). A copy leaves the original untouched, so a bad copy costs
   nothing but a retry.
   - Dry run, `/L` lists without copying; its summary shows 762 files:

     ```
     robocopy "C:\Users\estac\OneDrive - Syracuse University\vault" C:\Users\estac\vault /E /COPY:DAT /DCOPY:T /R:2 /W:2 /NP /L
     ```

   - Live:

     ```
     robocopy "C:\Users\estac\OneDrive - Syracuse University\vault" C:\Users\estac\vault /E /COPY:DAT /DCOPY:T /R:2 /W:2 /NP
     ```

     Robocopy's exit code is a bit mask: 1 means files were copied, 8 or more means a
     failure. Check the summary's `Failed` column is 0.

3. **Verify, archive outside OneDrive, then take the vault out of OneDrive** (R-C1).
   Unticking a folder in OneDrive removes it from this PC and keeps it online
   ([Microsoft](https://support.microsoft.com/en-us/onedrive/choose-which-onedrive-folders-you-want-to-sync-on-windows-or-macos)),
   so the 21-day safety copy cannot be the OneDrive folder. It is a local archive, made
   and verified before the untick.
   - **(a) Verify the working copy** (read-only):

     ```
     powershell -File scripts/verify-copy.ps1 -Source "C:\Users\estac\OneDrive - Syracuse University\vault" -Destination C:\Users\estac\vault
     ```

     It must print `identical (762 files, <bytes> bytes, SHA256, <s> s)` and exit 0. Exit 1
     prints the first mismatch (`missing in destination:`, `hash differs:`,
     `extra in destination:`); exit 2 is a bad argument. On anything but `identical`,
     stop: delete nothing, find out why, and repeat step 2 into a fresh folder.
   - **(b) The read-only archive**, a second copy from the same source, outside OneDrive.
     Dry run (`/L`, 762 files), then live:

     ```
     robocopy "C:\Users\estac\OneDrive - Syracuse University\vault" C:\Users\estac\vault-archive-2026-09-23 /E /COPY:DAT /DCOPY:T /R:2 /W:2 /NP /L
     robocopy "C:\Users\estac\OneDrive - Syracuse University\vault" C:\Users\estac\vault-archive-2026-09-23 /E /COPY:DAT /DCOPY:T /R:2 /W:2 /NP
     powershell -File scripts/verify-copy.ps1 -Source "C:\Users\estac\OneDrive - Syracuse University\vault" -Destination C:\Users\estac\vault-archive-2026-09-23
     attrib +R "C:\Users\estac\vault-archive-2026-09-23\*" /S /D
     ```

     `verify-copy.ps1` must print `identical (762 files, …)` again. Check:
     `attrib "C:\Users\estac\vault-archive-2026-09-23\projects\*"` shows `R` on every line.
   - **(c) MANUAL:** OneDrive › Settings › Account › Choose folders, untick `vault`. This
     removes the local OneDrive copy and keeps the cloud copy; that is intended. Do not
     delete the folder anywhere else: the cloud copy goes only on day 21.
   - **(d) Check** that the local OneDrive copy is gone:
     `Test-Path "C:\Users\estac\OneDrive - Syracuse University\vault"` is `False`, or `True`
     for an empty folder stub only (`Get-ChildItem` on it with `-Recurse -File` lists
     nothing).

4. **Move the `.pptx` into `attachments/`** (in the copy only). The sync never stages
   non-markdown outside `<realm>/attachments/`, so left where it is the deck would show
   as `not staged:` every night and never reach the remote.
   - Dry run: the only non-markdown outside `.obsidian`, and any note that links to it:

     ```
     Get-ChildItem C:\Users\estac\vault -Recurse -File | Where-Object { $_.Extension -ne '.md' -and $_.FullName -notmatch '\\\.obsidian\\' } | Select-Object FullName
     Get-ChildItem C:\Users\estac\vault\classes -Recurse -Filter *.md | Select-String 'Group 3 IST466'
     ```

     The first lists exactly `classes\ist466\ethics-case\Group 3 IST466.pptx`; a hit in
     the second is a link to check by hand after the move.
   - Live:

     ```
     New-Item -ItemType Directory -Force C:\Users\estac\vault\classes\attachments\ist466 | Out-Null
     Move-Item "C:\Users\estac\vault\classes\ist466\ethics-case\Group 3 IST466.pptx" C:\Users\estac\vault\classes\attachments\ist466\
     ```

     From here `verify-copy.ps1 -Source C:\Users\estac\vault-archive-2026-09-23
     -Destination C:\Users\estac\vault` reports this one file as moved
     (`missing in destination:`); that is expected and is why step 3 runs first.

5. **Initialise the two realms** (R-C2). `init-realm.mjs` writes the three policy files,
   runs `git init -b main`, runs the guard, stages the live pathspecs, runs
   `git add --renormalize .` and makes one baseline commit. It never pushes, and it exits
   2 on a refusal or when the realm already has a commit. The machine file does not exist
   until step 7, so the job identity comes from the shell for this step; `$env:` lasts
   only for this PowerShell window.
   - Dry run:

     ```
     $env:HARNESS_MACHINE = 'home-pc'; $env:HARNESS_GIT_EMAIL = 'emstacho@syr.edu'
     node hooks/init-realm.mjs --vault C:/Users/estac/vault --realm projects --dry-run
     node hooks/init-realm.mjs --vault C:/Users/estac/vault --realm classes --dry-run
     ```

     Each lists the three policy files it would write, the staged path count with a
     sample, any `not staged:` lines (expect none after step 4), the guard's notes and the
     commit it would make. It writes nothing.
   - Live: the same two commands without `--dry-run`. Then, in each of
     `C:/Users/estac/vault/projects` and `C:/Users/estac/vault/classes`:

     ```
     git -C C:/Users/estac/vault/projects log --oneline
     git -C C:/Users/estac/vault/projects fsck
     git -C C:/Users/estac/vault/projects ls-files --eol | Select-String '\.md' | Select-String -NotMatch 'i/lf'
     git -C C:/Users/estac/vault/projects diff --stat HEAD
     ```

     One commit; `fsck` clean; the `--eol` line prints nothing (every note LF in the
     index); `diff --stat HEAD` is empty (the commit's tree equals the copy).

6. **Create the remotes, push, archive the old repo.** Each command is its own go.
   - Dry run: `gh repo view emstacho-su/vault-projects` and
     `gh repo view emstacho-su/vault-classes` both fail (absent);
     `gh repo view emstacho-su/vault --json visibility,isArchived` shows `PRIVATE`, `false`.
   - Live:

     ```
     gh repo create emstacho-su/vault-projects --private
     gh repo create emstacho-su/vault-classes --private
     git -C C:/Users/estac/vault/projects remote add origin https://github.com/emstacho-su/vault-projects.git
     git -C C:/Users/estac/vault/classes remote add origin https://github.com/emstacho-su/vault-classes.git
     git -C C:/Users/estac/vault/projects push -u origin main
     git -C C:/Users/estac/vault/classes push -u origin main
     gh repo archive emstacho-su/vault --yes
     ```

     (`init-realm.mjs --remote <url>` in step 5 does the `remote add` instead, if
     preferred.) The first push may prompt Git Credential Manager once. That is fine here,
     in an interactive shell; it must never happen in the job, which runs git with
     `GCM_INTERACTIVE=never` and fails closed instead.
   - Check: `gh repo view emstacho-su/vault-projects --json visibility` and the same for
     `vault-classes` show `PRIVATE`; `gh repo view emstacho-su/vault --json isArchived`
     shows `true`. The old repo is archived rather than reused because reusing it would
     mix two histories and two layouts under one name.

7. **Write the machine file** (R-C3). From here every tier resolves the new vault.
   The text, verbatim:

   ```
   HARNESS_MACHINE=home-pc
   HARNESS_VAULT=C:/Users/estac/vault
   HARNESS_REALMS=projects:push,classes:push
   HARNESS_GIT_EMAIL=emstacho@syr.edu
   HARNESS_INGEST_PROJECT=C:/Users/estac/agentic-harness/ingest
   ```

   `DATABASE_URL` stays in the repo `.env`: this machine's store is Supabase, the secret
   already lives there, and the machine file carries no secret.
   - Dry run, print what will be written:

     ```
     $lines = @(
       'HARNESS_MACHINE=home-pc',
       'HARNESS_VAULT=C:/Users/estac/vault',
       'HARNESS_REALMS=projects:push,classes:push',
       'HARNESS_GIT_EMAIL=emstacho@syr.edu',
       'HARNESS_INGEST_PROJECT=C:/Users/estac/agentic-harness/ingest'
     )
     $lines
     ```

   - Live (ASCII, so no byte-order mark lands in front of the first key):

     ```
     New-Item -ItemType Directory -Force "$HOME\.harness" | Out-Null
     Set-Content -Path "$HOME\.harness\machine.env" -Value $lines -Encoding ascii
     ```

8. **Check every tier, refresh the hook.**
   - `node hooks/doctor.mjs`: the vault is `C:/Users/estac/vault`; both realms on disk
     and listed, `realms unlisted` none, `realms missing` none; `git email` set; a
     `realm projects` and a `realm classes` row each showing a git checkout with its
     `github.com/emstacho-su/vault-…` origin, one commit and no lock.
   - `node hooks/install.mjs --dry-run`, read it, then `node hooks/install.mjs` (the
     installed hook copy is refreshed).
   - `claude mcp get rag`: look for `Connected` and nothing else. Never paste its output
     anywhere: it prints the server's env block in clear text.

9. **Re-register both tasks.** They captured the OneDrive path when they were
   registered; registering again reads the machine file.
   - Dry run: `(Get-ScheduledTask -TaskName AgenticHarness-NightlyIngest).Actions | Select-Object Execute, Arguments`
     and the same for `AgenticHarness-CheckpointCollect` show the OneDrive path.
   - Live:

     ```
     powershell -File scripts/register-nightly-ingest.ps1 -RealmSync DryRun
     & .\scripts\register-checkpoint-collect.ps1 -Authors @('noreply@anthropic.com', 'emstacho@syr.edu')
     ```

     The collector is registered from a PowerShell session, not through `powershell
     -File`: `-File` cannot pass an array, so `-Authors a,b` would arrive as one
     comma-joined string and the allow-list would match nobody (found at the cutover on
     2026-09-23). The same `Get-ScheduledTask` now shows `C:/Users/estac/vault` in both
     actions, two `--author` flags on the collector, `-RealmSync DryRun` on the nightly
     one, and both tasks `Ready` again (a registration replaces the disabled task).

10. **MANUAL: open the new vault in Obsidian.** Open another vault › Open folder as vault ›
    `C:\Users\estac\vault`. Open a note with a known wikilink and follow it; open the
    graph view.

    - **MANUAL, per machine: Front Matter Title** (R-N3). Settings › Community plugins ›
      Browse, install [Front Matter Title](https://github.com/snezhig/obsidian-front-matter-title)
      and enable it; in its settings turn on the Graph and Explorer features, so both show a
      note's frontmatter `title` rather than its UUID filename. It is manual because
      `.obsidian/` is untracked and each machine keeps its own (see the rules above); the
      plugin writes only under `.obsidian/` at the vault root, outside every realm, so the
      check below still holds.

    Close Obsidian, then (R-A2, live):

    ```
    git -C C:/Users/estac/vault/projects status --porcelain
    git -C C:/Users/estac/vault/classes status --porcelain
    ```

    Both print nothing.

11. **End to end.** End a Claude Code session in a repo. Within a minute its note lands
    under `C:\Users\estac\vault\projects\<collection>\sessions\`:

    ```
    Get-ChildItem C:\Users\estac\vault\projects -Recurse -Filter *.md | Sort-Object LastWriteTime -Descending | Select-Object -First 1 FullName, LastWriteTime
    node hooks/sync-realms.mjs --push --dry-run
    ```

    The sync dry run shows `would-commit -> would-pull -> would-push` for `projects` (it
    holds the new note) and changes nothing.

12. **Exit from Phase C.** The first night runs with `-RealmSync DryRun`; read
    `~/.claude/hooks/nightly-ingest.log` the next morning. If it reads clean, re-register
    with the sync live:

    ```
    powershell -File scripts/register-nightly-ingest.ps1 -RealmSync Apply
    ```

    Then the checks Phase B deferred (decision 4 in `vault-migration-requirements.md`) run
    here, before Phase D: three consecutive nights with one
    `committed -> pulled -> pushed` (or `up-to-date`) line per realm in the log (R-B1), and the
    credential-less push test (R-B4: remove the stored credential, run
    `node hooks/sync-realms.mjs --push`, see exit 2 with a `credential` line within 30 s,
    restore it, see a push). The full re-ingest and the one-time `--prune-legacy` are
    Phase D (R-D1), not this runbook.

    The weekly curator task (the memory sprint's Phase C, not this runbook's) is registered
    once the nightly is live, typed by Stack in Claude Code with the `!` prefix:

    ```
    ! powershell -NoProfile -File C:/Users/estac/agentic-harness/scripts/register-weekly-curate.ps1
    ```

    It runs `scripts/weekly-curate.ps1` on Sundays at 04:30, after the nightly and the
    backup, and logs to `C:/Users/estac/.claude/hooks/weekly-curate.log`. Its settings are
    read from `C:/Users/estac/.harness/machine.env` at each run, so changing one needs no
    re-registration:

    - `CURATE_MODEL`: the judge model for the stages that call it (extract, ledger,
      history, report).
    - `CURATE_MAX_CALLS`: their judge-call budget per run, a positive integer.
    - `CURATE_MAX_TOKENS`: their token budget per run, a positive integer.
    - `CURATE_GIT`: `apply` (the default) or `skip`, which gives `--no-git` to every stage
      that reads git.
    - `CURATE_STAGES`: the stages to run, space- or comma-separated, from `inventory extract
      ledger status history report retrievals`; default `all`, always in that order.

    Its first run is step L7 of `docs/memory-sprint-orchestration.md` and waits for Stack's
    "go".

**Day 21 (R-F2).** 21 days after the R-F1 smoke test, if no rollback was needed, both old
copies go, so the vault exists only in `C:\Users\estac\vault` and the realm remotes:

- MANUAL: delete the vault folder from OneDrive online (web: Files › vault › Delete), then
  delete it again from the Recycle bin, which otherwise keeps it.
- Delete the local archive. Dry run: `Test-Path C:\Users\estac\vault-archive-2026-09-23`
  is `True` and the last nightly log shows `pushed` for both realms. Live:

  ```
  attrib -R "C:\Users\estac\vault-archive-2026-09-23\*" /S /D
  Remove-Item -Recurse -Force C:\Users\estac\vault-archive-2026-09-23
  ```

- Record the date in R-F2 and mark the *Rollback* section below expired: it re-points at
  the archive, which no longer exists.

**Phase D record (R-D1, 2026-09-24, nightly disabled for the run).** Full ingest: 470 loaded,
468 `metadata-updated`, 2 unchanged, 0 re-embedded; the one real `--prune-legacy` found
nothing stale (1 new session note inserted). Now 0 obsidian rows without a realm, 472
documents (`projects` 464, `classes` 8), 1,838 obsidian chunks, claude-mem 1,037 untouched; eval
hit@3 0.95, MRR 0.775, 5/5 before and after, `returned` identical. Details in R-D1.

## Runbook: adding the `harness` realm (R-H1 to R-H3, live step L3)

The harness's own history gets a third realm, `harness/<collection>/`, beside `projects` and
`classes` (spec `docs/memory-sprint-requirements.md`, R-H1). It needs no new mechanism: the hook,
sweep, ingest and doctor treat it as they treat the other two. Run it only after the three
`committed -> pulled -> pushed` (or `up-to-date`) nights and Stack's "go L3", never between 02:45 and 04:30.

1. Stack edits `~/.harness/machine.env` **first**:
   `HARNESS_REALMS=projects:push,classes:push,harness:push`. A realm listed but not yet on
   disk is harmless (sync skips it, doctor lists it under `realms missing`). The reverse order is
   not: a `harness/.realm` on disk that the list does not name makes ingest refuse the whole
   vault, `projects` and `classes` included, until the list is fixed.
2. Remote and baseline. `gh repo view emstacho-su/vault-harness` fails (absent) first. The
   realm starts empty: its baseline is the three policy files. No hub is seeded, because
   `projects/agentic-harness/agentic-harness.md` is still the collection's hub until R-H3 moves
   the history, and two hubs with one name make `[[agentic-harness]]` ambiguous.

   ```
   gh repo create emstacho-su/vault-harness --private
   mkdir C:/Users/estac/vault/harness
   node hooks/init-realm.mjs --vault C:/Users/estac/vault --realm harness --remote https://github.com/emstacho-su/vault-harness.git --dry-run
   node hooks/init-realm.mjs --vault C:/Users/estac/vault --realm harness --remote https://github.com/emstacho-su/vault-harness.git
   git -C C:/Users/estac/vault/harness push -u origin main
   ```

   The push by hand is the one the sync asks for on a realm's first push ("no upstream"); it
   may prompt Git Credential Manager once, which the job never may.
3. Check: `node hooks/sync-realms.mjs --push --vault C:/Users/estac/vault --dry-run` has a
   `harness:` line; `node hooks/doctor.mjs` has a `realm harness` row with its origin.
4. Eval before: `uv run ingest eval` (from `ingest/`), scores into the spec's R-H3 record.
5. Move the history (R-H3). Stack reads every line of the dry run:

   ```
   node hooks/move-to-realm.mjs --dry-run --vault C:/Users/estac/vault
   node hooks/move-to-realm.mjs --apply --vault C:/Users/estac/vault
   ```

   One line per note: `move <from> -> <to> (<reason>)`, where the reason is the routing rule
   and the cwd it read, or `parent <id> -> <collection>` for a worker. The preview of
   2026-09-27 (`--plan-only`, before the realm existed): 322 moves (250 to
   `harness/agentic-harness`, 71 bb2dash workers and memory sessions to `projects/bb2dash`,
   1 to `projects/misc`), 4 hubs to `~/.claude-archive/<date>-vault-hubs/`, 0 conflicts.
   It refuses without `harness/.realm`, with `harness` unlisted, or with a realm lock held,
   and exits 2 on any conflict. A second `--dry-run` must print `moves: 0`.
6. **Reinstall the hook straight after**, so new harness sessions go to the realm and do not
   recreate `projects/agentic-harness`: `node hooks/install.mjs --dry-run`, then
   `node hooks/install.mjs`. The routing takes effect only where `harness/.realm` exists, so the
   order of 5 and 6 matters only for the minutes between them.
7. `node hooks/sync-realms.mjs --push --vault C:/Users/estac/vault` commits the deletions in
   `projects` and the additions in `harness` (one sync, both realms), then
   `uv run ingest --source obsidian --path C:/Users/estac/vault --prune`: the moved notes are
   `metadata-updated` only, 0 deleted.
8. Eval after, unchanged; `node hooks/rename-hubs.mjs --check` reports 0 broken hub links.

Done when `projects/{agentic-harness,claude,memory,projects,remote}` are gone, doctor shows the
`realm harness` row, and the next nightly log has `harness: … -> pushed`.

## Rollback

Use it when anything in steps 7-12 misbehaves while the local archive still exists (until
day 21, R-F2): notes land somewhere unexpected, doctor will not come clean, a nightly run
fails in a way that is not a one-line fix, or Obsidian will not work from the new folder.
A problem in steps 1-2 needs only `Enable-ScheduledTask` on both tasks: the OneDrive
folder is still on this PC and nothing points anywhere else. Once step 3 has unticked the
folder, the OneDrive path no longer exists locally, so from then on use the whole section
even though step 7 has not run yet. `C:\Users\estac\vault` stays where it is either way.

The rollback re-points every tier at the read-only local archive
`C:\Users\estac\vault-archive-2026-09-23` by editing the machine file. It does not remove
the file: with no machine file every tier falls back to the OneDrive path, which is no
longer on this PC. The archive has no `.realm` files, so it is the legacy layout the
harness ran on before Phase C. From (c) on it is the live vault, not a safety copy; the
migrated state stays in `C:\Users\estac\vault` and the realm remotes. Nothing is deleted.

a. Stop the writers:

   ```
   Disable-ScheduledTask -TaskName AgenticHarness-NightlyIngest
   Disable-ScheduledTask -TaskName AgenticHarness-CheckpointCollect
   ```

b. Point the machine file at the archive, with no `HARNESS_REALMS`. The current file is
   kept as `machine.env.migrated` for a later retry (skip the `Copy-Item` if step 7 has
   not run and there is no file yet):

   ```
   Copy-Item "$HOME\.harness\machine.env" "$HOME\.harness\machine.env.migrated"
   $lines = @(
     'HARNESS_MACHINE=home-pc',
     'HARNESS_VAULT=C:/Users/estac/vault-archive-2026-09-23',
     'HARNESS_GIT_EMAIL=emstacho@syr.edu',
     'HARNESS_INGEST_PROJECT=C:/Users/estac/agentic-harness/ingest'
   )
   New-Item -ItemType Directory -Force "$HOME\.harness" | Out-Null
   Set-Content -Path "$HOME\.harness\machine.env" -Value $lines -Encoding ascii
   ```

   The hook resolves the vault on every run, so it follows without a reinstall. Run (c)
   straight after, so a session that ends in between does not meet a read-only folder.

c. Make the archive writable:

   ```
   attrib -R "C:\Users\estac\vault-archive-2026-09-23\*" /S /D
   ```

d. Re-register both tasks with the archive path, so their actions stop naming
   `C:\Users\estac\vault`:

   ```
   powershell -File scripts/register-nightly-ingest.ps1 -VaultPath C:/Users/estac/vault-archive-2026-09-23
   powershell -File scripts/register-checkpoint-collect.ps1 -VaultPath C:/Users/estac/vault-archive-2026-09-23
   ```

   (the collector's script passes it on to the node collector as `--vault`). Whatever
   `-RealmSync` is, the archive has no realms, so the sync prints `nothing to sync` and
   exits 0. Check:
   `(Get-ScheduledTask -TaskName AgenticHarness-NightlyIngest).Actions.Arguments` and the
   same for `AgenticHarness-CheckpointCollect` contain `vault-archive-2026-09-23`, and
   both tasks are `Ready`.

e. MANUAL: open `C:\Users\estac\vault-archive-2026-09-23` in Obsidian (Open another vault ›
   Open folder as vault).

f. `node hooks/doctor.mjs` shows the archive as the vault and `realms on disk` as
   `(none: legacy layout)`.

g. What is not rolled back, on purpose:
   - The two GitHub realm repos. Private and harmless; leave them. A second attempt
     decides whether to reuse or recreate them.
   - `C:\Users\estac\vault` itself. Leave it; it is the only copy of anything written
     there after cutover.
   - Notes written into `C:\Users\estac\vault` after cutover. Copy them back by hand,
     after (c), list first:

     ```
     robocopy C:\Users\estac\vault C:\Users\estac\vault-archive-2026-09-23 /E /XO /XD .git attachments /XF .realm .gitattributes .gitignore /COPY:DAT /DCOPY:T /R:2 /W:2 /NP /L
     ```

     then the same without `/L`. `/XO` copies only files newer than the archive's, and
     without `/MIR` or `/PURGE` nothing in the archive is deleted. `attachments` is
     excluded so the moved `.pptx` does not appear twice; copy any attachment added after
     cutover by hand.
   - OneDrive. The folder stays unticked; the rollback never touches OneDrive.
   - The archived old repo. If it is wanted back: `gh repo unarchive emstacho-su/vault --yes`.

### Rehearsal

The rehearsal (runbook step 0) runs this section verbatim, before cutover, with these swaps
so the live machine is not touched:

- the archive -> `C:\tmp\vault-rehearsal`, frozen first with
  `attrib +R "C:\tmp\vault-rehearsal\*" /S /D` so (c) has something to undo;
- the machine file -> set `$env:HARNESS_MACHINE_ENV = 'C:\tmp\rehearsal-machine.env'` in
  the rehearsal window (every tier honours it), write that file as in step 7, and point
  (b)'s `Copy-Item` and `Set-Content` at it instead of `$HOME\.harness\machine.env`;
- the tasks -> register throwaway copies first with
  `-TaskName AgenticHarness-Rehearsal-Nightly` / `-TaskName AgenticHarness-Rehearsal-Collect`,
  re-register them in (d) with `-VaultPath C:/tmp/vault-rehearsal`, and `-Unregister`
  both at the end;
- the new vault in (g)'s copy-back -> a second scratch copy `C:\tmp\vault-rehearsal-new`
  with one note edited, so the `/L` listing has something to show;
- (e) opens `C:\tmp\vault-rehearsal` in Obsidian, then switch back.

Run it inside `Start-Transcript -Path ~/.claude/hooks/rollback-rehearsal.log` and time each
step (`Measure-Command { … }`, or the transcript's timestamps).

| Step | What | Time |
| --- | --- | --- |
| a | disable both tasks | 0.6 s |
| b | point the machine file at the archive | under 0.1 s |
| c | `attrib -R` on the archive | 0.2 s |
| d | re-register both tasks with the archive path | 3.7 s |
| e | open the archive in Obsidian (MANUAL) | not rehearsed: needs a person |
| f | `doctor.mjs` | 0.1 s |
| g | copy back post-cutover notes (list, then copy) | 0.1 s |
| | **total, a-g** | 4.7 s (whole rehearsal incl. copy and verify: 20.5 s) |

Rehearsal log: `~/.claude/hooks/rollback-rehearsal.log` (rehearsed 2026-09-23 23:14 local, by
Claude Code for Stack, against a 769-file copy; `verify-copy.ps1` printed `identical` in
5.3 s, reported one altered byte as `hash differs: projects/agentic-harness/index.md`, and
`identical` again after the restore).

## Homelab, later

Host bare realm repos and a pgvector Postgres on the MacBook. On each machine, point the
realm remotes at it (`git remote set-url origin …`) and `DATABASE_URL` in the machine
file. Nothing in the code changes.

## Out of scope, on purpose

A second search implementation (SQLite): the same `rag.search` runs on every Postgres.
Syncing embeddings: cheaper to rebuild than to move. A dev-container image: the VM
replaces that need.
