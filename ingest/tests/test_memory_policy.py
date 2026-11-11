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


# ---------------------------------------------------------------------------
# HARNESS_HOST_PATH_FLAVOR=win32: the ingest runs in the Linux jobs container
# and judges paths a Windows host recorded. Text only, so these cases give the
# same answer on every platform. They mirror hooks/tests/host-path-flavor.test.mjs.
# ---------------------------------------------------------------------------

WIN_ROOT = "C:/Users/alex/private-work"
WIN_PROJECT = "C:\\Users\\alex\\projects\\app"
PROTECTED = "memory policy: protected path touched"


def flavor_env(tmp_path: Path, roots=(WIN_ROOT,), **extra) -> dict[str, str]:
    return policy_env(tmp_path, HARNESS_HOST_PATH_FLAVOR="win32",
                      HARNESS_MEMORY_EXCLUDED_ROOTS=json.dumps(list(roots)), **extra)


@pytest.mark.parametrize("metadata", [
    {"cwd": "C:\\Users\\alex\\private-work\\briefs"},
    {"cwd": WIN_ROOT},
    {"cwd": "c:/users/ALEX/Private-Work/x"},
    {"cwd": WIN_PROJECT, "cwds_seen": ["C:\\USERS\\alex\\private-work"]},
    {"cwd": WIN_PROJECT, "files_modified": ["C:\\Users\\alex\\private-work\\research\\a.json"]},
    {"cwd": WIN_PROJECT, "files_read": ["..\\..\\private-work\\a.md"]},
    {"cwd": WIN_PROJECT, "files_read": ["../../private-work/a.md"]},
    {"cwd": WIN_PROJECT, "files_read": ["\\\\?\\C:\\Users\\alex\\private-work\\a.md"]},
    {"cwd": WIN_PROJECT, "files_read": ["/c/Users/alex/private-work/a.md"]},
    {"cwd": "/c/Users/alex/private-work"},
    {"files_read": ["\\Users\\alex\\private-work\\a.md"]},
])
def test_windows_flavor_protects_paths_inside_the_root(tmp_path, metadata):
    assert memory_exclusion_reason(metadata, env=flavor_env(tmp_path)) == PROTECTED


@pytest.mark.parametrize("metadata", [
    {"cwd": WIN_PROJECT},
    {"cwd": "C:/Users/alex/private-work-other/x"},
    {"cwd": "D:/Users/alex/private-work/x"},
    {"cwd": WIN_PROJECT, "files_modified": ["docs\\a.md", "C:/Users/alex/projects/app/README.md"]},
    {"cwd": WIN_PROJECT, "files_read": 12},
    {"files_read": ["\\Users\\alex\\projects\\a.md"]},
])
def test_windows_flavor_allows_paths_outside_the_root(tmp_path, metadata):
    assert memory_exclusion_reason(metadata, env=flavor_env(tmp_path)) is None


def test_windows_flavor_never_matches_the_containers_own_note_path(tmp_path):
    note = "/vault/projects/app/sessions/abc.md"
    assert memory_exclusion_reason({"cwd": WIN_PROJECT}, note_path=note, env=flavor_env(tmp_path)) is None
    assert memory_exclusion_reason({}, note_path=note, env=flavor_env(tmp_path)) is None


def test_windows_flavor_protects_a_share_root(tmp_path):
    env = flavor_env(tmp_path, roots=["//fileserver/its/briefs"])
    inside = {"cwd": WIN_PROJECT, "files_read": ["\\\\fileserver\\its\\briefs\\2026\\a.html"]}
    long_form = {"cwd": WIN_PROJECT, "files_read": ["\\\\?\\UNC\\fileserver\\its\\briefs\\a.html"]}
    outside = {"cwd": WIN_PROJECT, "files_read": ["\\\\fileserver\\its\\other\\a.html"]}
    assert memory_exclusion_reason(inside, env=env) == PROTECTED
    assert memory_exclusion_reason(long_form, env=env) == PROTECTED
    assert memory_exclusion_reason(outside, env=env) is None


