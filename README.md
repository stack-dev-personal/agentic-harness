# agentic-harness

An agentic engineering harness for Claude Code, Codex and Hermes, plus a
Postgres + pgvector retrieval store that unifies an Obsidian vault with six
months of migrated agent-memory history — searchable by meaning and by keyword,
filtered by the project or class it came from.

Two problems, one repo:

1. **The harness had rotted.** Six months of accumulated configuration —
   71 always-on skills, 58 custom agents, 60 slash commands, 22 hooks and 220
   permission rules — most of it either broken or reimplementing something Claude
   Code now does natively. Phase 2 deleted it and rebuilt on built-ins.
2. **Memory was tied to a leaky daemon.** The previous memory system stored its
   real data in SQLite but ran a vector layer that leaked orphan processes and
   held file locks. The data was worth keeping; the machinery was not. It was
   exported and re-homed in Postgres.

The result: eligible sessions from all three runtimes write into the vault, the
vault is embedded into Postgres, and any agent can query the whole history
through one MCP server and one SQL function.

---

## Architecture at a glance

```mermaid
flowchart LR
    hook["Shared capture + checkpoints"] --> vault
    vault["Obsidian vault<br/>git realms, folder = collection"] --> ing
    cmem["claude-mem export<br/>1,305 documents"] --> ing

    ing["ingest/<br/>parse - chunk - embed - upsert"]
    ing <--> emb["fastembed<br/>bge-small-en-v1.5<br/>local, 384 dims"]

    cc["Claude Code"] --> mcp["mcp-server/<br/>Node stdio MCP<br/>registered as rag"]
    codex["Codex"] --> mcp
    hermes["Hermes Agent"] --> mcp
    mcp --> search["rag.search()<br/>vector + full-text, RRF<br/>0.70 cosine floor"]

    ing ==>|"DATABASE_URL"| db
    search --> db[("harness-memory<br/>Supabase Postgres 17<br/>pgvector 0.8.2, schema rag")]

```

All clients use the same retrieval service and memory contract.

