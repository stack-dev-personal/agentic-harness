"""Content-free ingestion checks matching the shared native capture policy.

Historical notes can only supply the identities and paths they recorded. This
module never guesses missing ancestry or scans arbitrary conversation content.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Mapping

from .session_content import exclusion_reason

_DISABLED = frozenset({"0", "false", "off", "no", "exclude"})
_MAX_ANCESTORS = 128
_MAX_EXCLUSION_BYTES = 4096

# Where the ingest runs on one operating system and judges paths recorded on
# another (the Linux jobs container reading a Windows host's notes), session
# paths are compared as text by that system's rules, with no filesystem call.
# The rules are hooks/lib/host-paths.mjs, repeated here step for step: the two
# must give the same answer for the same text, so neither borrows from its
# standard library (`ntpath` and Node's `path.win32` disagree). A change there
# is a change here. Patterns end in `\Z`, not `$`: `$` also matches before a
# final newline, which JavaScript's does not.
_HOST_PATH_FLAVOR_VAR = "HARNESS_HOST_PATH_FLAVOR"
_SUPPORTED_FLAVORS = frozenset({"win32"})
_SEPARATORS = ("\\", "/")
_ONE_SEPARATOR = re.compile(r"[\\/]")
_SEPARATOR_RUN = re.compile(r"[\\/]+")
# `\\?\`, `\\.\` and the NT form `\??\`: device prefixes in front of an ordinary path.
_DEVICE_PREFIX = re.compile(r"^(?:[\\/]{2}[?.][\\/]|[\\/]\?\?[\\/])")
_DEVICE_UNC = re.compile(r"^UNC[\\/]", re.IGNORECASE)
_DRIVE_THEN_SEPARATOR = re.compile(r"^[A-Za-z]:[\\/]")
# `\\host\C$\x`: the administrative share of a drive, on this machine or any other.
_ADMIN_SHARE = re.compile(r"^\\\\[^\\]+\\([A-Za-z])\$(?:\\(.*))?\Z", re.DOTALL)
_DRIVE_FULL = re.compile(r"^[A-Za-z]:\\")
_SHARE_FULL = re.compile(r"^\\\\[^\\]+\\[^\\]+(?:\\|\Z)")
_DRIVE_RELATIVE = re.compile(r"^[A-Za-z]:(?!\\)")
_DRIVE_LETTER = re.compile(r"^[A-Za-z]\Z")
_DRIVE_SEGMENT = re.compile(r"^[A-Za-z]:\Z")
# The owner in `/proc/<owner>/root`: this process, this thread, or a process id.
_PROCESS_NAME = re.compile(r"^(?:self|thread-self|[0-9]+)\Z")
# Folders a home folder normally sits directly inside.
_HOME_PARENTS = frozenset({"users", "home", "documents and settings"})
# An 8.3 short name: up to six characters, a tilde, a number, an optional short extension.
_SHORT_NAME = re.compile(r"^([^\\]{1,6})~[0-9]{1,6}(?:\.[^.\\]{0,3})?\Z", re.DOTALL)
_SHORT_NAME_REPLACED = re.compile(r"[+,;=\[\]]")
_HEX4 = re.compile(r"^[0-9A-F]{4}\Z")


def _identities(metadata: Mapping[str, Any]) -> list[str]:
    identities = []
    for key in ("session_id", "sessionId", "parent_session", "parent_session_id", "parentSession"):
        value = metadata.get(key)
        if value is None or value == "":
            continue
        if not isinstance(value, str):
            raise ValueError("invalid session identity")
        identities.append(value)
    for key in ("ancestor_sessions", "ancestorSessions"):
        if key not in metadata:
            continue
        values = metadata[key]
        if not isinstance(values, list) or len(values) > _MAX_ANCESTORS:
            raise ValueError("invalid session ancestry")
        if any(not isinstance(value, str) or not value for value in values):
            raise ValueError("invalid ancestor identity")
        identities.extend(values)
    return list(dict.fromkeys(identities))


def _state_directory(env: Mapping[str, str]) -> Path:
    configured = env.get("HARNESS_MEMORY_STATE_DIR")
    if configured:
        directory = Path(configured)
    else:
        directory = Path(env.get("USERPROFILE") or Path.home()) / ".harness"
    if not directory.is_absolute():
        raise ValueError("invalid state directory")
    return directory


def _sticky_reason(metadata: Mapping[str, Any], env: Mapping[str, str]) -> str | None:
    try:
        directory = _state_directory(env)
        identities = _identities(metadata)
        runtime = metadata.get("runtime") or metadata.get("agent")
        if runtime is not None and not isinstance(runtime, str):
            raise ValueError("invalid runtime identity")
        if not runtime:
            return None
        for identity in identities:
            prefix = f"{runtime}-"
            while identity.startswith(prefix):
                identity = identity[len(prefix):]
            # Exact shared JS contract: SHA256(`${runtime}:${nativeId}`).
            key = hashlib.sha256(f"{runtime}:{identity}".encode("utf-8")).hexdigest()
            file = directory / "memory-exclusions" / f"{key}.json"
            try:
                if file.stat().st_size > _MAX_EXCLUSION_BYTES:
                    raise ValueError("invalid exclusion state size")
                previous = json.loads(file.read_text(encoding="utf-8"))
            except FileNotFoundError:
                continue
            if not isinstance(previous, dict):
                raise ValueError("invalid exclusion state")
            return "memory policy: previously excluded session"
    except (OSError, ValueError, TypeError, RuntimeError):
        return "memory policy: session exclusion state unavailable"
    return None


def _canonical_path(file: str | Path) -> Path:
    """Resolve existing prefixes strictly; only missing suffixes are permitted."""
    current = Path(os.path.abspath(file))
    suffix = []
    while True:
        try:
            return current.resolve(strict=True).joinpath(*suffix)
        except FileNotFoundError:
            parent = current.parent
            if parent == current:
                raise
            suffix.insert(0, current.name)
            current = parent


def _host_path_flavor(env: Mapping[str, str]) -> str | None:
    """The flavor the environment names, or None. An unknown value raises: a typo must not fall back."""
    value = str(env.get(_HOST_PATH_FLAVOR_VAR) or "").strip().lower()
    if not value:
        return None
    if value not in _SUPPORTED_FLAVORS:
        raise ValueError("unknown host path flavor")
    return value


def _is_unplaceable_device_path(text: str) -> bool:
    r"""True for a device path whose target text cannot say: one with a `.` or `..`
    segment (Windows applies those before it reads the drive or the server), or
    one that names neither a drive nor a share (`\\?\GLOBALROOT\...`)."""
    device = _DEVICE_PREFIX.match(text)
    if not device:
        return False
    rest = _device_remainder(text, device)
    segments = rest.split("\\")
    if ".." in segments or "." in segments:
        return True
    return not _DEVICE_UNC.match(rest) and not _DRIVE_FULL.match(rest)


def _device_remainder(text: str, device: re.Match[str]) -> str:
    r"""What follows a device prefix, with separator runs read as one, as Windows
    reads them there: `\\.\UNC\\host\share` is `\\host\share`."""
    return _SEPARATOR_RUN.sub(lambda _match: "\\", text[device.end():])


def _leading_separators(text: str) -> int:
    count = 0
    while count < len(text) and text[count] in _SEPARATORS:
        count += 1
    return count


def _from_unix_shell(text: str) -> str:
    """A path that starts with `/`, read the way a Unix shell on Windows reads it:
    either slash separates, runs collapse, `.` and `..` apply, and `/c/x`,
    `/mnt/c/x`, `/cygdrive/c/x` and `/proc/cygdrive/c/x` name drive C:, also
    behind `/proc/self/root`."""
    segments: list[str] = []
    for raw in _ONE_SEPARATOR.split(text):
        if raw in ("", "."):
            continue
        if raw == "..":
            # `/dev/fd` is a link into `/proc/self`, and `..` there leads to
            # that process's `root` and `cwd`. Under either tree a parent step
            # is a step through a link text cannot follow.
            # Git Bash finds `/dev` whatever its letter case.
            if segments and (segments[0] == "proc" or segments[0].lower() == "dev"):
                raise ValueError("parent step under a process tree")
            if segments:
                segments.pop()
            continue
        segments.append(raw)
        # Links the shell follows as it walks, before any later `..` applies:
        # `/proc/cygdrive` and `/cygdrive` are the list of drives, and
        # `/proc/<process>/root` is the top of the filesystem again.
        depth = len(segments)
        if depth == 1 and raw == "cygdrive":
            segments.clear()
            continue
        if segments[0] != "proc":
            continue
        if depth == 2 and raw == "cygdrive":
            segments.clear()
            continue
        if depth == 3 and _PROCESS_NAME.match(segments[1]):
            if raw == "root":
                segments.clear()
                continue
            # `/proc/self/cwd` is wherever that process happened to be.
            if raw in ("cwd", "exe", "fd"):
                raise ValueError("path through a process link")
    if segments[:1] == ["proc"] and any(name in ("root", "cwd", "cygdrive") for name in segments):
        raise ValueError("path through a process link")
    if segments and (_DRIVE_LETTER.match(segments[0]) or _DRIVE_SEGMENT.match(segments[0])):
        return segments[0][0] + ":\\" + "\\".join(segments[1:])
    if segments[:1] == ["mnt"] and len(segments) > 1 and _DRIVE_LETTER.match(segments[1]):
        return segments[1] + ":\\" + "\\".join(segments[2:])
    return "\\" + "\\".join(segments)


def _plain(file: str) -> str:
    """One spelling for every path: backslashes, no device prefix, no Unix-shell
    drive form, no administrative share.

    Raises for text that names no place a comparison can use.
    """
    text = file
    if "\0" in text:
        raise ValueError("path with a NUL character")
    # A file URL is not a path: it can percent-encode any character, name a
    # host, and write a drive three ways. No tool records one where a path
    # belongs, so it is refused rather than half-read.
    # Compared by lower-casing five characters, not by a case-insensitive
    # pattern: Python's would also accept a dotless i, which JavaScript's does not.
    if text[:5].lower() == "file:":
        raise ValueError("file URL where a path belongs")
    device = _DEVICE_PREFIX.match(text)
    if device:
        if _is_unplaceable_device_path(text):
            raise ValueError("device path text cannot place")
        rest = _device_remainder(text, device)
        text = "\\\\" + rest[4:] if _DEVICE_UNC.match(rest) else rest
    elif text[:1] == "/" and _leading_separators(text) != 2:
        text = _from_unix_shell(text)
    # Windows reads a run of separators as one, except the two that open a
    # share path; three or more at the start are one again.
    lead = _leading_separators(text)
    body = _SEPARATOR_RUN.sub(lambda _match: "\\", text[lead:])
    text = ("\\\\" if lead == 2 else "\\" if lead > 0 else "") + body
    if text.startswith("\\\\"):
        # Server and share lose trailing dots and spaces like any other name.
        parts = text[2:].split("\\")
        parts[0] = parts[0].rstrip(". ")
        if len(parts) > 1:
            parts[1] = parts[1].rstrip(". ")
        text = "\\\\" + "\\".join(parts)
    # `\\;LanmanRedirector\host\share\x` reaches `\\host\share\x` by another door.
    if text.startswith("\\\\;"):
        raise ValueError("share path through a named redirector")
    admin = _ADMIN_SHARE.match(text)
    if admin:
        text = f"{admin.group(1)}:\\{admin.group(2) or ''}"
    return text


def _is_full(text: str) -> bool:
    r"""True for `C:\x` and `\\server\share\x`: a path that names its own drive or share."""
    return bool(_DRIVE_FULL.match(text) or _SHARE_FULL.match(text))


def _is_rooted_without_drive(text: str) -> bool:
    return text.startswith("\\") and not text.startswith("\\\\")


def _root_of(full: str) -> str:
    r"""`C:\` or `\\server\share\`, as it starts a full path."""
    if _DRIVE_FULL.match(full):
        return full[:3]
    server = full.find("\\", 2)
    share = full.find("\\", server + 1)
    return full + "\\" if share == -1 else full[:share + 1]


def _names_of(body: str) -> list[str]:
    r"""The folder and file names of `body`, each as Windows opens it.

    In Windows' own order: `.` and `..` are applied to the segments as written,
    and only then does each name lose a stream suffix and its trailing dots and
    spaces. The order matters: in `private\...\..\a` the `..` cancels the
    `...`, not `private`.
    """
    written: list[str] = []
    for raw in body.split("\\"):
        if raw in ("", "."):
            continue
        if raw == "..":
            if written:
                written.pop()
            continue
        written.append(raw)
    names: list[str] = []
    for raw in written:
        # `X:\..\C:\x` with its device prefix already stripped by some caller.
        if _DRIVE_SEGMENT.match(raw.rstrip(". ")):
            raise ValueError("drive named inside a path")
        opened = raw.split(":", 1)[0].rstrip(". ")
        if opened:
            names.append(opened)
    return names


def _located(full: str) -> tuple[str, list[str]]:
    """A full path as a root (lower case) and its names."""
    root = _root_of(full)
    return root.lower(), _names_of(full[len(root):])


def _ascii_only(text: str) -> str:
    return "".join(character for character in text if ord(character) < 128)


def _could_be_short_name_of(long_name: str, candidate: str) -> bool:
    """Whether `candidate` could be the 8.3 short name Windows gave `long_name`
    (`PRIVAT~1` for `private-work`). Text cannot know which short names
    exist, so every plausible one counts. Windows builds one from the name's
    ASCII characters only, without leading dots, spaces or inner dots."""
    match = _SHORT_NAME.match(candidate)
    if not match:
        return False
    stem = long_name.lstrip(".")
    dot = stem.rfind(".")
    if dot > 0:
        stem = stem[:dot]
    base = _SHORT_NAME_REPLACED.sub("_", _ascii_only(stem).replace(" ", "").replace(".", "")).upper()
    prefix = _ascii_only(match.group(1)).upper()
    if len(prefix) != len(match.group(1)):
        return False
    if base != "" and base.startswith(prefix):
        return True
    # After a few collisions, or for a very short name: up to two characters of
    # the name, then four of a hash.
    if len(prefix) < 4 or not _HEX4.match(prefix[-4:]):
        return False
    head = prefix[:-4]
    return base == "" if head == "" else base.startswith(head)


def _same_name(root_name: str, file_name: str) -> bool:
    # Windows folds by upper case; lower case alone misses a final capital sigma.
    return (root_name.lower() == file_name.lower()
            or root_name.upper() == file_name.upper()
            or _could_be_short_name_of(root_name, file_name))


def _starts_with_names(wanted: list[str], names: list[str]) -> bool:
    return len(names) >= len(wanted) and all(_same_name(name, names[index]) for index, name in enumerate(wanted))


def _within(root_at: tuple[str, list[str]], file_at: tuple[str, list[str]]) -> bool:
    root_root, root_names = root_at
    file_root, file_names = file_at
    if file_root == "":
        # A path with no drive is compared by names alone. A root that is a
        # whole drive or share has no names to compare, and every Mac path,
        # Linux path and container path would match it: there is no evidence
        # either way, so it does not.
        return len(root_names) > 0 and _starts_with_names(root_names, file_names)
    return root_root == file_root and _starts_with_names(root_names, file_names)


def _could_land_in(root_at: tuple[str, list[str]], names: list[str]) -> bool:
    r"""For a path whose starting folder is unknown (a relative path with no
    recorded working directory, `~/x`): could it land in the root? Yes when it
    begins with the last names of the root, as `private\a` does under
    `C:\Users\me` for the root `C:\Users\me\private`."""
    root_names = root_at[1]
    # A whole drive or share: everything on it is inside.
    if not root_names:
        return True
    return any(_starts_with_names(root_names[start:], names) for start in range(len(root_names)))


def _could_hold_home(root_at: tuple[str, list[str]]) -> bool:
    """A root that is a home folder, or the folder that holds them: every `~` path is inside it."""
    root_names = root_at[1]
    if not root_names:
        return True
    return len(root_names) <= 2 and root_names[0].lower() in _HOME_PARENTS


def _host_path_within(root: str, file: str, cwd: str) -> bool:
    """Text-only containment by Windows rules: hooks/lib/host-paths.mjs `hostPathWithin`, step for step."""
    base = _plain(root)
    if not _is_full(base):
        raise ValueError("protected root is not a full path")
    target = _plain(file)
    root_at = _located(base)
    if _is_full(target):
        return _within(root_at, _located(target))
    start = _plain(cwd) if cwd else ""
    if _DRIVE_RELATIVE.match(target):
        # `C:notes\a` means "under the current folder of drive C:". That is the
        # recorded working directory only when it is on the same drive.
        if not _DRIVE_FULL.match(start) or start[0].lower() != target[0].lower():
            raise ValueError("drive-relative path on another drive")
        return _within(root_at, _located(start + "\\" + target[2:]))
    if target.startswith("\\\\"):
        raise ValueError("share path that names no share")
    if target.startswith("\\"):
        # Rooted, with no drive of its own: on the working directory's drive.
        if _is_full(start):
            return _within(root_at, _located(_root_of(start) + target[1:]))
        # No drive to borrow (`\Users\x`, a Mac or Linux path, the container's
        # own `/vault/...`): inside the root on some drive counts as inside it.
        return _within(root_at, ("", _names_of(target)))
    # The home folder is not recorded: `~\private\a` could be anywhere.
    if target == "~" or target.startswith("~\\"):
        return _could_hold_home(root_at) or _could_land_in(root_at, _names_of(target[1:]))
    if _is_full(start):
        return _within(root_at, _located(start + "\\" + target))
    if _is_rooted_without_drive(start):
        return _within(root_at, ("", _names_of(start + "\\" + target)))
    return _could_land_in(root_at, _names_of(target))


def _is_host_root(root: str) -> bool:
    if root == "":
        return False
    try:
        text = _plain(root)
        if not _is_full(text):
            return False
        _located(text)
        return True
    except ValueError:
        return False


def _host_protected_path_reason(metadata: Mapping[str, Any], note_path: str | Path | None,
                                roots: list[str]) -> str | None:
    """The protected-root check for paths another operating system recorded: no filesystem call.

    Every path is judged before anything is refused as unverifiable: one
    malformed or unplaceable entry must not hide a protected path beside it.
    """
    unverified = False
    raw_cwd = metadata.get("cwd")
    cwd = raw_cwd if isinstance(raw_cwd, str) else ""
    # Absent or empty is "not recorded"; any other non-text value is malformed.
    if raw_cwd is not None and not isinstance(raw_cwd, str):
        unverified = True
    paths: list[str] = [cwd]
    if note_path is not None:
        paths.append(str(note_path))
    for key in ("cwds_seen", "files_modified", "files_read"):
        values = metadata.get(key, [])
        if key == "files_read" and isinstance(values, int) and not isinstance(values, bool):
            continue
        if not isinstance(values, list):
            unverified = True
            continue
        for value in values:
            if isinstance(value, str):
                paths.append(value)
            else:
                unverified = True
    for raw in paths:
        if raw == "":
            continue
        for root in roots:
            try:
                if _host_path_within(root, raw, cwd):
                    return "memory policy: protected path touched"
            except (OSError, ValueError, TypeError, RuntimeError):
                unverified = True
    if unverified:
        return "memory policy: memory path policy could not be verified"
    return None


def _protected_path_reason(metadata: Mapping[str, Any], note_path: str | Path | None,
                           env: Mapping[str, str]) -> str | None:
    try:
        # Set where the ingest judges another operating system's paths (the
        # jobs container): compared as text by that system's rules.
        flavor = _host_path_flavor(env)
        configured = env.get("HARNESS_MEMORY_EXCLUDED_ROOTS")
        # Under a flavor the roots travel from the host into another
        # environment. A variable that did not make the trip must not read as
        # "nothing is protected": say `[]` to mean that.
        if flavor and not configured:
            raise ValueError("roots not passed")
        roots = json.loads(configured or "[]")
        if not isinstance(roots, list) or any(not isinstance(root, str) for root in roots):
            raise ValueError("invalid protected roots")
        if any(not (_is_host_root(root) if flavor else Path(root).is_absolute()) for root in roots):
            raise ValueError("invalid protected roots")
    except (ValueError, TypeError):
        return "memory policy: invalid memory exclusion configuration"
    if not roots:
        return None
    if flavor:
        return _host_protected_path_reason(metadata, note_path, roots)
    try:
        resolved_roots = [_canonical_path(root) for root in roots]
        cwd = metadata.get("cwd") or os.getcwd()
        if not isinstance(cwd, str):
            raise ValueError("invalid session cwd")
        base = _canonical_path(cwd)
        paths: list[str | Path] = [base]
        if note_path is not None:
            paths.append(note_path)
        for key in ("cwds_seen", "files_modified", "files_read"):
            values = metadata.get(key, [])
            # Some historical notes record only a count of reads, not paths.
            if key == "files_read" and isinstance(values, int):
                continue
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
                raise ValueError("invalid session paths")
            paths.extend(values)
        for raw in paths:
            candidate = Path(raw)
            resolved = _canonical_path(candidate if candidate.is_absolute() else base / candidate)
            if any(resolved.is_relative_to(root) for root in resolved_roots):
                return "memory policy: protected path touched"
    except (OSError, ValueError, TypeError, RuntimeError):
        return "memory policy: memory path policy could not be verified"
    return None


def memory_exclusion_reason(metadata: Mapping[str, Any], *, note_path: str | Path | None = None,
                            env: Mapping[str, str] | None = None) -> str | None:
    """Return a content-free reason before embedding, retrieval parsing or writes."""
    environment = os.environ if env is None else env
    if str(environment.get("HARNESS_MEMORY_PERSISTENCE", "")).strip().lower() in _DISABLED:
        return "memory policy: memory persistence disabled"
    explicit = exclusion_reason(dict(metadata))
    if explicit:
        return explicit
    return (_protected_path_reason(metadata, note_path, environment)
            or _sticky_reason(metadata, environment))
