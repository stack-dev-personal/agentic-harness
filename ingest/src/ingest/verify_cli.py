"""``uv run ingest verify`` — a read-only audit of the store (R-Q1).

    uv run ingest verify --path C:/Users/you/vault
    uv run ingest verify --path C:/Users/you/vault --seed 1 --sample 50
    uv run ingest verify --path C:/Users/you/vault --json > audit.json

Six checks: chunks, embeddings, token-count, vault, duplicate-ids, re-embed (see
the README). Exit 0 clean, 1 findings, 2 could not run (vault missing, database
down, model missing, bad arguments). The nightly job runs it after ingest and
greps the last line, ``verify: clean`` or ``verify: N finding(s) in K check(s)``.

Like embed-check it loads the repo ``.env`` and ``~/.harness/machine.env`` first,
so ``FASTEMBED_CACHE_DIR`` and ``HARNESS_REALMS`` come from the machine file. No
value from either file is ever printed.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

from .config import ENV_DATABASE_URL, ENV_REALMS, load_db_settings, machine_name, parse_realm_policies
from .embedding import Embedder, FastEmbedEmbedder
from .envfile import load_env_file
from .errors import EmbeddingError, IngestError
from .loaders import load_vault
from .loaders.obsidian import discover_realms, vault_root
from .tokenizer import SupportsEncode, TokenCounter, model_token_counter, tokenizer_from_embedder
from .verify import DEFAULT_SAMPLE_SIZE, SEVERITY_ERROR, CheckResult, StoreReader, VaultSnapshot, VerifyReport
from .verify_checks import run_audit
from .verify_store import PostgresReader

SUBCOMMAND = "verify"

EXIT_CLEAN = 0
EXIT_FINDINGS = 1
EXIT_UNAVAILABLE = 2

# Findings shown per check in the text report; --json carries all of them.
MAX_SHOWN_FINDINGS = 20


def build_verify_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=f"ingest {SUBCOMMAND}",
        description="Audit the store read-only: chunks, embeddings, token counts, vault parity, "
        "duplicate ids and a re-embedded sample. Exit 0 clean, 1 findings, 2 could not run.",
    )
    parser.add_argument("--path", required=True, help="vault directory (C:/Users/... on Windows)")
    parser.add_argument(
        "--sample", type=int, default=DEFAULT_SAMPLE_SIZE,
        help=f"chunks to re-embed (default {DEFAULT_SAMPLE_SIZE})",
    )
    parser.add_argument("--seed", type=int, default=None, help="seed for a reproducible sample (default: random)")
    parser.add_argument("--json", action="store_true", help="machine-readable report with every finding")
    parser.add_argument(
        "--env-file", default=None,
        help="explicit .env path (default: nearest .env walking up); ~/.harness/machine.env follows it",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def run_verify(
    argv: list[str],
    *,
    reader: StoreReader | None = None,
    embedder: Embedder | None = None,
    count_tokens: TokenCounter | None = None,
) -> int:
    """Run the subcommand. ``reader``, ``embedder`` and ``count_tokens`` are injectable
    for tests; the CLI builds the live ones. An injected reader is not closed here."""
    args = build_verify_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    if args.sample < 1:
        print("error: --sample must be >= 1", file=sys.stderr)
        return EXIT_UNAVAILABLE

    owned: PostgresReader | None = None
    try:
        # Before the embedder exists: its cache dir and the realm policy come from these files.
        load_env_file(Path(args.env_file) if args.env_file else None)
        if reader is None:
            owned = PostgresReader.from_settings(load_db_settings())
            reader = owned
        # Read before the walk, on the clock that stamps updated_at: the nightly
        # ingest's rows predate it and are compared; a note captured during the
        # audit postdates it and is left alone, as the orphan sweep leaves it.
        snapshot = _walk(args.path, reader.database_now())
        model = embedder or FastEmbedEmbedder()
        counter = count_tokens or build_token_counter(model)
        report = run_audit(reader, snapshot, model, counter, sample_size=args.sample, seed=args.seed,
                           machine=machine_name())
    except IngestError as exc:
        print(f"error: {_redacted(str(exc))}", file=sys.stderr)
        return EXIT_UNAVAILABLE
    except Exception as exc:  # noqa: BLE001 - reported; exit 1 would read as "findings"
        # A bug or an untyped failure (tokenizer, filesystem, driver) still means the
        # audit could not run, so it must exit 2, never Python's default 1.
        # No traceback: its message lines could carry what _redacted strips.
        print(f"error: {type(exc).__name__}: {_redacted(str(exc))}", file=sys.stderr)
        return EXIT_UNAVAILABLE
    finally:
        if owned is not None:
            owned.close()

    print(json.dumps(as_json(report), indent=2) if args.json else as_text(report, snapshot))
    return EXIT_CLEAN if report.clean else EXIT_FINDINGS


def _redacted(message: str) -> str:
    """``message`` with the connection string masked, should an error have echoed it."""
    url = (os.environ.get(ENV_DATABASE_URL) or "").strip()
    return message.replace(url, f"<{ENV_DATABASE_URL}>") if url else message


def _walk(path: str, walked_at: datetime | None) -> VaultSnapshot:
    """Load the vault the way the nightly ingest does, under this machine's realm policy."""
    policies = parse_realm_policies(os.environ.get(ENV_REALMS))
    allowed = list(policies) if policies else None
    root = vault_root(path)
    realms = tuple(sorted(set(discover_realms(root).values())))
    return VaultSnapshot(
        path=root.as_posix(), realms=realms, loaded=load_vault(root, allowed_realms=allowed), walked_at=walked_at
    )


