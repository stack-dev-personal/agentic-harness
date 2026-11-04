# Shared Context — Agentic Harness + RAG

**Every agent working on this project reads this file first.** It is the single source of truth for
decisions already made. Do not re-litigate them; if something here looks wrong, report it rather than
silently diverging.

Last updated: 2026-09-29 (bb2dash Phase 20, R-104: the realm vault, the machine file, the optional
local store, the environment re-read on stack-laptop). Before that 2026-09-27 (memory sprint unit
C-b: curator status, history, scores and curation report, the weekly curator run; built, not live)

---

## What this project is

An agentic engineering harness rebuilt on native Claude Code primitives, plus a Postgres + pgvector
RAG store that unifies an Obsidian vault with six months of migrated agent-memory history.

It replaces a previous stack (GSD workflow system + claude-mem + context-mode) that had accumulated
71 always-on skills, 58 custom agents, 60 slash commands and 220 permission rules — most of it broken
or duplicating capability that is now native.

## Decisions already made — do not revisit

| Decision | Choice | Why |
| --- | --- | --- |
| Vector DB | Supabase Postgres + pgvector 0.8.2 | Already enabled, always up, no daemon to babysit |
| Project | **`harness-memory` (`hqkytnyiiuxovnnyixye`)**, schema `rag` | Its own project since 2026-09-09. **NOT bb2dash** — that is a different corpus with a different model |
| Embeddings | `BAAI/bge-small-en-v1.5`, **384 dims**, local via `fastembed` | No API key, private, offline, zero cost |
| Retrieval | Hybrid vector + full-text, fused with RRF | Scale-free; no score normalisation needed |
| Harness | Native-first (plan mode, Agent, Workflow, `/code-review`) | The old stack was mostly dead weight |
| Memory | claude-mem retired, history migrated | Chroma leaked orphan processes; SQLite was the real store |
| Runtime memory | Claude Code, Codex and Hermes share capture policy, durable queue/checkpoints, chunker, embedding model and `rag.search()` | User-approved model-agnostic memory plan, 2026-11-03; runtime/model are provenance |

### Model-agnostic memory (2026-11-03)

The approved implementation contract is [docs/model-agnostic-memory.md](docs/model-agnostic-memory.md).
All captured sessions route through vault notes and the Obsidian loader; the
older separate `source='hermes'` plan is superseded. Preserve historical IDs and
source keys. Generated session embeddings exclude machine-generated provenance;
raw notes and metadata retain it. Unknown attribution remains unknown. Explicit
session purposes and restrictions replace SDK-origin eligibility rules.

The common `AgenticHarness-Memory` worker checkpoints recent/new native activity
every five minutes, drains durable path-only queues, and records health outside
the vault. Historical bulk reconciliation requires a reviewed preview and user
approval. No database schema migration is required.

Restricted-data controls must apply before persistence. Sticky content-free
session exclusions, parent inheritance and protected-root checks guard harness
exports and recall. They do not suppress native raw history or remote model
traffic. Native Hermes history suppression has not been established; restricted
workflows through Hermes remain prohibited. Never claim secret redaction proves
content is unrestricted.

## Database

> **Relocated 2026-09-09.** The harness RAG previously squatted in `bb2dash` because of the free-tier
> ceiling. `quant-edge-tracker-v2` was paused (it held 0 bets / 0 bankroll rows) to free a slot, and the
> harness now has its own project. The `rag` schema was dropped from `bb2dash` — it was empty.

### ⚠ TWO SEPARATE RAG STORES. NEVER CROSS THEM.

| | **harness-memory** | **bb2dash** |
| --- | --- | --- |
| Project ref | `hqkytnyiiuxovnnyixye` | `goultdzqcavefcgnifdy` |
| Purpose | Session histories, per project/class | Class materials + the bb2dash app |
| Location | schema `rag` | schema `public` |
| Model | **`bge-small-en-v1.5`** (local fastembed) | **`gte-small`** (Supabase server-side) |
| Dims | 384 | 384 |
| State | **live — on 2026-09-24: obsidian 472 docs (realms `projects` 464 / `classes` 8), 1,838 chunks; claude-mem 1,037 docs, 2,010 chunks**; every obsidian row carries `_ingest.realm` (2026-09-24) | **fully embedded** — 534/534 texts, 1,195 chunks; retrieval via Edge Function `search` + MCP server `bb2dash` (see bb2dash repo) |

