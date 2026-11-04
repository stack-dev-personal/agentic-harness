"""Orphan sweep.

After a *complete* ingest of one source, any ``external_id`` still in
``rag.documents`` that the loader did not produce is an orphan — a deleted note,
or a note renamed while it had no stable frontmatter ``id:``.

This is the only destructive operation in the package, so it is off by default
and refuses to run unless the sweep can be trusted:

* the run must have been a full pass — ``--limit`` truncates the seen set, so a
  sweep after one would delete most of the corpus;
* no document may have failed — a failure means the seen set is incomplete;
* the loader must have produced something — an empty vault (a mistyped path, an
  unmounted OneDrive folder) would otherwise wipe the source.

A row written after the walk began is never an orphan, however the run ends: it
belongs to a note captured while the run embedded (a SessionEnd hook ingests its
own note at once), which the walk had no chance to see. ``written_before`` holds
that cutoff: the database's own clock, read before the walk, because
``updated_at`` is stamped by that clock. Both the listing and the delete test it,
so a row rewritten between the two statements is kept. Such rows are reported as
spared; the next run sees their notes.

Each guard reports why it declined. Nothing is ever deleted silently.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from .store import ChunkStore

log = logging.getLogger(__name__)


def owned_by(metadata: dict, machine: str | None) -> bool:
    """Is a row this machine's to sweep? The rule behind ``store.OWN_MACHINE_CLAUSE``.

    No scope (``machine=None``) owns everything, as before machines existed. A
    row whose note carries no ``machine:``, or an empty one (the hooks write
    ``machine: ''`` when ``HARNESS_MACHINE`` is unset), belongs to whoever holds
    the realm. A row naming another machine is that machine's.
    """
    if machine is None:
        return True
    return metadata.get("machine") in (None, "", machine)


@dataclass(frozen=True)
class PruneResult:
    """What the sweep found and whether it acted."""

    source: str
    #: The realm swept, or None for the rows written before realms existed.
    realm: str | None = None
    orphans: tuple[str, ...] = ()
    #: Unseen rows written after the cutoff: notes captured during the run, kept.
    spared: tuple[str, ...] = ()
    deleted: int = 0
    performed: bool = False
    declined_reason: str | None = None

    @property
    def declined(self) -> bool:
        return self.declined_reason is not None


def prune_orphans(
    store: ChunkStore,
    source: str,
    seen_external_ids: Iterable[str],
    *,
    dry_run: bool = False,
    document_count: int = 0,
    failure_count: int = 0,
    limited: bool = False,
    realm: str | None = None,
    written_before: datetime | None = None,
    machine: str | None = None,
) -> PruneResult:
    """Delete documents of ``source`` inside ``realm`` whose ``external_id`` was not seen.

    One call per realm the loader walked. A realm this machine holds no clone of
    is never listed, so two vaults sharing one store cannot prune each other.
    ``realm=None`` sweeps only the rows written before realms existed.
    ``written_before`` keeps every row written at or after it (see the module doc).
    ``machine`` keeps every row whose note names another machine: two clones of
    one realm that have not synced yet hold different notes, and the other
    machine's sessions are not this walk's orphans. The CLI always passes it.
    """
    label = f"{source}/{realm or 'legacy'}"
    declined = _decline_reason(document_count, failure_count, limited)
    if declined:
        log.warning("Skipping orphan sweep for %s: %s", label, declined)
        return PruneResult(source=source, realm=realm, declined_reason=declined)

    seen = {str(value) for value in seen_external_ids}
    unseen = store.list_external_ids(source, realm=realm, machine=machine) - seen
    if written_before is None:
        orphans = tuple(sorted(unseen))
    else:
        orphans = tuple(sorted(
            store.list_external_ids(source, realm=realm, written_before=written_before, machine=machine) & unseen
        ))
    spared = tuple(sorted(unseen - set(orphans)))
    if spared:
        log.info("Orphan sweep for %s kept %d row(s) written during this run", label, len(spared))

    if not orphans:
        return PruneResult(source=source, realm=realm, spared=spared, performed=not dry_run)
    if dry_run:
        return PruneResult(source=source, realm=realm, orphans=orphans, spared=spared, performed=False)

    deleted = store.delete_documents(
        source, orphans, realm=realm, written_before=written_before, machine=machine
    )
    if written_before is not None and deleted < len(orphans):
        # The delete's own cutoff test kept rows rewritten since the listing.
        kept = store.list_external_ids(source, realm=realm, machine=machine) & set(orphans)
        orphans = tuple(sorted(set(orphans) - kept))
        spared = tuple(sorted(set(spared) | kept))
    log.info("Orphan sweep removed %d document(s) from %s", deleted, label)
    return PruneResult(
        source=source, realm=realm, orphans=orphans, spared=spared, deleted=deleted, performed=True
    )


def _decline_reason(document_count: int, failure_count: int, limited: bool) -> str | None:
    if limited:
        return "--limit was used, so the seen set is not a complete pass"
    if failure_count:
        return f"{failure_count} document(s) failed, so the seen set is incomplete"
    if document_count == 0:
        return "the loader produced no documents; refusing to empty the source"
    return None
