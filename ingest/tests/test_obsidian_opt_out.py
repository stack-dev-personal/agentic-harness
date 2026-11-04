"""Notes that live in the vault but must not be embedded.

Two mechanisms, both deliberate and both reported as skips rather than hidden:

* frontmatter ``ingest: false`` — a per-note opt-out. Used for class materials
  exported from bb2dash, whose retrieval belongs to the bb2dash store.
* the ``templates/`` folder — Obsidian's own convention. A template carries
  ``{{date}}`` placeholders and is never content.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ingest.loaders.obsidian import load_vault, load_vault_notes


def by_id(loaded):
    return {doc.external_id: doc for doc in loaded.documents}


def skipped_ids(loaded):
    return {record.external_id: record.reason for record in loaded.skipped}


# --------------------------------------------------------------------------
# ingest: false
# --------------------------------------------------------------------------


def test_ingest_false_note_is_skipped_not_loaded(vault_path: Path):
    loaded = load_vault(vault_path)
    assert "7d0a1c9e-2f44-4e0b-9d5b-1a2b3c4d5e6f" not in by_id(loaded)
    assert skipped_ids(loaded)["notes/opted-out.md"] == "frontmatter ingest: false"


def test_ingest_true_or_absent_loads_normally(tmp_path: Path):
    (tmp_path / "yes.md").write_text("---\ningest: true\n---\n\nbody\n", encoding="utf-8")
    (tmp_path / "absent.md").write_text("body only\n", encoding="utf-8")
    loaded = load_vault(tmp_path)
    assert set(by_id(loaded)) == {"yes.md", "absent.md"}
    assert not loaded.skipped


@pytest.mark.parametrize("raw", ["ingest: no", "ingest: 'false'", "ingest: off", "ingest: 0"])
def test_common_false_spellings_are_honoured(tmp_path: Path, raw: str):
    (tmp_path / "note.md").write_text(f"---\n{raw}\n---\n\nbody\n", encoding="utf-8")
    loaded = load_vault(tmp_path)
    assert not loaded.documents
    assert skipped_ids(loaded)["note.md"] == "frontmatter ingest: false"


@pytest.mark.parametrize("raw", ["ingest:\n  - false", "ingest: ''", "ingest: 2", "ingest: maybe"])
def test_non_boolean_ingest_value_is_a_real_error(tmp_path: Path, raw: str):
    # A list, an empty string, a stray int: a typo, not a preference. Refuse rather than guess.
    (tmp_path / "note.md").write_text(f"---\n{raw}\n---\n\nbody\n", encoding="utf-8")
    loaded = load_vault(tmp_path)
    assert not loaded.documents
    reason = skipped_ids(loaded)["note.md"]
    assert "ingest" in reason and "true or false" in reason


# --------------------------------------------------------------------------
# templates/
# --------------------------------------------------------------------------


def test_root_templates_folder_is_never_walked(vault_path: Path):
    loaded = load_vault(vault_path)
    assert not any(i.startswith("templates/") for i in by_id(loaded))
    # Not even reported as a skip: it is not a note, the same as .obsidian/.
    assert not any(i.startswith("templates/") for i in skipped_ids(loaded))


def test_nested_templates_folder_is_ordinary_content(tmp_path: Path):
    # Only the vault-root folder is Obsidian's. A project's own `templates/`
    # (report templates as documentation, say) is real content.
    nested = tmp_path / "projects" / "quant-edge-tracker" / "notes" / "templates"
    nested.mkdir(parents=True)
    (nested / "weekly-report.md").write_text("# Weekly report\n\nbody\n", encoding="utf-8")
    (tmp_path / "templates").mkdir()
    (tmp_path / "templates" / "daily.md").write_text("# {{date}}\n", encoding="utf-8")
    loaded = load_vault(tmp_path)
    assert set(by_id(loaded)) == {"projects/quant-edge-tracker/notes/templates/weekly-report.md"}


# --------------------------------------------------------------------------
# SDK origin is provenance; eligibility is an explicit runtime-neutral policy
# --------------------------------------------------------------------------


def session_note(origin: str | None, note_type: str = "session") -> str:
    origin_line = f"origin: {origin}\n" if origin is not None else ""
    return f"---\nid: session-abc\ntype: {note_type}\n{origin_line}---\n\n## What I asked for\n\n1. Review this diff.\n"


@pytest.mark.parametrize("origin", ["sdk-py", "sdk-cli", "sdk-ts"])
def test_a_meaningful_session_started_by_the_sdk_is_loaded(tmp_path: Path, origin: str):
    (tmp_path / "worker.md").write_text(session_note(origin), encoding="utf-8")
    loaded = load_vault(tmp_path)
    assert set(by_id(loaded)) == {"session-abc"}
    assert not loaded.skipped


@pytest.mark.parametrize("origin", ["cli", "claude-desktop", "cloud", "", None])
def test_a_session_a_person_drove_still_loads(tmp_path: Path, origin):
    (tmp_path / "mine.md").write_text(session_note(origin), encoding="utf-8")
    assert set(by_id(load_vault(tmp_path))) == {"session-abc"}


def test_origin_only_excludes_session_notes(tmp_path: Path):
    # `origin` on some other kind of note is somebody's own frontmatter, not ours.
    (tmp_path / "note.md").write_text(session_note("sdk-py", note_type="reference"), encoding="utf-8")
    assert set(by_id(load_vault(tmp_path))) == {"session-abc"}


def test_only_on_an_sdk_session_has_the_same_policy_as_a_full_walk(tmp_path: Path):
    (tmp_path / "worker.md").write_text(session_note("sdk-py"), encoding="utf-8")
    loaded = load_vault_notes(tmp_path, ["worker.md"])
    assert set(by_id(loaded)) == {"session-abc"}
    assert not loaded.skipped
