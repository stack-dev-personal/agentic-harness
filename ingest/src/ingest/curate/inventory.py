"""R-C1: a deterministic inventory and timeline of every collection in the vault.

Per collection (``<realm-folder>/<collection>/``): main sessions in date order
with their subagents nested beneath, notes/ and decisions/ notes, the plan
sources from the hub profile, and optional git facts. Read-only.

The inventory keeps ``origin: sdk-*`` session notes as ordinary provenance;
the origin never establishes whether a session is eligible for memory.

What it leaves out, each with a reason and never silently:

* the hub itself (it is the profile, not a note);
* curator-written notes (``captured_by: curator``, SC-4) — the curator must
  never read its own output back as evidence;
* anything under ``materials/``, ``templates/`` or a tool folder (``excluded``);
* a file without frontmatter, with malformed YAML, or unreadable (``skipped``).

``counts.raw_session_files`` is an independent plain glob of
``sessions/*.md``; R-C1 is done when main sessions plus subagents equal it for
every collection.
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..config import SDK_ORIGIN_PREFIX
from ..errors import ConfigError, IngestError, SourceError
from ..loaders.obsidian import SKIP_DIRECTORIES, discover_realms, vault_root
from .note_records import (
    ROLE_DECISION,
    ROLE_NOTE,
    ROLE_SESSION,
    ROLE_SUBAGENT,
    SESSIONS_DIR,
    NoteRecord,
    SkippedNote,
    walk_collection,
)
from .profile import (
    CollectionProfile,
    Runner,
    SessionHint,
    build_profile,
    check_collection_name,
    default_runner,
    hub_file,
)

__all__ = [
    "ROLE_DECISION", "ROLE_NOTE", "ROLE_SESSION", "ROLE_SUBAGENT", "NoteRecord", "SkippedNote",
    "SessionGroup", "OrphanGroup", "InventoryCounts", "Inventory", "VaultInventory", "build_inventory",
]

log = logging.getLogger(__name__)

# Top-level folders holding collections when the vault is one realm, or has none.
LEGACY_PARENTS = ("projects", "classes")

NOT_A_COLLECTION = "not a collection (no hub note and no sessions/)"
NAME_NOT_ALLOWED = "collection name not allowed"

# Hub fields a hub should set rather than leave to a fallback; one warning per
# missing field, which the L7 pre-flight reads. ``repo`` is not among them.
EXPECTED_HUB_FIELDS = ("kind", "plan_sources", "repo_path")

# (repo_path, repo_slug) -> GitFacts. gitfacts.collect_git_facts, bound to its runner.
GitCollector = Callable[[Path | None, str | None], Any]


@dataclass(frozen=True)
class SessionGroup:
    session: NoteRecord
    subagents: tuple[NoteRecord, ...]


@dataclass(frozen=True)
class OrphanGroup:
    """Subagents whose parent session note is not in this collection."""

    parent_session_id: str
    subagents: tuple[NoteRecord, ...]


@dataclass(frozen=True)
class InventoryCounts:
    main_sessions: int
    subagents: int
    sdk_notes: int
    notes: int
    decisions: int
    skipped: int
    excluded: int
    raw_session_files: int

    @property
    def session_notes(self) -> int:
        return self.main_sessions + self.subagents

    @property
    def matches(self) -> bool:
        return self.session_notes == self.raw_session_files


@dataclass(frozen=True)
class Inventory:
    folder: str  # the collection folder, vault-relative posix
    profile: CollectionProfile
    sessions: tuple[SessionGroup, ...]
    orphans: tuple[OrphanGroup, ...]
    notes: tuple[NoteRecord, ...]
    decisions: tuple[NoteRecord, ...]
    skipped: tuple[SkippedNote, ...]
    excluded: tuple[SkippedNote, ...]
    git: Any  # GitFacts | None
    counts: InventoryCounts
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class VaultInventory:
    root: str
    collections: tuple[Inventory, ...]
    ignored: tuple[SkippedNote, ...] = ()
    errors: tuple[SkippedNote, ...] = ()  # a collection whose profile could not be read

    @property
    def mismatched(self) -> tuple[Inventory, ...]:
        return tuple(inv for inv in self.collections if not inv.counts.matches)


@dataclass(frozen=True)
class _CollectionDir:
    realm: str | None
    realm_folder: str
    name: str
    path: Path


def build_inventory(
    vault_path: str | Path,
    *,
    realm: str | None = None,
    collection: str | None = None,
    git_collector: GitCollector | None = None,
    runner: Runner = default_runner,
) -> VaultInventory:
    """Inventory every collection, or those the filters name.

    ``git_collector`` is None for no git facts (``--no-git``). A filter naming
    nothing raises ConfigError; a vault that cannot be read raises SourceError.
    A hub that cannot be read is an error for its collection only.
    """
    if collection is not None:
        check_collection_name(collection)
    root = vault_root(vault_path)
    found, ignored = _discover(root)
    selected = _select(found, realm, collection)

    inventories: list[Inventory] = []
    errors: list[SkippedNote] = []
    for target in selected:
        relative = target.path.relative_to(root).as_posix()
        try:
            inventories.append(_inventory_one(root, target, git_collector, runner))
        except SourceError as exc:
            log.error("%s: %s", relative, exc)
            errors.append(SkippedNote(relative, str(exc)))
    return VaultInventory(root.as_posix(), tuple(inventories), tuple(ignored), tuple(errors))


# -- discovery ---------------------------------------------------------------------------


def _parents(root: Path) -> list[tuple[Path, str | None, str]]:
    """(folder, realm name, realm folder) for every folder that holds collections."""
    realms = discover_realms(root)
    if realms and "" not in realms:
        return [(root / folder, name, folder) for folder, name in sorted(realms.items())]
    realm = realms.get("")
    return [(root / folder, realm, folder) for folder in LEGACY_PARENTS if (root / folder).is_dir()]


def _discover(root: Path) -> tuple[list[_CollectionDir], list[SkippedNote]]:
    found: list[_CollectionDir] = []
    ignored: list[SkippedNote] = []
    for parent, realm, realm_folder in _parents(root):
        for child in sorted(parent.iterdir()):
            if not child.is_dir() or child.name.startswith(".") or child.name in SKIP_DIRECTORIES:
                continue
            relative = child.relative_to(root).as_posix()
            if not hub_file(child).is_file() and not (child / SESSIONS_DIR).is_dir():
                ignored.append(SkippedNote(relative, NOT_A_COLLECTION))
            elif not _allowed(child.name):
                log.warning("Refusing %s: %s", relative, NAME_NOT_ALLOWED)
                ignored.append(SkippedNote(relative, NAME_NOT_ALLOWED))
            else:
                found.append(_CollectionDir(realm, realm_folder, child.name, child))
    return found, ignored


def _allowed(name: str) -> bool:
    try:
        check_collection_name(name)
    except ConfigError:
        return False
    return True


def _select(found: list[_CollectionDir], realm: str | None, collection: str | None) -> list[_CollectionDir]:
    selected = found
    if realm is not None:
        selected = [c for c in selected if realm in (c.realm, c.realm_folder)]
        if not selected:
            raise ConfigError(f"no realm '{realm}' with collections in this vault")
    if collection is not None:
        selected = [c for c in selected if c.name == collection]
        if not selected:
            raise ConfigError(f"no collection '{collection}' in this vault")
    return selected


# -- one collection ----------------------------------------------------------------------


def _inventory_one(
    root: Path, target: _CollectionDir, git_collector: GitCollector | None, runner: Runner
) -> Inventory:
    walked = walk_collection(root, target.path, target.realm, target.name)
    session_records = [r for r in walked.records if r.role in (ROLE_SESSION, ROLE_SUBAGENT)]
    hints = [SessionHint(cwd=r.cwd, repo=r.repo) for r in session_records]
    profile = build_profile(
        vault=root, realm=target.realm, realm_folder=target.realm_folder, collection=target.name,
        collection_dir=target.path, hints=hints, runner=runner,
    )
    warnings = list(_profile_warnings(profile))
    git = _git_facts(profile, git_collector, warnings)

    groups, orphans = _timeline(session_records)
    notes = _ordered(r for r in walked.records if r.role == ROLE_NOTE)
    decisions = _ordered(r for r in walked.records if r.role == ROLE_DECISION)
    counts = InventoryCounts(
        main_sessions=len(groups),
        subagents=sum(len(g.subagents) for g in groups) + sum(len(o.subagents) for o in orphans),
        sdk_notes=sum(1 for r in session_records if (r.origin or "").startswith(SDK_ORIGIN_PREFIX)),
        notes=len(notes),
        decisions=len(decisions),
        skipped=len(walked.skipped),
        excluded=len(walked.excluded),
        raw_session_files=_raw_session_files(target.path),
    )
    return Inventory(
        folder=target.path.relative_to(root).as_posix(), profile=profile, sessions=groups, orphans=orphans, notes=notes, decisions=decisions,
        skipped=walked.skipped, excluded=walked.excluded, git=git, counts=counts, warnings=tuple(warnings),
    )


def _raw_session_files(collection_dir: Path) -> int:
    """The vault's own count, by a plain glob that shares no code with the walk."""
    sessions = collection_dir / SESSIONS_DIR
    return sum(1 for path in sessions.glob("*.md") if path.is_file()) if sessions.is_dir() else 0


