"""Obsidian vault loader.

Walks a vault directory for markdown, splits YAML frontmatter from the body, and
emits one :class:`SourceDocument` per note.

* ``source``      = ``obsidian``
* ``external_id`` = the note's frontmatter ``id:`` when it has one, else the
  vault-relative POSIX path (``notes/ideas/rag.md``), so a note keeps the same
  identity whether it is ingested from Windows or WSL.

  Prefer an ``id:`` in notes you expect to move. With a path-based key a rename
  is indistinguishable from delete-plus-create: the old row is stranded and a
  duplicate appears. A stable ``id:`` survives the rename.
* ``agent``       = validated explicit agent/runtime provenance, else ``unknown``
* ``metadata``    = the frontmatter verbatim, plus an ``_ingest`` sub-object.
  Ingest-added keys are nested under ``_ingest`` so they can never collide with
  a user's own frontmatter key named ``path`` or ``source``. The one key left
  out is ``retrievals``: it is parsed into ``SourceDocument.retrievals`` and
  projected into ``rag.retrieval_events`` instead.

Opting out. A note with frontmatter ``ingest: false`` stays in the vault for
reading and linking but is never embedded. Class materials exported from bb2dash
use this: their retrieval belongs to the bb2dash store, and embedding them here
would put gte-small content into a bge-small index (CONTEXT.md). Opt-outs are
reported as skips, never hidden.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from ..config import ENV_REALMS, REALM_NAME, SOURCE_OBSIDIAN
from ..errors import SourceError
from ..jsonutil import json_safe
from ..hashing import content_hash
from ..models import RetrievalEvent, SourceDocument
from ..retrievals import parse_retrievals, session_fields_from
from ..session_content import embedding_body
from ..memory_policy import memory_exclusion_reason
from .base import LoadedSource, SkippedRecord

log = logging.getLogger(__name__)

MARKDOWN_SUFFIXES = (".md", ".markdown", ".mdx")

# Obsidian's own state, VCS metadata and dependency trees are not notes, at any depth.
SKIP_DIRECTORIES = frozenset(
    {".obsidian", ".trash", ".git", ".github", "node_modules", ".venv", "__pycache__"}
)

# Obsidian's Templates and Daily Notes plugins read from a vault-ROOT folder
# (`.obsidian/templates.json`), and a template is `{{date}}` placeholders, not
# content. Only the root folder is excluded: a `notes/templates/` deeper in a
# project may well hold real documentation.
TEMPLATES_DIRECTORY = "templates"

_H1 = re.compile(r"^\s{0,3}#\s+(.+?)\s*#*\s*$", re.MULTILINE)

# Frontmatter key that overrides the path-based identity.
ID_KEY = "id"
MAX_ID_LENGTH = 512

# Frontmatter key the capture hook records a session's searches under (SC-1).
# Projected into rag.retrieval_events; never part of documents.metadata.
RETRIEVALS_KEY = "retrievals"

# Frontmatter key that opts a note out of embedding. Absent means ingest.
INGEST_KEY = "ingest"
OPT_OUT_REASON = "frontmatter ingest: false"

# A realm is one git repo of notes, marked by a committed `.realm` file holding
# its name. Either the vault root is one realm, or each top-level folder with a
# marker is one; the folder must be named after the realm, because external_id
# is the vault-relative path and a rename would re-key every note.
REALM_MARKER = ".realm"
OUTSIDE_REALM_REASON = "not inside a realm"

# The vault's top-level areas, each holding one folder per collection. Mirrors
# AREAS in hooks/lib/constants.mjs; `harness` is the harness's own realm (R-H1).
AREA_FOLDERS = frozenset({"projects", "classes", "harness"})


def vault_root(vault_path: str | Path) -> Path:
    """Validate and return the vault directory. Shared by both entry points."""
    root = Path(vault_path).expanduser()
    if not _exists(root):
        raise SourceError(f"Vault path does not exist: {root}")
    if not _is_dir(root):
        raise SourceError(f"Vault path is not a directory: {root}")
    return root


# Filesystem probes that turn an unusable path into a typed error rather than a
# traceback. `Path.exists()` raises ValueError — not OSError — on a path holding
# a null byte, and OSError on names the platform rejects outright; both reach a
# CLI flag, so both are handled here instead of escaping as a crash.
def _exists(path: Path) -> bool:
    try:
        return path.exists()
    except (OSError, ValueError):
        return False


def _is_dir(path: Path) -> bool:
    try:
        return path.is_dir()
    except (OSError, ValueError):
        return False


def _is_file(path: Path) -> bool:
    try:
        return path.is_file()
    except (OSError, ValueError):
        return False


def discover_realms(root: Path) -> dict[str, str]:
    """Map each realm's top-level folder (``""`` for the root) to its name.

    Empty when the vault carries no marker at all: the pre-realm layout, whose
    rows are the "legacy" rows prune treats separately. Raises on a marker that
    is not a name, a folder not named after its realm, or a root marker beside
    folder markers — each of those is a vault that means two things at once.
    """
    root_marker = root / REALM_MARKER
    folder_markers = sorted(
        child
        for child in root.iterdir()
        if _is_dir(child) and child.name not in SKIP_DIRECTORIES and _is_file(child / REALM_MARKER)
    )
    if _is_file(root_marker):
        if folder_markers:
            names = ", ".join(child.name for child in folder_markers)
            raise SourceError(
                f"{REALM_MARKER} at the vault root and inside {names}: a vault is either one realm or several"
            )
        return {"": _read_realm_name(root_marker)}

    realms: dict[str, str] = {}
    for folder in folder_markers:
        name = _read_realm_name(folder / REALM_MARKER)
        if name != folder.name:
            raise SourceError(
                f"folder '{folder.name}' holds {REALM_MARKER} '{name}': a realm's folder must be "
                "named after it, or every note in it would change external_id"
            )
        realms[folder.name] = name
    return realms


def _read_realm_name(marker: Path) -> str:
    try:
        name = marker.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError) as exc:
        raise SourceError(f"{marker.as_posix()}: unreadable ({exc})") from exc
    if not REALM_NAME.match(name):
        raise SourceError(
            f"{marker.as_posix()}: '{name}' is not a realm name (lowercase letters, digits, dashes; 1-32 chars)"
        )
    return name


def _check_allowed(realms: dict[str, str], allowed_realms: Sequence[str] | None) -> None:
    """Refuse a realm on disk that this machine's policy does not list."""
    if allowed_realms is None:
        return
    unlisted = sorted(set(realms.values()) - set(allowed_realms))
    if unlisted:
        raise SourceError(
            f"realm(s) on disk but not in this machine's {ENV_REALMS}: {', '.join(unlisted)}. "
            "A realm cloned by mistake must not enter this store; list it, or remove it."
        )