**Both are 384-dim, so mixing them raises no error — it silently returns confidently-ranked garbage.**
They are different vector spaces. A `bge` query vector must never be run against `gte` vectors or the
reverse. Keep the two pipelines, clients and connection strings entirely separate.

**This project owns `harness-memory` only.** Do not write to `bb2dash`; its class-materials pipeline is
already built and running server-side.

`harness-memory`: region `us-east-1`, Postgres 17, pgvector 0.8.2.

A machine without Supabase runs its own store from `db/docker-compose.yml` (pinned
`pgvector/pgvector:0.8.6-pg17`) and backs it up with `scripts/backup-store.ps1|sh`; before its
first ingest it runs `uv run ingest embed-check` (see `docs/portable.md`, *Local store*).

```
rag.documents                              rag.chunks
  id            bigint identity PK           id           bigint identity PK
  source        text NOT NULL                document_id  bigint FK -> documents (cascade)
  collection    text            <-- NEW      chunk_index  int NOT NULL
  agent         text                         content      text NOT NULL
  external_id   text NOT NULL                token_count  int
  title         text                         embedding    extensions.vector(384)
  body          text NOT NULL                tsv          tsvector GENERATED (english)
  metadata      jsonb NOT NULL '{}'          created_at   timestamptz
  content_hash  text NOT NULL
  created_at    timestamptz                 UNIQUE (document_id, chunk_index)
  updated_at    timestamptz (trigger)
UNIQUE (source, external_id)
```

**`collection`** is the project or class a document belongs to. It mirrors the vault folder structure
and is what makes "histories by project or class" queryable. Indexed, exposed as `filter_collection`.

**`filter_collection` matches with `=`, so case and spacing are load-bearing.** Values came from
claude-mem's own `project` field and are lowercase, some containing spaces. `IST335` matches nothing;
`ist335` matches. These are the 17 claude-mem values — do not guess, and do not invent title-case variants:

| collection | docs | | collection | docs |
| --- | --- | --- | --- | --- |
| `estac` | 513 | | `dreamy-swirles-5ff0b4` | 11 |
| `ai-news-agent` | 404 | | `serene-chaum-0bbfca` | 11 |
| `quant-edge-tracker` | 154 | | `wa2 final` | 9 |
| `portfolio website` | 47 | | `unit2` | 8 |
| `claude-mem` | 46 | | `unit 3` | 7 |
| `wta dog finder` | 31 | | `projects` | 6 |
| `team project` | 30 | | `bb2dash` | 2 |
| `ist335` | 14 | | `reading nugget 4` | 1 |
| `ce2` | 11 | | | |

Vault ingestion has since added `source='obsidian'` collections derived from folder names:
`agentic-harness`, `ev-trainer`, `quant-edge-tracker`, `misc`, `bb2dash-retrieval`, `ist323`, `ist352`,
`ist466`, `ist471`, `ecn304`, `geo103`, plus the pre-existing `ist335` (which now spans both
sources). Keep new folders lowercase-hyphenated to avoid widening the inconsistency above; the
existing spaced values are historical and cannot be renamed without breaking `external_id` stability.

Indexes: HNSW `vector_cosine_ops` on `chunks.embedding`; GIN on `chunks.tsv` and
`documents.metadata`; btree on source, agent, content_hash, document_id.

**RLS is enabled with no policies** — only the service role can read or write. Ingestion and the MCP
server both connect with the service key.

### Retrieval contract

```sql
rag.search(
  query_embedding   extensions.vector(384) default null,
  query_text        text default null,
  match_count       int  default 10,
  filter_source     text default null,
  filter_collection text default null,      -- project or class
  rrf_k             int  default 60,
  max_per_document  int  default 3,
  min_similarity    double precision default 0.70,
  filter_metadata   jsonb default null,       -- contains-match on frontmatter, e.g. {"repo": "owner/name"}
  include_superseded boolean default true     -- false drops status: superseded
)
returns (chunk_id, doc_id, doc_source, doc_collection, doc_external,
         doc_title, chunk_content, doc_metadata, fused_score, vector_similarity)
```

**Bind by NAME (`query_embedding => $1`), never positionally.** This signature has already
changed four times, and a positional call silently shifted `rrf_k` into `filter_collection`
— an int into a text parameter, surfacing as a misleading "function does not exist".