- **Storage** — its own Supabase project, `harness-memory`. Two tables:
  `rag.documents` (one row per source artifact, tagged with a `collection`) and
  `rag.chunks` (embedded slices, 384-dim vector plus a generated `tsvector`).
  A machine that cannot reach Supabase runs the same schema in an optional local
  store, Docker pgvector from `db/docker-compose.yml`
  ([db/README.md](./db/README.md#the-optional-local-store)).
- **Vault** — the folder `HARNESS_VAULT` names in the machine file,
  `~/.harness/machine.env` (`C:/Users/stack/vault` on stack-laptop), outside
  OneDrive. Its top-level folders are git **realms** with private remotes, the
  ones listed in `HARNESS_REALMS`; the nightly job commits, merge-pulls and pushes
  them (`hooks/sync-realms.mjs`) when its task is registered with `-RealmSync Apply`
  (stack-laptop's runs `DryRun`, checked 2026-09-29). See [docs/portable.md](./docs/portable.md).
- **Embeddings** — `BAAI/bge-small-en-v1.5` run locally through `fastembed` on
  both the ingestion side (Python) and the query side (Node). 384 dimensions,
  cosine distance, HNSW index. No API key, no per-token cost, nothing leaves
  the machine. Parity between the two runtimes is measured, not assumed.
- **Retrieval** — one function, `rag.search()`. It runs a vector kNN search and a
  full-text search independently, fuses the two ranked lists with Reciprocal
  Rank Fusion, caps chunks per document, and applies a cosine relevance floor so
  an off-topic question returns nothing instead of its nearest junk.
- **Capture** — a `SessionEnd` hook writes each finished session to
  `<vault>/<realm>/<collection>/sessions/<session_id>.md` as redacted
  markdown: one note per session, keyed on the repository rather than the folder,
  carrying its branch, commits, PRs, phase, tags and resume chain. Rewrites merge
  into what is already there, so a tag typed by hand survives. The next ingest
  run embeds it; unchanged notes cost nothing.
- **Access** — RLS enabled with zero policies, and the `rag` schema is not
  exposed to the REST API at all. Clients connect over **direct Postgres**
  (`DATABASE_URL`) with the service role. A `supabase-js` RPC returns
  `HTTP 406 PGRST106` and cannot reach the store — deliberate, not a
  misconfiguration.

Full detail in [docs/](./docs/README.md).

### ⚠ Two stores exist. Never cross them.

A second, unrelated RAG store lives in the `bb2dash` project: class materials
embedded with `gte-small`. It is also 384-dimensional, so a query vector from
one model runs against the other's rows without error and returns
confidently-ranked nonsense. This repo owns `harness-memory` only; the MCP
server refuses a `DATABASE_URL` naming the bb2dash project.

---

## Status

| Phase | What | State |
| --- | --- | --- |
| 0 | Archive the old harness | ✅ Done — 839 files, 210 MB, `~/.claude-archive/2026-09-09/` on the machine the reset ran on (not on stack-laptop) |
| 1 | Export claude-mem history | ✅ Done — 4 JSON files + verified 56 MB snapshot |
| 2 | Teardown and rebuild the harness | ✅ Done — 71→12 skills, 58→0 agents, 60→0 commands, 22→1 hooks, 220→0 permission rules |
| 3 | pgvector schema | ✅ Done — migrations applied to `harness-memory` and mirrored in `db/migrations/` (9 files) |
| 4 | Vault + ingestion pipeline | ✅ Done — 1,319 documents / 2,312 chunks / 27 collections at the time (2026-09-09); vault open in Obsidian with Fall 2026 class folders and bb2dash materials. `ingest/`: 1,706 passed, 3 skipped |
| 5 | Retrieval MCP server | ✅ Done — registered with Claude Code as `rag`; verified against the live store. `mcp-server/`: 196 tests in 11 files, all passing |
| 6 | Dev cycle | ✅ Done — user-level `~/.claude/CLAUDE.md` rewritten with required gates |
| 7 | Second agent on the same store | ⏸ Deferred. Schema is already agent-neutral |
| 8 | Self-evolution loop | ⏸ Deferred |
| 9 | Docs + diagrams | ✅ This |
| V-2 | Session capture v2: one note per session, schema v2, tags, resume chains, sweep, `/checkpoint` | Built 2026-09-16; its acceptance walk and closure are bb2dash Phase 20 (brief 101), in progress. `hooks/`: see the test line below |
| Vault | Out of OneDrive into git realms (`docs/vault-migration-requirements.md`) | Moved into realms 2026-09-23 (Phase C); R-D1 done 2026-09-24. Open: the three-night push check (R-B1) and the credential-less push test (R-B4), then E (the VM) and F (smoke test, deleting the old copies) |
| Memory sprint | Hub names, `harness` realm, SessionStart brief, retrieval provenance, store audit, curator (`docs/memory-sprint-requirements.md`) | In progress; the board is `docs/memory-sprint-status.md` |

Test counts above are from runs on 2026-09-29 on `feat/v2-closure` (harness `main` at
`9cffe90` plus Phase 20, integrated): `uv run pytest -o addopts="" -q` in `ingest/` (1,706
passed, 3 skipped) and `npm ci && npm run typecheck && npm test` in `mcp-server/` (196 passed).
`npm test` in `hooks/`: 1,083 tests, 1,080 passed, 3 skipped, 0 failed.

What is verifiable right now, against the live project:

- `rag.documents` held 1,319 rows across 27 collections and `rag.chunks` 2,312
  on 2026-09-09, every chunk with a 384-dim embedding and a generated `tsv`; the
  counts move nightly (`select source, count(*) from rag.documents group by 1`).
- `rag.search()` returns real results with real cosine similarities: relevant
  hits on this corpus score 0.79–0.87, unrelated queries 0.48–0.66, and the
  0.70 floor turns "banana bread recipe" into an honest empty result.
- The `SessionEnd` hook has been observed firing unprompted; its note was
  ingested on the next run as the store's first `source='obsidian'` document.
- `npm test` in `mcp-server/`, `uv run pytest` in `ingest/` and `npm test` in
  `hooks/` are the three suites; CI runs them on every push to `main` and on pull
  requests. All three mock the database,
  the model and the network, so they need no credentials.

---

## Repo layout

```
agentic-harness/
├── README.md            you are here
├── CONTEXT.md           shared context every agent on this project reads first
├── .env.example         connection variables — copy to .env, never commit .env
├── .github/workflows/   CI: the three test suites on Windows and Ubuntu
├── .harness/            /checkpoint notes committed by cloud sessions, collected into the vault
├── certs/prod-ca.crt    Supabase's public root CA, pinned by both clients
├── docs/
│   ├── README.md        documentation index
│   ├── architecture.md  system design and the decisions behind it
│   ├── harness-reset.md what was deleted in Phase 2 and why
│   ├── ingestion.md     parse → chunk → embed → upsert, vault layout, session capture, the nightly
│   ├── embeddings.md    tokenization → 384-dim vectors → HNSW, runtime parity
│   ├── retrieval.md     hybrid search, RRF, the relevance floor, the contract
│   ├── tags.md          the controlled tag vocabulary for session notes
│   ├── portable.md      realms, the machine file, the local store, the runbooks
│   ├── vault-migration-requirements.md   the vault's move into realms: requirements and gates
│   └── memory-sprint-*.md                the memory sprint: requirements, orchestration, status
├── db/
│   ├── README.md        project ref, connection gotchas, access model, migration mirror, local store
│   ├── docker-compose.yml  the optional local store (Docker pgvector)
│   └── migrations/      SQL mirroring what is applied to harness-memory
├── hooks/               session capture and start hooks, sweeps, realm sync, their tests and installers
├── ingest/              Python ingestion pipeline (uv)
├── mcp-server/          Node/TS stdio MCP retrieval server
├── scripts/             the nightly job, the checkpoint collector and weekly curator tasks, bootstrap, store backup
└── skills/checkpoint/   the /checkpoint skill for cloud sessions, installed into each repo
```

The repo lives at `~/agentic-harness` (`C:/Users/stack/agentic-harness` on
stack-laptop), deliberately **outside OneDrive**: `.git` and OneDrive sync corrupt
each other. The vault is outside OneDrive too, since 2026-09-23: its realms are
git repositories, and git moves them between machines.

---

## Quickstart

### Prerequisites

| Tool | Notes |
| --- | --- |
| Supabase project with pgvector | `harness-memory` (`hqkytnyiiuxovnnyixye`), pgvector 0.8.2 |
| `uv` | 0.9.26+; it manages Python itself (`uv python install 3.12`) |
| Node | ≥ 20.11 (developed on 24.13.0) |
| Docker | Optional. Only the local store needs it (`db/docker-compose.yml`); a machine on Supabase does not |
| Machine file | `~/.harness/machine.env`: `HARNESS_MACHINE`, `HARNESS_VAULT`, `HARNESS_REALMS` and the rest ([docs/portable.md](./docs/portable.md)) |

### 1. Configure credentials

```bash
cp .env.example .env
# fill in DATABASE_URL — the session pooler, postgres.<ref> username, port 5432
```

`.env` is gitignored. Nothing in this repo hardcodes a connection string. The
connection details that each cost an hour to discover are in
[db/README.md](./db/README.md#connection-specifics--each-of-these-cost-an-hour).

### 2. Apply the database schema

Already applied to `harness-memory`. To reproduce it elsewhere, run the files in
`db/migrations/` in filename order:

```bash
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

Against the live Supabase project, schema changes go through the Supabase MCP
`apply_migration` tool instead — it authenticates without a local secret. The
files here are the mirror, not the mechanism.

### 3. Ingest

```bash
cd ingest && uv sync && uv run pytest
uv run ingest --source claude-mem --path C:/Users/you/.claude-archive/2026-09-09/claude-mem-export   # one-time, done 2026-09-09
uv run ingest --source obsidian   --path "C:/Users/you/vault"
```

Re-run the vault ingest whenever you like; `content_hash` skips every unchanged
note, so a run after one session embeds one document. A note whose *frontmatter*
changed but whose body did not — a session concluded by the nightly sweep, say —
gets its `title` and `metadata` refreshed with one UPDATE and no embedding. See
[ingest/README.md](./ingest/README.md) for every flag, including the repeatable
`--only` and the guarded `--prune` orphan sweep.

Class materials are a separate, read-only step: `uv run export-materials`
copies bb2dash's extracted text into `classes/<course>/materials/` as notes
flagged `ingest: false`, so they are readable in Obsidian but searched through
the `bb2dash` MCP server, never embedded here (the two stores use different
models). Details in [docs/ingestion.md](./docs/ingestion.md).

### 4. Register the retrieval server with Claude Code

```powershell
cd mcp-server; npm install; npm run build; npm test
```

MCP servers are configured with the `claude mcp` CLI, which writes user-scope
servers to `~/.claude.json` (not `settings.json`). Build the JSON from `.env` so
the secret never appears on a command line:

```bash
JSON=$(node -e '
const env=Object.fromEntries(require("fs").readFileSync(".env","utf8").split(/\r?\n/)
  .filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf("=");return[l.slice(0,i),l.slice(i+1).trim()]}));
process.stdout.write(JSON.stringify({type:"stdio",command:"C:/Program Files/nodejs/node.exe",
  args:["C:/Users/you/agentic-harness/mcp-server/dist/index.js"],
  env:{DATABASE_URL:env.DATABASE_URL,
       DATABASE_CA_CERT:"C:/Users/you/agentic-harness/certs/prod-ca.crt",
       FASTEMBED_CACHE_DIR:"C:/Users/you/agentic-harness/mcp-server/.fastembed-cache"}}))')
claude mcp add-json rag "$JSON" -s user
claude mcp list        # rag: ✔ Connected
```

After restarting Claude Code the tools appear as `mcp__rag__search_context` and
`mcp__rag__get_document`. Details in [mcp-server/README.md](./mcp-server/README.md).

### 5. Install the session-capture hook

```bash
cd hooks && npm test          # no dependencies
node install.mjs --dry-run    # what would change in ~/.claude/hooks
node install.mjs              # copy, then verify every file by SHA-256
```

`~/.claude/settings.json` registers
`~/.claude/hooks/session-capture.mjs` as a `SessionEnd` hook. The installer
copies into that directory rather than pointing settings at a checkout: a
worktree gets deleted, and a hook that goes with it takes every future session's
note along. Details in [hooks/README.md](./hooks/README.md).

### 6. Search

From Claude Code, ask anything that depends on past decisions or project
history; the server embeds the query locally and calls `rag.search()`. Or go
straight to SQL:

```sql
select doc_collection, doc_title, vector_similarity, left(chunk_content, 120)
from rag.search(query_text => 'retrieval ranking', match_count => 5);
```

### Codex desktop and CLI

Both Codex clients read `~/.codex/config.toml`. Build the MCP server above, then
register it once (adjust paths for the machine):

```toml
[mcp_servers.rag]
command = "C:/Program Files/nodejs/node.exe"
args = ["C:/Users/you/agentic-harness/mcp-server/dist/index.js"]
cwd = "C:/Users/you/agentic-harness/mcp-server"

[mcp_servers.rag.env]
HARNESS_ENV_FILE = "C:/Users/you/agentic-harness/.env"
```

Restart Codex desktop after changing the MCP config. `codex mcp list` confirms
the CLI registration; ask Codex to call `rag.search_context` for an end-to-end
check. The `.env` stays in the harness checkout, not in the TOML file.

All clients share the [model-agnostic memory pipeline](docs/model-agnostic-memory.md).
Claude Code, Codex and Hermes use one capture policy, durable queue, checkpoint
worker, chunker, embedding model and retrieval service. Runtime/model identity
is provenance. See [Hermes installation](hermes/README.md) for profile setup.

For the Codex start brief and chat capture, register `hooks/codex-session-start.mjs`
as a `SessionStart` command (matcher `startup|resume`) and
`hooks/codex-session-capture.mjs` as a `SessionEnd` command in
`~/.codex/hooks.json`, then trust both in Codex's Hooks review. On
Windows, run `scripts/register-memory-worker.ps1 -Apply`: all hooks queue new
vault notes and start the same hidden task. Every five minutes it saves and
indexes new or changed sessions across runtimes, including chats left open.
The registration replaces the old Codex-only schedule with the common worker. See
[hooks/README.md](./hooks/README.md) for the exact JSON and logs.

---

## Windows path gotcha

Native Windows binaries — `node.exe`, `sqlite3.exe`, the Python interpreter —
cannot read MSYS-style `/c/Users/...` paths. `node` silently resolves such a path
to `C:\c\Users\...` and fails with `ENOENT`, which looks like a missing file
rather than a malformed path.

- Pass `C:/Users/...` to any native binary.
- Only the bash shell itself — redirects, `ls`, `cp`, `find` — understands
  `/c/...`.
- A script needing both should bind two separate variables.

This has already broken two commands during this project.

---

## Conventions

- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
- Files 200–400 lines typical, 800 max.
- Errors handled explicitly, never silently swallowed. Input validated at
  boundaries.
- Tests required, 80%+ coverage. Both suites run with no credentials.
- No secrets in code, ever.
- Diagrams are mermaid in fenced blocks so they render on GitHub without a build
  step.

---

## A note on honesty in this documentation

If a document here describes something in the present tense, it should be
verifiable against the live database or the filesystem. Phases 7 and 8 are
designs and say so. If you find present-tense prose that you cannot verify, that
is a bug in the documentation — please treat it as one.

## License

MIT — see [LICENSE](./LICENSE).
