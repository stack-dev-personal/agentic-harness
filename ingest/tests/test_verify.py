"""``ingest verify``: each check against an in-memory store with one planted defect.

No database and no model: :class:`FakeReader` holds documents, chunks and vectors
built from the fixture vault, and :class:`HashEmbedder` turns a text into the same
unit vector every time, so a clean store re-embeds to cosine 1.0 and each helper
plants exactly one kind of defect.
"""

from __future__ import annotations

import hashlib
import shutil
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Sequence

import numpy as np
import pytest

from ingest.hashing import content_hash
from ingest.loaders import LoadedSource, load_vault
from ingest.loaders.obsidian import discover_realms
from ingest.verify import (
    CHECK_CHUNKS,
    CHECK_DUPLICATE_IDS,
    CHECK_EMBEDDINGS,
    CHECK_ORDER,
    CHECK_REEMBED,
    CHECK_TOKEN_COUNT,
    CHECK_VAULT,
    SEVERITY_INFO,
    ChunkText,
    DocumentRow,
    NormRow,
    SampledChunk,
    VaultRow,
    VaultSnapshot,
    pick_sample,
)
from ingest.verify_checks import run_audit

FIXTURE_VAULT = Path(__file__).parent / "fixtures" / "verify-vault"
DIMENSIONS = 8
SAMPLE = 50


def word_count(text: str) -> int:
    """The tests' tokenizer: one token per whitespace-separated word."""
    return len(text.split())


class HashEmbedder:
    """A text always maps to the same unit vector; different texts to different ones."""

    def __init__(self, dimensions: int = DIMENSIONS) -> None:
        self._dimensions = dimensions
        self.calls: list[list[str]] = []

    @property
    def dimensions(self) -> int:
        return self._dimensions

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [unit_vector(text, self._dimensions) for text in texts]


def unit_vector(text: str, dimensions: int = DIMENSIONS) -> list[float]:
    seed = int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big")
    raw = np.random.default_rng(seed).normal(size=dimensions)
    return [float(v) for v in raw / np.linalg.norm(raw)]


@dataclass(frozen=True)
class FakeDocument:
    document_id: int
    source: str
    external_id: str
    content_hash: str
    realm: str | None
    path: str | None = None
    written_at: datetime | None = None


@dataclass(frozen=True)
class FakeChunk:
    chunk_id: int
    document_id: int
    chunk_index: int
    content: str
    token_count: int | None
    vector: tuple[float, ...] | None


