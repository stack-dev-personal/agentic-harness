"""Persistence for ``rag.documents`` and ``rag.chunks``.

The pipeline talks to the :class:`ChunkStore` protocol, so the tests run against
an in-memory fake and never need a database. :class:`PostgresStore` is the real
implementation and is the only place SQL is written.

Write model: one transaction per document. Upsert on ``(source, external_id)``,
delete that document's chunks, insert the new ones. If anything in that sequence
fails the document keeps its previous chunks — never a half-rewritten document.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from typing import Any, Protocol, Sequence

from .config import CHUNKS_TABLE, DOCUMENTS_TABLE, RAG_SCHEMA, VECTOR_TYPE, DbSettings
from .embedding import vector_literal
from .errors import ConfigError, StoreError
from .jsonutil import dumps
from .migrations import LEDGER_TABLE
from .models import Chunk, DocumentState, RetrievalEvent, SourceDocument

log = logging.getLogger(__name__)


def _as_metadata(raw: Any) -> dict[str, Any]:
    """The ``metadata`` column as a dict, whatever the driver handed back.

    psycopg decodes ``jsonb`` to a dict, but a connection configured without the
    json loader (or a fake in a test) returns the raw text. Both are accepted; a
    column holding a JSON scalar or array is not metadata and comes back empty
    rather than crashing a run over one odd row.
    """
    if raw is None:
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            log.warning("metadata column did not hold valid JSON; treating it as empty")
            return {}
    if isinstance(raw, dict):
        return raw
    log.warning("metadata column held %s, not an object", type(raw).__name__)
    return {}

# TCP keepalives so the OS notices a half-open socket rather than the next query
# discovering it. Embedding runs leave the connection idle for long stretches and
# Supabase's pooler will otherwise reap it silently.
_KEEPALIVE_KWARGS: dict[str, object] = {
    "keepalives": 1,
    "keepalives_idle": 30,
    "keepalives_interval": 10,
    "keepalives_count": 5,
}


def connect_kwargs(settings: DbSettings) -> dict[str, object]:
    """Everything psycopg.connect needs beyond the URL — TLS included.

    libpq's default is ``sslmode=prefer``, which neither verifies the server
    certificate nor refuses a plaintext downgrade. This connection carries the
    service-role credential and every document body, so it is ``verify-full``
    against the pinned Supabase CA, mirroring the MCP server's
    ``rejectUnauthorized: true``. The only way off that is the explicit
    ``DATABASE_SSL=disable`` for a local Postgres; there is no "no-verify".
    """
    kwargs: dict[str, object] = {"autocommit": False, **_KEEPALIVE_KWARGS}
    if settings.ssl_disabled:
        kwargs["sslmode"] = "disable"
        return kwargs
    if not settings.ssl_root_cert:
        raise ConfigError(
            "DATABASE_CA_CERT is not set. TLS is verified (sslmode=verify-full) and "
            "Supabase signs with its own root CA, so the pinned certificate is required: "
            "set DATABASE_CA_CERT (or PGSSLROOTCERT) to certs/prod-ca.crt using an "
            "absolute C:/... path. For a local Postgres only, DATABASE_SSL=disable."
        )
    if not os.path.isfile(settings.ssl_root_cert):
        raise ConfigError(
            f"DATABASE_CA_CERT points at {settings.ssl_root_cert}, which does not exist "
            "or is not a file. Use an absolute C:/... path (not an MSYS /c/... path); "
            "the Supabase CA lives at certs/prod-ca.crt in this repo."
        )
    kwargs["sslmode"] = "verify-full"
    kwargs["sslrootcert"] = settings.ssl_root_cert
    return kwargs

_UPSERT_DOCUMENT = f"""
INSERT INTO {DOCUMENTS_TABLE}
    (source, collection, agent, external_id, title, body, metadata, content_hash)
VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)
ON CONFLICT (source, external_id) DO UPDATE SET
    collection   = EXCLUDED.collection,
    agent        = EXCLUDED.agent,
    title        = EXCLUDED.title,
    body         = EXCLUDED.body,
    metadata     = EXCLUDED.metadata,
    content_hash = EXCLUDED.content_hash
