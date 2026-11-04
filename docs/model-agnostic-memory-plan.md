# Model-agnostic harness memory

Status: approved by the user on 2026-11-03; implementation verified on Windows;
installed-provider refresh awaits user approval.
Branch: `feat/model-agnostic-memory`.

## Objective

Claude Code, Codex, and Hermes use one memory methodology. Equivalent work
receives the same capture, exclusion, lifecycle, ingestion, chunking, embedding,
and retrieval treatment regardless of runtime, provider, or model.

The existing uncommitted Codex capture repair is the starting point and must be
preserved. The user approved implementation in the originating session. Bulk
historical reconciliation and destructive changes still require separate approval.

## Verified current state

- Shared note rendering/merging, collection routing, chunking, local
  `BAAI/bge-small-en-v1.5` embeddings (384 dimensions), and `rag.search()` already exist.
- Claude uses detached ingestion; Codex uses a durable queue and scheduled worker.
- Five-minute active-session checkpoints currently apply only to Codex.
- Claude creates linked child-session notes; Codex excludes child rollouts.
- The vault loader excludes sessions by the Claude-specific `sdk-*` origin prefix.
- Unattributed notes default to `claude-code`, even when authorship is unknown.
- Hermes's current home is `C:/Users/stack/AppData/Local/hermes`; its installed
  source checkout is the `hermes-agent` child, inspected at commit `b200f5bc60`.
  The checkout exposes a MemoryProvider interface and lifecycle hooks.
  Live Hermes-to-harness capture and retrieval have not been exercised.
- The harness plan named by the global instructions,
  `~/.claude/plans/abundant-gathering-wirth.md`, was not found. This proposal
  uses `CONTEXT.md`, the checked-in architecture and memory-sprint documents,
  current code, and native vendor documentation instead.
- The prior full hook test run reported 1,203 passes, eight skips, and one
  diagnostic failure caused by loading the checkout's real `.env` in a fixture.
  Implementation must resolve test isolation and obtain passing required checks.

## Proposed design decisions

### One contract and one pipeline

Each runtime adapter translates native input into a canonical session record:
stable session identity, role/purpose, parent/child relationships, human prompts,
assistant outcomes, normalized activity, retrieval provenance, timestamps,
lifecycle state, and persistence eligibility.

Shared code owns policy, redaction, note rendering/merging, durable queueing,
five-minute checkpoints, retries, recovery, and collection routing. Native
adapters own format and event translation only. Adapters must report unsupported
capabilities explicitly rather than silently discard eligible content.

Keep runtime, provider, and model identifiers distinct. Retain provenance for
audit and explicit filtering; it must not change default ranking, thresholds,
retention, eligibility, or the canonical content sent for embedding. Preserve
existing external IDs and history. Unknown attribution must remain unknown.

### One eligibility and lifecycle policy

Meaningful main sessions and delegated tasks are eligible across runtimes.
Exclude housekeeping and derivative observer work by explicit purpose and policy,
not by runtime names, model names, or SDK prefixes. Child notes include their
own task, result, and activity, excluding inherited parent context, and link to
the parent. Apply matching inclusion and exclusion tests to all adapters.

All runtimes use active checkpoints, clean-close finalization, interruption
recovery, resume handling, and idempotent replay. Runtime event names do not
define shared lifecycle semantics. For example, Hermes's `on_session_end` can
fire after each turn; it cannot automatically mean a concluded conversation.

### Hermes joins the existing memory store

Use supported Hermes hooks/plugin interfaces and the existing retrieval Model
Context Protocol (MCP) server. Provide the shared startup brief, session capture,
and recall with the same collection scope and budgets used by the other clients.
Avoid editing Hermes core files. Bind the integration to the owning profile.

Proposed session path: every runtime writes the same vault-note type, loaded
through the existing Obsidian loader with `source='obsidian'`. This explicitly
updates the older architecture proposal for a separate `source='hermes'` producer.
Existing source keys remain valid; no rekeying or duplicate ingestion.

Hermes's `MEMORY.md`, `USER.md`, session search, and autonomous skill writes are
separate native persistence paths that must be included in the policy audit.
Do not bulk-export these files or enable a second cloud memory provider.
Any added curated-memory write path must obey the shared policy and must not
quietly create a Hermes-only definition of shared memory.

### Restricted-data boundary before persistence

Use a shared, explicit session exclusion/taint mechanism and protected path/realm
policy. Excluded sessions produce no vault bodies, queue bodies, embeddings,
retrieval-event bodies, native-memory writes, or self-created skills containing
restricted content. Metadata-only diagnostics must not reproduce that content.

Secret redaction is not restricted-data classification. A regular-expression
scan alone cannot prove a session is safe. Policy instructions that mention a
classification label are not themselves classified content.

Audit native transcript and memory persistence separately for each runtime.
Post-session export filtering cannot undo an earlier native-history write.
Where verified suppression is unavailable, declare that limitation and block
restricted-session use of that persistence path. Do not claim full protection
until runtime-specific tests establish it. If restricted material is found,
stop and notify the user; do not move, delete, export, or remediate it unilaterally.

## Implementation increments

- [x] Add canonical fixtures and failing parity tests; repair the diagnostic
  fixture's `.env` isolation without changing live credentials.
- [x] Extract shared capture policy, durable queue, checkpoint/recovery worker,
  and scheduling from the current implementations. Adapt Claude and Codex and
  retain compatibility entry points during verification.
