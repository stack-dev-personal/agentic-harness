"""The store audit's data: findings, reports, the rows it reads, and the reader protocol.

``uv run ingest verify`` (R-Q1) asks whether the store is chunked and embedded
properly — a property of the rows, not of the code that wrote them. This module
holds the shapes only; the checks are pure functions in :mod:`verify_checks`, the
SQL lives in :mod:`verify_store` and the command line in :mod:`verify_cli`.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from .loaders import LoadedSource

# Check names, in report order. They are the names the nightly log shows.
CHECK_CHUNKS = "chunks"
CHECK_EMBEDDINGS = "embeddings"
CHECK_TOKEN_COUNT = "token-count"
CHECK_VAULT = "vault"
CHECK_DUPLICATE_IDS = "duplicate-ids"
CHECK_REEMBED = "re-embed"
CHECK_ORDER = (
    CHECK_CHUNKS,
    CHECK_EMBEDDINGS,
    CHECK_TOKEN_COUNT,
    CHECK_VAULT,
    CHECK_DUPLICATE_IDS,
    CHECK_REEMBED,
)

# An info finding still counts: it fails the run like any other, it only says
# the row is suspicious rather than broken.
SEVERITY_ERROR = "error"
SEVERITY_INFO = "info"

# bge-small returns L2-normalised vectors; a stored norm further than this from 1
# was not written by the model as configured.
NORM_TOLERANCE = 1e-3
# A stored token_count this far (relative) from a fresh recount was counted by
# something else — the heuristic fallback, or another tokenizer.
TOKEN_DRIFT = 0.10
# How many chunks the re-embed check samples by default.
DEFAULT_SAMPLE_SIZE = 50


@dataclass(frozen=True)
class Finding:
    """One thing wrong with one row, document or note."""

    subject: str
    detail: str
    severity: str = SEVERITY_ERROR


@dataclass(frozen=True)
class CheckResult:
    """One named check: its findings, plus notes that are context, not findings."""

    name: str
    findings: tuple[Finding, ...] = ()
    notes: tuple[str, ...] = ()

    @property
    def count(self) -> int:
        return len(self.findings)


@dataclass(frozen=True)
class VerifyReport:
    checks: tuple[CheckResult, ...]

    @property
    def finding_count(self) -> int:
        return sum(result.count for result in self.checks)

    @property
    def failing(self) -> tuple[CheckResult, ...]:
        return tuple(result for result in self.checks if result.findings)

    @property
    def clean(self) -> bool:
        return self.finding_count == 0

    def check(self, name: str) -> CheckResult:
        for result in self.checks:
            if result.name == name:
                return result
        raise KeyError(name)


# -- what the audit reads ---------------------------------------------------------


@dataclass(frozen=True)
class DocumentRow:
    """A document and the ``chunk_index`` values of its chunks, ascending."""

    document_id: int
    source: str
    external_id: str
    chunk_indexes: tuple[int, ...]


@dataclass(frozen=True)
class NormRow:
    """A chunk's embedding norm, computed in SQL; None when the embedding is null."""

    chunk_id: int
    source: str
    external_id: str
    chunk_index: int
    norm: float | None


@dataclass(frozen=True)
class ChunkText:
    chunk_id: int
    source: str
    external_id: str
    chunk_index: int
    content: str
    token_count: int | None


@dataclass(frozen=True)
class SampledChunk:
    """A chunk picked for re-embedding: its text and its stored vector."""

    chunk_id: int
    source: str
    external_id: str
    chunk_index: int
    content: str
    vector: tuple[float, ...] | None


@dataclass(frozen=True)
class VaultRow:
    """An obsidian row, as far as the vault comparison needs it.

    ``path`` is the note path stored in ``_ingest.path`` when the row was written:
    it names the note behind a row keyed by a frontmatter id. ``written_at`` is the
    row's ``updated_at``, which tells a note captured during the audit from a stale row.
    """

    external_id: str
    content_hash: str
    path: str | None = None
    written_at: datetime | None = None


@dataclass(frozen=True)
class VaultSnapshot:
    """One walk of the vault: its realm names (empty when unmarked) and what it loaded.

    ``walked_at`` is the database clock read just before the walk: a row written at
    or after it may belong to a note the walk could not see, so the vault check
    leaves it alone, exactly as the orphan sweep does.
    """

    path: str
    realms: tuple[str, ...]
    loaded: LoadedSource
    walked_at: datetime | None = None


class StoreReader(Protocol):
    """Every read the audit makes. :class:`verify_store.PostgresReader` is the real one."""

    def documents(self) -> Sequence[DocumentRow]: ...

    def embedding_norms(self) -> Sequence[NormRow]: ...

    def chunk_texts(self) -> Sequence[ChunkText]: ...

    def vault_rows(self, realm: str | None, machine: str | None = None) -> Sequence[VaultRow]:
        """Obsidian rows of ``realm``; ``None`` means the legacy rows with no realm.

        ``machine`` narrows them to the rows this machine may sweep (see
        ``prune.owned_by``), so the audit never reports another machine's
        unsynced sessions as orphans the sweep would then refuse to delete.
        """
        ...

    def chunk_ids(self) -> Sequence[int]: ...

    def database_now(self) -> datetime | None:
        """The database clock, which stamps ``updated_at``."""
        ...

    def chunks_by_id(self, ids: Sequence[int]) -> Sequence[SampledChunk]: ...

    def close(self) -> None: ...


# -- helpers shared by the checks and the report ------------------------------------


def document_label(source: str, external_id: str) -> str:
    return f"{source}:{external_id}"


def chunk_label(source: str, external_id: str, chunk_index: int) -> str:
    return f"{source}:{external_id}#{chunk_index}"


def pick_sample(ids: Sequence[int], size: int, seed: int | None) -> tuple[int, ...]:
    """``size`` ids drawn at random, all of them when there are fewer.

    The ids are sorted first, so the same seed picks the same chunks whatever
    order the database returned them in. ``seed=None`` draws a fresh sample.
    """
    if size < 1:
        raise ValueError(f"sample size must be >= 1, got {size}")
    ordered = sorted(set(ids))
    if len(ordered) <= size:
        return tuple(ordered)
    return tuple(random.Random(seed).sample(ordered, size))