class FakeReader:
    """In-memory StoreReader. Build it clean, then plant one defect per test."""

    def __init__(self) -> None:
        self.docs: list[FakeDocument] = []
        self.chunks: list[FakeChunk] = []
        self.requested_samples: list[tuple[int, ...]] = []
        self.closed = False

    # -- building ---------------------------------------------------------

    @classmethod
    def from_loaded(cls, loaded: LoadedSource) -> "FakeReader":
        reader = cls()
        for document in loaded.documents:
            ingest_meta = document.metadata.get("_ingest", {})
            reader.add_document(
                document.source, document.external_id, content_hash(document.body),
                ingest_meta.get("realm"), [document.body], path=ingest_meta.get("path"),
            )
        return reader

    def add_document(
        self, source: str, external_id: str, digest: str, realm: str | None, contents: list[str],
        *, path: str | None = None, written_at: datetime | None = None,
    ) -> int:
        document_id = len(self.docs) + 1
        self.docs.append(FakeDocument(document_id, source, external_id, digest, realm, path, written_at))
        for index, text in enumerate(contents):
            self.chunks.append(FakeChunk(
                chunk_id=len(self.chunks) + 1, document_id=document_id, chunk_index=index,
                content=text, token_count=word_count(text), vector=tuple(unit_vector(text)),
            ))
        return document_id

    def doc(self, external_id: str) -> FakeDocument:
        return next(d for d in self.docs if d.external_id == external_id)

    def _replace_chunk(self, chunk_id: int, **changes) -> None:
        self.chunks = [replace(c, **changes) if c.chunk_id == chunk_id else c for c in self.chunks]

    # -- planting defects -------------------------------------------------

    def drop_chunks(self, external_id: str) -> None:
        document_id = self.doc(external_id).document_id
        self.chunks = [c for c in self.chunks if c.document_id != document_id]

    def shift_index(self, chunk_id: int, new_index: int) -> None:
        self._replace_chunk(chunk_id, chunk_index=new_index)

    def null_embedding(self, chunk_id: int) -> None:
        self._replace_chunk(chunk_id, vector=None)

    def scale_embedding(self, chunk_id: int, factor: float) -> None:
        vector = next(c.vector for c in self.chunks if c.chunk_id == chunk_id)
        self._replace_chunk(chunk_id, vector=tuple(v * factor for v in vector))

    def rotate_embedding(self, chunk_id: int) -> None:
        """A different unit vector: the norm stays 1, the cosine collapses."""
        self._replace_chunk(chunk_id, vector=tuple(unit_vector(f"drifted {chunk_id}")))

    def set_token_count(self, chunk_id: int, token_count: int | None) -> None:
        self._replace_chunk(chunk_id, token_count=token_count)

    def set_content(self, chunk_id: int, content: str) -> None:
        """New content with a matching vector and stored count: only the length is wrong."""
        self._replace_chunk(
            chunk_id, content=content, token_count=word_count(content), vector=tuple(unit_vector(content))
        )

    def stale_hash(self, external_id: str, *, written_at: datetime | None = None) -> None:
        self.docs = [
            replace(d, content_hash="0" * 64, written_at=written_at) if d.external_id == external_id else d
            for d in self.docs
        ]

    def remove_document(self, external_id: str) -> None:
        document_id = self.doc(external_id).document_id
        self.docs = [d for d in self.docs if d.document_id != document_id]
        self.chunks = [c for c in self.chunks if c.document_id != document_id]

    # -- StoreReader ------------------------------------------------------

    def documents(self) -> list[DocumentRow]:
        return [
            DocumentRow(d.document_id, d.source, d.external_id, tuple(sorted(
                c.chunk_index for c in self.chunks if c.document_id == d.document_id
            )))
            for d in self.docs
        ]

    def _owner(self, chunk: FakeChunk) -> FakeDocument:
        return next(d for d in self.docs if d.document_id == chunk.document_id)

    def embedding_norms(self) -> list[NormRow]:
        return [
            NormRow(c.chunk_id, self._owner(c).source, self._owner(c).external_id, c.chunk_index,
                    None if c.vector is None else float(np.linalg.norm(c.vector)))
            for c in self.chunks
        ]

    def chunk_texts(self) -> list[ChunkText]:
        return [
            ChunkText(c.chunk_id, self._owner(c).source, self._owner(c).external_id, c.chunk_index,
                      c.content, c.token_count)
            for c in self.chunks
        ]

    def vault_rows(self, realm: str | None, machine: str | None = None) -> list[VaultRow]:
        return [VaultRow(d.external_id, d.content_hash, d.path, d.written_at) for d in self.docs
                if d.source == "obsidian" and d.realm == realm
                and (machine is None or getattr(d, "machine", None) in (None, "", machine))]

    def chunk_ids(self) -> list[int]:
        return [c.chunk_id for c in reversed(self.chunks)]  # order must not matter

    def chunks_by_id(self, ids: Sequence[int]) -> list[SampledChunk]:
        self.requested_samples.append(tuple(ids))
        wanted = set(ids)
        return [
            SampledChunk(c.chunk_id, self._owner(c).source, self._owner(c).external_id, c.chunk_index,
                         c.content, c.vector)
            for c in self.chunks if c.chunk_id in wanted
        ]

    def database_now(self) -> datetime | None:
        return None

    def close(self) -> None:
        self.closed = True


# --------------------------------------------------------------------------


def snapshot_of(vault: Path) -> VaultSnapshot:
    return VaultSnapshot(
        path=vault.as_posix(),
        realms=tuple(sorted(set(discover_realms(vault).values()))),
        loaded=load_vault(vault),
    )


