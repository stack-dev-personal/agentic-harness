"""The six store checks behind ``uv run ingest verify``, and the audit that runs them.

Each check is a pure function over rows the reader already fetched (or, for the
re-embed sample, over an embedder that is passed in), so the tests plant one
defect in an in-memory store and assert exactly one finding.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime

from .config import EMBEDDING
from .embed_check import COSINE_THRESHOLD, cosine
from .embedding import Embedder
from .errors import EmbeddingError
from .hashing import content_hash
from .loaders import SkippedRecord
from .models import SourceDocument
from .tokenizer import TokenCounter
from .verify import (
    CHECK_CHUNKS,
    CHECK_DUPLICATE_IDS,
    CHECK_EMBEDDINGS,
    CHECK_REEMBED,
    CHECK_TOKEN_COUNT,
    CHECK_VAULT,
    NORM_TOLERANCE,
    SEVERITY_INFO,
    TOKEN_DRIFT,
    ChunkText,
    CheckResult,
    DocumentRow,
    Finding,
    NormRow,
    SampledChunk,
    StoreReader,
    VaultRow,
    VaultSnapshot,
    VerifyReport,
    chunk_label,
    document_label,
    pick_sample,
)

# The reason the obsidian loader's `_claim` gives a note whose external_id an
# earlier note already took. The nightly log showed eight of these.
DUPLICATE_REASON_PREFIX = "duplicate external_id"

# How many index values a chunks finding spells out before it abbreviates.
MAX_LISTED_INDEXES = 10


def run_audit(
    reader: StoreReader,
    snapshot: VaultSnapshot,
    embedder: Embedder,
    count_tokens: TokenCounter,
    *,
    sample_size: int,
    seed: int | None,
) -> VerifyReport:
    """Every check, in report order. Store and embedding errors propagate."""
    scoped, legacy = _vault_rows(reader, snapshot)
    return VerifyReport((
        check_chunks(reader.documents()),
        check_embeddings(reader.embedding_norms()),
        check_token_counts(reader.chunk_texts(), count_tokens),
        check_vault(snapshot, scoped, legacy),
        check_duplicate_ids(snapshot.loaded.skipped),
        _reembed_sample(reader, embedder, sample_size, seed),
    ))


# -- chunks -------------------------------------------------------------------------


def check_chunks(documents: Sequence[DocumentRow]) -> CheckResult:
    """Every document has chunks, and their indexes are exactly 0..n-1."""
    findings = tuple(
        Finding(document_label(doc.source, doc.external_id), problem)
        for doc in documents
        if (problem := _index_problem(doc.chunk_indexes)) is not None
    )
    return CheckResult(CHECK_CHUNKS, findings, (f"{len(documents)} documents",))


def _index_problem(indexes: Sequence[int]) -> str | None:
    if not indexes:
        return "no chunks"
    expected = set(range(len(indexes)))
    if sorted(indexes) == sorted(expected):
        return None
    parts = [f"chunk_index is not 0..{len(indexes) - 1}"]
    missing = sorted(expected - set(indexes))
    duplicate = sorted(index for index, seen in Counter(indexes).items() if seen > 1)
    outside = sorted(set(indexes) - expected)
    for label, values in (("missing", missing), ("duplicate", duplicate), ("out of range", outside)):
        if values:
            parts.append(f"{label} {_list(values)}")
    return "; ".join(parts)


def _list(values: Sequence[int]) -> str:
    shown = ", ".join(str(value) for value in values[:MAX_LISTED_INDEXES])
    return shown + (" …" if len(values) > MAX_LISTED_INDEXES else "")


# -- embeddings --------------------------------------------------------------------------


def check_embeddings(rows: Sequence[NormRow], tolerance: float = NORM_TOLERANCE) -> CheckResult:
    """No null embedding, and every stored vector has unit L2 norm."""
    findings: list[Finding] = []
    for row in rows:
        subject = chunk_label(row.source, row.external_id, row.chunk_index)
        if row.norm is None:
            findings.append(Finding(subject, "embedding is null"))
        elif abs(row.norm - 1.0) > tolerance:
            findings.append(Finding(subject, f"L2 norm {row.norm:.6f}, expected 1 ± {tolerance:g}"))
    return CheckResult(CHECK_EMBEDDINGS, tuple(findings), (f"{len(rows)} chunks",))


# -- token-count ------------------------------------------------------------------------


def check_token_counts(
    chunks: Sequence[ChunkText],
    count_tokens: TokenCounter,
    *,
    max_tokens: int = EMBEDDING.max_input_tokens,
    drift: float = TOKEN_DRIFT,
) -> CheckResult:
    """Recount every chunk: over the model window is an error, a stale count is info."""
    findings = tuple(
        finding for chunk in chunks
        if (finding := _token_finding(chunk, count_tokens(chunk.content), max_tokens, drift)) is not None
    )
    note = f"{len(chunks)} chunks recounted; window {max_tokens} tokens"
    return CheckResult(CHECK_TOKEN_COUNT, findings, (note,))


def _token_finding(chunk: ChunkText, recount: int, max_tokens: int, drift: float) -> Finding | None:
    subject = chunk_label(chunk.source, chunk.external_id, chunk.chunk_index)
    if recount > max_tokens:
        return Finding(subject, f"recount {recount} tokens exceeds the model window of {max_tokens}")
    if chunk.token_count is None:
        return Finding(subject, f"no stored token_count (recount {recount})", SEVERITY_INFO)
    if abs(chunk.token_count - recount) > drift * max(recount, 1):
        return Finding(
            subject,
            f"stored token_count {chunk.token_count} differs from the recount {recount} by more than {drift:.0%}",
            SEVERITY_INFO,
        )
    return None


# -- vault ------------------------------------------------------------------------------


def check_vault(
    snapshot: VaultSnapshot,
    scoped_rows: Mapping[str | None, Sequence[VaultRow]],
    legacy_rows: Sequence[VaultRow] = (),
) -> CheckResult:
    """Per scope (a realm, or the whole unmarked vault): notes and rows agree.

    A note's scope is its ``_ingest.realm``; in an unmarked vault every note is
    ``None`` and so is the one scope (the legacy rows), so the same comparison
    covers both layouts. A row written after the walk began is counted, not
    compared: its note may have been captured after the walk passed it.
    """
    skipped = {record.external_id: record.reason for record in snapshot.loaded.skipped}
    findings: list[Finding] = []
    notes: list[str] = []
    for scope, rows in scoped_rows.items():
        documents = [doc for doc in snapshot.loaded.documents if _realm_of(doc) == scope]
        fresh = {row.external_id for row in rows if _written_since(row, snapshot.walked_at)}
        findings.extend(_compare_scope(
            _scope_name(scope),
            [doc for doc in documents if doc.external_id not in fresh],
            [row for row in rows if row.external_id not in fresh],
            skipped,
        ))
        notes.append(f"{_scope_name(scope)}: {len(documents)} notes, {len(rows)} rows")
        if fresh:
            notes.append(
                f"{_scope_name(scope)}: {len(fresh)} row(s) written after the walk began, "
                "not compared (notes captured during the audit)"
            )
    if legacy_rows:
        notes.append(f"{len(legacy_rows)} legacy row(s) carry no _ingest.realm and are not compared")
    return CheckResult(CHECK_VAULT, tuple(findings), tuple(notes))


def _compare_scope(
    where: str,
    documents: Sequence[SourceDocument],
    rows: Sequence[VaultRow],
    skipped: Mapping[str, str],
) -> list[Finding]:
    by_id = {doc.external_id: doc for doc in documents}
    stored = {row.external_id: row for row in rows}
    findings: list[Finding] = []
    for external_id, doc in sorted(by_id.items()):
        row = stored.get(external_id)
        if row is None:
            findings.append(Finding(external_id, f"{where}: ingestable note{_path_of(doc)} has no row"))
        elif row.content_hash != content_hash(doc.embedding_body if doc.embedding_body is not None else doc.body):
            findings.append(Finding(external_id, f"{where}: stored content_hash differs from the note{_path_of(doc)}"))
    for external_id in sorted(stored.keys() - by_id.keys()):
        findings.append(Finding(external_id, f"{where}: {_orphan_detail(stored[external_id], skipped)}"))
    return findings


def _orphan_detail(row: VaultRow, skipped: Mapping[str, str]) -> str:
    """Why a row has no walked note: the walk skips it (by id or stored path), or it is gone."""
    reason = skipped.get(row.external_id) or (skipped.get(row.path) if row.path else None)
    was = f" (stored path {row.path})" if row.path and row.path != row.external_id else ""
    if reason:
        return f"row's note is skipped by the walk ({reason}){was}"
    return f"row has no note{was}"


def _written_since(row: VaultRow, cutoff: datetime | None) -> bool:
    return cutoff is not None and row.written_at is not None and row.written_at >= cutoff


def _scope_name(scope: str | None) -> str:
    return f"realm {scope}" if scope is not None else "vault"


def _realm_of(document: SourceDocument) -> str | None:
    ingest_meta = document.metadata.get("_ingest")
    return ingest_meta.get("realm") if isinstance(ingest_meta, dict) else None


def _path_of(document: SourceDocument) -> str:
    """`` (projects/x.md)`` when the external_id is a frontmatter id, else nothing."""
    ingest_meta = document.metadata.get("_ingest")
    path = ingest_meta.get("path") if isinstance(ingest_meta, dict) else None
    return f" ({path})" if path and path != document.external_id else ""


def _vault_rows(
    reader: StoreReader, snapshot: VaultSnapshot
) -> tuple[dict[str | None, Sequence[VaultRow]], Sequence[VaultRow]]:
    """Rows per realm plus the legacy rows, scoped exactly as cli.py's orphan sweep is.

    An unmarked vault is one scope: the legacy rows, the only ones its sweep
    (``--prune-legacy``, realm ``None``) can delete. Rows another machine wrote
    under a realm are outside it, so they are neither compared nor reported.
    """
    if not snapshot.realms:
        return {None: reader.vault_rows(None)}, ()
    scoped = {realm: reader.vault_rows(realm) for realm in snapshot.realms}
    return scoped, reader.vault_rows(None)


# -- duplicate-ids -----------------------------------------------------------------------


def check_duplicate_ids(skipped: Sequence[SkippedRecord]) -> CheckResult:
    """One finding per note the walk refused because another note holds its external_id."""
    findings = tuple(
        Finding(record.external_id, record.reason)
        for record in skipped
        if record.reason.startswith(DUPLICATE_REASON_PREFIX)
    )
    return CheckResult(CHECK_DUPLICATE_IDS, findings)


# -- re-embed ----------------------------------------------------------------------------


def _reembed_sample(reader: StoreReader, embedder: Embedder, size: int, seed: int | None) -> CheckResult:
    ids = reader.chunk_ids()
    chosen = pick_sample(ids, size, seed)
    sample = reader.chunks_by_id(chosen) if chosen else ()
    return check_reembed(sample, embedder, total=len(ids), seed=seed)


def check_reembed(
    sample: Sequence[SampledChunk],
    embedder: Embedder,
    *,
    total: int,
    seed: int | None,
    threshold: float = COSINE_THRESHOLD,
) -> CheckResult:
    """Re-embed each sampled chunk's content; a cosine under ``threshold`` is a finding.

    A sampled chunk with a null embedding is left to the embeddings check rather
    than reported twice.
    """
    embedded = [chunk for chunk in sample if chunk.vector is not None]
    # The embedder refuses a blank text outright; one such chunk is a finding, not a dead run.
    blank = tuple(
        Finding(chunk_label(c.source, c.external_id, c.chunk_index), "content is blank; cannot be re-embedded")
        for c in embedded if not c.content.strip()
    )
    usable = [chunk for chunk in embedded if chunk.content.strip()]
    fresh = embedder.embed([chunk.content for chunk in usable]) if usable else []
    if len(fresh) != len(usable):
        raise EmbeddingError(f"embedder returned {len(fresh)} vectors for {len(usable)} texts")
    findings = blank + tuple(
        finding for chunk, vector in zip(usable, fresh, strict=True)
        if (finding := _drift_finding(chunk, vector, threshold)) is not None
    )
    seeded = f"seed {seed}" if seed is not None else "random seed"
    notes = [f"sampled {len(sample)} of {total} chunks ({seeded}); threshold {threshold}"]
    if len(embedded) < len(sample):
        notes.append(f"{len(sample) - len(embedded)} sampled chunk(s) with a null embedding skipped")
    return CheckResult(CHECK_REEMBED, findings, tuple(notes))


def _drift_finding(chunk: SampledChunk, fresh: Sequence[float], threshold: float) -> Finding | None:
    subject = chunk_label(chunk.source, chunk.external_id, chunk.chunk_index)
    stored = chunk.vector or ()
    if len(stored) != len(fresh):
        return Finding(subject, f"stored vector has {len(stored)} dimensions, the model returns {len(fresh)}")
    score = cosine(stored, fresh)
    if score < threshold:
        return Finding(subject, f"cosine {score:.6f} against a fresh embedding, below {threshold}")
    return None