### `min_similarity` — an empty result is a correct answer

RRF fuses *ranks*, not distances, so without a floor every query returns its nearest neighbours no
matter how far away they are. Measured on this corpus: relevant hits **0.79–0.83** cosine, nonsense
**0.48–0.66**, a clean +0.126 gap. The 0.70 default sits in that gap, biased toward false positives
because missing a real memory is worse than showing a weak one.

- **Zero rows means nothing relevant exists. That is not an error.** Do not surface it as one.
- **The floor gates the VECTOR arm only.** A row can appear with similarity below 0.70 if it matched
  the full-text arm — a literal keyword hit is independent evidence. Never filter that out client-side.
- `fused_score` is an RRF rank score with ceiling `2/(k+1)` ≈ 0.0328; it is meaningless in absolute
  terms and not comparable across queries. **Use `vector_similarity` for relevance**, RRF for ordering.

Pass either argument or both. `filter_source` narrows to one producer. **All ranked retrieval goes
through this function** — do not hand-roll ranking in clients, or Claude Code and Hermes will drift
apart. A point lookup by `(source, external_id)` may read `rag.documents` directly; that is a key
lookup, not ranking.

Contract details that are easy to get wrong:

- **Both arguments null raises**, rather than returning an empty set. An empty result from a silent
  no-op is indistinguishable from "nothing matched", so it fails loudly instead. `match_count < 1` and
  `max_per_document < 1` raise too.
- **`fused_score` is not a percentage and is not comparable across queries.** It is a raw RRF sum of
  `1/(k+rank)`, so its ceiling is `2/(k+1)` — about **0.0328** at the default `k=60`. A top hit scoring
  `0.03` is an excellent match, not a 3% one. Label it accordingly in any client output.
- **`max_per_document` defaults to 3** (null disables). Without it, several chunks of one long
  document crowd out every other source. Candidate over-fetch is `max(match_count*10, 100)` per arm to
  leave room for the cap to bite.

### Embedding parity — both sides must agree

The ingestion pipeline and the MCP server embed with the same model, and any asymmetry between them
degrades retrieval **silently** — you get worse rankings, never an error.

- Model: `BAAI/bge-small-en-v1.5`, 384 dims, cosine. Assert the vector length on both sides.

**Parity VERIFIED empirically (2026-09-09) — not assumed.** The two runtimes reach the same weights by
different routes: Node `fastembed` pulls `fast-bge-small-en-v1.5.tar.gz` from Qdrant's GCS bucket,
Python `fastembed` pulls HF `qdrant/bge-small-en-v1.5-onnx-q`. Both resolve to `model_optimized.onnx`.
Embedding three identical sentences in each runtime and comparing:

```
cosine = 0.99999975 .. 0.99999985    maxAbsDiff ~1e-4    both L2-normalised to 1.000000
control (different sentences)        cosine = 0.532543
```

The ~1e-4 deltas are float32 rounding. The control line is the point: unrelated sentences score 0.53,
so the test discriminates rather than trivially returning 1.0. **Re-run this check if either package
is upgraded** — a silent weights change is exactly the failure this catches.

- fastembed's default cache is the system temp directory, which Windows cleans. Python side pins it to
  `~/.cache/fastembed` (override `FASTEMBED_CACHE_DIR`), Node to `~/.cache/fastembed-node`. Both
  deliberately outside OneDrive, per the binary-index rule above.
- **Query instruction prefix: NOT used, on either side.** BGE's model card offers
  `"Represent this sentence for searching relevant passages: "` for queries, and `fastembed` does not
  apply it automatically. v1.5 was specifically trained to need it less, so the project convention is
  **no prefix anywhere**. The MCP server exposes `RAG_QUERY_PREFIX` if this is ever revisited — but
  changing it on one side only is a silent-quality-loss bug, so change both or neither.

### stdio MCP servers: stdout is the wire

For the retrieval server, **stdout is the JSON-RPC channel**. Anything else written there corrupts the
protocol. fastembed's download progress bar must stay disabled and all logging goes to stderr. This
applies to anything added to that server later.

## Data to ingest

### 1. claude-mem history (already exported)

`~/.claude-archive/2026-09-09/claude-mem-export/` on the machine the reset ran on (imported once on
2026-09-09; the archive is not on stack-laptop)