def _profile_warnings(profile: CollectionProfile):
    for source in profile.plan_sources:
        if not source.exists:
            yield f"plan source not found: {source.given}"
    if profile.repo_path is not None and not Path(profile.repo_path).is_dir():
        yield f"repo_path does not exist: {profile.repo_path}"
    if profile.hub_path is not None:
        for name in EXPECTED_HUB_FIELDS:
            if name not in profile.explicit:
                yield f"hub does not set {name} explicitly"


def _git_facts(profile: CollectionProfile, git_collector: GitCollector | None, warnings: list[str]) -> Any:
    if git_collector is None or (profile.repo_path is None and profile.repo is None):
        return None
    repo_path = Path(profile.repo_path) if profile.repo_path else None
    try:
        return git_collector(repo_path, profile.repo)
    except (IngestError, OSError) as exc:
        message = f"git facts unavailable: {exc}"
    except Exception as exc:  # noqa: BLE001 - a collector bug must not sink the whole inventory
        message = f"git facts unavailable: {type(exc).__name__}: {exc}"
    log.warning("%s/%s: %s", profile.realm, profile.collection, message)
    warnings.append(message)
    return None


def _sort_key(record: NoteRecord) -> tuple[bool, str, str]:
    """Date order, undated last, ties by path."""
    return (record.date is None, record.date or "", record.path)