def test_windows_flavor_relative_path_without_a_working_directory_is_judged_by_where_it_could_land(tmp_path):
    # The starting folder is unknown, so a path that begins with the root's
    # last names counts as inside it; one that does not is an ordinary file.
    env = flavor_env(tmp_path)
    assert memory_exclusion_reason({"files_read": ["private-work\\a.md"]}, env=env) == PROTECTED
    assert memory_exclusion_reason({"files_read": ["alex\\private-work\\sub\\a.md"]}, env=env) == PROTECTED
    assert memory_exclusion_reason({"files_read": ["..\\private-work\\a.md"]}, env=env) == PROTECTED
    assert memory_exclusion_reason({"files_read": ["notes\\a.md"]}, env=env) is None
    assert memory_exclusion_reason({"files_modified": ["local\\a.md"]}, env=env) is None


@pytest.mark.parametrize("root", [
    "/home/harness/private-work", "private-work", "C:private-work", "\\Users\\alex\\private-work",
])
def test_windows_flavor_rejects_a_root_that_is_not_a_full_windows_path(tmp_path, root):
    reason = memory_exclusion_reason({"cwd": WIN_PROJECT}, env=flavor_env(tmp_path, roots=[root]))
    assert reason == "memory policy: invalid memory exclusion configuration"


def test_unknown_flavor_is_a_configuration_error_even_with_no_roots(tmp_path):
    env = policy_env(tmp_path, HARNESS_HOST_PATH_FLAVOR="beos")
    assert memory_exclusion_reason({"cwd": WIN_PROJECT}, env=env) == "memory policy: invalid memory exclusion configuration"


def test_windows_flavor_keeps_explicit_classification_first(tmp_path):
    reason = memory_exclusion_reason({"cwd": WIN_PROJECT, "classification": "TLP:AMBER"}, env=flavor_env(tmp_path))
    assert reason and "protected path" not in reason


@pytest.mark.parametrize("file", [
    "C:\\Users\\alex\\private-work.\\a.md",
    "C:\\Users\\alex\\private-work \\a.md",
    "C:\\Users\\alex\\private-work...\\sub\\a.md",
    "C:\\Users\\alex\\private-work::$INDEX_ALLOCATION\\a.md",
    "C:\\Users\\alex\\private-work\\a.md:hidden-stream",
    "\\\\.\\C:\\Users\\alex\\private-work\\a.md",
    "/mnt/c/Users/alex/private-work/a.md",
    "/cygdrive/c/Users/alex/private-work/a.md",
])
def test_windows_flavor_protects_spellings_windows_treats_as_the_same_folder(tmp_path, file):
    metadata = {"cwd": WIN_PROJECT, "files_read": [file]}
    assert memory_exclusion_reason(metadata, env=flavor_env(tmp_path)) == PROTECTED


@pytest.mark.parametrize("file", [
    "C:\\Users\\alex\\private-work.bak\\a.md",
    "C:\\Users\\alex\\private-work2\\a.md",
    "C:\\Users\\alex\\projects\\notes. \\a.md",
])
def test_windows_flavor_allows_a_folder_that_only_starts_with_the_same_name(tmp_path, file):
    metadata = {"cwd": WIN_PROJECT, "files_read": [file]}
    assert memory_exclusion_reason(metadata, env=flavor_env(tmp_path)) is None


@pytest.mark.parametrize("file", [
    "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\Users\\alex\\private-work\\a.md",
    "\\\\?\\Volume{4c1b02c1-d990-11dc-99ae-806e6f6e6963}\\Users\\alex\\private-work\\a.md",
    "\\\\.\\HarddiskVolume3\\Users\\alex\\private-work\\a.md",
])
def test_windows_flavor_fails_closed_on_a_device_path_text_cannot_place(tmp_path, file):
    metadata = {"cwd": WIN_PROJECT, "files_read": [file]}
    reason = memory_exclusion_reason(metadata, env=flavor_env(tmp_path))
    assert reason == "memory policy: memory path policy could not be verified"


# ---------------------------------------------------------------------------
# Found by the adversarial review of 2026-11-11: each of these opened the
# protected file on a real Windows volume while an earlier version allowed it,
# or made the Node and Python sides disagree.
# ---------------------------------------------------------------------------

UNVERIFIED = "memory policy: memory path policy could not be verified"
INVALID = "memory policy: invalid memory exclusion configuration"