| File | Rows | Notes |
| --- | --- | --- |
| `observations.json` | 461 | **Ingest 443** — see below |
| `session_summaries.json` | 141 | |
| `sdk_sessions.json` | 103 | session metadata |
| `user_prompts.json` | 725 | |
| `claude-mem-snapshot.db` | 56 MB | SQLite source, `integrity_check: ok` |

`observations` columns: `id, memory_session_id, project, type, title, subtitle, facts, narrative,
concepts, files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch,
content_hash`.

- `facts`, `concepts`, `files_read`, `files_modified` are **JSON-encoded TEXT**, not arrays. Parse
  them into `jsonb`. Verified: 0 of 461 fail to parse.
- `narrative` is the prose body and the primary embed source. `text` is legacy and NULL on modern rows.
- **Skip 18 rows** (ids 68–164, all within `2026-05-07 06:09–08:27`): no narrative, no text, no title.
  Failed writes from that day's data-directory migration. Ingest 443.
- Types: `change 156, discovery 113, feature 92, bugfix 38, refactor 34, decision 28`.
- Projects: `ai-news-agent 251, estac 103, quant-edge-tracker 79, claude-mem 28`.
- Range: 2026-03-24 → 2026-09-09.

Map to `source='claude-mem'`, `external_id=<observation id>`, `agent='claude-code'`.

#### Mapping for the other three exports

| File | Ingest? | Mapping |
| --- | --- | --- |
| `session_summaries.json` (141) | **yes — 137** | `external_id='summary:<id>'`; body = labelled concat of `request`, `investigated`, `learned`, `completed`, `next_steps`, `notes`; title from `request`. **4 rows have all six prose columns blank** and are skipped, same as the 18 empty observations |
| `user_prompts.json` (725) | **yes — all** | `external_id='prompt:<id>'`; body = `prompt_text`; no title |
| `sdk_sessions.json` (103) | **no** | Pure session metadata (timestamps, status, worker port) — nothing to embed. Use it only to enrich `metadata` on the other two |

**Correction — the enrichment join needs two keys, not one.** `user_prompts` has no
`memory_session_id` column at all; it joins on `content_session_id`. And only **18 of 103**
`sdk_sessions` rows carry a `memory_session_id`, while `content_session_id` is unique across all 103.
So the enrichment index must key on both. Verified: 14/14 memory ids and 80/80 content ids resolve.

Ingest totals: **1305 documents, 2278 chunks** (443 observations + 137 summaries + 725 prompts).

All three carry `source='claude-mem'`. Keep `external_id` prefixes distinct (`summary:`, `prompt:`,
bare id for observations) so the three never collide inside one `source`.

### Vault reconciliation policy

`external_id` = the note's frontmatter `id:` when present, else the **vault-relative path**. Prefer an
`id:` (UUID) convention in vault notes: with a path-based key, renaming a note strands its old row and
creates a duplicate, because a rename is indistinguishable from delete-plus-create.