RETURNING id, (xmax = 0) AS inserted
"""

# Everything the upsert writes except body and content_hash comes back too: the
# pipeline compares these against the freshly parsed ones to spot an edit the
# body hash cannot see.
_SELECT_STATE = f"""
SELECT id, content_hash, title, collection, agent, metadata
FROM {DOCUMENTS_TABLE}
WHERE source = %s AND external_id = %s
"""

# The frontmatter-only path: no chunk delete, no chunk insert, no embedding.
#
# It sets every column the upsert sets apart from body and content_hash, which
# are unchanged by definition here. `collection` in particular: a note with a
# stable frontmatter `id:` that moves between folders keeps its body, so this is
# the only statement that would ever correct its collection — and a stale
# collection is invisible, because `filter_collection` just stops matching.
_UPDATE_METADATA = f"""
UPDATE {DOCUMENTS_TABLE}
SET title = %s, collection = %s, agent = %s, metadata = %s::jsonb, body = %s
WHERE id = %s
"""

_DELETE_CHUNKS = f"DELETE FROM {CHUNKS_TABLE} WHERE document_id = %s"

# Realm scoping. A named realm is a jsonb containment match, which the
# documents_metadata_idx GIN index serves; "no realm" matches only rows whose
# `_ingest` carries no `realm` key — the rows written before realms existed.
_IN_REALM = "metadata @> %s::jsonb"
_NO_REALM = "NOT (metadata ? '_ingest' AND metadata->'_ingest' ? 'realm')"
# The orphan sweep's machine scope: a row whose note names another machine is
# that machine's to sweep. A row with no `machine:`, or an empty one (a hub, a
# handoff, a session captured before machine.env existed), belongs to whoever
# holds the realm. ``prune.owned_by`` states the same rule in Python; keep both.
# Public: the store audit (``verify_store``) scopes its reads with it too.
OWN_MACHINE_CLAUSE = "coalesce(metadata->>'machine', '') IN ('', %s)"

_SELECT_EXTERNAL_IDS = f"SELECT external_id FROM {DOCUMENTS_TABLE} WHERE source = %s AND "

_SELECT_NOW = "SELECT now()"

# rag.chunks cascades from rag.documents, so deleting the parent is enough.
_DELETE_DOCUMENTS = f"DELETE FROM {DOCUMENTS_TABLE} WHERE source = %s AND external_id = ANY(%s) AND "


def realm_clause(realm: str | None) -> tuple[str, tuple[Any, ...]]:
    """The SQL predicate and its parameters for one realm, or for the legacy rows.

    Public because the store audit (``verify_store``) scopes its reads with the
    same predicate, so the audit and the orphan sweep can never disagree about
    which rows belong to a realm.
    """
    if realm is None:
        return _NO_REALM, ()
    return _IN_REALM, (json.dumps({"_ingest": {"realm": realm}}),)

_INSERT_CHUNK = f"""
INSERT INTO {CHUNKS_TABLE}
    (document_id, chunk_index, content, token_count, embedding)
VALUES (%s, %s, %s, %s, %s::{VECTOR_TYPE})
"""

# -- retrieval events (R-P2) -------------------------------------------------
#
# A session note's `retrievals:` projected into rows. The note is the record, so
# re-ingesting it replaces all of its rows at once, keyed by the note: delete,
# then insert, one transaction.

RETRIEVAL_EVENTS_TABLE = f"{RAG_SCHEMA}.retrieval_events"

_EVENTS_TABLE_EXISTS = f"SELECT to_regclass('{RETRIEVAL_EVENTS_TABLE}')"
_LEDGER_EXISTS = f"SELECT to_regclass('{LEDGER_TABLE}')"

# The newest applied migration that touched rag.search, by its file name. The
# ledger is how a later report tells which ranking produced an event.
_SEARCH_VERSION = f"SELECT max(version) FROM {LEDGER_TABLE} WHERE position('search' in name) > 0"

_DELETE_EVENTS = f"DELETE FROM {RETRIEVAL_EVENTS_TABLE} WHERE note_source = %s AND note_external_id = %s"

_COUNT_EVENTS = f"SELECT count(*) FROM {RETRIEVAL_EVENTS_TABLE} WHERE note_source = %s AND note_external_id = %s"

# result_document_id is resolved in the same statement, so it names the row the
# result points at now; an unknown or empty result resolves to null.
_INSERT_EVENT = f"""
INSERT INTO {RETRIEVAL_EVENTS_TABLE}
    (note_source, note_external_id, document_id, session_id, parent_session, machine,
     realm, collection, channel, tool, query, filters, "limit", retrieval_index,
     retrieved_at, rank, source, external_id, result_document_id, chunk_id,
     similarity, rrf, search_version)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s,
        (SELECT d.id FROM {DOCUMENTS_TABLE} d WHERE d.source = %s AND d.external_id = %s),
        %s, %s, %s, %s)