@pytest.fixture
def snapshot() -> VaultSnapshot:
    return snapshot_of(FIXTURE_VAULT)


@pytest.fixture
def clean_reader(snapshot: VaultSnapshot) -> FakeReader:
    reader = FakeReader.from_loaded(snapshot.loaded)
    # A claude-mem document with two chunks: it takes part in every check but the vault one.
    reader.add_document("claude-mem", "461", "f" * 64, None, ["first observation chunk", "second one"])
    return reader


def audit(reader: FakeReader, snapshot: VaultSnapshot, *, sample: int = SAMPLE, seed: int | None = 1,
          embedder: HashEmbedder | None = None):
    return run_audit(
        reader, snapshot, embedder or HashEmbedder(), word_count, sample_size=sample, seed=seed
    )


def findings_of(report, name: str):
    return report.check(name).findings


def only_failing(report) -> set[str]:
    return {result.name for result in report.checks if result.findings}


# -- the fixture itself -------------------------------------------------------------


def test_the_fixture_vault_has_two_realms_and_one_duplicate(snapshot: VaultSnapshot) -> None:
    assert snapshot.realms == ("classes", "projects")
    reasons = [record.reason for record in snapshot.loaded.skipped]
    assert sum(reason.startswith("duplicate external_id") for reason in reasons) == 1
    assert len(snapshot.loaded.documents) == 5


# -- a clean store --------------------------------------------------------------------


def test_a_clean_store_reports_every_check_with_no_findings(clean_reader, snapshot) -> None:
    report = audit(clean_reader, snapshot)

    assert tuple(result.name for result in report.checks) == CHECK_ORDER
    # The fixture plants one duplicate external_id, which is a finding by design.
    assert only_failing(report) == {CHECK_DUPLICATE_IDS}
    assert report.finding_count == 1


