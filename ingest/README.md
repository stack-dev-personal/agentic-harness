# `ingest` — RAG ingestion pipeline

Turns an Obsidian vault and the migrated claude-mem history into rows in
`rag.documents` and `rag.chunks` on the `harness-memory` Supabase Postgres
(project ref `hqkytnyiiuxovnnyixye` — **not** `bb2dash`, which holds a different corpus
embedded with a different model).

Two loaders, one pipeline:

```
loader ──▶ SourceDocument ──▶ sha256 hash ──▶ body unchanged? ──yes──▶ anything else changed?
                                                  │no                      │yes            │no
                                                  │                        ▼               ▼
                                                  │      UPDATE title/collection/metadata  skip
                                                  │                (no embed)
                                                  ▼
                                    markdown chunker (token-aware)
                                                  ▼
                                    fastembed / bge-small-en-v1.5
                                                  ▼
                        one transaction: upsert document, delete chunks, insert chunks
```

---

## Setup

Prerequisites: `uv` (0.9.26+). No system Python needed — uv manages it.

```bash
uv python install 3.12          # once, if you have no uv-managed Python
cd C:/Users/estac/agentic-harness/ingest
uv sync                         # creates .venv and installs everything
uv run pytest                   # verify
```

The first real (non-dry) run downloads the ONNX weights for
`BAAI/bge-small-en-v1.5` (~130 MB) into fastembed's cache. Every run after that
is fully offline — no API key, no network, no cost.

> **Windows paths.** Always pass `C:/Users/...`. An MSYS-style `/c/Users/...`
> path silently resolves to `C:\c\Users\...` for anything that is not the bash
> shell itself, and fails with a misleading ENOENT.

---

## Environment

Credentials come from the environment. Nothing is ever hardcoded, committed or
printed. The CLI walks up from the package looking for a `.env` (so the repo
root `.env` is found automatically); **an exported variable always wins over the
file**.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | for writes | Direct Postgres URI. The only write path. |
| `DATABASE_CA_CERT` | for writes | Absolute path to Supabase's root CA (`certs/prod-ca.crt`). Connections are `sslmode=verify-full` and never downgrade; `PGSSLROOTCERT` is accepted as an alias. |
| `DATABASE_SSL` | no | `disable` turns TLS off for a local Postgres only. No `prefer`, no `no-verify`. |
| `SUPABASE_URL` | no | Reported by `--check-env`; used by the MCP server. |
| `SUPABASE_SERVICE_ROLE` | no | Same. `SUPABASE_SERVICE_KEY` is accepted as a legacy alias. |

```bash
uv run ingest --check-env       # presence report; never prints a value
```

**There is no PostgREST path, by design.** The `rag` schema is not exposed on
the project's REST surface (`PGRST106`) and will not be — a REST surface is
anon-facing by nature and exposing the store there buys nothing. Direct Postgres is also far faster for
bulk chunk inserts than thousands of HTTP round-trips.

`--dry-run` works with no credentials at all. Without `DATABASE_URL` it cannot
tell new from changed, so it reports everything as new and says so.

---

## Usage