def _ordered(records) -> tuple[NoteRecord, ...]:
    return tuple(sorted(records, key=_sort_key))


def _timeline(records: list[NoteRecord]) -> tuple[tuple[SessionGroup, ...], tuple[OrphanGroup, ...]]:
    mains = _ordered(r for r in records if r.role == ROLE_SESSION)
    subagents = _ordered(r for r in records if r.role == ROLE_SUBAGENT)

    owner: dict[str, int] = {}
    for index, main in enumerate(mains):
        if main.session_id and main.session_id not in owner:
            owner[main.session_id] = index
    duplicates = [sid for sid, n in Counter(m.session_id for m in mains if m.session_id).items() if n > 1]
    if duplicates:
        log.info("Session ids shared by more than one main note (subagents go to the earliest): %s", duplicates)

    children: dict[int, list[NoteRecord]] = {index: [] for index in range(len(mains))}
    orphans: dict[str, list[NoteRecord]] = {}
    for sub in subagents:
        parent = sub.parent_session_id or ""
        if parent in owner:
            children[owner[parent]].append(sub)
        else:
            orphans.setdefault(parent, []).append(sub)

    groups = tuple(SessionGroup(main, tuple(children[i])) for i, main in enumerate(mains))
    orphan_groups = tuple(OrphanGroup(parent, tuple(subs)) for parent, subs in orphans.items())
    return groups, orphan_groups
