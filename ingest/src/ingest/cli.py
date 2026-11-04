"""Command line entry point.

    uv run ingest --source obsidian   --path C:/Users/you/vault
    uv run ingest --source claude-mem --path C:/Users/you/.claude-archive/.../claude-mem-export
    uv run ingest --source obsidian   --path C:/Users/you/vault --dry-run
    uv run ingest --source obsidian   --path C:/Users/you/vault --only projects/x/sessions/y.md
    uv run ingest --source obsidian   --path C:/Users/you/vault --only a.md --only b.md
    uv run ingest sweep-concluded     --path C:/Users/you/vault [--apply]
    uv run ingest eval                [--json] [--min-hit-rate 0.8]
    uv run ingest db migrate          [--dry-run]
    uv run ingest embed-check         [--json] [--threshold 0.999] [--record [--force]]
    uv run ingest verify              --path C:/Users/you/vault [--sample 50] [--seed N] [--json]
    uv run ingest report retrievals   [--json] [--since 14d] [--limit 20]
    uv run ingest curate inventory    --path C:/Users/you/vault [--collection X] [--json] [--no-git]
    uv run ingest --health

A session note's ``retrievals:`` frontmatter is projected into
``rag.retrieval_events`` as part of any obsidian ingest; the summary reports the
rows written, planned (``--dry-run``) or skipped (table not migrated yet).

Windows note: always pass ``C:/Users/...``. An MSYS-style ``/c/Users/...`` path
resolves to ``C:\\c\\Users\\...`` for anything that is not the bash shell itself.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

from .chunking import MarkdownChunker
from .db_cli import SUBCOMMAND as DB_SUBCOMMAND, run_db
from .curate.cli import SUBCOMMAND as CURATE_SUBCOMMAND, run_curate
from .config import (
    CHUNKING,
    EMBEDDING,
    ENV_REALMS,
    SOURCE_CLAUDE_MEM,
    SOURCE_OBSIDIAN,
    load_db_settings,
    parse_realm_policies,
)
from .embed_check import SUBCOMMAND as EMBED_CHECK_SUBCOMMAND, run_embed_check
from .embedding import FastEmbedEmbedder
from .envfile import load_env_file
from .errors import IngestError
from .eval_cli import SUBCOMMAND as EVAL_SUBCOMMAND, run_eval_command
from .loaders import LoadedSource, load_claude_mem, load_vault, load_vault_notes
from .pipeline import Action, IngestPipeline, IngestStats
from .prune import PruneResult, prune_orphans
from .report_cli import SUBCOMMAND as REPORT_SUBCOMMAND, run_report
from .runstate import DEFAULT_MAX_AGE_HOURS, health, state_file
from .store import ChunkStore, NullStore, PostgresStore
from .session_content import require_memory_enabled
from .sweep_cli import SUBCOMMAND as SWEEP_SUBCOMMAND, run_sweep
from .tokenizer import HeuristicTokenCounter, model_token_counter, tokenizer_from_embedder
from .verify_cli import SUBCOMMAND as VERIFY_SUBCOMMAND, run_verify

log = logging.getLogger("ingest")

SOURCES = (SOURCE_OBSIDIAN, SOURCE_CLAUDE_MEM)

# Subcommands are dispatched before argparse sees anything, so the flag-only
# parser above keeps working exactly as it did.
SUBCOMMANDS = {
    SWEEP_SUBCOMMAND: run_sweep,
    EVAL_SUBCOMMAND: run_eval_command,
    DB_SUBCOMMAND: run_db,
    EMBED_CHECK_SUBCOMMAND: run_embed_check,
    VERIFY_SUBCOMMAND: run_verify,
    REPORT_SUBCOMMAND: run_report,
    CURATE_SUBCOMMAND: run_curate,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ingest",
        description="Ingest markdown or claude-mem history into rag.documents/rag.chunks.",
    )
    parser.add_argument("--source", choices=SOURCES, help="which loader to run")
    parser.add_argument(
        "--path",
        help="vault directory (obsidian) or export directory (claude-mem). "
        "On Windows use C:/Users/... , not /c/Users/... ",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would change; no embedding, no writes",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-chunk and re-embed even when the content hash is unchanged",
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="process at most N documents"
    )
    parser.add_argument(
        "--only",
        action="append",
        default=None,
        metavar="NOTE",
        help="obsidian only: ingest exactly these notes instead of walking the "
        "vault. Absolute or vault-relative; each must be inside --path and must "
        "be a note a full run would also visit. Repeat the flag for more than "
        "one note; they are ingested by one process, so the embedding model is "
        "loaded once. This is what the SessionEnd hook runs.",
    )
    parser.add_argument(
        "--no-summaries",
        action="store_true",
        help="claude-mem only: skip session_summaries.json",
    )
    parser.add_argument(
        "--no-prompts",
        action="store_true",
        help="claude-mem only: skip user_prompts.json",
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="DESTRUCTIVE: after a full pass, delete documents of this source "
        "whose external_id was not produced by the loader. Off by default; "
        "refused after --limit or any failure. Scoped to the realms this run "
        "walked; a realm not on this machine is never touched.",
    )
    parser.add_argument(
        "--prune-legacy",
        action="store_true",
        help="DESTRUCTIVE and UNSCOPED: also sweep the rows ingested before realms "
        "existed (no _ingest.realm), whichever machine wrote them. Only the one "
        "machine that owned the store before realms may pass this. Needs a full pass.",
    )
    parser.add_argument(
        "--check-env",
        action="store_true",
        help="report which connection variables are set, then exit",
    )
    parser.add_argument(
        "--health",
        action="store_true",
        help=f"report how long ago the last full reconcile finished and exit "
        f"non-zero if it is older than {DEFAULT_MAX_AGE_HOURS} h",
    )
    parser.add_argument(
        "--env-file",
        default=None,
        help="path to a .env file (default: nearest .env walking up from the "
        "package, i.e. the repo root). Exported variables always win.",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        require_memory_enabled()
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] in SUBCOMMANDS:
        return SUBCOMMANDS[arguments[0]](arguments[1:])

    args = build_parser().parse_args(arguments)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    try:
        load_env_file(Path(args.env_file) if args.env_file else None)
        require_memory_enabled()
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.check_env:
        _report_env()
        return 0

    if args.health:
        return _report_health()

    if not args.source or not args.path:
        build_parser().print_usage(sys.stderr)
        print("error: --source and --path are both required", file=sys.stderr)
        return 2

    refusal = _refuse_bad_combination(args)
    if refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return 2

    try:
        return _run(args)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        print("interrupted", file=sys.stderr)
        return 130


# --------------------------------------------------------------------------


def _refuse_bad_combination(args: argparse.Namespace) -> str | None:
    """Flag combinations that cannot mean anything sensible. Checked at the boundary."""
    if not args.only:
        return None
    if args.source != SOURCE_OBSIDIAN:
        return f"--only applies to --source {SOURCE_OBSIDIAN} only"
    if args.prune or args.prune_legacy:
        # The orphan sweep deletes every document the run did not produce. After
        # a one-note run that is the entire vault.
        flag = "--prune" if args.prune else "--prune-legacy"
        return (
            f"--only and {flag} contradict each other: naming the notes to "
            "ingest is not a full pass"
        )
    return None


def _run(args: argparse.Namespace) -> int:
    path = Path(args.path).expanduser()
    if args.limit is not None and args.limit < 1:
        print("error: --limit must be >= 1", file=sys.stderr)
        return 2

    store, embedder, chunker = _build_components(args)
    prune_results: list[PruneResult] = []
    try:
        # Before the walk, on the clock that stamps updated_at: a row written after
        # this is a note captured mid-run, not an orphan.
        written_before = store.database_now() if (args.prune or args.prune_legacy) else None
        loaded = _load(args, path)
        _report_load(loaded)

        documents = loaded.documents
        if args.limit is not None:
            documents = documents[: args.limit]
        if not documents:
            print("Nothing to ingest.")
            return 0

        pipeline = IngestPipeline(
            store, embedder, chunker, dry_run=args.dry_run, force=args.force
        )
        stats = pipeline.run(documents)

        if args.prune or args.prune_legacy:
            prune_results = _sweep(args, store, documents, stats, written_before)
    finally:
        store.close()

    _report_stats(stats, dry_run=args.dry_run)
    for prune_result in prune_results:
        _report_prune(prune_result, dry_run=args.dry_run)
    if _reconciled_everything(args, stats):
        _record_success(args, stats, len(documents))
    return 1 if stats.failures else 0


def _sweep(
    args: argparse.Namespace, store: ChunkStore, documents, stats: IngestStats, written_before: datetime | None
) -> list[PruneResult]:
    """One orphan sweep per realm the run walked, plus the legacy rows on request.

    The legacy rows — no ``_ingest.realm`` — have no scope at all: they are every
    pre-realm row in the store, whichever machine wrote them. So they are swept
    only behind the explicit ``--prune-legacy``, never as a side effect of
    ``--prune`` on a vault that happens to carry no markers, and the flag's help
    says which machine may pass it.
    """
    by_realm: dict[str | None, list[str]] = {}
    for doc in documents:
        by_realm.setdefault(_realm_of(doc), []).append(doc.external_id)
    realms = [realm for realm in by_realm if realm is not None]
    sweep_legacy = args.prune_legacy
    if args.prune and not realms and not sweep_legacy:
        print(
            "\nOrphan sweep: this vault has no .realm marker, so --prune has nothing it can "
            "safely scope; pass --prune-legacy on the one machine that owned the store before realms."
        )

    common = dict(
        dry_run=args.dry_run,
        failure_count=len(stats.failures),
        limited=args.limit is not None,
        written_before=written_before,
    )
    results = []
    if args.prune:
        for realm in realms:
            results.append(prune_orphans(
                store, args.source, by_realm[realm], document_count=len(by_realm[realm]), realm=realm, **common
            ))
    if sweep_legacy:
        results.append(prune_orphans(
            store, args.source, (doc.external_id for doc in documents),
            document_count=len(documents), realm=None, **common,
        ))
    return results


def _realm_of(document) -> str | None:
    ingest_meta = document.metadata.get("_ingest")
    return ingest_meta.get("realm") if isinstance(ingest_meta, dict) else None


def _allowed_realms() -> list[str] | None:
    policies = parse_realm_policies(os.environ.get(ENV_REALMS))
    return list(policies) if policies else None


def _load(args: argparse.Namespace, path: Path) -> LoadedSource:
    if args.source == SOURCE_OBSIDIAN:
        if args.only:
            return load_vault_notes(path, args.only, allowed_realms=_allowed_realms())
        return load_vault(path, allowed_realms=_allowed_realms())
    return load_claude_mem(
        path,
        include_summaries=not args.no_summaries,
        include_prompts=not args.no_prompts,
    )


def _build_components(
    args: argparse.Namespace,
) -> tuple[ChunkStore, FastEmbedEmbedder | None, MarkdownChunker]:
    settings = load_db_settings()

    if args.dry_run:
        # Dry runs use approximate token counts so they never download the model.
        chunker = MarkdownChunker(count_tokens=HeuristicTokenCounter())
        if settings.can_connect:
            return PostgresStore.from_settings(settings), None, chunker
        log.warning(
            "DATABASE_URL is not set: every document will be reported as new."
        )
        return NullStore(), None, chunker

    embedder = FastEmbedEmbedder()
    chunker = MarkdownChunker(
        count_tokens=model_token_counter(tokenizer_from_embedder(embedder.model))
    )
    return PostgresStore.from_settings(settings), embedder, chunker


# --------------------------------------------------------------------------


def _reconciled_everything(args: argparse.Namespace, stats: IngestStats) -> bool:
    """Did this run actually reconcile the whole vault?

    Only such a run may refresh the health timestamp. A dry run wrote nothing, a
    ``--limit`` run saw part of the corpus, a ``--only`` run saw one note, and a
    run with failures left documents behind — none of them is evidence that the
    nightly reconcile is working. claude-mem is a retired one-time import, so it
    never counts either.
    """
    return (
        args.source == SOURCE_OBSIDIAN
        and not args.dry_run
        and not args.only
        and args.limit is None
        and not stats.failures
    )


def _record_success(args: argparse.Namespace, stats: IngestStats, documents: int) -> None:
    """Record the run, but never fail the run over the recording."""
    from .runstate import record_success

    try:
        target = record_success(
            source=args.source,
            path=str(Path(args.path).expanduser()),
            documents=documents,
            chunks_written=stats.chunks_written,
        )
    except IngestError as exc:
        log.warning("Could not record the run state: %s", exc)
        return
    print(f"  last-success recorded in {target}")


def _report_health() -> int:
    report = health()
    print(f"Nightly reconcile health: {'OK' if report.ok else 'STALE'}")
    print(f"  state file: {state_file()}")
    print(f"  {report.reason}")
    if report.record is not None:
        record = report.record
        print(f"  last success: {record.completed_at.isoformat()}")
        print(f"  source: {record.source}")
        print(f"  path: {record.path}")
        print(f"  documents: {record.documents}, chunks written: {record.chunks_written}")
    return 0 if report.ok else 1


def _report_env() -> None:
    settings = load_db_settings()
    print("Connection variables (values never printed):")
    for name, state in settings.redacted().items():
        print(f"  {name:22} {state}")
    print(
        "\nWrites go over DATABASE_URL (direct Postgres). The rag schema is not "
        "exposed to PostgREST, so there is no REST fallback. TLS is verify-full "
        "against DATABASE_CA_CERT; it never downgrades."
    )
    print(f"\nEmbedding model: {EMBEDDING.model_name} ({EMBEDDING.dimensions} dims)")
    print(
        f"Chunking: target {CHUNKING.target_tokens} tokens, "
        f"overlap {CHUNKING.overlap_tokens}, min {CHUNKING.min_tokens}"
    )


def _report_load(loaded: LoadedSource) -> None:
    for note in loaded.notes:
        print(note)
    print(f"Loaded {len(loaded.documents)} documents.")
    if loaded.skipped:
        print(f"Skipped {len(loaded.skipped)} records:")
        for reason, count in sorted(loaded.skip_reasons().items(), key=lambda kv: -kv[1]):
            print(f"  {count:5}  {reason}")


def _report_stats(stats: IngestStats, *, dry_run: bool) -> None:
    print("\n--- dry run, nothing written ---" if dry_run else "\n--- ingest complete ---")
    for action in Action:
        count = stats.count(action)
        if count:
            print(f"  {count:5}  {action.value}")
    if dry_run:
        print(f"  chunks that would be written: {stats.chunks_planned}")
    else:
        print(f"  chunks written: {stats.chunks_written}")
    _report_events(stats)

    # Say what "metadata-updated" means where it is counted, rather than leaving
    # an unexplained action name in the nightly log.
    refreshed = stats.count(
        Action.PLANNED_METADATA if dry_run else Action.METADATA_UPDATED
    )
    if refreshed:
        verb = "would refresh" if dry_run else "refreshed"
        print(
            f"  {verb} title/metadata on {refreshed} document(s) whose body was "
            "unchanged: no re-chunking, no embedding"
        )

    _report_failures(stats)


def _report_events(stats: IngestStats) -> None:
    """One line on rag.retrieval_events (R-P2), and only when there is something to say."""
    parts = []
    if stats.events_written:
        parts.append(f"{stats.events_written} written")
    if stats.events_planned:
        parts.append(f"{stats.events_planned} would be written")
    if stats.events_skipped:
        parts.append(f"{stats.events_skipped} skipped (rag.retrieval_events missing)")
    if parts:
        print(f"  retrieval events: {', '.join(parts)}")


def _report_prune(result: PruneResult, *, dry_run: bool) -> None:
    scope = f"realm '{result.realm}'" if result.realm else "legacy rows (no realm)"
    if result.declined:
        print(f"\nOrphan sweep skipped for {scope}: {result.declined_reason}")
        return
    if result.spared:
        print(
            f"\nOrphan sweep kept {len(result.spared)} row(s) in {scope} written after this run's "
            "walk began (notes captured during the run); the next run sees them."
        )
    if not result.orphans:
        print(f"\nOrphan sweep: nothing stale in source '{result.source}', {scope}.")
        return

    verb = "would delete" if dry_run else "deleted"
    print(f"\nOrphan sweep {verb} {len(result.orphans)} document(s) from '{result.source}', {scope}:")
    for external_id in result.orphans[:20]:
        print(f"  {external_id}")
    if len(result.orphans) > 20:
        print(f"  ... and {len(result.orphans) - 20} more")
    if not dry_run:
        print(f"  rows removed: {result.deleted}")


def _report_failures(stats: IngestStats) -> None:
    failures = stats.failures
    if failures:
        print(f"\n{len(failures)} document(s) failed:", file=sys.stderr)
        for outcome in failures[:20]:
            print(f"  {outcome.external_id}: {outcome.detail}", file=sys.stderr)
        if len(failures) > 20:
            print(f"  ... and {len(failures) - 20} more", file=sys.stderr)


__all__ = ["main", "build_parser", "Action"]