def test_a_vault_without_the_duplicate_is_clean(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    shutil.copytree(FIXTURE_VAULT, vault)
    (vault / "projects" / "alpha" / "notes" / "shared-b.md").unlink()
    snap = snapshot_of(vault)

    report = audit(FakeReader.from_loaded(snap.loaded), snap)

    assert report.clean
    assert report.finding_count == 0


# -- chunks -------------------------------------------------------------------------------


def test_a_document_without_chunks_is_a_finding(clean_reader, snapshot) -> None:
    clean_reader.drop_chunks("alpha-index-0001")

    found = findings_of(audit(clean_reader, snapshot), CHECK_CHUNKS)

    assert len(found) == 1
    assert "alpha-index-0001" in found[0].subject
    assert "no chunks" in found[0].detail


def test_a_gap_in_chunk_index_is_a_finding(clean_reader, snapshot) -> None:
    # claude-mem 461 has chunks 0 and 1 (ids 6 and 7); moving 1 to 3 leaves a gap.
    clean_reader.shift_index(7, 3)

    found = findings_of(audit(clean_reader, snapshot), CHECK_CHUNKS)

    assert [f.subject for f in found] == ["claude-mem:461"]
    assert "missing 1" in found[0].detail


def test_a_duplicate_chunk_index_is_a_finding(clean_reader, snapshot) -> None:
    clean_reader.shift_index(7, 0)

    found = findings_of(audit(clean_reader, snapshot), CHECK_CHUNKS)

    assert len(found) == 1
    assert "duplicate 0" in found[0].detail


# -- embeddings ---------------------------------------------------------------------------


def test_a_null_embedding_is_a_finding(clean_reader, snapshot) -> None:
    clean_reader.null_embedding(6)

    report = audit(clean_reader, snapshot)
    found = findings_of(report, CHECK_EMBEDDINGS)

    assert [f.subject for f in found] == ["claude-mem:461#0"]
    assert "null" in found[0].detail
    # The re-embed sample skips it rather than counting the same defect twice.
    assert not findings_of(report, CHECK_REEMBED)


def test_a_vector_off_unit_norm_is_a_finding(clean_reader, snapshot) -> None:
    clean_reader.scale_embedding(6, 1.01)

    found = findings_of(audit(clean_reader, snapshot), CHECK_EMBEDDINGS)

    assert len(found) == 1
    assert "1.01" in found[0].detail


def test_a_norm_inside_the_tolerance_is_not_a_finding(clean_reader, snapshot) -> None:
    clean_reader.scale_embedding(6, 1.0005)

    assert not findings_of(audit(clean_reader, snapshot), CHECK_EMBEDDINGS)


# -- token-count --------------------------------------------------------------------------


def test_a_chunk_over_the_model_window_is_a_finding(clean_reader, snapshot) -> None:
    clean_reader.set_content(6, " ".join(["word"] * 513))

    found = findings_of(audit(clean_reader, snapshot), CHECK_TOKEN_COUNT)

    assert len(found) == 1
    assert "513" in found[0].detail and "512" in found[0].detail
    assert found[0].severity != SEVERITY_INFO


def test_a_chunk_of_exactly_the_window_is_not_a_finding(clean_reader, snapshot) -> None:
    clean_reader.set_content(6, " ".join(["word"] * 512))

    assert not findings_of(audit(clean_reader, snapshot), CHECK_TOKEN_COUNT)


def test_a_stored_count_off_by_more_than_ten_percent_is_an_info_finding(clean_reader, snapshot) -> None:
    clean_reader.set_content(6, " ".join(["word"] * 100))
    clean_reader.set_token_count(6, 115)

    found = findings_of(audit(clean_reader, snapshot), CHECK_TOKEN_COUNT)

    assert len(found) == 1
    assert found[0].severity == SEVERITY_INFO
    assert "115" in found[0].detail and "100" in found[0].detail


def test_a_stored_count_within_ten_percent_is_not_a_finding(clean_reader, snapshot) -> None:
    clean_reader.set_content(6, " ".join(["word"] * 100))
    clean_reader.set_token_count(6, 109)

    assert not findings_of(audit(clean_reader, snapshot), CHECK_TOKEN_COUNT)


def test_a_missing_stored_count_is_an_info_finding(clean_reader, snapshot) -> None:
    clean_reader.set_token_count(6, None)

    found = findings_of(audit(clean_reader, snapshot), CHECK_TOKEN_COUNT)

    assert [f.severity for f in found] == [SEVERITY_INFO]


# -- vault ----------------------------------------------------------------------------------


def test_a_note_without_a_row_is_a_finding(clean_reader, snapshot) -> None:
    clean_reader.remove_document("classes/ist323/notes/lecture-1.md")

    found = findings_of(audit(clean_reader, snapshot), CHECK_VAULT)

    assert [f.subject for f in found] == ["classes/ist323/notes/lecture-1.md"]
    assert "no row" in found[0].detail
    assert "classes" in found[0].detail


def test_a_row_without_a_note_is_a_finding(clean_reader, snapshot) -> None:
    clean_reader.add_document("obsidian", "projects/alpha/notes/deleted.md", "a" * 64, "projects", ["gone"])

    found = findings_of(audit(clean_reader, snapshot), CHECK_VAULT)

    assert [f.subject for f in found] == ["projects/alpha/notes/deleted.md"]
    assert "no note" in found[0].detail


def test_a_row_for_a_note_the_walk_skips_names_the_reason(clean_reader, snapshot) -> None:
    clean_reader.add_document("obsidian", "projects/alpha/notes/opted-out.md", "a" * 64, "projects", ["x"])

    found = findings_of(audit(clean_reader, snapshot), CHECK_VAULT)

    assert len(found) == 1
    assert "skipped by the walk" in found[0].detail
    assert "ingest: false" in found[0].detail


def test_a_row_keyed_by_an_id_names_the_note_it_came_from(clean_reader, snapshot) -> None:
    clean_reader.add_document(
        "obsidian", "0b7e-uuid", "a" * 64, "projects", ["gone"], path="projects/vault/index.md"
    )

    found = findings_of(audit(clean_reader, snapshot), CHECK_VAULT)

    assert [f.subject for f in found] == ["0b7e-uuid"]
    assert "no note" in found[0].detail
    assert "projects/vault/index.md" in found[0].detail


def test_a_row_keyed_by_an_id_whose_note_is_skipped_is_matched_by_path(clean_reader, snapshot) -> None:
    clean_reader.add_document(
        "obsidian", "opted-out-uuid", "a" * 64, "projects", ["x"], path="projects/alpha/notes/opted-out.md"
    )

    found = findings_of(audit(clean_reader, snapshot), CHECK_VAULT)

    assert len(found) == 1
    assert "skipped by the walk (frontmatter ingest: false)" in found[0].detail


def test_a_stale_content_hash_is_a_finding(clean_reader, snapshot) -> None:
    clean_reader.stale_hash("alpha-index-0001")

    found = findings_of(audit(clean_reader, snapshot), CHECK_VAULT)

    assert [f.subject for f in found] == ["alpha-index-0001"]
    assert "content_hash" in found[0].detail


def test_legacy_rows_are_counted_not_reported(clean_reader, snapshot) -> None:
    clean_reader.add_document("obsidian", "old/pre-realm.md", "a" * 64, None, ["legacy"])

    result = audit(clean_reader, snapshot).check(CHECK_VAULT)

    assert not result.findings
    assert any("1 legacy row" in note for note in result.notes)


def test_rows_of_a_realm_this_vault_lacks_are_not_compared(clean_reader, snapshot) -> None:
    clean_reader.add_document("obsidian", "work-vm/notes/x.md", "a" * 64, "work-vm", ["elsewhere"])

    assert not findings_of(audit(clean_reader, snapshot), CHECK_VAULT)


def test_claude_mem_rows_never_take_part_in_the_vault_check(clean_reader, snapshot) -> None:
    clean_reader.stale_hash("461")

    assert not findings_of(audit(clean_reader, snapshot), CHECK_VAULT)


def test_a_vault_without_markers_is_compared_as_one_scope(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    shutil.copytree(FIXTURE_VAULT / "projects", vault / "projects")
    (vault / "projects" / ".realm").unlink()
    (vault / "projects" / "alpha" / "notes" / "shared-b.md").unlink()
    snap = snapshot_of(vault)
    assert snap.realms == ()
    reader = FakeReader.from_loaded(snap.loaded)
    # Realm-less rows are the whole scope here, and a stray one is a finding.
    reader.add_document("obsidian", "projects/alpha/notes/deleted.md", "a" * 64, None, ["gone"])

    report = audit(reader, snap)

    assert [f.subject for f in findings_of(report, CHECK_VAULT)] == ["projects/alpha/notes/deleted.md"]
    assert only_failing(report) == {CHECK_VAULT}


def test_a_vault_without_markers_leaves_realm_tagged_rows_alone(tmp_path: Path) -> None:
    # An unmarked vault is swept as the legacy rows only (``--prune-legacy``, realm None),
    # so a row another machine wrote under a realm is outside its scope: reporting it
    # would be a finding no prune here could ever clear.
    vault = tmp_path / "vault"
    shutil.copytree(FIXTURE_VAULT / "projects", vault / "projects")
    (vault / "projects" / ".realm").unlink()
    (vault / "projects" / "alpha" / "notes" / "shared-b.md").unlink()
    snap = snapshot_of(vault)
    assert snap.realms == ()
    reader = FakeReader.from_loaded(snap.loaded)
    reader.add_document("obsidian", "work-vm/notes/x.md", "a" * 64, "work-vm", ["elsewhere"])

    assert not findings_of(audit(reader, snap), CHECK_VAULT)


# -- duplicate-ids ----------------------------------------------------------------------------


def test_each_duplicate_external_id_is_a_finding(clean_reader, snapshot) -> None:
    found = findings_of(audit(clean_reader, snapshot), CHECK_DUPLICATE_IDS)

    assert [f.subject for f in found] == ["projects/alpha/notes/shared-b.md"]
    assert "shared-note-id" in found[0].detail


# -- re-embed ----------------------------------------------------------------------------------


def test_a_drifted_vector_is_a_re_embed_finding(clean_reader, snapshot) -> None:
    clean_reader.rotate_embedding(6)

    report = audit(clean_reader, snapshot)
    found = findings_of(report, CHECK_REEMBED)

    assert [f.subject for f in found] == ["claude-mem:461#0"]
    assert "cosine" in found[0].detail
    assert not findings_of(report, CHECK_EMBEDDINGS)


def test_a_store_smaller_than_the_sample_is_sampled_whole(clean_reader, snapshot) -> None:
    embedder = HashEmbedder()
    result = audit(clean_reader, snapshot, sample=SAMPLE, embedder=embedder).check(CHECK_REEMBED)

    assert not result.findings
    assert sorted(clean_reader.requested_samples[0]) == sorted(c.chunk_id for c in clean_reader.chunks)
    assert len(embedder.calls) == 1
    assert any(f"sampled {len(clean_reader.chunks)} of {len(clean_reader.chunks)}" in n for n in result.notes)


def test_the_sample_is_capped_at_the_requested_size(clean_reader, snapshot) -> None:
    audit(clean_reader, snapshot, sample=3)

    assert len(clean_reader.requested_samples[0]) == 3


def test_a_stored_vector_of_the_wrong_width_is_a_finding(clean_reader, snapshot) -> None:
    clean_reader._replace_chunk(6, vector=(1.0, 0.0))

    found = findings_of(audit(clean_reader, snapshot), CHECK_REEMBED)

    assert len(found) == 1
    assert "dimensions" in found[0].detail


def test_pick_sample_is_reproducible_with_a_seed_and_independent_of_order() -> None:
    ids = list(range(1, 201))

    first = pick_sample(ids, 10, seed=7)
    again = pick_sample(list(reversed(ids)), 10, seed=7)
    other = pick_sample(ids, 10, seed=8)

    assert first == again
    assert first != other
    assert len(set(first)) == 10


def test_pick_sample_takes_everything_when_the_store_is_small() -> None:
    assert sorted(pick_sample([3, 1, 2], 50, seed=None)) == [1, 2, 3]


def test_pick_sample_refuses_a_size_below_one() -> None:
    with pytest.raises(ValueError):
        pick_sample([1, 2], 0, seed=1)


# -- a row written while the audit walks (the capture race) -------------------------

WALK_CUTOFF = datetime(2026, 9, 28, 2, 50, tzinfo=timezone.utc)


def test_a_row_written_after_the_walk_began_is_not_reported_as_noteless(clean_reader, snapshot) -> None:
    # A SessionEnd hook captured this note after the walk; its row is not an orphan.
    clean_reader.add_document(
        "obsidian", "projects/alpha/sessions/captured.md", "a" * 64, "projects", ["new"],
        written_at=WALK_CUTOFF + timedelta(minutes=3),
    )

    result = audit(clean_reader, replace(snapshot, walked_at=WALK_CUTOFF)).check(CHECK_VAULT)

    assert result.findings == ()
    assert any("1 row(s) written after the walk began" in note for note in result.notes)


def test_a_row_rewritten_after_the_walk_began_is_not_a_hash_finding(clean_reader, snapshot) -> None:
    clean_reader.stale_hash("alpha-index-0001", written_at=WALK_CUTOFF + timedelta(seconds=30))

    result = audit(clean_reader, replace(snapshot, walked_at=WALK_CUTOFF)).check(CHECK_VAULT)

    assert result.findings == ()


def test_a_row_written_before_the_walk_is_still_compared(clean_reader, snapshot) -> None:
    clean_reader.add_document(
        "obsidian", "projects/alpha/notes/deleted.md", "a" * 64, "projects", ["gone"],
        written_at=WALK_CUTOFF - timedelta(days=1),
    )

    found = findings_of(audit(clean_reader, replace(snapshot, walked_at=WALK_CUTOFF)), CHECK_VAULT)

    assert [f.subject for f in found] == ["projects/alpha/notes/deleted.md"]
