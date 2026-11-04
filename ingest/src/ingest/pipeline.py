"""The one pipeline both loaders feed.

hash -> skip-if-unchanged -> chunk -> embed -> transactional upsert

Change detection happens before chunking and embedding, so a re-run over an
unchanged corpus does no model work and issues no writes at all.

The hash is over embedding content: a canonical view for generated sessions,
otherwise the original body. Frontmatter therefore needs its own comparison:
a resume flipping ``status`` to ``superseded``, a ``child_sessions`` link, or
``sweep-concluded --apply`` writing ``status`` and ``concluded_at`` changes
metadata and nothing else, and would otherwise sit behind the unchanged
short-circuit forever. Such a document takes the metadata-only path — one
UPDATE, no re-chunking and no embedding — and is counted separately. Generated
session notes also carry a raw-body hash so provenance-only edits refresh the
stored raw body without changing vectors.

Widening the hash to cover frontmatter would be the other way to catch it, and
would re-embed every document in the store the first time it ran.

A session note's retrievals (R-P2) ride along: after any write they are
re-projected into ``rag.retrieval_events``, and on an unchanged note the stored
row count is compared with the note's, so a re-run writes nothing and a table
migrated after the note was stored is filled on the next run.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Iterable

from .chunking import MarkdownChunker
from .embedding import Embedder
from .errors import IngestError
from .hashing import content_hash as compute_hash
from .jsonutil import canonical
from .models import DocumentState, SourceDocument
from .memory_policy import memory_exclusion_reason
from .store import ChunkStore
from .session_content import require_memory_enabled

log = logging.getLogger(__name__)


def _metadata_difference(
    document: SourceDocument, state: DocumentState
) -> str | None:
    """Why the stored row differs from the parsed document, or None.

    Every column the upsert writes apart from the body and its hash, because
    every one of them can change without the body changing. ``collection`` is
    the one that matters most: a note with a stable frontmatter ``id:`` that
    moves between folders keeps its body, and a stale collection is invisible —
    ``filter_collection`` simply stops matching it.

    ``metadata`` is compared as canonical JSON, so jsonb's key ordering — which
    is not the loader's — never reads as a difference. A blank scalar and a null
    one mean the same thing; the columns are nullable and the loaders disagree
    about which they produce.
    """
    reasons = [
        name
        for name, parsed, stored in (
            ("title", document.title, state.title),
            ("collection", document.collection, state.collection),
            ("agent", document.agent, state.agent),
        )
        if (parsed or None) != (stored or None)
    ]

    try:
        if canonical(_comparable(document.metadata)) != canonical(_comparable(state.metadata)):
            reasons.append("metadata")
    except IngestError as exc:
        # canonical() can refuse a value (metadata nested past its depth cap).
        # This path used to be a guaranteed no-op, so raising here would turn an
        # unchanged document into a FAILED one on every run — and a run with
        # failures never refreshes the health timestamp, so `ingest --health`
        # would report STALE for good. Rewriting from the freshly parsed
        # metadata, which the loader already validated, is self-healing.
        log.warning(
            "%s: could not compare stored metadata (%s); refreshing it",
            document.external_id,
            exc,
        )
        reasons.append("metadata")

    return " and ".join(reasons) + " changed" if reasons else None


# `_ingest` keys that describe the file on *this* machine, not the note: a second
# checkout has different mtimes, and a CRLF checkout a different byte count, for
# a note whose hash is identical. Stored, because they are useful, but never
# compared, or two machines sharing a store would rewrite each other's metadata
# on every run.
VOLATILE_INGEST_KEYS = frozenset({"modified_at", "bytes"})


def _comparable(metadata: dict | None) -> dict:
    """The metadata with its machine-volatile `_ingest` keys removed."""
    if not metadata or not isinstance(metadata.get("_ingest"), dict):
        return dict(metadata or {})
    ingest_meta = {k: v for k, v in metadata["_ingest"].items() if k not in VOLATILE_INGEST_KEYS}
    return {**metadata, "_ingest": ingest_meta}


class Action(str, Enum):
    INSERTED = "inserted"
    UPDATED = "updated"
    #: Body identical, frontmatter changed: title and metadata rewritten, chunks
    #: and embeddings left exactly as they are.
    METADATA_UPDATED = "metadata-updated"
    UNCHANGED = "unchanged"
    PLANNED_NEW = "would-insert"
    PLANNED_CHANGED = "would-update"
    PLANNED_METADATA = "would-update-metadata"
    FAILED = "failed"


class EventAction(str, Enum):
    """What happened to a document's retrieval events (R-P2)."""

    NONE = "none"
    WRITTEN = "written"
    PLANNED = "planned"
    #: rag.retrieval_events does not exist yet; the next run after the
    #: migration writes them.
    SKIPPED = "skipped"


