"""The orphan sweep — the only destructive operation, so guard it hard."""

from __future__ import annotations

import pytest

from ingest.chunking import MarkdownChunker
from ingest.config import ChunkConfig
from ingest.models import SourceDocument
from ingest.pipeline import IngestPipeline
from ingest.prune import owned_by, prune_orphans
from ingest.store import NullStore

SMALL = ChunkConfig(target_tokens=40, overlap_tokens=8, min_tokens=5, hard_max_tokens=80)


def document(external_id: str) -> SourceDocument:
    return SourceDocument(
        source="obsidian",
        external_id=external_id,
        body=f"Body for {external_id}, with enough words to make a chunk.",
        title=external_id,
        agent="claude-code",
    )


def ingest(store, embedder, docs):
    pipeline = IngestPipeline(
        store, embedder, MarkdownChunker(count_tokens=lambda t: len(t.split()), config=SMALL)
    )
    return pipeline.run(docs)


# --------------------------------------------------------------------------


def test_sweep_deletes_only_documents_the_loader_no_longer_produces(
    fake_store, fake_embedder
):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md"), document("c.md")])
    survivors = [document("a.md"), document("c.md")]
    stats = ingest(fake_store, fake_embedder, survivors)

    result = prune_orphans(
        fake_store,
        "obsidian",
        [doc.external_id for doc in survivors],
        document_count=len(survivors),
        failure_count=len(stats.failures),
    )

    assert result.performed
    assert result.orphans == ("b.md",)
    assert result.deleted == 1
    assert fake_store.list_external_ids("obsidian") == {"a.md", "c.md"}


def test_sweep_removes_the_orphans_chunks_too(fake_store, fake_embedder):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    before = fake_store.total_chunks
    prune_orphans(fake_store, "obsidian", ["a.md"], document_count=1)
    assert fake_store.total_chunks < before


def test_sweep_never_touches_another_source(fake_store, fake_embedder):
    other = SourceDocument(
        source="claude-mem", external_id="1", body="Some narrative body text here.", agent="x"
    )
    ingest(fake_store, fake_embedder, [document("a.md"), other])
    prune_orphans(fake_store, "obsidian", [], document_count=1)
    assert fake_store.list_external_ids("claude-mem") == {"1"}


def test_nothing_stale_is_reported_as_a_clean_sweep(fake_store, fake_embedder):
    docs = [document("a.md")]
    ingest(fake_store, fake_embedder, docs)
    result = prune_orphans(fake_store, "obsidian", ["a.md"], document_count=1)
    assert result.orphans == ()
    assert result.performed
    assert result.deleted == 0


# --------------------------------------------------------------------------
# guards
# --------------------------------------------------------------------------


def test_sweep_declines_after_a_limited_run(fake_store, fake_embedder):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    result = prune_orphans(fake_store, "obsidian", ["a.md"], document_count=1, limited=True)

    assert result.declined
    assert "--limit" in result.declined_reason
    assert fake_store.list_external_ids("obsidian") == {"a.md", "b.md"}


def test_sweep_declines_when_a_document_failed(fake_store, fake_embedder):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    result = prune_orphans(
        fake_store, "obsidian", ["a.md"], document_count=2, failure_count=1
    )

    assert result.declined
    assert "failed" in result.declined_reason
    assert fake_store.list_external_ids("obsidian") == {"a.md", "b.md"}


def test_sweep_declines_on_an_empty_loader_result(fake_store, fake_embedder):
    """A mistyped path or an unmounted vault must not empty the source."""
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    result = prune_orphans(fake_store, "obsidian", [], document_count=0)

    assert result.declined
    assert "no documents" in result.declined_reason
    assert fake_store.list_external_ids("obsidian") == {"a.md", "b.md"}


def test_dry_run_reports_orphans_without_deleting(fake_store, fake_embedder):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    result = prune_orphans(
        fake_store, "obsidian", ["a.md"], document_count=1, dry_run=True
    )

    assert result.orphans == ("b.md",)
    assert result.performed is False
    assert result.deleted == 0
    assert fake_store.list_external_ids("obsidian") == {"a.md", "b.md"}