```bash
# Obsidian vault
uv run ingest --source obsidian --path "C:/Users/estac/OneDrive - Syracuse University/vault"

# claude-mem export directory
uv run ingest --source claude-mem --path C:/Users/estac/.claude-archive/2026-09-09/claude-mem-export

# Plan without touching anything
uv run ingest --source obsidian --path C:/Users/estac/vault --dry-run

# Just the notes one SessionEnd wrote (what the capture hook runs), one process
uv run ingest --source obsidian --path "C:/Users/estac/OneDrive - Syracuse University/vault" \
    --only projects/bb2dash/sessions/<id>.md \
    --only projects/bb2dash/sessions/<id>--<agent>.md

# bb2dash class materials -> vault notes (ingest: false; read-only against bb2dash)
uv run export-materials --env-file C:/Users/estac/projects/bb2dash/.env \
    --vault "C:/Users/estac/OneDrive - Syracuse University/vault" [--dry-run] [--course IST.323]

# Retrieval provenance report (read-only): most/never retrieved, empty-result queries,
# similarity histogram, per collection, cross-collection searches. --since takes an
# ISO date or datetime (UTC when naive) or Nd; it bounds every section but never-retrieved.
uv run ingest report retrievals [--since 14d] [--limit 20]
uv run ingest report retrievals --since 2026-09-10 --json > retrievals.json
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report new/changed/unchanged and the chunk count. No embedding, no writes. |
| `--force` | Re-chunk and re-embed even when the hash is unchanged. Use after a model or chunk-config change. |
| `--limit N` | Process at most N documents. Useful for a first smoke test. |
| `--only NOTE` | obsidian only: ingest exactly the notes named instead of walking the vault. Repeatable. See below. |
| `--no-summaries` | claude-mem only: skip `session_summaries.json`. |
| `--no-prompts` | claude-mem only: skip `user_prompts.json`. |
| `--prune` | **Destructive.** Orphan sweep — see below. Off by default. |
| `--env-file PATH` | Use a specific `.env` instead of the walk-up search. |
| `--check-env` | Print which connection variables are set, then exit. |
| `-v` | Debug logging. |

Exit codes: `0` success, `1` at least one document failed (or a fatal config
error), `2` bad arguments.

---

## What each loader produces

### `obsidian`

| Column | Value |
| --- | --- |
| `source` | `obsidian` |
| `external_id` | frontmatter `id:` when present, else vault-relative POSIX path |
| `agent` | `claude-code` |
| `title` | frontmatter `title`, else first H1, else filename stem |
| `body` | the note with frontmatter stripped |
| `metadata` | the frontmatter verbatim, plus `_ingest` |

**Prefer an `id:` in notes you expect to move.** With a path-based key a rename
is indistinguishable from delete-plus-create: the old row is stranded and a
duplicate appears. A stable `id:` (a UUID) survives the rename.

* A missing or blank `id:` falls back to the path — adding an id later is a
  legitimate migration, and refusing the note would lose content over a
  formatting detail.
* A structurally wrong `id:` (a list, a mapping, a multi-line block, anything
  over 512 characters) skips the note and says why.
* Two notes claiming the same `id:` would silently overwrite each other through
  the upsert key, so the second is refused and the conflict is named.
* `_ingest.id_source` records whether the identity came from `frontmatter` or
  `path`.

Ingest-added keys are nested under `_ingest` (`path`, `id_source`, `filename`,
`folder`, `modified_at`, `bytes`, `loader`) so they can never collide with a
user's own frontmatter key named `path` or `source`.

`.obsidian/`, `.trash/`, `.git/`, `node_modules/`, `.venv/` and `__pycache__/`
are skipped at any depth; the vault-root `templates/` folder (Obsidian's own)
is skipped too, but a deeper `templates/` is ordinary content. A note whose
YAML is malformed is skipped and counted — one bad note never aborts a vault
ingest.

**SDK worker sessions** — a `type: session` note whose `origin` starts with `sdk`
(`/code-review` and `/security-review` workers, workflow agents) — are skipped and
reported as such. Their one prompt is a pasted diff, often in identical copies;
indexed, they were 130 of 313 session notes and buried the sessions a person drove.
The vault keeps them. **Raw claude-mem prompts under 80 characters**
(`MIN_PROMPT_CHARS`) are skipped for the same reason: a fragment such as a bare
project name scores above every real document that mentions it. A full run with
`--prune` removes rows that stopped qualifying; the nightly job passes it.

**`ingest: false`** in frontmatter opts a note out of embedding. It is reported
as a skip (`frontmatter ingest: false`), never hidden. `no`, `off`, `'false'`
and `0` are accepted; a list, mapping or empty string is refused as a typo.
Opting out a note that was *already* embedded leaves its rows in place — run
`--prune` to remove them. Class materials exported from bb2dash carry this flag
— see `export-materials` below.

### Named notes: `--only`

`--only` ingests exactly the notes it names, through the same loader and the
same pipeline a full walk uses. It is **repeatable**, and every note named in
one invocation is ingested by one process — which matters because each process
loads the 130 MB embedding model, so one run with three `--only` flags costs one
model load and three would cost three. A `SessionEnd` regularly touches more
than one note: a resume rewrites the note it supersedes, and a `SubagentStop`
rewrites its parent's `child_sessions`.

The same path named twice is loaded once. Two notes claiming the same
frontmatter `id:` are refused exactly as in a full walk.

Every other refusal is raised rather than shrugged off, because the caller is a
detached background process nobody is watching: a note outside `--path`, a
missing file, a non-markdown file, a path the walk excludes (`templates/`,
`.obsidian/`), and `--only` together with `--prune`. One bad path fails the
whole run rather than half-ingesting the rest. `ingest: false` and an empty body
stay skips, not errors, and the run exits 0. A `--only` run never refreshes the
health timestamp — it reconciled the notes it was given, not the vault.

### `export-materials` (bb2dash → vault, not a loader)

Reads `bb_files` + `bb_file_text` from the **bb2dash** Supabase project over
PostgREST and writes one note per file to
`classes/<course>/materials/<slug>-<id>.md` with `id: bb2dash-file-<id>`,
`type: material`, `source: bb2dash` and `ingest: false`. `--env-file` is
required and is read directly (never merged into the process environment); the
URL must be the bb2dash project or the run refuses with exit code `2`, as does
a malformed `--course`. Superseded, unextracted, empty and unmappable files are
reported as skips; a `--course` that matches nothing is an error. Idempotent:
unchanged notes are not rewritten. It never writes to bb2dash. Full rationale
in [docs/ingestion.md](../docs/ingestion.md).

### `claude-mem`

Three of the four export files become documents, all under
`source='claude-mem'`, with distinct `external_id` prefixes so they cannot
collide inside one source:

| File | Rows | Ingested | `external_id` | Body | Title |
| --- | --- | --- | --- | --- | --- |
| `observations.json` | 461 | **443** | `<id>` | `narrative` (legacy `text` fallback) | `title` |
| `session_summaries.json` | 141 | **137** | `summary:<id>` | six prose columns as `## ` sections | from `request` |
| `user_prompts.json` | 725 | **725** | `prompt:<id>` | `prompt_text` | none |
| `sdk_sessions.json` | 103 | — | not ingested | — | — |