"""

_EVENTS_MISSING_WARNING = (
    f"{RETRIEVAL_EVENTS_TABLE} does not exist; run `uv run ingest db migrate`. "
    "Retrieval events are skipped for this run and written on the next one."
)


def _sweep_clause(
    realm: str | None, written_before: datetime | None, machine: str | None = None
) -> tuple[str, tuple[Any, ...]]:
    """:func:`realm_clause`, plus the sweep's cutoff and machine scope when given."""
    clause, params = realm_clause(realm)
    if written_before is not None:
        clause, params = f"{clause} AND updated_at < %s", (*params, written_before)
    if machine is not None:
        clause, params = f"{clause} AND {OWN_MACHINE_CLAUSE}", (*params, machine)
    return clause, params


def _event_row(
    event: RetrievalEvent, document_id: int, search_version: str | None
) -> tuple[Any, ...]:
    """One ``_INSERT_EVENT`` parameter tuple, in column order."""
    return (
        event.note_source,
        event.note_external_id,
        document_id,
        event.session_id,
        event.parent_session,
        event.machine,
        event.realm,
        event.collection,
        event.channel,
        event.tool,
        event.query,
        dumps(event.filters),
        event.limit,
        event.retrieval_index,
        event.retrieved_at,
        event.rank,
        event.source,
        event.external_id,
        event.source,
        event.external_id,
        event.chunk_id,
        event.similarity,
        event.rrf,
        search_version,
    )


class ChunkStore(Protocol):
    """What the pipeline needs from a persistence layer."""

    def get_document_state(
        self, source: str, external_id: str
    ) -> DocumentState | None: ...

    def replace_document(
        self,
        document: SourceDocument,
        content_hash: str,
        chunks: Sequence[Chunk],
        embeddings: Sequence[Sequence[float]],
    ) -> tuple[int, bool]: ...

    def update_document_metadata(
        self, document_id: int, document: SourceDocument
    ) -> None: ...

    def list_external_ids(
        self,
        source: str,
        realm: str | None = None,
        written_before: datetime | None = None,
        machine: str | None = None,
    ) -> set[str]:
        """Ids of ``source`` inside ``realm``.

        ``realm=None`` is not "every realm": it means the rows that carry no
        ``_ingest.realm`` at all — rows ingested before realms existed. A realm
        this machine never walked is never listed, which is what keeps two vaults
        sharing one store from pruning each other. ``written_before`` keeps only
        rows whose ``updated_at`` is earlier. ``machine`` keeps only rows this
        machine may sweep: ones whose note carries no ``machine:`` or names this
        one, so two clones of one realm that have not synced yet cannot delete
        each other's sessions.
        """
        ...

    def delete_documents(
        self,
        source: str,
        external_ids: Sequence[str],
        realm: str | None = None,
        written_before: datetime | None = None,
        machine: str | None = None,
    ) -> int: ...

    def database_now(self) -> datetime | None:
        """The database clock, which stamps ``updated_at``; None when there is no database."""
        ...

    def replace_retrieval_events(self, document_id: int, document: SourceDocument) -> int:
        """Replace every event row of ``document`` with its ``retrievals``.

        Returns the rows written; 0 when the table does not exist yet.
        """
        ...

    def count_retrieval_events(self, document: SourceDocument) -> int | None:
        """Event rows stored for ``document``; None when the table does not exist."""
        ...

    def close(self) -> None: ...


