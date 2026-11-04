# Shared memory across Claude Code, Codex, and Hermes

All three clients use the same session policy, vault-note writer, merge rules,
durable queue, five-minute checkpoint worker, ingestion loader, chunker, local
`BAAI/bge-small-en-v1.5` embeddings (384 dimensions), and `rag.search()` ranking.
Adapters translate native events and storage formats. Runtime, model and provider
are provenance, never implicit ranking weights or retrieval filters.

Codex paginated sessions are read from native SQLite history in read-only mode.
That history is authoritative even when legacy rollout files remain on disk;
recovery never falls back to a stale rollout for a paginated thread. Unsupported
native schema versions report a capability error and leave data untouched.

## Capture and retrieval contract

Meaningful main sessions and delegated tasks are eligible regardless of runtime
or SDK origin. Explicit purposes `housekeeping`, `observer`, and `derivative` are
excluded. Delegated notes contain their own assignment, result and activity, with
parent/child links; inherited parent prompts are not re-exported.

Native event names are translated to shared lifecycle states. Checkpoints remain
active; actual session termination concludes a note. Existing external IDs and
resume chains are retained. Replaying an unchanged native revision does not
create duplicate notes. An interrupted handoff cannot strand a written note:
the worker retries it until a durable path-only queue entry exists.

Captured sessions from every runtime pass through the Obsidian loader as
`source='obsidian'`. `agent`/`runtime` identify the producing runtime; `model` and
`provider` are recorded when native metadata supplies them. Unknown authorship
remains `unknown`. Historical source keys, including `hermes` and `claude-mem`,
remain valid and are not rewritten.

Generated schema-v2 session notes have a canonical embedding view containing
their task, outcome, activity and handwritten additions. Machine-generated
session IDs, local transcript paths, runtime/model provenance and lifecycle facts
remain in the stored raw body and metadata, outside embedding content. A metadata
or lifecycle-only update refreshes the raw record without re-embedding.

Every client uses the existing MCP `search_context` and `get_document` contract.
Hermes obtains the same startup brief and exposes the same tool schemas. It adds
no provider-specific source filter, query prefix, embedding model or ranking rule.

## Installation and health

Node 22.13 or newer is required for read-only native Hermes SQLite recovery.

```powershell
node hooks/install.mjs --dry-run
node hooks/install.mjs
./scripts/register-memory-worker.ps1
./scripts/register-memory-worker.ps1 -Apply
node hooks/memory-worker.mjs --preview
node hooks/memory-worker.mjs --health
```

Claude's installer backs up and verifies deployed hooks. The scheduled task is
`AgenticHarness-Memory`, runs hidden every five minutes, and also starts on a
capture handoff. Registration backs up existing task definitions and disables
the old Codex-only task. The old script and queue names remain compatibility
entry points; the common worker drains legacy pending work.

On POSIX, schedule `node <harness>/hooks/memory-worker.mjs` every five minutes
using the machine's existing scheduler. All runtimes still use the same worker.

Hermes installation and profile activation are documented in
[hermes/README.md](../hermes/README.md). Its provider uses native serialized
background checkpointing and actual session-boundary callbacks. Existing native
`MEMORY.md`/`USER.md` files are not bulk-imported or mirrored as a second producer.

Worker state lives outside the vault under `~/.harness/`:

- `memory-ingest-queue.jsonl` and retained processing files contain note paths.
- `memory-checkpoints.json` records native revisions and already-queued paths.
- `memory-activation.json` limits discovery to recent/new activity; historical
  content is not automatically backfilled.
- `memory-health.json` and `memory-worker.log` report runtime coverage, failures,
  exclusions and ingestion counts without copying session text.
- `memory-exclusions/` stores hashed session identities and content-free sticky
  exclusion reasons, including parent exclusion inheritance.

Invalid queue entries remain recoverable while eligible sibling entries process.
Only one common worker runs at a time. A health record older than fifteen minutes
or reporting failures makes `--health` exit unsuccessfully.

## Restricted sessions

Set classification/exclusion before any content is supplied. The shared policy
recognizes `memory_excluded: true`, `restricted: true`, `persistence: exclude`,
`classification`/`data_classification` values `TLP:AMBER`, `TLP:AMBER+STRICT`,
`TLP:RED`, or `restricted`, and protected filesystem roots. Malformed
classification or protected-root configuration fails closed. Explicit session
exclusions remain in effect after restart and apply to children.

```powershell
$env:HARNESS_MEMORY_PERSISTENCE = 'off'
$env:HARNESS_MEMORY_EXCLUDED_ROOTS = '["C:/private-work"]'
```

The global switch blocks harness capture, recall, ingestion and brief records.
Protected-root checks resolve relative paths in the session/entry working
directory and follow junctions. Neither secret redaction nor a label-scanning
regular expression establishes that arbitrary content is unrestricted.

These controls govern the harness. They cannot undo native transcript writes or
remote model requests that already occurred. Before restricted work, each native
runtime must independently have verified history/memory suppression and local-only
processing. Claude documents `CLAUDE_CODE_SKIP_PROMPT_HISTORY` and
`CLAUDE_CODE_DISABLE_AUTO_MEMORY`; Codex documents `exec --ephemeral` and separate
local memory controls. `history.persistence=none` alone does not establish Codex
rollout suppression. Verify these controls for the installed runtime before use.

No supported global native-history suppression was established for this Hermes
installation. Restricted workflows through Hermes remain prohibited even with
this adapter installed. Native session search, memories, background review,
self-created skills, other plugins and model traffic are separate persistence
and egress paths. If restricted material is found, stop and notify the user;
do not move, delete, export or reconcile it unilaterally.

## Historical reconciliation

Existing session records can still hold their previous embedding view until
explicitly reconciled. New/changed sessions use the shared canonical view.
Preview the affected historical notes before a bulk re-embedding, attribution
update or eligibility change; apply only with user approval. No rekey, prune,
delete, remote schema migration or credential change is required by this feature.

## Verification and upstream interfaces

Synthetic fixtures test equivalent runtime captures and embedding inputs, native
lifecycle translation, delegated-context isolation, retries, exclusion inheritance,
protected-path aliases and shared recall defaults. Tests use temporary profiles;
native Hermes discovery/activation can be tested without model calls using
`hermes/tests/native_contract.py`.

- [Codex hook inputs](https://learn.chatgpt.com/docs/hooks#common-input-fields)
- [Claude CLI controls](https://code.claude.com/docs/en/cli-reference)
- [Claude memory controls](https://code.claude.com/docs/en/memory)
- [Hermes native hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- [Hermes memory providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)

Reuse: existing agentic-harness modules (MIT), and supported interfaces from
`NousResearch/hermes-agent` at `b200f5bc60` (MIT). The integration does not patch
Hermes core or copy upstream implementation code.