# -- the real tokenizer ----------------------------------------------------------------


def build_token_counter(embedder: Embedder) -> TokenCounter:
    """The model's own tokenizer, with its truncation switched off on a copy.

    fastembed's tokenizer truncates at 512, so a recount with it could never
    exceed the window this check exists to police. A heuristic fallback would
    produce false drift findings, so an unreachable tokenizer stops the run.
    """
    tokenizer = tokenizer_from_embedder(getattr(embedder, "model", None))
    if tokenizer is None:
        raise EmbeddingError("could not reach the model tokenizer to recount token_count")
    return model_token_counter(untruncated(tokenizer))


def untruncated(tokenizer: SupportsEncode) -> SupportsEncode:
    """A copy of a Hugging Face ``tokenizers.Tokenizer`` without truncation or padding."""
    to_str = getattr(tokenizer, "to_str", None)
    if to_str is None:
        raise EmbeddingError(f"cannot copy a {type(tokenizer).__name__} tokenizer to recount without truncation")
    from tokenizers import Tokenizer

    try:
        copy = Tokenizer.from_str(to_str())
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
        raise EmbeddingError(f"could not copy the model tokenizer: {exc}") from exc
    copy.no_truncation()
    copy.no_padding()
    return copy


# -- the report --------------------------------------------------------------------------


def as_json(report: VerifyReport) -> dict[str, object]:
    return {
        "clean": report.clean,
        "finding_count": report.finding_count,
        "checks": [
            {
                "name": result.name,
                "count": result.count,
                "notes": list(result.notes),
                "findings": [
                    {"subject": f.subject, "detail": f.detail, "severity": f.severity} for f in result.findings
                ],
            }
            for result in report.checks
        ],
    }


def as_text(report: VerifyReport, snapshot: VaultSnapshot) -> str:
    realms = ", ".join(snapshot.realms) if snapshot.realms else "none (legacy layout)"
    lines = [f"vault {snapshot.path}; realms: {realms}"]
    for result in report.checks:
        lines.extend(_check_lines(result))
    lines.append(_last_line(report))
    return "\n".join(lines)


def _check_lines(result: CheckResult) -> list[str]:
    lines = [f"  {result.name:<14} {result.count}"]
    lines.extend(f"      note: {note}" for note in result.notes)
    for finding in result.findings[:MAX_SHOWN_FINDINGS]:
        marker = "" if finding.severity == SEVERITY_ERROR else f" ({finding.severity})"
        lines.append(f"      {finding.subject}: {finding.detail}{marker}")
    hidden = result.count - MAX_SHOWN_FINDINGS
    if hidden > 0:
        lines.append(f"      ... and {hidden} more (--json lists all)")
    return lines


def _last_line(report: VerifyReport) -> str:
    if report.clean:
        return "verify: clean"
    return f"verify: {report.finding_count} finding(s) in {len(report.failing)} check(s)"