class PostgresStore:
    """psycopg-backed :class:`ChunkStore`.

    Holds one connection for the length of a run. That connection sits idle while
    each document is chunked and embedded locally — seconds at a time, minutes in
    aggregate — and Supabase's Supavisor pooler drops connections that go quiet.
    A dropped connection previously failed every remaining document with
    "the connection is closed", so operations reconnect once and retry.
    """

    def __init__(
        self,
        connection,
        database_url: str | None = None,
        connect_options: dict[str, object] | None = None,
    ) -> None:
        self._conn = connection
        self._database_url = database_url
        # The exact kwargs the first connection used, so a reconnect can never
        # come back with weaker TLS or without keepalives.
        self._connect_options = dict(connect_options or {"autocommit": False})
        # Checked once per run, on first use: whether rag.retrieval_events
        # exists, and the rag.search version its rows are stamped with.
        self._events_table: bool | None = None
        self._search_version: str | None = None

    # -- connection resilience ---------------------------------------------

    def _reconnect(self) -> bool:
        """Replace a dead connection. Returns False if that is not possible."""
        if not self._database_url:
            return False
        try:
            import psycopg

            try:
                self._conn.close()
            except Exception:  # noqa: BLE001 - already dead; nothing to salvage
                pass
            self._conn = psycopg.connect(self._database_url, **self._connect_options)
            log.warning("Database connection was dropped; reconnected.")
            return True
        except Exception as exc:  # noqa: BLE001
            log.error("Reconnect failed: %s", exc)
            return False

    @staticmethod
    def _is_connection_loss(exc: Exception) -> bool:
        """Distinguish a dead connection from a genuine query error.

        Retrying a constraint violation would just fail again; retrying a dropped
        connection succeeds. Only the latter is worth a second attempt.
        """
        text = str(exc).lower()
        markers = (
            "connection is closed",
            "connection already closed",
            "server closed the connection",
            "connection reset",
            "terminating connection",
            "eof detected",
            "ssl connection has been closed",
            "consuming input failed",
        )
        if any(m in text for m in markers):
            return True
        return type(exc).__name__ in {"OperationalError", "InterfaceError"}

    def _run(self, what: str, operation):
        """Execute ``operation``; on connection loss reconnect once and retry."""
        try:
            return operation()
        except Exception as exc:  # noqa: BLE001
            if not self._is_connection_loss(exc):
                raise
            log.warning("%s hit a dropped connection: %s", what, exc)
            if not self._reconnect():
                raise
            return operation()

    # -- construction ------------------------------------------------------

    @classmethod
    def from_settings(cls, settings: DbSettings) -> "PostgresStore":
        if not settings.can_connect:
            raise ConfigError(
                "DATABASE_URL is not set. Export it (or put it in ingest/.env and "
                "source it) before running a write ingest; use --dry-run to plan "
                "without a database."
            )
        try:
            import psycopg
        except ImportError as exc:  # pragma: no cover - install-time problem
            raise ConfigError(
                "psycopg is not installed. Run `uv sync` in ingest/."
            ) from exc

        options = connect_kwargs(settings)  # raises ConfigError before any I/O
        try:
            conn = psycopg.connect(settings.database_url, **options)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            raise StoreError(f"Could not connect to the database: {exc}") from exc
        return cls(conn, database_url=settings.database_url, connect_options=options)

    # -- reads -------------------------------------------------------------

    def get_document_state(self, source: str, external_id: str) -> DocumentState | None:
        def _lookup():
            with self._conn.cursor() as cur:
                cur.execute(_SELECT_STATE, (source, external_id))
                found = cur.fetchone()
            self._conn.rollback()  # end the implicit read transaction
            return found

        try:
            row = self._run(f"Lookup of {source}/{external_id}", _lookup)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(f"Lookup of {source}/{external_id} failed: {exc}") from exc

        if row is None:
            return None
        return DocumentState(
            document_id=int(row[0]),
            content_hash=str(row[1]),
            title=None if row[2] is None else str(row[2]),
            collection=None if row[3] is None else str(row[3]),
            agent=None if row[4] is None else str(row[4]),
            metadata=_as_metadata(row[5]),
        )

    # -- writes ------------------------------------------------------------

    def replace_document(
        self,
        document: SourceDocument,
        content_hash: str,
        chunks: Sequence[Chunk],
        embeddings: Sequence[Sequence[float]],
    ) -> tuple[int, bool]:
        if len(chunks) != len(embeddings):
            raise StoreError(
                f"{document.external_id}: {len(chunks)} chunks but "
                f"{len(embeddings)} embeddings"
            )
        if not chunks:
            raise StoreError(f"{document.external_id}: refusing to write 0 chunks")

        def _write() -> tuple[int, bool]:
            # The whole document — upsert, chunk delete, chunk insert — is one
            # transaction, so a retry after a dropped connection re-runs it
            # cleanly rather than leaving a document with half its chunks.
            with self._conn.cursor() as cur:
                cur.execute(
                    _UPSERT_DOCUMENT,
                    (
                        document.source,
                        document.collection,
                        document.agent,
                        document.external_id,
                        document.title,
                        document.body,
                        dumps(document.metadata),
                        content_hash,
                    ),
                )
                row = cur.fetchone()
                if row is None:
                    raise StoreError(
                        f"{document.external_id}: upsert returned no id"
                    )
                doc_id, was_inserted = int(row[0]), bool(row[1])

                cur.execute(_DELETE_CHUNKS, (doc_id,))
                cur.executemany(
                    _INSERT_CHUNK,
                    [
                        (
                            doc_id,
                            chunk.chunk_index,
                            chunk.content,
                            chunk.token_count,
                            vector_literal(embedding),
                        )
                        for chunk, embedding in zip(chunks, embeddings)
                    ],
                )
            self._conn.commit()
            return doc_id, was_inserted

        try:
            document_id, inserted = self._run(
                f"Write of {document.source}/{document.external_id}", _write
            )
        except StoreError:
            self._safe_rollback()
            raise
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(
                f"Write of {document.source}/{document.external_id} failed: {exc}"
            ) from exc

        return document_id, inserted

    def update_document_metadata(
        self, document_id: int, document: SourceDocument
    ) -> None:
        """Refresh raw display content and metadata, leaving every chunk in place.

        The canonical embedding view is unchanged, although the raw body may
        contain updated provenance or lifecycle facts,
        so re-chunking and re-embedding would produce byte-identical vectors at
        the cost of a model pass per document.
        """
        if not isinstance(document_id, int) or isinstance(document_id, bool):
            raise StoreError(f"document_id must be an int, got {document_id!r}")

        def _write() -> None:
            with self._conn.cursor() as cur:
                cur.execute(
                    _UPDATE_METADATA,
                    (
                        document.title,
                        document.collection,
                        document.agent,
                        dumps(document.metadata),
                        document.body,
                        document_id,
                    ),
                )
                affected = cur.rowcount
            self._conn.commit()
            # An UPDATE that matched nothing commits happily. Without this the
            # run would report a document refreshed after a concurrent --prune
            # had already deleted it.
            if affected is not None and affected == 0:
                raise StoreError(
                    f"{document.external_id}: no document with id {document_id} "
                    "to update; it was deleted between the lookup and the write"
                )

        try:
            self._run(f"Metadata update of document {document_id}", _write)
        except StoreError:
            self._safe_rollback()
            raise
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(
                f"Metadata update of document {document_id} failed: {exc}"
            ) from exc

    # -- orphan sweep ------------------------------------------------------

    def list_external_ids(
        self,
        source: str,
        realm: str | None = None,
        written_before: datetime | None = None,
        machine: str | None = None,
    ) -> set[str]:
        clause, params = _sweep_clause(realm, written_before, machine)

        def _list() -> list[tuple]:
            with self._conn.cursor() as cur:
                cur.execute(_SELECT_EXTERNAL_IDS + clause, (source, *params))
                found = cur.fetchall()
            self._conn.rollback()
            return found

        try:
            # The sweep runs after minutes of embedding; the pooler may have dropped us.
            rows = self._run(f"Listing external ids for {source}", _list)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(f"Listing external ids for {source} failed: {exc}") from exc
        return {str(row[0]) for row in rows}

    def delete_documents(
        self,
        source: str,
        external_ids: Sequence[str],
        realm: str | None = None,
        written_before: datetime | None = None,
        machine: str | None = None,
    ) -> int:
        ids = list(external_ids)
        if not ids:
            return 0
        clause, params = _sweep_clause(realm, written_before, machine)

        def _delete():
            # One statement, so a retry after a dropped connection deletes nothing twice.
            with self._conn.cursor() as cur:
                cur.execute(_DELETE_DOCUMENTS + clause, (source, ids, *params))
                count = cur.rowcount
            self._conn.commit()
            return count

        try:
            deleted = self._run(f"Deleting orphans from {source}", _delete)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(f"Deleting orphans from {source} failed: {exc}") from exc
        return int(deleted if deleted is not None and deleted >= 0 else len(ids))

    def database_now(self) -> datetime:
        def _now() -> datetime:
            with self._conn.cursor() as cur:
                cur.execute(_SELECT_NOW)
                row = cur.fetchone()
            self._conn.rollback()
            if not row or not isinstance(row[0], datetime):
                raise StoreError(f"SELECT now() returned {row!r}")
            return row[0]

        try:
            return self._run("Reading the database clock", _now)
        except StoreError:
            self._safe_rollback()
            raise
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(f"Reading the database clock failed: {exc}") from exc

    # -- retrieval events --------------------------------------------------

    def _events_table_ready(self) -> bool:
        """Does rag.retrieval_events exist? Asked once per run.

        A store that has not run the migration yet keeps ingesting documents;
        its events are skipped with one warning for the whole run, and the
        pipeline's count comparison writes them on the first run after it.
        """
        if self._events_table is not None:
            return self._events_table

        def _probe() -> tuple[bool, str | None]:
            with self._conn.cursor() as cur:
                cur.execute(_EVENTS_TABLE_EXISTS)
                row = cur.fetchone()
                exists = bool(row and row[0])
                version = None
                if exists:
                    cur.execute(_LEDGER_EXISTS)
                    ledger = cur.fetchone()
                    if ledger and ledger[0]:
                        cur.execute(_SEARCH_VERSION)
                        found = cur.fetchone()
                        version = None if not found or found[0] is None else str(found[0])
            self._conn.rollback()  # end the implicit read transaction
            return exists, version

        try:
            exists, version = self._run("Retrieval events table check", _probe)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(f"Checking for {RETRIEVAL_EVENTS_TABLE} failed: {exc}") from exc

        self._events_table, self._search_version = exists, version
        if not exists:
            log.warning(_EVENTS_MISSING_WARNING)
        return exists

    def replace_retrieval_events(self, document_id: int, document: SourceDocument) -> int:
        if not isinstance(document_id, int) or isinstance(document_id, bool):
            raise StoreError(f"document_id must be an int, got {document_id!r}")
        if not self._events_table_ready():
            return 0
        rows = [_event_row(event, document_id, self._search_version) for event in document.retrievals]
        key = (document.source, document.external_id)

        def _write() -> int:
            # Delete and insert commit together, so a retry after a dropped
            # connection re-runs both and a note never has half its events.
            with self._conn.cursor() as cur:
                cur.execute(_DELETE_EVENTS, key)
                if rows:
                    cur.executemany(_INSERT_EVENT, rows)
            self._conn.commit()
            return len(rows)

        try:
            return self._run(f"Retrieval events for {document.external_id}", _write)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(
                f"Writing retrieval events for {document.source}/{document.external_id} failed: {exc}"
            ) from exc

    def count_retrieval_events(self, document: SourceDocument) -> int | None:
        if not self._events_table_ready():
            return None

        def _count() -> int:
            with self._conn.cursor() as cur:
                cur.execute(_COUNT_EVENTS, (document.source, document.external_id))
                row = cur.fetchone()
            self._conn.rollback()
            return int(row[0]) if row and row[0] is not None else 0

        try:
            return self._run(f"Retrieval event count for {document.external_id}", _count)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(
                f"Counting retrieval events for {document.source}/{document.external_id} failed: {exc}"
            ) from exc

    # -- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception as exc:  # noqa: BLE001 - logged, not raised on teardown
            log.warning("Closing the database connection failed: %s", exc)

    def _safe_rollback(self) -> None:
        try:
            self._conn.rollback()
        except Exception as exc:  # noqa: BLE001 - logged; the real error wins
            log.warning("Rollback failed: %s", exc)