Orphan sweep: after a **full** ingest of one source, delete documents for that source whose
`external_id` was not seen in the walk, scoped to the realms walked and to this machine (a row
whose note names another `machine:` is never this walk's orphan; found 2026-11-04 after the
jobs container deleted stack-mac's sessions). Put this behind an explicit `--prune` flag, **off by default** —
otherwise a partial or interrupted run silently mass-deletes.

### 2. Obsidian vault (live)

The folder the machine file `~/.harness/machine.env` names in `HARNESS_VAULT`
(`C:/Users/stack/vault` on stack-laptop, whose `HARNESS_MACHINE` is `stack-laptop`). It left
OneDrive on 2026-09-23 (`docs/vault-migration-requirements.md`). Its top-level folders are
**realms**: each a git repository with a private remote and a committed `.realm` file naming it.
`HARNESS_REALMS` lists the realms a machine may hold and whether each may leave it
(`projects:push,classes:push,harness:push` on stack-laptop); a realm on disk it does not name stops
the run. `hooks/sync-realms.mjs` commits, merge-pulls and pushes them (never a rebase, never a
force), from the nightly job; the Obsidian Git plugin is not used. `.obsidian/` stays at the vault
root, outside every realm, untracked. **Binary indexes never go in the vault.**

Map to `source='obsidian'`, `external_id=<frontmatter id, else vault-relative path>`,
`collection=<second path segment>`.

### Vault layout — folder name IS the collection

```
vault/
  projects/              realm: one folder per repository
    bb2dash/             bb2dash.md             sessions/  decisions/
    quant-edge-tracker/  quant-edge-tracker.md  sessions/
    misc/                misc.md                sessions/
    …
  classes/               realm: one folder per course
    ist323/  ist352/  ist466/  ist471/  ecn304/  geo103/     (Fall 2026)
                         <course>.md            sessions/  materials/
    ist335/              ist335.md                                   (prior term)
    attachments/         the realm's binary files
  harness/               realm: this repository's own sessions
    agentic-harness/     agentic-harness.md     sessions/
  .obsidian/             vault root, outside every realm; never ingested
```

Subfolders exist once something is written into them. A vault-root `templates/`, where a vault
has one, is never ingested.

The second path segment (`ev-trainer`, `ist335`) becomes `documents.collection` **verbatim** — folder
casing is the collection casing, and `filter_collection` matches with `=`. Files land as
markdown **first**, get embedded **second** — the vault stays human-readable and git-friendly, and
survives any change of tooling underneath it.

**Registered in Obsidian** (`%APPDATA%/obsidian/obsidian.json` names `C:Usersstackault` on
stack-laptop, checked 2026-09-29), with the Front Matter Title community plugin enabled.

Conventions, all live:

- **Every project and class folder has a hub note named after the folder**,
  `<realm>/<collection>/<collection>.md` (`projects/agentic-harness/agentic-harness.md`,
  `classes/ist323/ist323.md`), with frontmatter `id:` (UUID), `title:`, `collection:` and
  `type: index`. Obsidian labels a graph node by its filename, which is why the hub is not called
  `index` (R-N1; `node hooks/rename-hubs.mjs` renames the old ones). Class hubs also carry
  `term:` and `bb2dash_course:` (the exact bb2dash id — `IST.323`; `geo103` lists both
  `GEO.103.lecture` and `GEO.103.recitation`). Class folder names are the lowercase-hyphenated
  form of those ids. The UUID means a rename never orphans a row.
- **Session notes carry a readable title and their graph links in frontmatter.** A session's
  `title` is `<date> · <collection> · <first six words of the first prompt>`
  (`2026-09-24 · agentic-harness · ultracode. You are the orchestrator for`); a subagent's is
  `<date> · <collection> · <agent type> · <first six words of the task>`. Notes written before
  2026-09-24 keep their old titles. `up` links a session to its hub,
  `[[<realm>/<collection>/<collection>|<collection>]]`, and a subagent to its parent, path-qualified
  as `[[<realm>/<collection>/sessions/<parent-uuid>|<parent title>]]`, so following it before the
  parent note exists creates the file where the hook will write it, never at the vault root. The
  hook treats a 0-byte or frontmatter-less file at its target path as absent and writes over it.
  Files are named by UUID, so the graph shows titles only with the Front Matter Title plugin, a
  MANUAL install per machine (`docs/portable.md`, both runbooks).
- **`ingest: false` in frontmatter opts a note out of embedding.** It is reported as a skip, never
  hidden. It is not a delete: flipping it on an already-embedded note leaves the rows until
  `--prune` sweeps them. The vault-root `templates/` is skipped outright, like `.obsidian/`.
- **Class materials live in the vault but are NOT embedded here.** `uv run export-materials` (in
  `ingest/`) reads bb2dash's already-extracted text over PostgREST and writes one note per file to
  `classes/<course>/materials/<slug>-<id>.md`, each with `id: bb2dash-file-<id>` and `ingest: false`. The vault is
  where the material is *read*; retrieval over it stays in the bb2dash store via the `bb2dash` MCP
  server. Embedding it into harness-memory would put gte-small content into a bge-small index.
  The exporter refuses any `SUPABASE_URL` that is not the bb2dash project and only ever reads.
  Run it with `--env-file C:/Users/you/projects/bb2dash/.env`; it never merges that file into the
  process environment. 63 of 64 files exported 2026-09-10 (one is `text_status = na`).

### Session capture: SessionEnd hook → vault → ingest

The capability that claude-mem used to provide and that nothing currently replaces. Design:

1. A `SessionEnd` hook fires when a session ends.
2. It reads that session's transcript (Claude Code writes JSONL under
   `~/.claude/projects/<sanitised-cwd>/<session-id>.jsonl`).