@dataclass(frozen=True)
class DocumentOutcome:
    external_id: str
    action: Action
    chunk_count: int = 0
    detail: str | None = None
    #: Retrieval event rows written, planned or skipped, per ``event_action``.
    event_count: int = 0
    event_action: EventAction = EventAction.NONE


@dataclass
class IngestStats:
    """Run accumulator. Mutable by design — it is a counter, not domain data."""

    outcomes: list[DocumentOutcome] = field(default_factory=list)

    def record(self, outcome: DocumentOutcome) -> None:
        self.outcomes.append(outcome)

    def count(self, action: Action) -> int:
        return sum(1 for o in self.outcomes if o.action is action)

    @property
    def total(self) -> int:
        return len(self.outcomes)

    @property
    def chunks_written(self) -> int:
        writing = (Action.INSERTED, Action.UPDATED)
        return sum(o.chunk_count for o in self.outcomes if o.action in writing)

    @property
    def chunks_planned(self) -> int:
        planned = (Action.PLANNED_NEW, Action.PLANNED_CHANGED)
        return sum(o.chunk_count for o in self.outcomes if o.action in planned)

    @property
    def failures(self) -> list[DocumentOutcome]:
        return [o for o in self.outcomes if o.action is Action.FAILED]

    def _events(self, event_action: EventAction) -> int:
        return sum(o.event_count for o in self.outcomes if o.event_action is event_action)

    @property
    def events_written(self) -> int:
        return self._events(EventAction.WRITTEN)

    @property
    def events_planned(self) -> int:
        return self._events(EventAction.PLANNED)

    @property
    def events_skipped(self) -> int:
        return self._events(EventAction.SKIPPED)

    def summary(self) -> dict[str, int]:
        return {
            **{action.value: self.count(action) for action in Action},
            "events_written": self.events_written,
            "events_planned": self.events_planned,
            "events_skipped": self.events_skipped,
        }