def read(file: str, cwd: str = WIN_PROJECT) -> dict:
    return {"cwd": cwd, "files_read": [file]}


@pytest.mark.parametrize("file", [
    "\\\\.\\X:\\..\\C:\\Users\\alex\\private-work\\a.md",
    "\\\\.\\UNC\\..\\C:\\Users\\alex\\private-work\\a.md",
    "\\\\.\\C:\\..\\C:\\Users\\alex\\private-work\\a.md",
    "//./X:/../C:/Users/alex/private-work/a.md",
    "\\\\?\\X:\\..\\C:\\Users\\alex\\private-work\\a.md",
    "\\\\.\\C:\\..\\GLOBALROOT\\DosDevices\\C:\\Users\\alex\\private-work\\a.md",
])
def test_parent_segment_cannot_climb_over_the_drive_of_a_device_path(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) is not None
    assert memory_exclusion_reason({"cwd": file}, env=flavor_env(tmp_path)) is not None


@pytest.mark.parametrize("file", [
    "\\\\localhost\\C$\\Users\\alex\\private-work\\a.md",
    "\\\\127.0.0.1\\C$\\Users\\alex\\private-work\\a.md",
    "\\\\devbox\\c$\\Users\\alex\\private-work\\a.md",
    "\\\\--1.ipv6-literal.net\\C$\\Users\\alex\\private-work\\a.md",
    "\\\\?\\UNC\\localhost\\C$\\Users\\alex\\private-work\\a.md",
    "\\\\.\\UNC\\localhost\\C$\\Users\\alex\\private-work\\a.md",
    "//localhost/C$/Users/alex/private-work/a.md",
    "\\\\localhost\\\\C$\\Users\\alex\\private-work\\a.md",
])
def test_administrative_share_is_the_drive_whatever_the_host_is_called(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == PROTECTED


def test_administrative_share_of_another_folder_or_drive_is_allowed(tmp_path):
    env = flavor_env(tmp_path)
    assert memory_exclusion_reason(read("\\\\localhost\\C$\\Users\\alex\\projects\\a.md"), env=env) is None
    assert memory_exclusion_reason(read("\\\\localhost\\D$\\Users\\alex\\private-work\\a.md"), env=env) is None


def test_nt_object_prefix_is_a_device_prefix_too(tmp_path):
    env = flavor_env(tmp_path)
    assert memory_exclusion_reason(read("\\??\\C:\\Users\\alex\\private-work\\a.md"), env=env) == PROTECTED
    assert memory_exclusion_reason(read("\\??\\GLOBALROOT\\Device\\HarddiskVolume3\\a.md"), env=env) == UNVERIFIED


@pytest.mark.parametrize("separator", ["\u2028", "\u2029", "\r", "\n"])
def test_line_separator_in_a_name_does_not_hide_a_unix_shell_drive_path(tmp_path, separator):
    file = f"/c/Users/alex/private-work/a{separator}b.md"
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == PROTECTED
    assert memory_exclusion_reason({"files_read": [file]}, env=flavor_env(tmp_path)) == PROTECTED


def test_proc_cygdrive_names_a_drive(tmp_path):
    file = "/proc/cygdrive/c/Users/alex/private-work/a.md"
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == PROTECTED


def test_extra_separators_are_read_the_way_windows_reads_them(tmp_path):
    env = flavor_env(tmp_path)
    assert memory_exclusion_reason(read("\\\\\\Users\\alex\\private-work\\a.md"), env=env) == PROTECTED
    assert memory_exclusion_reason(read("///Users/alex/private-work/a.md"), env=env) == PROTECTED
    share = flavor_env(tmp_path, roots=["//fileserver/its/briefs"])
    assert memory_exclusion_reason(read("\\\\fileserver\\\\its\\briefs\\a.html"), env=share) == PROTECTED
    assert memory_exclusion_reason(read("//fileserver//its//briefs//a.html"), env=share) == PROTECTED


def test_drive_relative_path_is_placed_only_on_its_own_drive(tmp_path):
    env = flavor_env(tmp_path)
    assert memory_exclusion_reason(read("C:private-work\\a.md", cwd="C:\\Users\\alex"), env=env) == PROTECTED
    assert memory_exclusion_reason(read("C:docs\\a.md"), env=env) is None
    for file in ("C:Users\\alex\\private-work\\a.md", "C:..\\private-work\\a.md", "C:"):
        assert memory_exclusion_reason(read(file, cwd="D:\\work\\x"), env=env) == UNVERIFIED, file


@pytest.mark.parametrize("file", [
    "C:\\Users\\alex\\PRIVAT~1\\a.md",
    "C:\\Users\\alex\\privat~2\\sub\\a.md",
    "C:\\Users\\alex\\PRF1A3~1\\a.md",
    "C:\\Users\\alex\\PRIVA~12\\a.md",
])
def test_possible_short_name_of_a_protected_folder_counts_as_it(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == PROTECTED


@pytest.mark.parametrize("file", ["C:\\Users\\alex\\PROJEC~1\\a.md", "C:\\Users\\alex\\privatework~1\\a.md"])
def test_short_name_of_another_folder_is_allowed(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) is None


def test_nul_character_fails_closed_and_long_name_is_allowed(tmp_path):
    env = flavor_env(tmp_path)
    assert memory_exclusion_reason(read("C:\\Users\\alex\\private-work\0junk"), env=env) == UNVERIFIED
    assert memory_exclusion_reason(read("C:\\Users\\alex\\" + " " * 200000 + "x\\a.md"), env=env) is None


def test_flavor_with_no_roots_passed_is_a_configuration_error(tmp_path):
    missing = policy_env(tmp_path, HARNESS_HOST_PATH_FLAVOR="win32")
    blank = policy_env(tmp_path, HARNESS_HOST_PATH_FLAVOR="win32", HARNESS_MEMORY_EXCLUDED_ROOTS="")
    assert memory_exclusion_reason({"cwd": WIN_PROJECT}, env=missing) == INVALID
    assert memory_exclusion_reason({"cwd": WIN_PROJECT}, env=blank) == INVALID
    assert memory_exclusion_reason({"cwd": WIN_ROOT}, env=flavor_env(tmp_path, roots=[])) is None


@pytest.mark.parametrize("root", [
    "\\\\server", "\\\\server\\", "\\\\?\\UNC\\server", "\\\\?\\UNC\\", "\\\\", "//", "/c\n",
])
def test_share_root_must_name_a_server_and_a_share(tmp_path, root):
    reason = memory_exclusion_reason({"cwd": WIN_PROJECT}, env=flavor_env(tmp_path, roots=[root]))
    assert reason == INVALID


def test_empty_path_entries_are_skipped_like_the_hook_side(tmp_path):
    assert memory_exclusion_reason({"files_read": [""]}, env=flavor_env(tmp_path)) is None
    assert memory_exclusion_reason({"cwd": WIN_PROJECT, "files_read": ["", "docs\\a.md"]}, env=flavor_env(tmp_path)) is None


# ---------------------------------------------------------------------------
# Second review round, 2026-11-11.
# ---------------------------------------------------------------------------


def test_mac_or_linux_note_is_judged_by_its_names_not_refused(tmp_path):
    # Notes store modified files repo-relative; a session from another machine
    # has a working directory with no drive.
    env = flavor_env(tmp_path)
    mac = {"cwd": "/Users/alex/projects/app", "files_modified": ["src/app/page.tsx"]}
    linux = {"cwd": "/home/harness/work/repo", "files_modified": ["a/b.py"]}
    assert memory_exclusion_reason(mac, env=env) is None
    assert memory_exclusion_reason(linux, env=env) is None
    assert memory_exclusion_reason({"files_modified": ["docs/a.md"]}, env=env) is None
    assert memory_exclusion_reason({"cwd": "", "files_modified": ["docs/a.md"]}, env=env) is None
    assert memory_exclusion_reason({"cwd": "/Users/alex", "files_read": ["private-work/a.md"]}, env=env) == PROTECTED
    assert memory_exclusion_reason({"cwd": "/Users/alex/private-work/x"}, env=env) == PROTECTED


@pytest.mark.parametrize("odd", ["...", " ", ":x", ". .", ".. ", "...."])
def test_parent_segment_cancels_the_odd_name_before_it_not_the_folder(tmp_path, odd):
    file = "C:\\Users\\alex\\private-work\\" + odd + "\\..\\a.md"
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == PROTECTED


def test_parent_segment_still_leaves_the_folder_when_it_should(tmp_path):
    env = flavor_env(tmp_path)
    assert memory_exclusion_reason(read("..\\..\\private-work\\...\\..\\a.md"), env=env) == PROTECTED
    assert memory_exclusion_reason({"cwd": "C:\\Users\\alex\\private-work\\...\\.."}, env=env) == PROTECTED
    assert memory_exclusion_reason(read("C:\\Users\\alex\\private-work\\..\\projects\\a.md"), env=env) is None


@pytest.mark.parametrize("file", [
    "\\\\.\\UNC\\.\\localhost\\C$\\Users\\alex\\private-work\\a.md",
    "\\\\.\\UNC\\localhost\\.\\C$\\Users\\alex\\private-work\\a.md",
    "//./UNC/./localhost/C$/Users/alex/private-work/a.md",
    "\\\\;LanmanRedirector\\localhost\\C$\\Users\\alex\\private-work\\a.md",
    "X:/../C:/Users/alex/private-work/a.md",
    "GLOBALROOT/DosDevices/C:/Users/alex/private-work/a.md",
    "Global/C:/Users/alex/private-work/a.md",
])
def test_spellings_text_cannot_place_are_refused(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == UNVERIFIED


@pytest.mark.parametrize("file", [
    "/c/../c/Users/alex/private-work/a.md",
    "/./c/Users/alex/private-work/a.md",
    "///c/Users/alex/private-work/a.md",
    "/../c/Users/alex/private-work/a.md",
    "/usr/../c/Users/alex/private-work/a.md",
    "/tmp/../c/Users/alex/private-work/a.md",
    "/proc/cygdrive//c/Users/alex/private-work/a.md",
    "/proc//cygdrive/c/Users/alex/private-work/a.md",
    "/proc/./cygdrive/c/Users/alex/private-work/a.md",
    "/proc/self/root/c/Users/alex/private-work/a.md",
    "/c\\Users\\alex\\private-work\\a.md",
    "/mnt//c/Users/alex/private-work/a.md",
    "~/private-work/a.md",
    "~\\private-work",
])
def test_unix_shell_spellings_are_read_the_way_the_shell_reads_them(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == PROTECTED


@pytest.mark.parametrize("file", ["/tmp/build/a.md", "/c/Users/alex/projects/a.md", "~/.bashrc", "~/projects/a.md"])
def test_ordinary_unix_shell_paths_are_allowed(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) is None


@pytest.mark.parametrize(("folder", "short_name"), [
    ("a.verylongext", "A7903~1.VER"),
    ("r\u00e9sum\u00e9 private", "RSUMPR~1"),
    ("\u79d8\u5bc6\u30d5\u30a9\u30eb\u30c0-private", "-PRIVA~1"),
    ("...dots first", "DOTSFI~1"),
    ("tilde~in~name-long", "TILDE~~1"),
    ("stra\u00dfe-root", "STRAE-~1"),
    ("\u0130stanbul-root", "STANBU~1"),
    ("private-work", "PR36C7~1"),
])
def test_short_names_follow_how_windows_builds_them(tmp_path, folder, short_name):
    env = flavor_env(tmp_path, roots=["C:/Users/alex/" + folder])
    assert memory_exclusion_reason(read("C:\\Users\\alex\\" + short_name + "\\a.md"), env=env) == PROTECTED
    assert memory_exclusion_reason(read("C:\\Users\\alex\\OTHER~1\\a.md"), env=env) is None


def test_names_fold_by_upper_case_too(tmp_path):
    env = flavor_env(tmp_path, roots=["C:/Users/alex/\u0391\u03a3-root"])
    assert memory_exclusion_reason(read("C:\\Users\\alex\\\u03b1\u03c3-root\\a.md"), env=env) == PROTECTED


def test_protected_path_wins_over_an_unplaceable_one_beside_it(tmp_path):
    inside = "C:\\Users\\alex\\private-work\\a.md"
    metadata = {"cwd": WIN_PROJECT, "files_read": ["\\\\?\\GLOBALROOT\\x", inside]}
    assert memory_exclusion_reason(metadata, env=flavor_env(tmp_path)) == PROTECTED
    mixed = {"cwd": WIN_PROJECT, "files_read": [inside, 5]}
    assert memory_exclusion_reason(mixed, env=flavor_env(tmp_path)) == PROTECTED
    assert memory_exclusion_reason({"cwd": WIN_PROJECT, "files_read": [5]}, env=flavor_env(tmp_path)) == UNVERIFIED


# ---------------------------------------------------------------------------
# Third review round, 2026-11-11.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("file", [
    "\\\\.\\UNC\\\\localhost\\C$\\Users\\alex\\private-work\\a.md",
    "//./UNC//localhost/C$/Users/alex/private-work/a.md",
    "\\\\.\\unc\\\\\\localhost\\C$\\Users\\alex\\private-work\\a.md",
    "\\\\?\\UNC\\\\localhost\\C$\\Users\\alex\\private-work\\a.md",
    "\\\\.\\UNC\\localhost\\C$.\\Users\\alex\\private-work\\a.md",
    "\\\\localhost.\\C$ \\Users\\alex\\private-work\\a.md",
])
def test_device_share_path_is_read_with_runs_and_trailing_dots_as_windows_reads_them(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == PROTECTED


def test_device_share_root_with_a_dotted_share_name_is_the_same_share(tmp_path):
    env = flavor_env(tmp_path, roots=["//fileserver/its/briefs"])
    assert memory_exclusion_reason(read("\\\\.\\UNC\\\\fileserver\\its.\\briefs\\a.html"), env=env) == PROTECTED


@pytest.mark.parametrize("file", [
    "/proc/self/root/../c/Users/alex/private-work/a.md",
    "/proc/cygdrive/proc/self/root/c/Users/alex/private-work/a.md",
    "/proc/1234/root/c/Users/alex/private-work/a.md",
    "/proc/self/root/proc/self/root/c/Users/alex/private-work/a.md",
    "/cygdrive/cygdrive/c/Users/alex/private-work/a.md",
    "/c:/Users/alex/private-work/a.md",
])
def test_process_links_and_slash_drive_spellings_are_followed(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == PROTECTED


@pytest.mark.parametrize("file", [
    "/proc/self/cwd/../../private-work/a.md",
    "/proc/1234/cwd/a.md",
    "/proc/self/task/9/root/c/Users/alex/private-work/a.md",
    "X:/../C:./Users/alex/private-work/a.md",
    "X:\\..\\C: \\Users\\alex\\private-work\\a.md",
])
def test_process_links_text_cannot_follow_are_refused(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == UNVERIFIED


def test_ordinary_proc_paths_are_allowed(tmp_path):
    env = flavor_env(tmp_path)
    assert memory_exclusion_reason(read("/proc/cpuinfo"), env=env) is None
    assert memory_exclusion_reason(read("/c:/Users/alex/projects/app/a.ts"), env=env) is None


def test_root_that_is_a_whole_drive_share_or_home_folder_covers_what_could_be_inside(tmp_path):
    relative = {"files_read": ["notes\\a.md"]}
    assert memory_exclusion_reason(relative, env=flavor_env(tmp_path, roots=["C:\\"])) == PROTECTED
    assert memory_exclusion_reason(relative, env=flavor_env(tmp_path, roots=["//fs/its"])) == PROTECTED
    home = read("~/Documents/a.md")
    assert memory_exclusion_reason(home, env=flavor_env(tmp_path, roots=["C:\\Users\\alex"])) == PROTECTED
    assert memory_exclusion_reason(read("~"), env=flavor_env(tmp_path, roots=["C:\\Users"])) == PROTECTED
    assert memory_exclusion_reason(home, env=flavor_env(tmp_path)) is None
    assert memory_exclusion_reason(home, env=flavor_env(tmp_path, roots=["D:\\work\\private"])) is None


def test_non_text_working_directory_is_malformed_even_when_falsy(tmp_path):
    env = flavor_env(tmp_path)
    assert memory_exclusion_reason({"cwd": 0, "files_read": ["a.md"]}, env=env) == UNVERIFIED
    assert memory_exclusion_reason({"cwd": [], "files_read": ["a.md"]}, env=env) == UNVERIFIED
    assert memory_exclusion_reason({"cwd": [], "files_read": [5]}, env=flavor_env(tmp_path, roots=[])) is None


# ---------------------------------------------------------------------------
# Fourth review round, 2026-11-11.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("file", [
    "file:///C:/Users/alex/private-work/a.md",
    "file:///C:/Users/alex/private%2Dwork/a.md",
    "file:///C:/Users/alex/%70rivate-work/a.md",
    "file:///C:/Users/alex/PRIVAT%7E1/a.md",
    "file:///C%3A/Users/alex/private-work/a.md",
    "file:///C:/Users/alex/x/%2E%2E/private-work/a.md",
    "file://localhost/C:/Users/alex/private-work/a.md",
    "file://C:/Users/alex/private-work/a.md",
    "file:///C|/Users/alex/private-work/a.md",
    "file:C:/Users/alex/private-work/a.md",
    "FILE:///C:/Users/alex/projects/app/a.ts",
])
def test_file_url_is_refused_not_half_read(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == UNVERIFIED


def test_protected_path_wins_over_a_file_url_and_similar_names_are_ordinary(tmp_path):
    env = flavor_env(tmp_path)
    both = {"cwd": WIN_PROJECT, "files_read": ["file:///C:/Users/alex/projects/app/a.ts", "C:\\Users\\alex\\private-work\\a.md"]}
    assert memory_exclusion_reason(both, env=env) == PROTECTED
    assert memory_exclusion_reason({"cwd": WIN_PROJECT, "files_read": ["docs\\file-list.md", "profile:x"]}, env=env) is None


@pytest.mark.parametrize("file", [
    "/dev/fd/../root/c/Users/alex/private-work/a.md",
    "/proc/self/root/dev/fd/../root/c/Users/alex/private-work/a.md",
    "/dev/fd/../cwd/../../private-work/a.md",
    "/proc/self/../self/root/c/Users/alex/private-work/a.md",
    "/Dev/fd/../root/c/Users/alex/private-work/a.md",
    "/DEV/FD/../root/c/Users/alex/private-work/a.md",
])
def test_parent_step_under_proc_or_dev_is_refused(tmp_path, file):
    assert memory_exclusion_reason(read(file), env=flavor_env(tmp_path)) == UNVERIFIED


def test_ordinary_dev_and_proc_paths_are_allowed_and_root_link_is_followed(tmp_path):
    env = flavor_env(tmp_path)
    ordinary = {"cwd": WIN_PROJECT, "files_read": ["/dev/null", "/proc/self/status", "/usr/../tmp/a.md"]}
    assert memory_exclusion_reason(ordinary, env=env) is None
    assert memory_exclusion_reason(read("/proc/self/root/../c/Users/alex/private-work/a.md"), env=env) == PROTECTED


@pytest.mark.parametrize("root", ["D:\\", "//fs/its"])
def test_whole_drive_or_share_root_does_not_swallow_paths_with_no_drive(tmp_path, root):
    env = flavor_env(tmp_path, roots=[root])
    note = "/vault/projects/app/sessions/abc.md"
    assert memory_exclusion_reason({"cwd": WIN_PROJECT}, note_path=note, env=env) is None
    assert memory_exclusion_reason({"cwd": "/Users/alex/projects/app", "files_modified": ["src/a.ts"]}, note_path=note, env=env) is None
    assert memory_exclusion_reason({"cwd": "/home/alex/repo"}, note_path=note, env=env) is None


def test_whole_drive_or_share_root_still_protects_what_is_on_it(tmp_path):
    drive = flavor_env(tmp_path, roots=["D:\\"])
    assert memory_exclusion_reason({"cwd": "D:\\work", "files_read": ["a.md"]}, env=drive) == PROTECTED
    share = flavor_env(tmp_path, roots=["//fs/its"])
    assert memory_exclusion_reason(read("\\\\fs\\its\\briefs\\a.md"), env=share) == PROTECTED


def test_file_scheme_is_matched_the_same_way_on_both_sides(tmp_path):
    # A dotless i is not an i: `fıle:` is an ordinary relative name here, as it is in the hooks.
    env = flavor_env(tmp_path)
    assert memory_exclusion_reason(read("fıle:x/a.md"), env=env) is None
    assert memory_exclusion_reason(read("FiLe:x/a.md"), env=env) == UNVERIFIED
