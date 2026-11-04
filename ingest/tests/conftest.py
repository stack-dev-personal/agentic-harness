"""Shared fixtures. No test touches a real database or downloads a model."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Sequence

import pytest

from ingest.config import EMBEDDING
from ingest.errors import StoreError
from ingest.models import Chunk, DocumentState, RetrievalEvent, SourceDocument

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def isolate_memory_policy_environment(tmp_path: Path, monkeypatch):
    """Tests never consult real session exclusion markers or machine policy."""
    monkeypatch.setenv("HARNESS_MEMORY_STATE_DIR", str(tmp_path / "memory-state"))
    monkeypatch.delenv("HARNESS_MEMORY_EXCLUDED_ROOTS", raising=False)
    monkeypatch.delenv("HARNESS_MEMORY_PERSISTENCE", raising=False)


@pytest.fixture
def vault_path() -> Path:
    return FIXTURES / "vault"


class FakeEmbedder:
    """Deterministic stand-in for fastembed. Same dimensions, no model."""

    def __init__(self, dimensions: int = EMBEDDING.dimensions) -> None:
        self._dimensions = dimensions
        self.calls: list[list[str]] = []

    @property
    def dimensions(self) -> int:
        return self._dimensions

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [
            [float((len(text) + i) % 7) / 7.0 for i in range(self._dimensions)]
            for text in texts
        ]


def _state(document_id: int, content_hash: str, document: SourceDocument) -> DocumentState:
    """What the database would hold after writing this document."""
    return DocumentState(
        document_id=document_id,
        content_hash=content_hash,
        title=document.title,
        collection=document.collection,
        agent=document.agent,
        metadata=dict(document.metadata),
    )


def _realm_of(state: DocumentState) -> str | None:
    """Mirrors the store's jsonb predicate: the realm key, or None for a legacy row."""
    ingest_meta = state.metadata.get("_ingest")
    return ingest_meta.get("realm") if isinstance(ingest_meta, dict) else None


class FakeStore:
    """In-memory ChunkStore that records every write."""

    def __init__(self) -> None:
        self.documents: dict[tuple[str, str], DocumentState] = {}
        self.chunks: dict[int, list[Chunk]] = {}
        self.embeddings: dict[int, list[list[float]]] = {}
        self.bodies: dict[tuple[str, str], str] = {}
        self.write_calls = 0
        self.metadata_writes = 0
        self.lookup_calls = 0
        self._next_id = 1
        self.closed = False
        # Retrieval events, keyed like the store keys them: by the note.
        self.events: dict[tuple[str, str], list[tuple[int, RetrievalEvent]]] = {}
        #: One (document_id, note external_id, rows written) per projection.
        self.event_projections: list[tuple[int, str, int]] = []
        #: Flip to False to stand for a store that has not run the migration.
        self.events_table_exists = True
        #: The database clock: every write stamps a row with it, as the
        #: updated_at trigger does. Tests move it with :meth:`advance`.
        self.now = datetime(2026, 9, 27, 3, 0, tzinfo=timezone.utc)
        self.written_at: dict[tuple[str, str], datetime] = {}

    def advance(self, **delta: float) -> datetime:
        """Move the database clock forward; returns the new time."""
        self.now = self.now + timedelta(**delta)
        return self.now

    def get_document_state(self, source: str, external_id: str) -> DocumentState | None:
        self.lookup_calls += 1
        return self.documents.get((source, external_id))

    def replace_document(
        self,
        document: SourceDocument,
        content_hash: str,
        chunks: Sequence[Chunk],
        embeddings: Sequence[Sequence[float]],
    ) -> tuple[int, bool]:
        if len(chunks) != len(embeddings):
            raise StoreError("chunk/embedding length mismatch")
        self.write_calls += 1
        key = (document.source, document.external_id)
        existing = self.documents.get(key)
        if existing is None:
            document_id = self._next_id
            self._next_id += 1
            inserted = True
        else:
            document_id = existing.document_id
            inserted = False
        self.documents[key] = _state(document_id, content_hash, document)
        self.bodies[key] = document.body
        self.written_at[key] = self.now
        self.chunks[document_id] = list(chunks)
        self.embeddings[document_id] = [list(e) for e in embeddings]
        return document_id, inserted

    def update_document_metadata(self, document_id, document) -> None:
        """Refresh everything but the body; chunks and embeddings stay put."""
        for key, state in self.documents.items():
            if state.document_id != document_id:
                continue
            self.metadata_writes += 1
            self.documents[key] = _state(document_id, state.content_hash, document)
            self.bodies[key] = document.body
            self.written_at[key] = self.now
            return
        raise StoreError(f"no document with id {document_id}")

    def list_external_ids(
        self, source: str, realm: str | None = None, written_before: datetime | None = None
    ) -> set[str]:
        return {
            external_id
            for (src, external_id), state in self.documents.items()
            if src == source and _realm_of(state) == realm
            and self._written_before((src, external_id), written_before)
        }

    def delete_documents(
        self, source: str, external_ids, realm: str | None = None, written_before: datetime | None = None
    ) -> int:
        deleted = 0
        for external_id in external_ids:
            state = self.documents.get((source, external_id))
            if state is None or _realm_of(state) != realm:
                continue
            if not self._written_before((source, external_id), written_before):
                continue
            self.documents.pop((source, external_id))
            self.written_at.pop((source, external_id), None)
            self.chunks.pop(state.document_id, None)
            self.embeddings.pop(state.document_id, None)
            deleted += 1
        return deleted

    def _written_before(self, key: tuple[str, str], cutoff: datetime | None) -> bool:
        return cutoff is None or self.written_at[key] < cutoff

    def replace_retrieval_events(self, document_id: int, document: SourceDocument) -> int:
        """Delete the note's rows and insert all of them, as the real store does."""
        if not self.events_table_exists:
            return 0
        key = (document.source, document.external_id)
        self.events[key] = [(document_id, event) for event in document.retrievals]
        self.event_projections.append((document_id, document.external_id, len(document.retrievals)))
        return len(document.retrievals)

    def count_retrieval_events(self, document: SourceDocument) -> int | None:
        if not self.events_table_exists:
            return None
        return len(self.events.get((document.source, document.external_id), []))

    def close(self) -> None:
        self.closed = True

    @property
    def total_chunks(self) -> int:
        return sum(len(v) for v in self.chunks.values())