def test_null_store_refuses_to_delete():
    from ingest.errors import StoreError

    with pytest.raises(StoreError):
        NullStore().delete_documents("obsidian", ["a.md"])


# --------------------------------------------------------------------------
# realms: two vaults, one store
# --------------------------------------------------------------------------


def realm_document(external_id: str, realm: str | None) -> SourceDocument:
    ingest_meta = {"loader": "obsidian", "path": external_id}
    if realm is not None:
        ingest_meta["realm"] = realm
    return SourceDocument(
        source="obsidian",
        external_id=external_id,
        body=f"Body for {external_id}, with enough words to make a chunk.",
        title=external_id,
        agent="claude-code",
        metadata={"_ingest": ingest_meta},
    )


def test_sweep_never_touches_another_realm(fake_store, fake_embedder):
    # Machine A walked `projects`; machine B's `work-vm` rows are not orphans.
    ingest(fake_store, fake_embedder, [realm_document("projects/a.md", "projects"), realm_document("work-vm/b.md", "work-vm")])
    result = prune_orphans(fake_store, "obsidian", [], document_count=1, realm="projects")
    assert result.realm == "projects"
    assert result.orphans == ("projects/a.md",)
    assert fake_store.list_external_ids("obsidian", realm="work-vm") == {"work-vm/b.md"}


def machine_document(external_id: str, machine: str) -> SourceDocument:
    """A captured session note: its frontmatter names the machine that wrote it."""
    return SourceDocument(
        source="obsidian",
        external_id=external_id,
        body=f"Body for {external_id}, with enough words to make a chunk.",
        title=external_id,
        agent="claude-code",
        metadata={"_ingest": {"loader": "obsidian", "path": external_id, "realm": "projects"}, "machine": machine},
    )


def test_sweep_never_touches_a_row_another_machine_captured(fake_store, fake_embedder):
    # Two machines hold clones of `projects` that have not synced yet. The laptop's
    # walk cannot see the Mac's note, but the Mac's session is not an orphan. A row
    # with no `machine:` (a hub), one with an empty `machine: ''` (captured before
    # machine.env existed) and the laptop's own unseen row still are.
    ingest(fake_store, fake_embedder, [
        machine_document("projects/laptop.md", "stack-laptop"),
        machine_document("projects/mac.md", "stack-mac"),
        machine_document("projects/blank.md", ""),
        realm_document("projects/hub.md", "projects"),
        realm_document("projects/old-hub.md", "projects"),
    ])
    result = prune_orphans(
        fake_store, "obsidian", ["projects/hub.md"], document_count=1, realm="projects", machine="stack-laptop"
    )
    assert result.orphans == ("projects/blank.md", "projects/laptop.md", "projects/old-hub.md")
    assert result.deleted == 3
    assert fake_store.list_external_ids("obsidian", realm="projects") == {"projects/hub.md", "projects/mac.md"}


def test_owned_by_states_the_sweep_rule():
    assert owned_by({}, None) and owned_by({"machine": "stack-mac"}, None)
    assert owned_by({}, "stack-laptop") and owned_by({"machine": ""}, "stack-laptop")
    assert owned_by({"machine": "stack-laptop"}, "stack-laptop")
    assert not owned_by({"machine": "stack-mac"}, "stack-laptop")


def test_a_realm_this_machine_did_not_walk_is_never_listed(fake_store):
    assert fake_store.list_external_ids("obsidian", realm="work-vm") == set()
    assert fake_store.delete_documents("obsidian", ["work-vm/b.md"], realm="work-vm") == 0


def test_realm_none_means_legacy_rows_only(fake_store, fake_embedder):
    # Rows ingested before realms existed carry no `_ingest.realm`. They are the
    # only rows a realm-less sweep may see, and only behind the explicit flag.
    ingest(fake_store, fake_embedder, [realm_document("old.md", None), realm_document("projects/a.md", "projects")])
    assert fake_store.list_external_ids("obsidian", realm=None) == {"old.md"}
    result = prune_orphans(fake_store, "obsidian", ["projects/a.md"], document_count=1, realm=None)
    assert result.orphans == ("old.md",)
    assert fake_store.list_external_ids("obsidian", realm=None) == set()
    assert fake_store.list_external_ids("obsidian", realm="projects") == {"projects/a.md"}