`sdk_sessions.json` is pure session metadata (timestamps, status, worker port)
with nothing to embed. It is read only to enrich the other three, joined on
whichever session id that record carries:

* observations and summaries join on `memory_session_id`
* prompts join on `content_session_id` — prompts have no `memory_session_id`

The joined fields land under `metadata._session`, namespaced so they cannot
shadow a real column. `worker_port` is deliberately dropped: an ephemeral local
detail with no retrieval value. Prompts additionally inherit `project` from
their session, since they carry no project column of their own. On the
2026-09-09 export every one of the 1305 ingested documents resolves to a
session.

`facts`, `concepts`, `files_read` and `files_modified` are JSON **inside a TEXT
column**, not arrays. They are decoded into real lists in `metadata`. Malformed
JSON skips that one row rather than being swallowed.

Deliberate skips, all counted and printed:

* **18 observations** (ids 68–164, all within `2026-05-07 06:09–08:27`) with no
  narrative, no text and no title — failed writes from that day's
  data-directory migration. 461 exported, **443 ingested**.
* **4 session summaries** whose six prose columns are all blank. 141 exported,
  **137 ingested**. (Not in CONTEXT.md; found while probing the export.)

Total: **1305 documents, 2278 chunks** from the export; vault notes captured since add to that
(1,319 / 2,312 as of 2026-09-10).

