"""Runtime-neutral session policy and embedding content.

Only recognized generated notes receive a separate embedding view. Their raw
body and provenance remain in the document store for exact retrieval.
"""
from __future__ import annotations

import os
import re
from typing import Any

from .errors import IngestError

EXCLUDED_PURPOSES = frozenset({"housekeeping", "observer", "derivative"})
_GENERATED_FOOTER = re.compile(r"^_Generated mechanically by `[^`]+`[^\n]*_\s*$", re.MULTILINE)
_GENERATOR = re.compile(r"^(?:(?:codex|hermes)-)?session-capture\.mjs(?:\s|$)")
_FIRST_SECTION = re.compile(r"^## What I asked for\s*$", re.MULTILINE)
_FACTS_SECTION = re.compile(r"^## Session facts\s*\n[\s\S]*?(?=^## |\Z)", re.MULTILINE)


def require_memory_enabled() -> None:
    """Block direct ingestion as well as queued capture before content is read."""
    if os.environ.get("HARNESS_MEMORY_PERSISTENCE", "").strip().lower() in {
        "0", "false", "off", "no", "exclude"
    }:
        raise IngestError("memory persistence disabled")


def exclusion_reason(metadata: dict[str, Any]) -> str | None:
    """Explicit policy applies to all producers; origin strings are provenance."""
    if (metadata.get("memory_excluded") is True or metadata.get("restricted") is True
            or metadata.get("persistence") == "exclude"):
        return "memory policy: session excluded"
    for key in ("classification", "data_classification"):
        if key in metadata and not isinstance(metadata[key], str):
            return "memory policy: invalid classification metadata"
        classification = metadata.get(key)
        if isinstance(classification, str):
            label = re.sub(r"[\s:+_-]+", "", classification).upper()
            if label in {"TLPAMBER", "TLPAMBERSTRICT", "TLPRED", "RESTRICTED"}:
                return "memory policy: restricted classification"
    purpose = metadata.get("purpose")
    if isinstance(purpose, str) and purpose.strip().lower() in EXCLUDED_PURPOSES:
        return "memory policy: excluded session purpose"
    return None


def embedding_body(body: str, metadata: dict[str, Any]) -> str | None:
    """Keep task, outcome, activity and user notes; remove generated provenance.

    User prose is never searched-and-replaced for runtime or model names. Only
    the known schema's generated heading/summary, facts and footer are removed.
    """
    if metadata.get("type") != "session" or metadata.get("schema_version") != 2:
        return None
    generator = metadata.get("generator")
    if not isinstance(generator, str) or not _GENERATOR.match(generator):
        return None
    normalized = body.replace("\r\n", "\n").replace("\r", "\n")
    first = _FIRST_SECTION.search(normalized)
    if first is None:
        return None
    footer = _GENERATED_FOOTER.search(normalized)
    generated_end = footer.start() if footer else len(normalized)
    generated = normalized[first.start():generated_end]
    generated = _FACTS_SECTION.sub("", generated).rstrip()
    generated = re.sub(r"\n---\s*$", "", generated).rstrip()
    handwritten = normalized[footer.end():].strip() if footer else ""
    parts = ["# Session memory", generated]
    if handwritten:
        parts.append(handwritten)
    return "\n\n".join(parts) + "\n"
