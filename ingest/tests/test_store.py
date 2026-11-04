"""PostgresStore SQL and transaction behaviour, against a fake connection."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from ingest.config import DbSettings
from ingest.errors import ConfigError, StoreError
from ingest.models import Chunk, SourceDocument
from ingest.store import NullStore, PostgresStore


class FakeCursor:
    def __init__(self, connection) -> None:
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.connection.log.append(("execute", sql.strip(), params))
        if self.connection.raise_on and self.connection.raise_on in sql:
            raise RuntimeError("simulated database error")

    def executemany(self, sql, seq):
        self.connection.log.append(("executemany", sql.strip(), list(seq)))
        if self.connection.raise_on and self.connection.raise_on in sql:
            raise RuntimeError("simulated database error")

    def fetchone(self):
        return self.connection.next_row

    def fetchall(self):
        return self.connection.next_rows

    @property
    def rowcount(self):
        return self.connection.rowcount


class FakeConnection:
    def __init__(self, next_row=(7, True), raise_on: str | None = None) -> None:
        self.log: list[tuple] = []
        self.next_row = next_row
        self.next_rows: list[tuple] = []
        self.rowcount = 0
        self.raise_on = raise_on
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True

    def statements(self) -> list[str]:
        return [entry[1] for entry in self.log]


def document(collection: str | None = None) -> SourceDocument:
    return SourceDocument(
        source="obsidian",
        external_id="notes/a.md",
        body="Body text.",
        title="A",
        agent="claude-code",
        collection=collection,
        metadata={"tags": ["rag"], "_ingest": {"path": "notes/a.md"}},
    )


CHUNKS = (Chunk(0, "first chunk", 3), Chunk(1, "second chunk", 3))
VECTORS = ([0.1] * 384, [0.2] * 384)


# --------------------------------------------------------------------------


def test_state_lookup_uses_the_upsert_key():
    conn = FakeConnection(next_row=(12, "abc123", "A", "bb2dash", "claude-code", {"tags": ["rag"]}))
    state = PostgresStore(conn).get_document_state("obsidian", "notes/a.md")

    assert state is not None
    assert (state.document_id, state.content_hash) == (12, "abc123")
    sql, params = conn.log[0][1], conn.log[0][2]
    assert "source = %s AND external_id = %s" in sql
    assert params == ("obsidian", "notes/a.md")


def test_state_lookup_returns_every_column_the_upsert_writes_but_the_body():
    """The pipeline needs these to spot an edit the body hash cannot see.

    `collection` especially: a note with a stable frontmatter id that moves
    between folders keeps its body, and a stale collection is invisible because
    `filter_collection` just stops matching it.
    """
    conn = FakeConnection(
        next_row=(12, "abc123", "A title", "bb2dash", "claude-code", {"status": "concluded"})
    )
    state = PostgresStore(conn).get_document_state("obsidian", "notes/a.md")

    assert state.title == "A title"
    assert state.collection == "bb2dash"
    assert state.agent == "claude-code"
    assert state.metadata == {"status": "concluded"}
    sql = conn.log[0][1]
    for column in ("title", "collection", "agent", "metadata"):
        assert column in sql


@pytest.mark.parametrize(
    "stored, expected",
    [
        ({"a": 1}, {"a": 1}),
        ('{"a": 1}', {"a": 1}),      # a connection without the json loader
        (None, {}),
        ("not json at all", {}),
        ([1, 2], {}),                # a JSON array is not metadata
    ],
)
def test_metadata_column_shapes_all_come_back_as_a_dict(stored, expected):
    conn = FakeConnection(next_row=(12, "abc123", None, None, None, stored))
    state = PostgresStore(conn).get_document_state("obsidian", "notes/a.md")

    assert state.metadata == expected
    assert state.title is None
    assert state.collection is None


MOVED = SourceDocument(
    source="obsidian",
    external_id="session-1",
    body="Body text.",
    title="A title",
    agent="claude-code",
    collection="bb2dash",
    metadata={"status": "superseded"},
)


def test_metadata_update_touches_no_chunk_and_commits_once():
    conn = FakeConnection()
    conn.rowcount = 1
    PostgresStore(conn).update_document_metadata(12, MOVED)

    statements = conn.statements()
    assert len(statements) == 1
    assert statements[0].startswith("UPDATE rag.documents")
    assert "%s::jsonb" in statements[0]
    assert "rag.chunks" not in statements[0]
    assert conn.commits == 1
    assert conn.rollbacks == 0


def test_metadata_update_rewrites_the_collection_a_moved_note_landed_in():
    """The upsert rewrites `collection`; this statement has to as well.

    A note with a stable frontmatter id that moves from projects/foo to
    projects/bar keeps its body, so this is the only write that would ever
    correct its collection — and `filter_collection` matches with `=`, so a
    stale one silently stops returning the note.
    """
    conn = FakeConnection()
    conn.rowcount = 1
    PostgresStore(conn).update_document_metadata(12, MOVED)

    sql, params = conn.log[0][1], conn.log[0][2]
    assert "collection = %s" in sql
    assert "agent = %s" in sql
    assert params[0] == "A title"
    assert params[1] == "bb2dash"
    assert params[2] == "claude-code"
    assert json.loads(params[3]) == {"status": "superseded"}
    assert params[4] == MOVED.body
    assert params[5] == 12


def test_a_metadata_update_that_matched_no_row_is_an_error_not_a_success():
    """A concurrent --prune can delete the row between the lookup and the write.

    An UPDATE matching nothing commits happily, and the run would otherwise
    report a document refreshed that no longer exists.
    """
    conn = FakeConnection()
    conn.rowcount = 0
    with pytest.raises(StoreError, match="no document with id 12"):
        PostgresStore(conn).update_document_metadata(12, MOVED)
    assert conn.rollbacks >= 1


def test_a_failed_metadata_update_rolls_back_and_raises_a_typed_error():
    conn = FakeConnection(raise_on="UPDATE rag.documents")
    with pytest.raises(StoreError, match="Metadata update"):
        PostgresStore(conn).update_document_metadata(12, MOVED)
    assert conn.rollbacks >= 1
    assert conn.commits == 0


def test_metadata_update_refuses_a_non_integer_document_id():
    conn = FakeConnection()
    with pytest.raises(StoreError, match="document_id"):
        PostgresStore(conn).update_document_metadata("12", MOVED)
    assert conn.statements() == []


def test_null_store_refuses_a_metadata_update():
    with pytest.raises(StoreError):
        NullStore().update_document_metadata(1, MOVED)


def test_missing_document_returns_none():
    conn = FakeConnection(next_row=None)
    assert PostgresStore(conn).get_document_state("obsidian", "nope.md") is None


def test_replace_document_upserts_deletes_then_inserts_and_commits_once():
    conn = FakeConnection()
    document_id, inserted = PostgresStore(conn).replace_document(
        document(), "hash-1", CHUNKS, VECTORS
    )

    statements = conn.statements()
    assert "ON CONFLICT (source, external_id) DO UPDATE" in statements[0]
    assert statements[1].startswith("DELETE FROM rag.chunks")
    assert "INSERT INTO rag.chunks" in statements[2]
    assert conn.commits == 1
    assert conn.rollbacks == 0
    assert (document_id, inserted) == (7, True)


def test_metadata_is_sent_as_json_text_for_the_jsonb_cast():
    conn = FakeConnection()
    PostgresStore(conn).replace_document(document(), "hash-1", CHUNKS, VECTORS)
    params = conn.log[0][2]
    sql = conn.log[0][1]
    assert "%s::jsonb" in sql

    # Bind order is (source, collection, agent, external_id, title, body,
    # metadata, content_hash). Locate by column order rather than a bare
    # literal index, so adding a column fails loudly here instead of silently
    # writing the wrong value into the wrong column.
    columns = [c.strip() for c in sql.split("(", 1)[1].split(")", 1)[0].split(",")]
    assert json.loads(params[columns.index("metadata")])["tags"] == ["rag"]
    assert params[columns.index("content_hash")] == "hash-1"


def test_collection_is_written_so_filter_collection_can_use_it():
    conn = FakeConnection()
    PostgresStore(conn).replace_document(
        document(collection="ev-trainer"), "hash-1", CHUNKS, VECTORS
    )
    sql, params = conn.log[0][1], conn.log[0][2]
    columns = [c.strip() for c in sql.split("(", 1)[1].split(")", 1)[0].split(",")]

    assert "collection" in columns, "collection column missing from the INSERT"
    assert params[columns.index("collection")] == "ev-trainer"
    # An upsert must refresh it too, or a moved document keeps its stale collection.
    assert "collection   = EXCLUDED.collection" in sql or "collection = EXCLUDED.collection" in sql


def test_chunk_rows_carry_index_token_count_and_a_vector_literal():
    conn = FakeConnection()
    PostgresStore(conn).replace_document(document(), "hash-1", CHUNKS, VECTORS)
    rows = conn.log[2][2]

    assert [row[1] for row in rows] == [0, 1]
    assert [row[3] for row in rows] == [3, 3]
    assert rows[0][4].startswith("[") and rows[0][4].endswith("]")
    assert rows[0][4].count(",") == 383
    assert "::extensions.vector" in conn.log[2][1]


def test_update_path_is_reported_as_not_inserted():
    conn = FakeConnection(next_row=(7, False))
    _, inserted = PostgresStore(conn).replace_document(
        document(), "hash-2", CHUNKS, VECTORS
    )
    assert inserted is False


def test_a_failed_insert_rolls_back_and_never_commits():
    conn = FakeConnection(raise_on="INSERT INTO rag.chunks")
    with pytest.raises(StoreError):
        PostgresStore(conn).replace_document(document(), "hash-1", CHUNKS, VECTORS)
    assert conn.commits == 0
    assert conn.rollbacks == 1


def test_mismatched_chunk_and_embedding_counts_are_rejected():
    conn = FakeConnection()
    with pytest.raises(StoreError):
        PostgresStore(conn).replace_document(document(), "h", CHUNKS, VECTORS[:1])
    assert conn.commits == 0


def test_writing_zero_chunks_is_refused():
    conn = FakeConnection()
    with pytest.raises(StoreError):
        PostgresStore(conn).replace_document(document(), "h", (), ())


def test_list_external_ids_is_scoped_to_one_source():
    conn = FakeConnection()
    conn.next_rows = [("a.md",), ("b.md",)]
    ids = PostgresStore(conn).list_external_ids("obsidian")

    assert ids == {"a.md", "b.md"}
    assert conn.log[0][2] == ("obsidian",)
    assert "WHERE source = %s" in conn.log[0][1]


def test_delete_documents_uses_one_statement_and_commits():
    conn = FakeConnection()
    conn.rowcount = 2
    deleted = PostgresStore(conn).delete_documents("obsidian", ["a.md", "b.md"])

    assert deleted == 2
    assert conn.commits == 1
    sql, params = conn.log[0][1], conn.log[0][2]
    assert sql.startswith("DELETE FROM rag.documents")
    assert "external_id = ANY(%s)" in sql
    assert params == ("obsidian", ["a.md", "b.md"])


def test_deleting_nothing_issues_no_sql():
    conn = FakeConnection()
    assert PostgresStore(conn).delete_documents("obsidian", []) == 0
    assert conn.log == []
    assert conn.commits == 0


def test_a_failed_delete_rolls_back():
    conn = FakeConnection(raise_on="DELETE FROM rag.documents")
    with pytest.raises(StoreError):
        PostgresStore(conn).delete_documents("obsidian", ["a.md"])
    assert conn.commits == 0
    assert conn.rollbacks == 1


def test_close_closes_the_connection():
    conn = FakeConnection()
    PostgresStore(conn).close()
    assert conn.closed


# --------------------------------------------------------------------------


def test_missing_database_url_raises_a_clear_config_error():
    settings = DbSettings(database_url=None, supabase_url="x", supabase_service_role="y")
    with pytest.raises(ConfigError) as excinfo:
        PostgresStore.from_settings(settings)
    assert "DATABASE_URL" in str(excinfo.value)


def test_null_store_reports_everything_as_new_and_refuses_writes():
    store = NullStore()
    assert store.get_document_state("obsidian", "a.md") is None
    with pytest.raises(StoreError):
        store.replace_document(document(), "h", CHUNKS, VECTORS)
    store.close()


# --------------------------------------------------------------------------
# TLS: verify-full against the pinned CA, on both connect paths
# --------------------------------------------------------------------------


def _capture_connect(monkeypatch):
    import psycopg

    calls: list[tuple[str, dict]] = []

    def fake_connect(conninfo, **kwargs):
        calls.append((conninfo, kwargs))
        return FakeConnection()

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    return calls


def _settings(tmp_path, **overrides) -> DbSettings:
    ca = tmp_path / "prod-ca.crt"
    ca.write_text("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n")
    fields = {
        "database_url": "postgresql://postgres.ref:pw@pooler.example:5432/postgres",
        "supabase_url": None,
        "supabase_service_role": None,
        "ssl_root_cert": str(ca),
    }
    fields.update(overrides)
    return DbSettings(**fields)


def test_initial_connect_verifies_the_server_against_the_pinned_ca(monkeypatch, tmp_path):
    calls = _capture_connect(monkeypatch)
    settings = _settings(tmp_path)

    PostgresStore.from_settings(settings)

    conninfo, kwargs = calls[0]
    assert conninfo == settings.database_url
    assert kwargs["sslmode"] == "verify-full"
    assert kwargs["sslrootcert"] == settings.ssl_root_cert
    assert kwargs["keepalives"] == 1  # the resilience kwargs survive too


def test_reconnect_uses_the_same_tls_and_keepalive_kwargs(monkeypatch, tmp_path):
    calls = _capture_connect(monkeypatch)
    settings = _settings(tmp_path)
    store = PostgresStore.from_settings(settings)

    assert store._reconnect() is True

    _, initial = calls[0]
    _, again = calls[1]
    assert again == initial, "the retry path must not regress TLS or keepalives"


def test_missing_ca_is_a_config_error_not_a_silent_downgrade(monkeypatch, tmp_path):
    calls = _capture_connect(monkeypatch)
    settings = _settings(tmp_path, ssl_root_cert=None)

    with pytest.raises(ConfigError) as excinfo:
        PostgresStore.from_settings(settings)

    assert "DATABASE_CA_CERT" in str(excinfo.value)
    assert calls == [], "must fail before any connection is attempted"


def test_unreadable_ca_path_is_a_config_error(monkeypatch, tmp_path):
    calls = _capture_connect(monkeypatch)
    settings = _settings(tmp_path, ssl_root_cert=str(tmp_path / "does-not-exist.crt"))

    with pytest.raises(ConfigError) as excinfo:
        PostgresStore.from_settings(settings)

    assert "does-not-exist.crt" in str(excinfo.value)
    assert calls == []


def test_tls_can_be_disabled_explicitly_for_a_local_postgres(monkeypatch, tmp_path):
    calls = _capture_connect(monkeypatch)
    settings = _settings(tmp_path, ssl_root_cert=None, ssl_disabled=True)

    PostgresStore.from_settings(settings)

    _, kwargs = calls[0]
    assert kwargs["sslmode"] == "disable"
    assert "sslrootcert" not in kwargs


# --------------------------------------------------------------------------
# the orphan sweep's cutoff: rows written after the walk began are left alone
# --------------------------------------------------------------------------

CUTOFF = datetime(2026, 9, 28, 2, 50, tzinfo=timezone.utc)


def test_listing_with_a_cutoff_keeps_only_rows_written_before_it() -> None:
    conn = FakeConnection()
    conn.next_rows = [("projects/a.md",)]

    ids = PostgresStore(conn).list_external_ids("obsidian", realm="projects", written_before=CUTOFF)

    assert ids == {"projects/a.md"}
    _, sql, params = conn.log[-1]
    assert sql.endswith("AND updated_at < %s")
    assert params[0] == "obsidian" and params[-1] == CUTOFF


def test_deleting_with_a_cutoff_rechecks_it_in_the_same_statement() -> None:
    conn = FakeConnection()
    conn.rowcount = 1

    deleted = PostgresStore(conn).delete_documents(
        "obsidian", ["projects/a.md"], realm="projects", written_before=CUTOFF
    )

    assert deleted == 1
    _, sql, params = conn.log[-1]
    assert sql.startswith("DELETE FROM rag.documents")
    assert sql.endswith("AND updated_at < %s")
    assert params[1] == ["projects/a.md"] and params[-1] == CUTOFF


def test_a_machine_scope_spares_rows_another_machine_captured() -> None:
    conn = FakeConnection()
    conn.next_rows = [("projects/a.md",)]

    PostgresStore(conn).list_external_ids("obsidian", realm="projects", machine="stack-laptop")

    _, sql, params = conn.log[-1]
    assert sql.endswith("AND coalesce(metadata->>'machine', '') IN ('', %s)")
    assert params[-1] == "stack-laptop"

    conn.rowcount = 1
    PostgresStore(conn).delete_documents("obsidian", ["projects/a.md"], realm="projects", machine="stack-laptop")
    _, sql, params = conn.log[-1]
    assert sql.endswith("AND coalesce(metadata->>'machine', '') IN ('', %s)")
    assert params[-1] == "stack-laptop"


def test_without_a_cutoff_the_sweep_sql_is_unchanged() -> None:
    conn = FakeConnection()
    store = PostgresStore(conn)

    store.list_external_ids("obsidian", realm="projects")
    store.delete_documents("obsidian", ["projects/a.md"], realm="projects")

    assert all("updated_at" not in sql for sql in conn.statements())


def test_database_now_reads_the_database_clock() -> None:
    conn = FakeConnection(next_row=(CUTOFF,))

    assert PostgresStore(conn).database_now() == CUTOFF
    assert conn.log[-1][1] == "SELECT now()"


def test_a_dry_run_store_has_no_clock() -> None:
    assert NullStore().database_now() is None


class DroppingConnection(FakeConnection):
    """Fails its first statement the way a pooler-dropped connection does."""

    def cursor(self):
        if not self.log:
            self.log.append(("dropped", "", None))
            raise RuntimeError("the connection is closed")
        return super().cursor()


@pytest.mark.parametrize("call", ["list", "delete"])
def test_the_sweep_reconnects_after_the_idle_embedding_phase(call) -> None:
    fresh = FakeConnection()
    fresh.next_rows = [("a.md",)]
    fresh.rowcount = 1
    store = PostgresStore(DroppingConnection())

    def reconnect() -> bool:
        store._conn = fresh
        return True

    store._reconnect = reconnect
    if call == "list":
        assert store.list_external_ids("obsidian", realm="projects", written_before=CUTOFF) == {"a.md"}
    else:
        assert store.delete_documents("obsidian", ["a.md"], realm="projects", written_before=CUTOFF) == 1
    assert fresh.log, "the statement ran again on the new connection"