The exporter's own 16-character `content_hash` is kept as
`metadata.source_content_hash` for provenance. It is *not* what goes into
`rag.documents.content_hash` — that is our own sha256.

---

## Orphan sweep (`--prune`)

After a *complete* pass over one source, any `external_id` still in
`rag.documents` that the loader did not produce is an orphan: a deleted note, or
a note renamed while it had no stable frontmatter `id:`.

This is the only destructive operation in the package, so it is **off by
default** and refuses to run unless the sweep can be trusted:

* `--limit` was used — the seen set is not a full pass, so a sweep would delete
  most of the corpus;
* any document failed — the seen set is incomplete;
* the loader produced nothing — a mistyped path or an unmounted OneDrive folder
  would otherwise wipe the source;
* `HARNESS_MACHINE` is unset — a row whose note names another machine
  (`machine:` in its frontmatter) is that machine's to sweep, so the sweep has to
  know which machine it is. Two clones of one realm that have not synced yet
  must not delete each other's sessions.

Each guard prints why it declined. `--prune --dry-run` lists exactly what would
be deleted without touching anything. `rag.chunks` cascades from
`rag.documents`, so one delete removes both.

---

## Chunking

All budgets live in `ChunkConfig` in `src/ingest/config.py`.

| Parameter | Value | Why |
| --- | --- | --- |
| `target_tokens` | 384 | bge-small accepts 512. ~25% headroom lets a chunk carry a heading breadcrumb and an overlap block without the tokenizer silently truncating it. |
| `overlap_tokens` | 64 | One sixth of a chunk. Enough that a sentence split across a boundary is retrievable from either side; storage and embedding cost rise only ~17%. |
| `min_tokens` | 32 | Shorter fragments (a lone heading, one list item) embed to near-noise and pollute the top-k, so a runt trailing chunk is folded into its predecessor. |
| `hard_max_tokens` | 480 | Absolute ceiling after breadcrumb and overlap. Still under 512, so nothing is ever truncated by the model. |

**Structure is respected.** The chunker packs *blocks* (heading, fenced code,
table, list run, paragraph), never raw lines:

* A code fence that fits is never split. One that does not is split on **line**
  boundaries and the fence is re-opened and re-closed on every part, so no chunk
  ever contains an unbalanced fence.
* A table that does not fit is split on **row** boundaries with the header and
  separator repeated on each part, so every piece is still a valid table.
* An oversized paragraph splits at sentence boundaries, then line, then word.
  Only a single token-dense blob with no whitespace (a base64 string, a minified
  line) is ever cut mid-token.
* Code and table blocks are **not** duplicated into the next chunk's overlap.
  Repeating them doubles the most token-expensive content in the corpus for
  little retrieval gain, and a half-repeated fence reads as broken markdown.

**Heading breadcrumb.** Each chunk is prefixed with `Title > H1 > H2` so it stays
interpretable once torn out of its file. Toggle with
`ChunkConfig.include_heading_breadcrumb`.

**Token counting.** A real run uses the model's own WordPiece tokenizer, dug out
of fastembed, so `rag.chunks.token_count` is exactly what the model saw. If that
tokenizer cannot be reached the pipeline logs a warning and falls back to a
heuristic counter — it never fails silently. `--dry-run` and the test suite
always use the heuristic, so neither downloads a model.

---

## Embeddings

`BAAI/bge-small-en-v1.5`, **384 dimensions**, local via `fastembed` (ONNX, CPU).

The model name and dimension live in one place: `EMBEDDING` in
`src/ingest/config.py`. Swapping models is one edit there plus
`uv run ingest --force`, not a refactor.

Weights are cached in `~/.cache/fastembed` (override with `FASTEMBED_CACHE_DIR`).
fastembed's own default is the system temp directory, which Windows is free to
clean out — that would silently re-download 130 MB on some future run. The cache
must stay **out of OneDrive**: binary indexes plus OneDrive sync have already
caused file-lock failures in this project.