# --------------------------------------------------------------------------
# a note captured while the run is going (the walk-to-sweep race)
# --------------------------------------------------------------------------


def test_a_row_written_after_the_walk_began_is_not_an_orphan(fake_store, fake_embedder):
    # The nightly walks the vault, then spends minutes embedding. A SessionEnd hook
    # that captures a note in between writes a row the walk never saw.
    ingest(fake_store, fake_embedder, [document("a.md"), document("gone.md")])
    walk_began = fake_store.advance(minutes=5)
    fake_store.advance(minutes=2)
    ingest(fake_store, fake_embedder, [document("captured-mid-run.md")])

    result = prune_orphans(
        fake_store, "obsidian", ["a.md"], document_count=1, written_before=walk_began
    )

    assert result.orphans == ("gone.md",)
    assert result.deleted == 1
    assert result.spared == ("captured-mid-run.md",)
    assert fake_store.list_external_ids("obsidian") == {"a.md", "captured-mid-run.md"}


def test_a_dry_run_reports_the_spared_rows_too(fake_store, fake_embedder):
    ingest(fake_store, fake_embedder, [document("a.md")])
    walk_began = fake_store.advance(minutes=1)
    fake_store.advance(seconds=30)
    ingest(fake_store, fake_embedder, [document("new.md")])

    result = prune_orphans(
        fake_store, "obsidian", ["a.md"], document_count=1, dry_run=True, written_before=walk_began
    )

    assert result.orphans == ()
    assert result.spared == ("new.md",)
    assert fake_store.list_external_ids("obsidian") == {"a.md", "new.md"}


def test_the_delete_itself_keeps_a_row_rewritten_after_the_cutoff(fake_store, fake_embedder):
    # Listing and deleting are two statements; a hook can rewrite the row between them.
    ingest(fake_store, fake_embedder, [document("a.md"), document("old.md")])
    cutoff = fake_store.advance(minutes=1)
    fake_store.advance(minutes=1)
    rewritten = SourceDocument(
        source="obsidian", external_id="a.md", title="a.md", agent="claude-code",
        body="The hook appended a new section to this note, so its row is rewritten.",
    )
    ingest(fake_store, fake_embedder, [rewritten, document("b.md")])

    assert fake_store.delete_documents("obsidian", ["a.md", "b.md", "old.md"], written_before=cutoff) == 1
    assert fake_store.list_external_ids("obsidian") == {"a.md", "b.md"}


def test_without_a_cutoff_every_unseen_row_is_an_orphan(fake_store, fake_embedder):
    ingest(fake_store, fake_embedder, [document("a.md"), document("b.md")])
    fake_store.advance(minutes=10)

    result = prune_orphans(fake_store, "obsidian", ["a.md"], document_count=1)

    assert result.orphans == ("b.md",)
    assert result.spared == ()



def test_a_row_the_delete_recheck_keeps_is_reported_as_spared_not_deleted(fake_store, fake_embedder):
    # The listing names a.md, but a hook rewrites it before the DELETE runs.
    ingest(fake_store, fake_embedder, [document("a.md"), document("old.md")])
    cutoff = fake_store.advance(minutes=1)
    real_delete = fake_store.delete_documents

    def rewrite_then_delete(source, external_ids, realm=None, written_before=None, machine=None):
        fake_store.advance(seconds=5)
        ingest(fake_store, fake_embedder, [SourceDocument(
            source="obsidian", external_id="a.md", title="a.md", agent="claude-code",
            body="Rewritten by a hook between the listing and the delete.",
        )])
        return real_delete(source, external_ids, realm=realm, written_before=written_before, machine=machine)

    fake_store.delete_documents = rewrite_then_delete
    result = prune_orphans(fake_store, "obsidian", [], document_count=1, written_before=cutoff)

    assert result.orphans == ("old.md",)
    assert result.spared == ("a.md",)
    assert result.deleted == 1