class NullStore:
    """Store used by ``--dry-run`` when no database is reachable.

    Reports every document as new and refuses every write, so a dry run can be
    planned with no credentials at all.
    """

    def get_document_state(self, source: str, external_id: str) -> DocumentState | None:
        return None

    def replace_document(self, *args, **kwargs) -> tuple[int, bool]:
        raise StoreError("NullStore cannot write. This is a --dry-run store.")

    def update_document_metadata(self, *args, **kwargs) -> None:
        raise StoreError("NullStore cannot write. This is a --dry-run store.")

    def list_external_ids(
        self,
        source: str,
        realm: str | None = None,
        written_before: datetime | None = None,
        machine: str | None = None,
    ) -> set[str]:
        return set()

    def database_now(self) -> None:
        return None

    def delete_documents(
        self,
        source: str,
        external_ids,
        realm: str | None = None,
        written_before: datetime | None = None,
        machine: str | None = None,
    ) -> int:
        raise StoreError("NullStore cannot delete. This is a --dry-run store.")

    def replace_retrieval_events(self, document_id: int, document: SourceDocument) -> int:
        raise StoreError("NullStore cannot write. This is a --dry-run store.")

    def count_retrieval_events(self, document: SourceDocument) -> int | None:
        # Nothing is stored, so a dry run plans every event of every document.
        return 0

    def close(self) -> None:
        return None