Every returned vector is checked
against the configured dimension before it reaches the database, because
`rag.chunks.embedding` is fixed at `extensions.vector(384)` — a mismatch there
would otherwise surface as an opaque Postgres error mid-run.

Vectors are sent as pgvector text literals cast to `extensions.vector` in SQL,
so there is no runtime dependency on the `pgvector` Python package.

---

## Change detection and re-runs

`rag.documents.content_hash` is the sha256 of the **normalised** body:
Unicode NFC, CRLF/CR → LF, trailing whitespace stripped per line, blank-line
runs collapsed. That means a OneDrive round-trip or an editor adding a trailing
newline does not trigger a needless re-embed. The stored `body` is the original
text; only the hash input is normalised.

On re-ingest:

* **hash unchanged, frontmatter unchanged** → skipped entirely. No chunking, no
  embedding, no SQL write.
* **hash unchanged, anything else changed** → one
  `UPDATE rag.documents SET title, collection, agent, metadata`. No re-chunking,
  no embedding: the
  vectors came from a body that did not change. Counted as `metadata-updated`
  (`would-update-metadata` in a dry run). This is what makes a `status` flip, a
  `child_sessions` link and `sweep-concluded --apply` visible to a metadata
  filter; widening the hash to cover frontmatter would instead re-embed the
  whole store.
* **hash changed** → in one transaction: upsert the document on
  `(source, external_id)`, delete its chunks, insert the new ones. If any step
  fails, the document keeps its previous chunks — never a half-rewritten
  document, never duplicate chunks.

Title and metadata are compared as canonical JSON with sorted keys, because
`jsonb` does not preserve the order the loader produced.

A failed document is logged and counted; the run continues and exits `1`.

---

## Store audit (`verify`)

```bash
uv run ingest verify --path C:/Users/estac/vault            # the nightly job runs this after ingest
uv run ingest verify --path C:/Users/estac/vault --seed 1   # reproducible re-embed sample
uv run ingest verify --path C:/Users/estac/vault --json     # every finding, machine-readable
```

A read-only audit of what is actually in the store (R-Q1). The connection's first
statement is `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, so a write
would raise. It loads the repo `.env` and `~/.harness/machine.env` first, like
`embed-check`, so `FASTEMBED_CACHE_DIR` and `HARNESS_REALMS` apply. It loads the
embedding model, because two of the checks need it.

| Check | Finds |
| --- | --- |
| `chunks` | a document with no chunks, or `chunk_index` values that are not exactly `0..n-1` |
| `embeddings` | a null embedding, or a stored vector whose L2 norm (`vector_norm`) is more than 1e-3 from 1 |
| `token-count` | a chunk that the model's own tokenizer, recounting it with truncation off, puts over 512 tokens; also, marked `info`, a stored `token_count` more than 10% from the recount |
| `vault` | per realm: an ingestable note with no row, a row with no note (or whose note the walk skips, with the reason), and a row whose `content_hash` differs from the note. Only `source = 'obsidian'` rows are compared. Legacy rows with no `_ingest.realm` are counted, not reported. An unmarked vault is compared as one scope. |
| `duplicate-ids` | a note the walk refused because an earlier note already holds its `external_id` |
| `re-embed` | among `--sample` chunks (default 50; `--seed` makes the draw reproducible), one whose fresh embedding scores cosine < 0.999 against the stored vector |

The text report lists every check with its count, notes that give context, and
up to 20 findings. It ends with one line the nightly log can grep:
`verify: clean` or `verify: N finding(s) in K check(s)`. An `info` finding still
counts.

Exit codes: `0` clean, `1` at least one finding, `2` could not run (vault
missing, database unreachable or not configured, model or tokenizer
unavailable, a realm not in `HARNESS_REALMS`, or bad arguments). The reason is
given in one `error:` line on stderr.

---

## Curator (`curate`)

```bash
uv run ingest curate inventory --path C:/Users/estac/vault                     # read-only, R-C1
uv run ingest curate extract --path C:/Users/estac/vault --collection agentic-harness --dry-run
uv run ingest curate extract --path C:/Users/estac/vault --collection agentic-harness   # R-C2, calls the judge
uv run ingest curate ledger  --path C:/Users/estac/vault --collection agentic-harness   # R-C3, writes ledger.md
uv run ingest curate status  --path C:/Users/estac/vault --collection agentic-harness   # R-C4, writes status.md, no judge
uv run ingest curate history --path C:/Users/estac/vault --collection agentic-harness --dry-run
uv run ingest curate history --path C:/Users/estac/vault --collection agentic-harness   # R-C5, one judge call per new week
uv run ingest curate report  --path C:/Users/estac/vault --all --dry-run               # R-C6/R-C7: scores, proposals, tally
uv run ingest curate report  --path C:/Users/estac/vault --all                         # writes <realm>/curation/<date>.md