def _realm_for(relative: str, realms: dict[str, str]) -> str | None:
    if "" in realms:
        return realms[""]
    return realms.get(relative.split("/", 1)[0])


def load_vault(
    vault_path: str | Path, *, allowed_realms: Sequence[str] | None = None
) -> LoadedSource:
    """Load every markdown note under ``vault_path``."""
    root = vault_root(vault_path)
    realms = discover_realms(root)
    _check_allowed(realms, allowed_realms)
    if not realms:
        log.warning("No %s marker in %s: notes are ingested without a realm (legacy layout)", REALM_MARKER, root)

    documents: list[SourceDocument] = []
    skipped: list[SkippedRecord] = []
    claimed_by: dict[str, str] = {}

    for path in sorted(_iter_markdown(root)):
        relative = path.relative_to(root).as_posix()
        realm = _realm_for(relative, realms)
        if realms and realm is None:
            skipped.append(SkippedRecord(relative, OUTSIDE_REALM_REASON))
            continue
        try:
            loaded = _load_note(path, relative, realm)
        except SourceError as exc:
            log.warning("Skipping %s: %s", relative, exc)
            skipped.append(SkippedRecord(relative, str(exc)))
            continue

        if isinstance(loaded, SkippedRecord):
            # A deliberate skip (empty body, opt-out) is not a warning.
            log.debug("Skipping %s: %s", relative, loaded.reason)
            skipped.append(loaded)
            continue

        if _claim(loaded, relative, claimed_by, skipped):
            documents.append(loaded)

    notes = (f"vault root: {root.as_posix()}",)
    return LoadedSource(tuple(documents), tuple(skipped), notes)


def _claim(
    document: SourceDocument,
    relative: str,
    claimed_by: dict[str, str],
    skipped: list[SkippedRecord],
) -> bool:
    """Reserve this document's ``external_id``, or record why it cannot have it.

    Two notes claiming one id would silently overwrite each other through the
    ``(source, external_id)`` upsert key, so the second is refused and the
    conflict named. One function, because both walkers enforce it and a second
    copy would drift.
    """
    owner = claimed_by.get(document.external_id)
    if owner is not None:
        reason = f"duplicate external_id '{document.external_id}', already used by {owner}"
        log.warning("Skipping %s: %s", relative, reason)
        skipped.append(SkippedRecord(relative, reason))
        return False

    claimed_by[document.external_id] = relative
    return True


