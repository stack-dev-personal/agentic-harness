"""Content-free ingestion checks matching the shared native capture policy.

Historical notes can only supply the identities and paths they recorded. This
module never guesses missing ancestry or scans arbitrary conversation content.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping

from .session_content import exclusion_reason

_DISABLED = frozenset({"0", "false", "off", "no", "exclude"})
_MAX_ANCESTORS = 128
_MAX_EXCLUSION_BYTES = 4096


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


def _protected_path_reason(metadata: Mapping[str, Any], note_path: str | Path | None,
                           env: Mapping[str, str]) -> str | None:
    try:
        roots = json.loads(env.get("HARNESS_MEMORY_EXCLUDED_ROOTS") or "[]")
        if not isinstance(roots, list) or any(not isinstance(root, str) or not Path(root).is_absolute() for root in roots):
            raise ValueError("invalid protected roots")
    except (ValueError, TypeError):
        return "memory policy: invalid memory exclusion configuration"
    if not roots:
        return None
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