@pytest.fixture
def fake_store() -> FakeStore:
    return FakeStore()


@pytest.fixture
def fake_embedder() -> FakeEmbedder:
    return FakeEmbedder()


# --------------------------------------------------------------------------
# claude-mem export fixtures
# --------------------------------------------------------------------------


def observation_row(obs_id: int, **overrides) -> dict:
    row = {
        "id": obs_id,
        "memory_session_id": "62448f65-f47d-485c-a1d8-5661e45229bb",
        "project": "ai-news-agent",
        "text": None,
        "type": "discovery",
        "title": f"Observation {obs_id}",
        "subtitle": "a subtitle",
        "facts": json.dumps([f"fact {obs_id}", "another fact"]),
        "narrative": f"Narrative body for observation {obs_id}. " * 4,
        "concepts": json.dumps(["pattern", "how-it-works"]),
        "files_read": json.dumps(["src/a.py"]),
        "files_modified": json.dumps([]),
        "prompt_number": 3,
        "discovery_tokens": 1044,
        "created_at": "2026-05-07T06:09:44.425Z",
        "created_at_epoch": 1778134184425,
        "content_hash": "3c0b360f730969e4",
    }
    row.update(overrides)
    return row


def empty_observation_row(obs_id: int) -> dict:
    """Mirrors the 18 failed writes from the 2026-05-07 migration."""
    return observation_row(
        obs_id,
        text=None,
        title=None,
        subtitle=None,
        narrative=None,
        facts="[]",
        concepts="[]",
        files_read="[]",
        files_modified="[]",
        type="bugfix",
    )


def summary_row(summary_id: int, **overrides) -> dict:
    row = {
        "id": summary_id,
        "memory_session_id": "62448f65-f47d-485c-a1d8-5661e45229bb",
        "project": "quant-edge-tracker",
        "request": f"Request text for summary {summary_id}",
        "investigated": "Reviewed the existing spec.",
        "learned": "v1 is deliberately single user.",
        "completed": "Security review completed.",
        "next_steps": "Continue with phase 1.",
        "files_read": None,
        "files_edited": None,
        "notes": "Some closing notes.",
        "prompt_number": 1,
        "discovery_tokens": 1309,
        "created_at": "2026-05-07T05:14:25.569Z",
        "created_at_epoch": 1778130865569,
    }
    row.update(overrides)
    return row


MEMORY_SESSION_ID = "62448f65-f47d-485c-a1d8-5661e45229bb"
CONTENT_SESSION_ID = "7048196e-593e-4ac5-b02d-be2c5d83faf3"


def prompt_row(prompt_id: int, **overrides) -> dict:
    """user_prompts rows join on content_session_id, NOT memory_session_id."""
    row = {
        "id": prompt_id,
        "content_session_id": CONTENT_SESSION_ID,
        "prompt_number": prompt_id,
        # Long enough to clear MIN_PROMPT_CHARS: the fixture stands for a real request.
        "prompt_text": (
            f"Prompt text number {prompt_id}, asking for something specific enough "
            "to be worth finding again later on."
        ),
        "created_at": "2026-03-24T17:35:26.929Z",
        "created_at_epoch": 1774373726929,
    }
    row.update(overrides)
    return row


def session_row(session_id: int, **overrides) -> dict:
    row = {
        "id": session_id,
        "content_session_id": CONTENT_SESSION_ID,
        "memory_session_id": MEMORY_SESSION_ID,
        "project": "ai-news-agent",
        "user_prompt": "",
        "started_at": "2026-03-24T17:31:25.491Z",
        "started_at_epoch": 1774373485491,
        "completed_at": None,
        "completed_at_epoch": 1775677010685,
        "status": "failed",
        "worker_port": 37778,
        "prompt_counter": 0,
        "custom_title": None,
    }
    row.update(overrides)
    return row


@pytest.fixture
def export_dir(tmp_path: Path) -> Path:
    """5 usable observations, 2 empty, 2 summaries, 3 prompts, 1 session row."""
    directory = tmp_path / "claude-mem-export"
    directory.mkdir()

    observations = [observation_row(i) for i in range(1, 6)]
    observations += [empty_observation_row(i) for i in (68, 69)]
    (directory / "observations.json").write_text(
        json.dumps(observations), encoding="utf-8"
    )
    (directory / "session_summaries.json").write_text(
        json.dumps([summary_row(1), summary_row(2)]), encoding="utf-8"
    )
    (directory / "user_prompts.json").write_text(
        json.dumps([prompt_row(i) for i in (1, 2, 3)]), encoding="utf-8"
    )
    (directory / "sdk_sessions.json").write_text(
        json.dumps([session_row(1)]), encoding="utf-8"
    )
    return directory