def load_vault_note(vault_path: str | Path, note_path: str | Path) -> LoadedSource:
    """Load exactly one note, the way a full walk would load it."""
    return load_vault_notes(vault_path, [note_path])


def load_vault_notes(
    vault_path: str | Path,
    note_paths: Sequence[str | Path],
    *,
    allowed_realms: Sequence[str] | None = None,
) -> LoadedSource:
    """Load the named notes, the way a full walk would load them.

    This is what ``ingest --only`` runs, and its caller is the ``SessionEnd``
    hook's detached background process. Nobody watches its stdout, so every
    reason a note cannot be ingested is raised rather than shrugged off: a typo
    in the path must fail in the log, not look like a successful empty run. One
    bad path therefore fails the whole run rather than ingesting the rest
    quietly — the caller validated these paths before spawning, so a bad one is
    a defect, not an ordinary condition.

    Each note must resolve *inside* the vault and must be a file the full walk
    would also visit. Ingesting an excluded path (``templates/``, ``.obsidian/``)
    would create a row that the next ``--prune`` sweep deletes again.

    A deliberate skip — ``ingest: false``, an empty body — is not an error. It
    comes back as a :class:`SkippedRecord`, exactly as in a full walk.

    More than one note in one call is the normal case, not an optimisation: a
    ``SessionEnd`` that resumes also rewrites the note it supersedes, and a
    ``SubagentStop`` rewrites its parent. Loading them together means one
    process and one load of the embedding model instead of one per note.
    """
    root = vault_root(vault_path)
    requested = list(note_paths or ())
    if not requested:
        raise SourceError("--only needs at least one markdown note")
    realms = discover_realms(root)
    _check_allowed(realms, allowed_realms)

    documents: list[SourceDocument] = []
    skipped: list[SkippedRecord] = []
    notes: list[str] = [f"vault root: {root.as_posix()}"]
    seen: set[str] = set()
    claimed_by: dict[str, str] = {}

    for note_path in requested:
        note, relative = _resolve_note(root, note_path)
        if relative in seen:
            # The hook can name the same note twice — a subagent whose parent is
            # also its own note, say. Loading it twice would embed it twice.
            continue
        seen.add(relative)
        notes.append(f"only: {relative}")
        realm = _realm_for(relative, realms)
        if realms and realm is None:
            skipped.append(SkippedRecord(relative, OUTSIDE_REALM_REASON))
            continue

        try:
            loaded = _load_note(note, relative, realm)
        except SourceError as exc:
            # Exactly as in the full walk: a note that will not parse or will
            # not read is one skipped note, not a dead run. Losing the other
            # notes of the batch because OneDrive had this one locked would be
            # worse than the old one-note-per-spawn behaviour it replaced.
            log.warning("Skipping %s: %s", relative, exc)
            skipped.append(SkippedRecord(relative, str(exc)))
            continue

        if isinstance(loaded, SkippedRecord):
            log.debug("Skipping %s: %s", relative, loaded.reason)
            skipped.append(loaded)
            continue

        if _claim(loaded, relative, claimed_by, skipped):
            documents.append(loaded)

    return LoadedSource(tuple(documents), tuple(skipped), tuple(notes))


def _resolve_note(root: Path, note_path: str | Path) -> tuple[Path, str]:
    """Return ``(path, vault_relative_posix)`` for one requested note."""
    raw = str(note_path).strip()
    if not raw:
        raise SourceError("Note path is empty; --only needs a path to one markdown note")
    if "\x00" in raw:
        # Path.exists() raises ValueError rather than OSError on this, which
        # would escape as a traceback from a plain CLI flag.
        raise SourceError("Note path contains a null byte")

    # Windows callers pass backslashes; the hook passes whatever Node gave it.
    candidate = Path(raw.replace("\\", "/")).expanduser()
    if not candidate.is_absolute():
        # Deliberately resolved against the VAULT, never the process cwd: the
        # hook runs with an arbitrary working directory.
        candidate = root / candidate

    # resolve() collapses '..' and follows symlinks, so neither can be used to
    # step outside the vault after this check.
    try:
        resolved = candidate.resolve()
        vault = root.resolve()
    except (OSError, ValueError) as exc:
        raise SourceError(f"Note path cannot be resolved ({exc})") from exc

    try:
        relative = resolved.relative_to(vault).as_posix()
    except ValueError as exc:
        raise SourceError(
            f"{resolved} is outside the vault {vault}; --only may only name a note in the vault"
        ) from exc

    if not _exists(resolved):
        raise SourceError(f"Note does not exist: {resolved}")
    if not _is_file(resolved):
        raise SourceError(f"Note is not a file: {resolved}")
    if resolved.suffix.lower() not in MARKDOWN_SUFFIXES:
        raise SourceError(
            f"{relative} is not a markdown note (expected one of {', '.join(MARKDOWN_SUFFIXES)})"
        )

    excluded = walk_exclusion(relative)
    if excluded:
        raise SourceError(
            f"{relative} is excluded from the vault walk ({excluded}); "
            "a single-note run may not ingest what a full run skips"
        )

    # Join from the unresolved root so the document is byte-identical to the one
    # a full walk produces, symlinked vaults included.
    return root / relative, relative