3. It writes a markdown summary to `<vault>/<realm>/<collection>/sessions/<session_id>.md`
   (a subagent's note is `<session_id>--<agent_id>.md`)
   with YAML frontmatter carrying `collection`, `session_id`, `date`, and files touched.
4. The next ingest run embeds it. `content_hash` means re-running is free.

Collection is derived from the session's working directory. Unknown directories fall back to a
`misc` collection rather than being dropped — silently losing sessions is worse than filing them
imperfectly.

**Verified firing for real on 2026-09-09** (not just under a hand-fed payload): log line
`wrote projects/agentic-harness/sessions/2026-09-09-5ee983a8.md … ms=121`, note present in the
vault, and ingested on the next run as the store's first `source='obsidian'` document (the 18th
collection, `agentic-harness`). Hook lives at `~/.claude/hooks/session-capture.mjs`.

Two more paths feed the same folder (2026-09-16): the **nightly transcript sweep**
(`hooks/sweep-transcripts.mjs`) captures every idle transcript the hook never saw (SDK
review workers, killed sessions, teleported cloud sessions), and the **`/checkpoint`
skill** (`skills/checkpoint/`, installed into bb2dash and agentic-harness) lets a cloud
session write its own note into git, collected nightly by `hooks/collect-checkpoints.mjs`.
Notes carry `captured_by: hook | sweep | skill` and `origin`. See `hooks/README.md`.

## Environment

Read on stack-laptop, 2026-09-29:

- Windows 11. Both PowerShell and Git Bash available.
- `uv` 0.12.19 with a uv-managed Python 3.12 (`ingest/.python-version`).
- Node 24.19.0 at `C:/Program Files/nodejs/node.exe`.
- `gh` 2.101.0 on PATH, authed as `emstacho-su`. `sqlite3` is not on PATH.
- Docker Desktop running, with the optional local store's container `harness-postgres`
  (`pgvector/pgvector:0.8.6-pg17`) up; the repo `.env`'s `DATABASE_URL` still points at the
  Supabase pooler, so `harness-memory` is the store this machine ingests into.

### ⚠ Windows path gotcha — this has already broken two commands

Native Windows binaries (`node.exe`, `sqlite3.exe`) **cannot** read MSYS `/c/Users/...` paths. `node`
silently resolves them to `C:\c\Users\...` and fails with ENOENT.

- Pass `C:/Users/...` to any native binary.
- Only the bash shell itself (redirects, `ls`, `cp`, `find`) understands `/c/...`.
- If a script needs both, bind two separate variables.

### Credentials

A `.env` exists at the repo root and is confirmed gitignored. **Live and working:**

```
DATABASE_URL           # postgresql://postgres.hqkytnyiiuxovnnyixye:…@aws-0-us-east-1.pooler.supabase.com:5432/postgres
SUPABASE_DB_PASSWORD   # raw password; DATABASE_URL is assembled from it
```

bb2dash's `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE` **moved out** to the bb2dash checkout's own
`.env` (`~/projects/bb2dash/.env`). A stale service-role key for the wrong project sitting beside
the right one is a live footgun — do not reintroduce them here.

Never hardcode, never commit, never print a value. Schema changes go through the Supabase MCP
(`apply_migration`), which needs no local secret.

**Connection specifics that each cost an hour to discover:**

- Use the **session pooler** (`aws-0-us-east-1.pooler.supabase.com:5432`). The direct host
  `db.<ref>.supabase.co` is **AAAA-only** and this machine has no routable IPv6 — it fails with a
  misleading `ENOTFOUND`.
- Username is `postgres.<project-ref>`, not plain `postgres`. The pooler strips the suffix after
  routing, so auth failures report user `postgres` regardless.
- Port 6543 is the *transaction* pooler and does not support prepared statements. Use 5432.
- TLS needs Supabase's own root CA — committed at `certs/prod-ca.crt` (public, not a secret), valid
  to 2031, and covering every project in the org.
- **Hold a connection across a long embedding run and the pooler will reap it.** The first ingest died
  at document 276 with "the connection is closed" and failed the remaining 1,029. The store now
  reconnects and retries, with TCP keepalives.

### ⚠ Use direct Postgres, NOT PostgREST

Verified by probe: the `rag` schema is **not exposed to PostgREST** and will not be exposed.

```
POST /rest/v1/rpc/search  (Content-Profile: rag)
  -> HTTP 406  PGRST106
     "Only the following schemas are exposed: public, graphql_public"
```