class IngestPipeline:
    """Chunk, embed and store documents from any loader."""

    def __init__(
        self,
        store: ChunkStore,
        embedder: Embedder | None,
        chunker: MarkdownChunker | None = None,
        *,
        dry_run: bool = False,
        force: bool = False,
    ) -> None:
        if not dry_run and embedder is None:
            raise ValueError("a real run needs an embedder; pass dry_run=True instead")
        self.store = store
        self.embedder = embedder
        self.chunker = chunker or MarkdownChunker()
        self.dry_run = dry_run
        self.force = force

    def run(self, documents: Iterable[SourceDocument]) -> IngestStats:
        require_memory_enabled()
        stats = IngestStats()
        for document in documents:
            try:
                stats.record(self._process(document))
            except IngestError as exc:
                log.error("%s failed: %s", document.external_id, exc)
                stats.record(
                    DocumentOutcome(document.external_id, Action.FAILED, detail=str(exc))
                )
            except Exception as exc:  # noqa: BLE001 - counted, never swallowed
                log.exception("%s failed unexpectedly", document.external_id)
                stats.record(
                    DocumentOutcome(
                        document.external_id,
                        Action.FAILED,
                        detail=f"{type(exc).__name__}: {exc}",
                    )
                )
        return stats

    # -- per document ------------------------------------------------------

    def _process(self, document: SourceDocument) -> DocumentOutcome:
        policy_reason = memory_exclusion_reason({"agent": document.agent, **document.metadata})
        if policy_reason:
            raise IngestError(policy_reason)
        embedding_body = document.embedding_body if document.embedding_body is not None else document.body
        digest = compute_hash(embedding_body)
        state = self.store.get_document_state(document.source, document.external_id)
        is_new = state is None

        if state is not None and state.content_hash == digest and not self.force:
            return self._reconcile_metadata(document, state)

        # Canonical sessions carry a neutral heading. A display title can hold
        # runtime identifiers and must not become an embedding prefix.
        chunks = self.chunker.chunk(embedding_body, title=None if document.embedding_body is not None else document.title)
        if not chunks:
            raise IngestError(
                f"{document.external_id}: chunker produced nothing from a "
                f"{len(document.body)}-character body"
            )

        if self.dry_run:
            action = Action.PLANNED_NEW if is_new else Action.PLANNED_CHANGED
            return self._plan_events(
                DocumentOutcome(document.external_id, action, len(chunks)), document
            )

        assert self.embedder is not None  # guaranteed by __init__
        embeddings = self.embedder.embed([chunk.content for chunk in chunks])
        document_id, inserted = self.store.replace_document(
            document, digest, chunks, embeddings
        )
        outcome = DocumentOutcome(
            document.external_id,
            Action.INSERTED if inserted else Action.UPDATED,
            len(chunks),
        )
        return self._project_events(outcome, document_id, document, clear_stale=not inserted)

    # -- the body is identical; is the frontmatter? -------------------------

    def _reconcile_metadata(
        self, document: SourceDocument, state: DocumentState
    ) -> DocumentOutcome:
        difference = _metadata_difference(document, state)
        if difference is None:
            log.debug("%s unchanged, skipping", document.external_id)
            return self._heal_events(
                DocumentOutcome(document.external_id, Action.UNCHANGED),
                state.document_id,
                document,
            )

        if self.dry_run:
            return self._plan_events(
                DocumentOutcome(document.external_id, Action.PLANNED_METADATA, detail=difference),
                document,
            )

        log.debug("%s: %s; refreshing metadata only", document.external_id, difference)
        self.store.update_document_metadata(state.document_id, document)
        outcome = DocumentOutcome(
            document.external_id, Action.METADATA_UPDATED, detail=difference
        )
        return self._project_events(outcome, state.document_id, document, clear_stale=True)

    # -- retrieval events (R-P2) ---------------------------------------------
    #
    # `retrievals` is kept out of metadata, so neither the body hash nor the
    # metadata comparison sees it change. After a write the events are always
    # re-projected; on an unchanged document the stored row count is compared
    # with the expected one, which also fills a table created after the note was
    # stored. Replacing is keyed by the note, so a re-run never duplicates rows.

    def _project_events(
        self,
        outcome: DocumentOutcome,
        document_id: int,
        document: SourceDocument,
        *,
        clear_stale: bool = False,
    ) -> DocumentOutcome:
        expected = len(document.retrievals)
        if not expected:
            # A rewritten note that no longer carries retrievals must not keep
            # the rows of the ones it lost. A new document has none to lose.
            if clear_stale and self.store.count_retrieval_events(document):
                self.store.replace_retrieval_events(document_id, document)
                log.debug("%s: cleared retrieval events it no longer carries", document.external_id)
            return outcome

        written = self.store.replace_retrieval_events(document_id, document)
        if written == 0:
            # Only a missing table writes nothing for a non-empty list.
            return replace(outcome, event_count=expected, event_action=EventAction.SKIPPED)
        return replace(outcome, event_count=written, event_action=EventAction.WRITTEN)

    def _heal_events(
        self, outcome: DocumentOutcome, document_id: int, document: SourceDocument
    ) -> DocumentOutcome:
        expected = len(document.retrievals)
        if not expected:
            return outcome
        stored = self.store.count_retrieval_events(document)
        if stored is None:
            return replace(outcome, event_count=expected, event_action=EventAction.SKIPPED)
        if stored == expected:
            return outcome
        if self.dry_run:
            return replace(outcome, event_count=expected, event_action=EventAction.PLANNED)
        log.info(
            "%s: %d retrieval event(s) stored, %d in the note; re-projecting",
            document.external_id,
            stored,
            expected,
        )
        return self._project_events(outcome, document_id, document)

    def _plan_events(self, outcome: DocumentOutcome, document: SourceDocument) -> DocumentOutcome:
        expected = len(document.retrievals)
        if not expected:
            return outcome
        if self.store.count_retrieval_events(document) is None:
            return replace(outcome, event_count=expected, event_action=EventAction.SKIPPED)
        return replace(outcome, event_count=expected, event_action=EventAction.PLANNED)