# The weekly run: the six stages in order, then the retrievals JSON and dashboard
powershell -NoProfile -File C:/Users/estac/agentic-harness/scripts/weekly-curate.ps1 -DryRun
scripts/weekly-curate.sh --dry-run                                                      # Linux, macOS
```

The read-only half of Phase C in `docs/memory-sprint-requirements.md`. Python does
every read and write; the LLM is a pure function behind the `Judge` protocol
(`curate/judge.py`): text and a JSON schema in, validated JSON out. The backend,
`curate/claude_cli.py`, runs `claude -p` with no tools, no MCP servers, no hooks,
safe mode and no session persistence, from an empty temp folder, so a judge call
is never captured as a session. It strips `ANTHROPIC_API_KEY` from the child's
environment, so calls use the subscription login. Tests use `FakeJudge` and
never call a model.

| Stage | Reads | Writes | Exit codes |
| --- | --- | --- | --- |
| `inventory` | the vault; `git log` and `gh pr list` unless `--no-git` | nothing | `0` clean, `1` a collection's count differs from its `sessions/*.md`, `2` could not run |
| `extract` | inventory notes, the `curate.extractions` cache | cache rows, one batch at a time | `0` done, `1` notes failed, `2` could not run, `3` stopped by budget |
| `ledger` | cached extractions, git facts, `curate.issues`/`issue_events` | issues, members, events, `<realm>/<collection>/ledger.md` | as `extract` |
| `status` | inventory, cached extractions, the hub's plan sources, git facts unless `--no-git` | `<realm>/<collection>/status.md` (the store is only read; no judge) | `0` done, `1` a requirement is contradicted or a plan source is missing, `2` could not run |
| `history` | inventory, cached extractions, git facts, the `curate.history_weeks` cache | new `history_weeks` rows, `<realm>/<collection>/history.md` | as `extract` |
| `report` | the scores' inputs (cached extractions, ledger, status open items, git facts), `rag.retrieval_events` counts, the ticks in earlier `<realm>/curation/*.md` | `curate.note_scores`, `importance_judgements`, `proposals`, `decisions`, `<realm>/curation/<date>.md` | as `extract` |

- **Inventory:** each collection's timeline in date order, with subagents nested
  under their main session. It includes the `sdk-*` review-worker notes that
  ingest skips, and leaves out hubs, `captured_by: curator` notes and class
  `materials/`.
- **Hub profile:** each hub may carry `kind: project | class` (the default comes
  from the realm), `plan_sources:`, `repo:` (owner/name) and `repo_path:`. Set
  `repo_path` explicitly: a path derived from session `cwd`s can land on a
  worktree or scratchpad.
- **Extraction:** several notes go in one judge call, each fenced by a per-call
  nonce and marked as untrusted data. Every evidence quote must be an exact
  substring of its note (only CRLF→LF is normalised) and at least 12 characters,
  or the item is rejected with a reason.
- **Extraction cache:** results are cached by (note id, content hash, extractor
  version). The version carries a fingerprint of the schema and prompts, so
  editing either one invalidates the cache. `--max-calls` and `--max-tokens`
  stop a run before it crosses a limit, and keep the batches already written.
  `--dry-run` prints the batches and estimated tokens.
- **Ledger clustering:** each new issue is compared with the collection's
  existing issues by bge cosine (at least 0.85, best three), and a judge call
  confirms a match or none. Verdicts are cached. Ids are
  `ISSUE-<collection>-NNN` and never renumber.
- **Ledger events:** events are append-only facts: a note's claim, a `fix:`
  commit touching the issue's files, or a fix reference resolving to a commit on
  main or a merged PR. State (`open`, `claimed-fixed`, `verified`, `regressed`)
  is replayed from them in effective-time order. A fix closes a validity
  interval; a recurrence opens a new one.
- **Plan sources:** a hub's `plan_sources:` entry is a vault note, a repo file or
  a repo folder; a folder stands for the `*.md` files directly in it (one level,
  nothing that leads outside it). `curate/plan.py` reads a heading whose first
  token is a requirement id (`### R-C4 ...`) as that requirement's section, with
  its `**Done when.**` and `**Tests.**` bullets; a table whose first header cell
  is `Phase` as the phase table; every `- [ ]` / `- [x]` as a checkbox of the
  section it sits in. A document with no requirement headings is one numbered
  phase brief (bb2dash's `docs/planning/50_PHASE7_x.md`), its id from the
  filename. A source that is missing or unreadable is a finding, not a stop.
- **Status states:** `curate/status.py` gives each requirement one of five, in
  this order of precedence: `contradicted` (a done claim, from a note, a ticked
  checkbox or a merged PR, then a later note claim `broken`), `verified` (a done
  claim and a merged PR or a commit on main naming the id as a whole token),
  `claimed done` (a done claim, no such git evidence, nothing contradicting),
  `in progress` (any other evidence: a mention, a commit off main, an unmerged
  PR, an in-progress or blocked claim), `not started` (nothing). An unticked box
  is the plan, not evidence. status.md puts its state tables first, because
  R-H4 injects the top of it.
- **History:** one narrative per ISO week (Monday start) over the collection's
  dated sessions, subagents, notes and decisions, cached by a hash of the
  week's notes, commits and PRs, so a rerun pays only for a week that changed.
  The judge sees opaque labels (S1, S2 ...), never an id or a path; Python maps
  its citations back. A citation to an unknown label is dropped, and a paragraph
  left with no valid citation is dropped and counted. The suggested session
  titles are stored in `curate.history_weeks` and shown in history.md; they are
  never written into a note.
- **Scores:** impact (0 to 10) is `min(10, Σ w·log1p(f))` over commits, PRs,
  decisions, issues found, issues fixed, requirement references, later
  citations, retrievals, `used` retrievals and subagent children. The judge's
  1 to 10 importance is asked only where those disagree (activity without
  knowledge, knowledge without activity, usage without either), cached per note
  version in `curate.importance_judgements`, and averaged in. Relevance (0 to 1)
  is 0.5 × the best cosine to status's open items, plus 0.3 × recency (half-life
  90 days for a project, 42 for a class), plus 0.2 × membership of an open or
  regressed ledger issue. Scores live in `curate.note_scores`, one row per note
  per run, never in frontmatter.
- **Curation report:** `<realm>/curation/<date>.md` lists condense candidates (a
  subagent note whose every extracted item is already represented, its issues
  in the ledger and the rest in its parent's extraction, with no commit or PR)
  and prune candidates (every impact feature zero, and a scratchpad `cwd` or a
  body under 400 characters), one checkbox each, reasons joined by `; `:
  ``- [ ] condense `<note id>` [[link|date]] — reasons (no-loss: yes)``.
  Tick a box to accept it; the next run records it in `curate.decisions`. A box
  left unticked counts as a rejection once the report is older than the run's
  day, or when it undoes a recorded tick; today's unticked boxes stay undecided,
  and a report with undecided boxes is shown as `(open)` in the tally and not
  counted yet. `no-loss` is the verifier: nothing extracted from the note would
  be lost.
- **Tally and promotion (R-C7):** each report tallies, per action type and per
  earlier report, the share of proposals that were ticked; a report with no
  proposal of a type is not a run for it. Condense and prune are promoted
  separately: three consecutive runs at ≥ 95% acceptance with no loss make a
  type automatic, and a rejection while automatic demotes it back to proposals.
  Nothing is applied this sprint: the report only proposes.
- **Weekly run:** `scripts/weekly-curate.ps1` (or `.sh`), Sunday 04:30 after the
  nightly job and the store backup, runs `inventory`, `extract --all`,
  `ledger --all`, `status --all`, `history --all`, `report --all`, then
  `ingest report retrievals --quiet --json-out ... --html ...`, which writes
  `retrievals-<date>.json` and `retrievals-dashboard.html` under
  `~/.harness/reports/`. Every stage runs whatever the one before did; the run
  exits 2 only when a stage could not run. `CURATE_MODEL`, `CURATE_MAX_CALLS`,
  `CURATE_MAX_TOKENS`, `CURATE_GIT` (`apply` or `skip`) and `CURATE_STAGES` come
  from `~/.harness/machine.env`, the environment winning. Stack registers it
  with `scripts/register-weekly-curate.ps1` (`docs/portable.md`).
- **`curate/writer.py`** is the curator's only file writer. It writes
  allowlisted names only (`ledger`, `status`, `history`,
  `curation/<date>.md`), never leaves the vault, never overwrites a note it did
  not write, and skips the write when only `generated_at` would change.

Schema: `db/migrations/20260927200342_curate_schema.sql` (schema `curate`: the
extraction cache, issues, members, events, judge confirmations) and
`db/migrations/20260927214500_curate_status_scores.sql` (`history_weeks`,
`note_scores`, `importance_judgements`, `proposals`, `decisions`); RLS on, no
policies, nothing deleted. All of it is built and tested against fixtures and a
fake judge, never run live; the first live run is step L7 of
`docs/memory-sprint-orchestration.md`.

---

## Tests

```bash
uv run pytest
uv run pytest --cov=ingest --cov-report=term-missing
```

The database is mocked (`FakeStore`, and a fake psycopg connection that asserts
the exact SQL and transaction sequence) and the embedder is mocked
(`FakeEmbedder`), so the suite needs no credentials, no network and no model
download. Coverage includes chunker boundaries (code fences, tables, oversized
paragraphs, overlap, the hard ceiling), hash-based skip logic, the 18-empty-row
skip and the 461 → 443 arithmetic, frontmatter parsing, and the JSON-in-TEXT
column decoding.

---

## Layout

```
ingest/
  pyproject.toml
  src/ingest/
    config.py           model name, dimensions, chunk budgets, env names
    errors.py           typed errors; nothing is swallowed
    models.py           SourceDocument, Chunk, DocumentState
    hashing.py          normalise + sha256
    markdown_blocks.py  markdown -> structural blocks
    chunking.py         blocks -> chunks, with overlap
    tokenizer.py        real tokenizer, heuristic fallback
    embedding.py        fastembed wrapper + pgvector literal
    store.py            the only SQL in the package
    pipeline.py         hash -> skip -> chunk -> embed -> write
    prune.py            guarded orphan sweep
    verify*.py          read-only store audit: types, checks, SQL, CLI
    envfile.py          minimal .env reader
    cli.py              argument parsing and reporting
    curate/             the read-only curator: inventory, judge, extract, ledger, plan,
                        status, history, scores, report, writer
    retrieval_dashboard.py  the retrievals report as one offline HTML page
    loaders/
      obsidian.py
      claude_mem.py
      claude_mem_sessions.py
  tests/
```
