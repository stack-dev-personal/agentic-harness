# Hermes shared memory adapter

This standalone provider connects Hermes to the same vault capture, queue,
startup brief, and retrieval tools used by Claude Code and Codex. It adds no
embedding model, ranking algorithm, cloud memory service, or runtime-specific
retrieval defaults. Runtime/provider/model identity is provenance.

## Install and activate

Build the existing `mcp-server` first. Preview the additive installation for the
owning Hermes profile, using the actual home reported by Hermes:

```powershell
node hermes/install.mjs --home C:/Users/stack/AppData/Local/hermes
node hermes/install.mjs --home C:/Users/stack/AppData/Local/hermes --apply
```

The installer creates `plugins/harness-memory/` and `harness-memory.json`. It
refuses to replace differing files and leaves `config.yaml` untouched. Select
`harness-memory` through Hermes's native memory-provider setup, or set
`memory.provider: harness-memory` through its supported configuration interface.
Start a new session after activation. Each profile is configured separately.
The sidecar contains only `enabled`, an absolute harness `repo` path, and the
`node` executable path. It must never contain credentials.

To refresh an existing provider, first preview the source changes:

```powershell
node hermes/install.mjs --home C:/Users/stack/AppData/Local/hermes --update
```

After reviewing the diff and obtaining approval to replace the installed files,
apply with the same arguments plus `--apply`. The installer saves replaced files
under the profile's `backups/` folder. Start a new Hermes session after updating.

For an installation without a CLI on PATH, `hermes/activate.py` provides the
same selection through Hermes's native configuration writer. Run it with the
installed Hermes Python, explicit `--source` checkout and `--home` profile.
It previews by default; `--apply` backs up the profile configuration and changes
only `memory.provider` with the native merge operation. It refuses to replace an
unexpected external provider. `hermes/tests/native_contract.py --source <checkout>`
verifies native provider discovery and configuration using a new temporary home.

The MemoryProvider instance binds the `hermes_home` and workspace passed by
Hermes. It obtains the shared start brief once, exposes the existing MCP
`search_context` and `get_document` schemas verbatim, checkpoints completed
turns as active notes, and concludes notes at real session boundaries.
Meaningful delegation callbacks capture the child's own task and result using
its stable native child-session id. Native `MEMORY.md` and `USER.md` writes are
not mirrored or imported.

Only sessions started while the provider is enabled enter the metadata-only
registration index at `<profile>/state/harness-memory-sessions.json`.
Registration records contain a first-registration timestamp that is preserved
across resumes. The recovery worker also discovers native delegated descendants
created after that timestamp, with verified parent ancestry and the child's own
assignment. Older children and ordinary branched sessions are not opted in.
Parent exclusions and protected working folders apply before reading child
message content. Registration records contain no task or response text.

The shared recovery worker can read those sessions from the native SQLite
database using read-only access. Historical sessions are not automatically
registered or bulk-imported. The adapter selects human/assistant records and
normalized tool inputs; it does not query tool-output or reasoning columns.

## Restricted sessions

The shared policy accepts explicit `memory_excluded`, `classification`,
`data_classification`, and `purpose` values. These may be set in this profile's
`harness-memory.json` before a session starts. The shared
`HARNESS_MEMORY_PERSISTENCE=off` switch and protected-root policy also apply.
Excluded sessions receive no harness registration, capture, or recall.

This adapter cannot retroactively prevent Hermes's own raw session history,
native memory, autonomous skill creation, or other active plugins from retaining
content. Hermes normally persists its raw history before a completed-turn
callback. Installing this provider alone does not make restricted-data work
safe. Native history and memory controls must be verified separately before any
restricted session is allowed. The harness does not claim otherwise and must
stop if restricted material is found in an exportable location.
No restricted workflow should use this integration until native history
suppression is supported and tested. Autonomous skill creation remains governed
by the user's approval requirement; this provider never creates or edits skills.

## Verification

```powershell
node --test hooks/tests/hermes-capture.test.mjs hermes/tests/bridge.test.mjs
uv run --directory ingest python -m unittest discover -s ../hermes/tests -p test_provider.py
```

The synthetic tests use temporary profile homes, fixture databases, and injected
transports. They do not read historical memory, credentials, or live sessions.

The provider's registration lock currently times out if a crashed process leaves
its lock file behind. It reports registration failure rather than treating an
unverified lock as free; stale-lock recovery remains a reliability limitation.

## Upstream interface attribution

Integration interfaces are adapted from `NousResearch/hermes-agent`, MIT,
inspected at commit `b200f5bc60`: `agent/memory_provider.py`,
`plugins/memory/__init__.py`, `hermes_state_common.py`, and
`website/docs/developer-guide/memory-provider-plugin.md`.
No upstream implementation is copied. See the upstream
[license](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE),
[provider guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers),
and [hook lifecycle](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks).