This is deliberate, not an oversight. `bb2dash` is a real application with a public anon-facing REST
surface; putting the harness RAG schema on it would widen that surface for no benefit. Direct Postgres
is also far faster for bulk chunk inserts than thousands of HTTP round-trips.

**So: both the ingestion pipeline and the MCP server connect via `DATABASE_URL`.** Do not build a
PostgREST/`supabase-js` RPC path — it cannot reach `rag.search()`.

## Repo layout

```
agentic-harness/
  CONTEXT.md        <- this file
  README.md         <- primary user-facing doc
  docs/             <- architecture + diagrams
  db/migrations/    <- SQL mirroring what is applied to Supabase
  db/docker-compose.yml <- the optional local store (Docker pgvector)
  ingest/           <- Python ingestion pipeline (uv)
  mcp-server/       <- Node/TS stdio MCP retrieval server
  hooks/            <- SessionEnd capture hook, nightly transcript sweep, checkpoint collector (Node, zero deps)
  scripts/          <- nightly ingest, checkpoint collector, weekly curator, bootstrap, store backup (PowerShell + sh)
  skills/           <- /checkpoint skill for cloud sessions (copied into .claude/skills/)
  certs/            <- Supabase public root CA, pinned for TLS
  .harness/         <- checkpoint notes committed by cloud sessions, collected into the vault
```

Repo lives at `~/agentic-harness` (`C:/Users/stack/agentic-harness` on stack-laptop), deliberately
**outside OneDrive** — `.git` and OneDrive sync corrupt each other. Branch `main`. Public at
`https://github.com/emstacho-su/agentic-harness`, MIT.

## Conventions

- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
- Files 200–400 lines typical, 800 max. Small and focused over large and clever.
- Errors handled explicitly; never silently swallowed.
- Validate input at boundaries.
- Tests required. 80%+ coverage. No secrets in code, ever.
- Diagrams as **mermaid in fenced blocks** — they render natively in GitHub and in Artifacts.

## Phase status

| Phase | State |
| --- | --- |
| 0 Archive | done — `~/.claude-archive/2026-09-09/` on the machine the reset ran on, 839 files, 210 MB |
| 1 Export claude-mem | done — 4 JSON files + verified snapshot |
| 2 Teardown + rebuild harness | done — 71→12 skills, 58→0 agents, 60→0 commands, 22→1 hooks |
| 3 pgvector schema | done — `rag` schema live, verified |
| 4 Vault + ingestion | done — vault live and registered in Obsidian (2026-09-10), Fall 2026 class folders + index notes, bb2dash materials exported with `ingest: false`, SessionEnd capture verified |
| 5 Retrieval MCP server | done — registered with Claude Code as `rag` (user scope, `~/.claude.json`) |
| 6 Dev cycle | mostly done — user-level `~/.claude/CLAUDE.md` rewritten with required gates |
| 7 Hermes Agent | Shared-memory provider installed 2026-11-03; native contract and activation verified; new sessions load it. Restricted workflows remain prohibited until native persistence suppression is verified |
| 8 Self-evolution | deferred; repo currently unlicensed, re-check before adopting |
| 9 Docs repo | done — public on GitHub, docs rewritten for the harness-memory relocation |
| Memory sprint | proposed 2026-09-24 — `docs/memory-sprint-requirements.md`: phases N (hub names), H (`harness` realm, SessionStart brief, portable `~/.claude`), P (retrieval provenance), Q (store audit, location matrix), C (read-only curator); Hermes stays optional, the curator is tool-neutral |
| Curator C-a / C-b | built, not live (fixtures and a fake judge only) — `uv run ingest curate` stages inventory, extract, ledger, status, history and report (ingest/README.md, *Curator*); both `curate` migrations (`20260927200342_curate_schema`, `20260927214500_curate_status_scores`) are applied at L7; the weekly task (`scripts/weekly-curate.ps1|sh`, Sunday 04:30) is registered by Stack at L7 |
| Vault into realms | moved out of OneDrive 2026-09-23; R-D1 done 2026-09-24; open: R-B1's three-night push check and R-B4's credential test (`docs/vault-migration-requirements.md`), then Phases E and F. stack-laptop's nightly runs `-RealmSync DryRun` (checked 2026-09-29) |
| V-2 session capture | built 2026-09-16; acceptance walk and closure in bb2dash Phase 20 (brief 101), in progress on `feat/v2-closure` |