def walk_exclusion(relative: str) -> str | None:
    """Why the vault walk skips this vault-relative path, or None if it does not.

    Public because the conclude sweep must visit exactly the notes the loader
    visits; two copies of this rule would drift.
    """
    folders = Path(relative).parts[:-1]
    if folders and folders[0] == TEMPLATES_DIRECTORY:
        return f"vault-root {TEMPLATES_DIRECTORY}/"
    for part in folders:
        if part in SKIP_DIRECTORIES:
            return f"{part}/"
    return None


def _iter_markdown(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in MARKDOWN_SUFFIXES:
            continue
        if walk_exclusion(path.relative_to(root).as_posix()):
            continue
        yield path


def _load_note(path: Path, relative: str, realm: str | None = None) -> SourceDocument | SkippedRecord:
    try:
        raw = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise SourceError(f"not valid UTF-8 ({exc.reason})") from exc
    except OSError as exc:
        raise SourceError(f"unreadable ({exc})") from exc

    frontmatter, body = split_frontmatter(raw, relative)
    policy_reason = memory_exclusion_reason(frontmatter, note_path=path)
    if policy_reason:
        return SkippedRecord(relative, policy_reason)
    if not _wants_ingest(frontmatter):
        return SkippedRecord(relative, OPT_OUT_REASON)
    if not body.strip():
        return SkippedRecord(relative, "empty body")

    external_id = _derive_external_id(frontmatter, relative)
    collection = _derive_collection(frontmatter, relative)
    retrievals = _parse_retrievals(frontmatter, relative, external_id, collection, realm)

    stat = path.stat()
    ingest_meta: dict[str, Any] = {
        "loader": "obsidian",
        "path": relative,
        "id_source": "frontmatter" if external_id != relative else "path",
        "filename": path.name,
        "folder": str(Path(relative).parent.as_posix()),
        "modified_at": datetime.fromtimestamp(
            stat.st_mtime, tz=timezone.utc
        ).isoformat(),
        "bytes": stat.st_size,
    }
    if realm is not None:
        ingest_meta["realm"] = realm
    canonical_body = embedding_body(body, frontmatter)
    if canonical_body is not None:
        ingest_meta["embedding_view"] = "session-v1"
        ingest_meta["raw_body_hash"] = content_hash(body)

    # `retrievals` becomes rag.retrieval_events rows and stays out of metadata,
    # which rag.search returns with every hit. `retrieved` stays: it is links.
    kept = {key: value for key, value in frontmatter.items() if key != RETRIEVALS_KEY}
    metadata = {**json_safe(kept), "_ingest": ingest_meta}
    return SourceDocument(
        source=SOURCE_OBSIDIAN,
        external_id=external_id,
        body=body,
        title=_derive_title(frontmatter, body, path),
        agent=_derive_agent(frontmatter),
        collection=collection,
        metadata=metadata,
        retrievals=retrievals,
        embedding_body=canonical_body,
    )


def _parse_retrievals(
    frontmatter: dict,
    relative: str,
    external_id: str,
    collection: str | None,
    realm: str | None,
) -> tuple[RetrievalEvent, ...]:
    """The note's retrieval events. A malformed entry is logged and dropped, never fatal."""
    if RETRIEVALS_KEY not in frontmatter:
        return ()
    events, warnings = parse_retrievals(
        frontmatter[RETRIEVALS_KEY],
        note_external_id=external_id,
        session_fields=session_fields_from(frontmatter, collection=collection, realm=realm),
    )
    for warning in warnings:
        log.warning("%s: %s", relative, warning)
    return tuple(events)


def _wants_ingest(frontmatter: dict) -> bool:
    """``ingest: false`` opts a note out. Absent, or ``true``, ingests.

    YAML 1.1 already turns unquoted ``no``/``off``/``yes``/``on`` into booleans
    before this code sees them. Beyond that only the ints ``0``/``1`` and the
    quoted strings ``'true'``/``'false'`` are accepted — common hand-typed forms.
    Anything else (a list, a mapping, an empty string, ``2``) is a typo, not a
    preference, and fails rather than being guessed at.
    """
    raw = frontmatter.get(INGEST_KEY)
    if raw is None:
        return True
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, int) and raw in (0, 1):
        return bool(raw)
    if isinstance(raw, str) and raw.strip().lower() in ("true", "false"):
        return raw.strip().lower() == "true"
    raise SourceError(
        f"frontmatter '{INGEST_KEY}' must be true or false, got {raw!r} "
        f"(accepted: true/false, yes/no, on/off, 1/0, or the quoted strings 'true'/'false')"
    )


