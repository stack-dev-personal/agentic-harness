"""Synthetic policy checks at loader and direct-pipeline boundaries."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from ingest.chunking import MarkdownChunker
from ingest.loaders.obsidian import load_vault_notes
from ingest.memory_policy import memory_exclusion_reason
from ingest.models import SourceDocument
from ingest.pipeline import Action, IngestPipeline


def policy_env(tmp_path: Path, **extra) -> dict[str, str]:
    return {"HARNESS_MEMORY_STATE_DIR": str(tmp_path / "state"), **extra}


def exclude(tmp_path: Path, runtime: str, native_id: str, body: str | None = None) -> Path:
    directory = tmp_path / "state" / "memory-exclusions"
    directory.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(f"{runtime}:{native_id}".encode()).hexdigest()
    file = directory / f"{key}.json"
    file.write_text(body or json.dumps({"excluded": True, "taint": True}), encoding="utf-8")
    return file


def test_unrestricted_metadata_remains_eligible(tmp_path):
    assert memory_exclusion_reason({}, env=policy_env(tmp_path)) is None


@pytest.mark.parametrize("runtime", ["claude-code", "codex", "hermes"])
def test_sticky_identity_matches_shared_prefix_normalization(tmp_path, runtime):
    exclude(tmp_path, runtime, "synthetic")
    metadata = {"agent": runtime, "session_id": f"{runtime}-{runtime}-synthetic"}
    assert "excluded" in memory_exclusion_reason(metadata, env=policy_env(tmp_path))


@pytest.mark.parametrize("link", ["parent_session", "ancestor_sessions"])
def test_known_parent_and_full_ancestor_exclusions_apply(tmp_path, link):
    exclude(tmp_path, "hermes", "ancestor")
    metadata = {"runtime": "hermes", "session_id": "child",
                link: ["hermes-ancestor"] if link == "ancestor_sessions" else "hermes-ancestor"}
    assert "excluded" in memory_exclusion_reason(metadata, env=policy_env(tmp_path))


@pytest.mark.parametrize("field,value", [
    ("cwd", "protected"), ("cwds_seen", ["protected"]),
    ("files_modified", ["protected/file.py"]), ("files_read", ["protected/file.py"]),
])
def test_protected_paths_apply_to_session_activity(tmp_path, field, value):
    protected = tmp_path / "protected"
    protected.mkdir()
    metadata = {"cwd": str(tmp_path)}
    metadata[field] = str(protected) if field == "cwd" else value
    env = policy_env(tmp_path, HARNESS_MEMORY_EXCLUDED_ROOTS=json.dumps([str(protected)]))
    assert "protected" in memory_exclusion_reason(metadata, env=env)


def test_note_path_and_filesystem_aliases_cannot_bypass_protection(tmp_path):
    protected = tmp_path / "protected"
    protected.mkdir()
    alias = tmp_path / "alias"
    try:
        alias.symlink_to(protected, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks unavailable")
    env = policy_env(tmp_path, HARNESS_MEMORY_EXCLUDED_ROOTS=json.dumps([str(protected)]))
    assert "protected" in memory_exclusion_reason({}, note_path=alias / "note.md", env=env)


def test_unreadable_alias_resolution_fails_closed(tmp_path, monkeypatch):
    protected = tmp_path / "protected"
    protected.mkdir()
    unreadable = tmp_path / "unreadable-alias"
    unreadable.mkdir()
    original = Path.resolve
    def resolve(path, strict=False):
        if path == unreadable:
            if strict:
                raise PermissionError("synthetic unreadable alias")
            # pathlib's non-strict mode can return an unresolved path after
            # suppressing an access error, concealing its actual target.
            return path
        return original(path, strict=strict)
    monkeypatch.setattr(Path, "resolve", resolve)
    env = policy_env(tmp_path, HARNESS_MEMORY_EXCLUDED_ROOTS=json.dumps([str(protected)]))
    reason = memory_exclusion_reason({"cwd": str(unreadable)}, env=env)
    assert reason and "could not be verified" in reason
    assert "unreadable alias" not in reason


@pytest.mark.parametrize("roots", ["not json", "{}", '["relative"]', "[1]"])
def test_malformed_root_configuration_fails_closed(tmp_path, roots):
    reason = memory_exclusion_reason({}, env=policy_env(tmp_path, HARNESS_MEMORY_EXCLUDED_ROOTS=roots))
    assert reason and "invalid" in reason
    assert roots not in reason


@pytest.mark.parametrize("body", ["not json", "[]", "null"])
def test_malformed_exclusion_state_fails_closed_without_copying_content(tmp_path, body):
    exclude(tmp_path, "hermes", "synthetic", body)
    reason = memory_exclusion_reason({"runtime": "hermes", "session_id": "synthetic"}, env=policy_env(tmp_path))
    assert reason and "state" in reason
    assert body not in reason


def test_unreadable_exclusion_state_fails_closed(tmp_path, monkeypatch):
    file = exclude(tmp_path, "hermes", "synthetic")
    original = Path.read_text
    def unreadable(path, *args, **kwargs):
        if path == file:
            raise PermissionError("synthetic private error details")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "read_text", unreadable)
    reason = memory_exclusion_reason({"runtime": "hermes", "session_id": "synthetic"}, env=policy_env(tmp_path))
    assert reason and "state" in reason
    assert "private error" not in reason


def test_malformed_state_directory_and_lineage_fail_closed(tmp_path):
    assert memory_exclusion_reason({}, env={"HARNESS_MEMORY_STATE_DIR": "relative"})
    assert memory_exclusion_reason({"ancestor_sessions": "invalid"}, env=policy_env(tmp_path))


@pytest.mark.parametrize("policy", [{"classification": "TLP:RED"}, {"restricted": True}, {"persistence": "exclude"}])
def test_direct_documents_apply_explicit_policy_before_any_store_access(tmp_path, monkeypatch, fake_store, fake_embedder, policy):
    monkeypatch.setenv("HARNESS_MEMORY_STATE_DIR", str(tmp_path / "state"))
    document = SourceDocument(source="obsidian", external_id="synthetic", body="Ordinary synthetic fixture body.", metadata=policy)
    stats = IngestPipeline(fake_store, fake_embedder, MarkdownChunker(count_tokens=lambda text: len(text.split()))).run([document])
    assert stats.count(Action.FAILED) == 1
    assert fake_store.lookup_calls == fake_store.write_calls == 0
    assert fake_embedder.calls == []


@pytest.mark.parametrize("mode", ["protected-root", "sticky"])
def test_loader_and_direct_pipeline_enforce_current_external_policy(tmp_path, monkeypatch, fake_store, fake_embedder, mode):
    protected = tmp_path / "protected"
    protected.mkdir()
    monkeypatch.setenv("HARNESS_MEMORY_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("HARNESS_MEMORY_EXCLUDED_ROOTS", json.dumps([str(protected)]) if mode == "protected-root" else "[]")
    if mode == "sticky":
        exclude(tmp_path, "hermes", "synthetic")
    metadata = {"runtime": "hermes", "session_id": "hermes-synthetic", "cwd": str(protected)}
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "synthetic.md"
    note.write_text('---\nruntime: hermes\nsession_id: hermes-synthetic\ncwd: ' + protected.as_posix()
                    + '\n---\nOrdinary synthetic fixture body.\n', encoding="utf-8")
    loaded = load_vault_notes(vault, [note])
    assert loaded.documents == ()
    assert len(loaded.skipped) == 1
    document = SourceDocument(source="obsidian", external_id="synthetic", body="Ordinary synthetic fixture body.", metadata=metadata)
    stats = IngestPipeline(fake_store, fake_embedder, MarkdownChunker(count_tokens=lambda text: len(text.split()))).run([document])
    assert stats.count(Action.FAILED) == 1
    assert fake_store.lookup_calls == fake_store.write_calls == 0
    assert fake_embedder.calls == []