- [x] Add a profile-aware Hermes integration using the installed supported
  hooks/provider interfaces and the existing MCP retrieval path.
- [x] Unify parent/child handling, automated-session eligibility, attribution,
  restricted-session exclusion, and provenance across all three runtimes.
- [ ] Verify installers and live behavior with synthetic unrestricted sessions;
  preview any historical reconciliation before requesting approval for changes
  to existing data. Update architecture, operator docs, and `CONTEXT.md`.
- [x] Complete tests, code review, and security review; resolve CRITICAL/HIGH
  findings and required failures, then commit conventionally. No push, merge,
  production deployment, or remote migration without explicit authorization.

## Acceptance criteria

- [ ] Equivalent synthetic Claude/Codex/Hermes sessions yield the same canonical
  embedding content and chunk boundaries, with provenance retained separately.
- [ ] Changing only runtime/model metadata changes neither embedding inputs nor
  default retrieval arguments, thresholds, eligibility, or source filters.
- [ ] Identical queries and collection scope through each client return the
  same ranked document IDs and scores from the common retrieval service.
- [ ] All adapters pass active-checkpoint, finalization, interruption, resume,
  retry, duplicate replay, missing/moved transcript, and concurrent-append tests.
- [ ] All adapters pass meaningful-child and inherited-context exclusion tests.
- [ ] Restricted/excluded synthetic fixtures cause no content persistence or
  export through any supported capture, memory, queue, or retrieval-event path.
- [ ] Restarts recover queued work; a crash between note write and queue append
  cannot strand a note. Health output exposes failures and coverage per runtime.
- [ ] Tests meet the applicable 80% coverage target. Required unit, integration,
  and end-to-end checks pass; unavailable live checks are reported precisely.

## Reuse and references

Prefer the harness's existing shared modules and current queue/checkpoint code
(this repository, MIT). Adapt supported Hermes interfaces from
`NousResearch/hermes-agent` (MIT), specifically `agent/memory_provider.py`, the
plugin memory-provider registration interface, and native lifecycle hooks.
Record pinned upstream files and license attribution if code is copied.

- [Hermes event hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Hermes memory providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
- [Hermes source and MIT license](https://github.com/NousResearch/hermes-agent)
- [Codex hook inputs](https://learn.chatgpt.com/docs/hooks#common-input-fields)

## Final verification resume, 2026-11-03

Native Hermes provider discovery, abstract-interface compatibility, and native
configuration writing now pass through the installed Hermes Python using a new
temporary profile. The live profile's activation preview already selects
`harness-memory`. No model requests or user-history reads were used for this
contract check.

Review found and repaired three further issues, with failing regressions written
before implementation: ordinary successor sessions were incorrectly treated as
delegates and lost their user prompts; serialized `ancestor_sessions` was omitted
from the JavaScript queue policy; and Hermes live/recovery capture lacked the
shared realm locks. Recovery now defers before reading native message bodies
when the realm is held, without advancing the checkpoint. Code and security
review found no remaining HIGH findings in the reviewed changes.

Current verification evidence:

- [x] Combined capture, SQLite, recovery, queue, policy, bridge and locking
  regressions: 59 passed, no skips.
- [x] Hermes provider: 16 passed, 82% line coverage.
- [x] Native Hermes discovery/configuration contract: passed.
- [x] Shared retrieval: 196 passed; typecheck passed.
- [x] Routing, move-to-realm, startup brief and fixture-path suites: 62 passed.
  The test-only helper retains native Windows long-name expansion and falls back
  to standard canonicalization only on EPERM/ENOSYS. Production protected-path
  checks are unchanged.
- [x] CI now runs Hermes bridge and provider suites on Windows and Linux.
  Remote CI execution has not been requested or performed.
- [x] Full hook suite in the user's normal terminal: 1,261 passed, zero failed,
  eight platform skips; 95.95% line coverage. The earlier local-Git and native
  path-resolution failures were specific to the sandbox execution environment.
- [x] Full ingestion in the user's normal terminal: 1,794 passed, 95% line
  coverage. Protected-path policy was not weakened to obtain this result.
- [x] Nightly PowerShell runner: all cases passed in the normal terminal.
- [x] Original normal-terminal logs are retained at
  `C:/Users/stack/work/hermes-final-verification-20261103-203843-5385`.
  The provider result in that original `results.json` is a verifier false
  failure: Windows PowerShell treated expected unittest stderr as terminating.
  The provider action now allows stderr and uses the native exit code, with a
  failure sentinel if launching a native command fails. Regression probes verify
  stderr/success -> 0, stderr/failure -> 7, and missing executable -> 1.
- [x] The exact corrected provider action rerun through the verifier passed all
  16 tests at 82% coverage. Supplemental logs and `provider-result.json` are at
  `C:/Users/stack/work/hermes-provider-confirmation-20261103-204639-0127`.
- [ ] Latest provider source still differs from the installed copy. Approval is
  required before replacing the installed file. Live behavior after that update
  remains a separate verification step.

Next action: obtain user approval for the reviewed installed-provider update,
which replaces only `plugins/harness-memory/__init__.py` after backing it up.
The corrected `C:/Users/stack/work/Verify-HermesMemoryFinal-20261103.ps1` remains
available for future synthetic verification. It does not install, capture live
sessions, reconcile historical data, migrate a database, or commit. No historical
reconciliation or provider replacement has been performed. Native Hermes history
suppression remains unverified; restricted workflows remain prohibited.