def _derive_agent(frontmatter: dict) -> str:
    """Keep known provenance without inventing a runtime for unknown authors."""
    for key in ("agent", "runtime"):
        candidate = frontmatter.get(key)
        if isinstance(candidate, str) and re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", candidate):
            return candidate
    return "unknown"


def _derive_collection(frontmatter: dict, relative: str) -> str | None:
    """Which project or class this note belongs to.

    The vault is laid out ``<area>/<collection>/...`` for each of AREA_FOLDERS
    (``projects/<name>``, ``classes/<code>``, ``harness/<name>``), so the second
    path segment is the collection. Frontmatter ``collection:`` wins
    when present, which is the escape hatch for notes that live somewhere the
    folder structure does not describe.

    Returns ``None`` for a note at the vault root rather than inventing a name —
    an unfiltered document is honest; a wrongly-labelled one is not.
    """
    explicit = frontmatter.get("collection")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()

    parts = [p for p in relative.split("/") if p]
    if len(parts) < 2:
        return None
    if parts[0] in AREA_FOLDERS and len(parts) >= 3:
        return parts[1]
    return parts[0]


def split_frontmatter(raw: str, external_id: str = "<note>") -> tuple[dict, str]:
    """Return ``(frontmatter, body)``.

    Delegates to ``python-frontmatter``. A note whose YAML is malformed raises —
    it is a real error the user should fix, not something to paper over — but the
    caller downgrades it to a skip so one bad note cannot abort a vault ingest.
    """
    if not isinstance(raw, str):
        raise TypeError(f"raw must be str, got {type(raw).__name__}")

    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    if not text.lstrip().startswith("---"):
        return {}, text

    try:
        import frontmatter as fm
    except ImportError as exc:  # pragma: no cover - install-time problem
        raise SourceError("python-frontmatter is not installed; run `uv sync`") from exc

    try:
        post = fm.loads(text)
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
        raise SourceError(f"malformed YAML frontmatter ({exc})") from exc

    metadata = dict(post.metadata) if isinstance(post.metadata, dict) else {}
    return metadata, post.content


def _derive_external_id(frontmatter: dict, relative: str) -> str:
    """Frontmatter ``id:`` wins over the path, if it is a usable scalar.

    A missing or blank ``id:`` falls back to the path rather than failing —
    adding an id later is a legitimate migration, and refusing the note would
    lose content over a formatting detail. A *structurally* wrong id (a list, a
    mapping, a multi-line block) is a real mistake and does fail.
    """
    raw = frontmatter.get(ID_KEY)
    if raw is None:
        return relative
    if isinstance(raw, bool) or isinstance(raw, (list, dict, set, tuple)):
        raise SourceError(f"frontmatter '{ID_KEY}' must be a scalar, got {type(raw).__name__}")

    text = str(raw).strip()
    if not text:
        return relative
    if len(text) > MAX_ID_LENGTH:
        raise SourceError(f"frontmatter '{ID_KEY}' is longer than {MAX_ID_LENGTH} characters")
    if any(char in text for char in "\r\n\t"):
        raise SourceError(f"frontmatter '{ID_KEY}' contains a line break or tab")
    return text


def _derive_title(frontmatter: dict, body: str, path: Path) -> str:
    """Frontmatter ``title`` wins, then the first H1, then the filename."""
    candidate = frontmatter.get("title")
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()

    match = _H1.search(body)
    if match:
        return match.group(1).strip()

    return path.stem
