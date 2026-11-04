"""Realms: which git repo of notes a document belongs to.

A realm is a folder carrying a committed ``.realm`` marker. The name is what
prune is scoped by, so two machines holding different realms can share one
store without deleting each other's rows.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ingest.config import parse_realm_policies
from ingest.errors import ConfigError, SourceError
from ingest.loaders.obsidian import (
    REALM_MARKER,
    discover_realms,
    load_vault,
    load_vault_notes,
)


def note(path: Path, body: str = "A note with enough words to be a chunk.") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nid: {path.stem}\n---\n\n{body}\n", encoding="utf-8")


def realm(folder: Path, name: str | None = None) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / REALM_MARKER).write_text(f"{name or folder.name}\n", encoding="utf-8")


def realms_of(loaded) -> dict[str, str | None]:
    return {doc.external_id: doc.metadata["_ingest"].get("realm") for doc in loaded.documents}


# -- discovery ----------------------------------------------------------------


def test_a_marker_at_the_root_makes_the_whole_vault_one_realm(tmp_path: Path):
    realm(tmp_path, "personal")
    note(tmp_path / "projects" / "a.md")
    assert discover_realms(tmp_path) == {"": "personal"}
    assert realms_of(load_vault(tmp_path)) == {"a": "personal"}


def test_top_level_folders_with_markers_are_realms(tmp_path: Path):
    realm(tmp_path / "projects")
    realm(tmp_path / "classes")
    note(tmp_path / "projects" / "a.md")
    note(tmp_path / "classes" / "b.md")
    assert discover_realms(tmp_path) == {"projects": "projects", "classes": "classes"}
    assert realms_of(load_vault(tmp_path)) == {"a": "projects", "b": "classes"}


def test_a_note_outside_every_realm_is_skipped_once_realms_exist(tmp_path: Path):
    realm(tmp_path / "projects")
    note(tmp_path / "projects" / "a.md")
    note(tmp_path / "daily" / "today.md")
    loaded = load_vault(tmp_path)
    assert realms_of(loaded) == {"a": "projects"}
    assert {s.external_id: s.reason for s in loaded.skipped} == {"daily/today.md": "not inside a realm"}


def test_no_marker_anywhere_is_legacy_not_an_error(tmp_path: Path):
    note(tmp_path / "projects" / "a.md")
    assert discover_realms(tmp_path) == {}
    assert realms_of(load_vault(tmp_path)) == {"a": None}


def test_the_folder_must_be_named_after_its_realm(tmp_path: Path):
    # external_id is the vault-relative path; a folder renamed away from its
    # realm would re-key every note. Refuse rather than re-embed.
    realm(tmp_path / "proj", "projects")
    with pytest.raises(SourceError, match="proj"):
        discover_realms(tmp_path)


@pytest.mark.parametrize("bad", ["", "Projects", "my realm", "-x", "a" * 33, "a/b"])
def test_a_marker_that_is_not_a_realm_name_is_refused(tmp_path: Path, bad: str):
    realm(tmp_path / "projects", bad) if bad else (tmp_path / "projects").mkdir()
    if not bad:
        (tmp_path / "projects" / REALM_MARKER).write_text("\n", encoding="utf-8")
    with pytest.raises(SourceError, match=REALM_MARKER):
        discover_realms(tmp_path)


def test_a_root_marker_and_folder_markers_together_are_refused(tmp_path: Path):
    realm(tmp_path, "personal")
    realm(tmp_path / "projects")
    with pytest.raises(SourceError, match="root"):
        discover_realms(tmp_path)


def test_only_carries_the_realm_of_the_note(tmp_path: Path):
    realm(tmp_path / "projects")
    note(tmp_path / "projects" / "a.md")
    loaded = load_vault_notes(tmp_path, ["projects/a.md"])
    assert realms_of(loaded) == {"a": "projects"}


# -- the machine's allowlist -----------------------------------------------------


def test_a_realm_this_machine_does_not_list_is_refused(tmp_path: Path):
    # A realm cloned by mistake must never enter this machine's store.
    realm(tmp_path / "projects")
    realm(tmp_path / "work-vm")
    with pytest.raises(SourceError, match="work-vm"):
        load_vault(tmp_path, allowed_realms=["projects"])


def test_the_allowlist_may_name_realms_that_are_not_cloned_here(tmp_path: Path):
    realm(tmp_path / "projects")
    note(tmp_path / "projects" / "a.md")
    assert realms_of(load_vault(tmp_path, allowed_realms=["projects", "work-vm"])) == {"a": "projects"}


def test_parse_realm_policies_reads_name_policy_pairs():
    assert parse_realm_policies("projects:push, classes:local,work-vm:push") == {
        "projects": "push",
        "classes": "local",
        "work-vm": "push",
    }
    assert parse_realm_policies(None) is None
    assert parse_realm_policies("   ") is None


@pytest.mark.parametrize("bad", ["projects", "projects:sync", "Projects:push", "projects:push,projects:local"])
def test_parse_realm_policies_refuses_a_malformed_entry(bad: str):
    with pytest.raises(ConfigError):
        parse_realm_policies(bad)


# -- the harness realm (R-H1) -------------------------------------------------


def test_the_harness_realm_is_accepted_and_its_collection_is_the_folder_below_it(tmp_path: Path):
    realm(tmp_path / "projects")
    realm(tmp_path / "harness")
    note(tmp_path / "projects" / "bb2dash" / "sessions" / "a.md")
    note(tmp_path / "harness" / "agentic-harness" / "sessions" / "b.md")
    note(tmp_path / "harness" / "agentic-harness" / "agentic-harness.md")
    loaded = load_vault(tmp_path, allowed_realms=["projects", "classes", "harness"])
    assert realms_of(loaded) == {"a": "projects", "b": "harness", "agentic-harness": "harness"}
    assert {doc.external_id: doc.collection for doc in loaded.documents} == {
        "a": "bb2dash",
        "b": "agentic-harness",
        "agentic-harness": "agentic-harness",
    }


def test_parse_realm_policies_reads_the_three_realm_line():
    assert parse_realm_policies("projects:push,classes:push,harness:push") == {
        "projects": "push",
        "classes": "push",
        "harness": "push",
    }


def test_a_note_moved_from_projects_to_harness_is_a_metadata_update_and_nothing_is_pruned(
    tmp_path: Path, fake_store, fake_embedder
):
    """R-H3: move-to-realm copies a note into the harness realm and removes it from
    projects, keeping its ``id``. One full ingest with --prune then updates the row's
    collection and realm in place and deletes nothing in either realm, because prune
    runs after the load has re-tagged the row (cli._sweep)."""
    import argparse

    from ingest.chunking import MarkdownChunker
    from ingest.cli import _sweep
    from ingest.config import ChunkConfig
    from ingest.pipeline import Action, IngestPipeline

    realm(tmp_path / "projects")
    realm(tmp_path / "harness")
    body = "A harness session with enough words to be one chunk of text.\n"
    old = tmp_path / "projects" / "agentic-harness" / "sessions" / "s.md"
    old.parent.mkdir(parents=True)
    old.write_text(f"---\nid: note-s\ncollection: 'agentic-harness'\n---\n\n{body}", encoding="utf-8")
    note(tmp_path / "projects" / "bb2dash" / "sessions" / "b.md")

    chunker = MarkdownChunker(
        count_tokens=lambda t: len(t.split()),
        config=ChunkConfig(target_tokens=40, overlap_tokens=8, min_tokens=5, hard_max_tokens=80),
    )
    args = argparse.Namespace(prune=True, prune_legacy=False, dry_run=False, limit=None, source="obsidian")

    def full_run():
        documents = load_vault(tmp_path, allowed_realms=["projects", "classes", "harness"]).documents
        stats = IngestPipeline(fake_store, fake_embedder, chunker).run(documents)
        # written_before=None: the strictest sweep, sparing nothing written during the run.
        return stats, _sweep(args, fake_store, documents, stats, None, "test-machine")

    first, _ = full_run()
    assert first.count(Action.INSERTED) == 2
    row_id = fake_store.documents[("obsidian", "note-s")].document_id

    new = tmp_path / "harness" / "agentic-harness" / "sessions" / "s.md"
    new.parent.mkdir(parents=True)
    new.write_text(old.read_text(encoding="utf-8"), encoding="utf-8")
    old.unlink()

    second, prunes = full_run()
    outcome = {o.external_id: o.action for o in second.outcomes}
    assert outcome["note-s"] is Action.METADATA_UPDATED
    assert sum(result.deleted for result in prunes) == 0
    state = fake_store.documents[("obsidian", "note-s")]
    assert state.document_id == row_id
    assert state.collection == "agentic-harness"
    assert state.metadata["_ingest"]["realm"] == "harness"
    assert len(fake_store.documents) == 2
