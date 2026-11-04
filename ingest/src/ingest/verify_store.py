"""The store audit's reads: the only SQL behind ``uv run ingest verify``.

The connection is made read-only before anything else runs: the first statement
is ``SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY``, and with autocommit
every later statement is its own read-only transaction, so a write anywhere in
this module would raise rather than land. Nothing here writes, and a test reads
every query constant to keep it that way.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Sequence
from datetime import datetime
from typing import Any, TypeVar

from .config import CHUNKS_TABLE, DOCUMENTS_TABLE, SOURCE_OBSIDIAN, DbSettings
from .errors import ConfigError, StoreError
from .store import OWN_MACHINE_CLAUSE, realm_clause, connect_kwargs
from .verify import ChunkText, DocumentRow, NormRow, SampledChunk, VaultRow

log = logging.getLogger(__name__)

READ_ONLY_GUARD = "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"

# Each document with the chunk_index values of its chunks. The LEFT JOIN keeps a
# document with no chunks at all; its array comes back NULL.
_SELECT_DOCUMENTS = f"""
SELECT d.id, d.source, d.external_id,
       array_agg(c.chunk_index ORDER BY c.chunk_index) FILTER (WHERE c.id IS NOT NULL)
FROM {DOCUMENTS_TABLE} d
LEFT JOIN {CHUNKS_TABLE} c ON c.document_id = d.id
GROUP BY d.id, d.source, d.external_id
ORDER BY d.source, d.external_id
"""

# pgvector computes the norm server-side, so thousands of vectors never cross the wire.
# vector_norm(NULL) is NULL, which is how a null embedding is reported.
_SELECT_NORMS = f"""
SELECT c.id, d.source, d.external_id, c.chunk_index, extensions.vector_norm(c.embedding)
FROM {CHUNKS_TABLE} c
JOIN {DOCUMENTS_TABLE} d ON d.id = c.document_id
ORDER BY c.id
"""

_SELECT_CHUNK_TEXTS = f"""
SELECT c.id, d.source, d.external_id, c.chunk_index, c.content, c.token_count
FROM {CHUNKS_TABLE} c
JOIN {DOCUMENTS_TABLE} d ON d.id = c.document_id
ORDER BY c.id
"""

# Scoped by appending store.py's own realm predicate, so the audit and the orphan
# sweep can never disagree about which rows belong to a realm.
_SELECT_VAULT_ROWS = (
    f"SELECT external_id, content_hash, metadata -> '_ingest' ->> 'path', updated_at "
    f"FROM {DOCUMENTS_TABLE} WHERE source = %s"
)

_SELECT_CHUNK_IDS = f"SELECT id FROM {CHUNKS_TABLE} ORDER BY id"

_SELECT_CHUNKS_BY_ID = f"""
SELECT c.id, d.source, d.external_id, c.chunk_index, c.content, c.embedding::text
FROM {CHUNKS_TABLE} c
JOIN {DOCUMENTS_TABLE} d ON d.id = c.document_id
WHERE c.id = ANY(%s)
ORDER BY c.id
"""

Row = TypeVar("Row")


class PostgresReader:
    """psycopg-backed :class:`verify.StoreReader` over a read-only session."""

    def __init__(self, connection) -> None:
        self._conn = connection
        try:
            with connection.cursor() as cursor:
                cursor.execute(READ_ONLY_GUARD)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self.close()
            raise StoreError(f"could not make the audit session read-only: {exc}") from exc

    @classmethod
    def from_settings(cls, settings: DbSettings) -> "PostgresReader":
        if not settings.can_connect:
            raise ConfigError("DATABASE_URL is not set; verify reads the live store.")
        import psycopg

        options = {**connect_kwargs(settings), "autocommit": True}
        try:
            connection = psycopg.connect(settings.database_url, **options)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            raise StoreError(f"Could not connect to the database: {exc}") from exc
        return cls(connection)

    # -- reads -------------------------------------------------------------------

    def documents(self) -> tuple[DocumentRow, ...]:
        return self._select("documents", _SELECT_DOCUMENTS, (), lambda r: DocumentRow(
            int(r[0]), str(r[1]), str(r[2]), tuple(int(i) for i in (r[3] or ())),
        ))

    def embedding_norms(self) -> tuple[NormRow, ...]:
        return self._select("embedding norms", _SELECT_NORMS, (), lambda r: NormRow(
            int(r[0]), str(r[1]), str(r[2]), int(r[3]), None if r[4] is None else float(r[4]),
        ))

    def chunk_texts(self) -> tuple[ChunkText, ...]:
        return self._select("chunk texts", _SELECT_CHUNK_TEXTS, (), lambda r: ChunkText(
            int(r[0]), str(r[1]), str(r[2]), int(r[3]), str(r[4]), None if r[5] is None else int(r[5]),
        ))

    def vault_rows(self, realm: str | None, machine: str | None = None) -> tuple[VaultRow, ...]:
        clause, params = realm_clause(realm)
        if machine is not None:
            clause, params = f"{clause} AND {OWN_MACHINE_CLAUSE}", (*params, machine)
        sql = f"{_SELECT_VAULT_ROWS} AND {clause}"
        scope = f"realm {realm}" if realm else "legacy rows"
        return self._select(f"vault rows ({scope})", sql, (SOURCE_OBSIDIAN, *params), _vault_row)

    def database_now(self) -> datetime:
        now = self._select("database clock", "SELECT now()", (), lambda r: r[0])
        if len(now) != 1 or not isinstance(now[0], datetime):
            raise StoreError(f"SELECT now() returned {now!r}")
        return now[0]

    def chunk_ids(self) -> tuple[int, ...]:
        return self._select("chunk ids", _SELECT_CHUNK_IDS, (), lambda r: int(r[0]))

    def chunks_by_id(self, ids: Sequence[int]) -> tuple[SampledChunk, ...]:
        wanted = [int(chunk_id) for chunk_id in ids]
        if not wanted:
            return ()
        return self._select("sampled chunks", _SELECT_CHUNKS_BY_ID, (wanted,), lambda r: SampledChunk(
            int(r[0]), str(r[1]), str(r[2]), int(r[3]), str(r[4]), None if r[5] is None else parse_vector(r[5]),
        ))

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception as exc:  # noqa: BLE001 - logged, not raised on teardown
            log.warning("Closing the database connection failed: %s", exc)

    def _select(
        self, what: str, sql: str, params: tuple[Any, ...], build: Callable[[tuple], Row]
    ) -> tuple[Row, ...]:
        try:
            with self._conn.cursor() as cursor:
                cursor.execute(sql, params or None)
                rows = cursor.fetchall()
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            raise StoreError(f"Reading {what} failed: {exc}") from exc
        return tuple(build(row) for row in rows)


def _vault_row(row: tuple) -> VaultRow:
    return VaultRow(str(row[0]), str(row[1]), None if row[2] is None else str(row[2]), row[3])


def parse_vector(text: str) -> tuple[float, ...]:
    """pgvector's text form ``[0.1,0.2]`` as floats. Anything else is a StoreError."""
    body = text.strip()
    if not (body.startswith("[") and body.endswith("]")):
        raise StoreError(f"not a pgvector literal: {body[:40]!r}")
    inner = body[1:-1].strip()
    if not inner:
        return ()
    try:
        values = tuple(float(part) for part in inner.split(","))
    except ValueError as exc:
        raise StoreError(f"not a pgvector literal: {body[:40]!r}") from exc
    if not all(math.isfinite(value) for value in values):
        raise StoreError("stored vector holds a non-finite value")
    return values
