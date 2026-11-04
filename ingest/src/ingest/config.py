"""Central configuration for the RAG ingestion pipeline.

Everything that a future model swap would have to touch lives in ``EMBEDDING``.
Changing the model is one edit here plus a re-embed (``ingest --force``) — the
rest of the pipeline reads the name and dimension from this object.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from .errors import ConfigError

# --------------------------------------------------------------------------
# Embeddings
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class EmbeddingConfig:
    """The one place the embedding model is named.

    ``max_input_tokens`` is the model's own sequence limit. fastembed silently
    truncates beyond it, so the chunker must stay under it — see CHUNKING below.
    """

    model_name: str
    dimensions: int
    max_input_tokens: int


# BAAI/bge-small-en-v1.5: 384 dims, 512-token window, runs locally on CPU via
# ONNX. Matches `rag.chunks.embedding extensions.vector(384)`.
EMBEDDING = EmbeddingConfig(
    model_name="BAAI/bge-small-en-v1.5",
    dimensions=384,
    max_input_tokens=512,
)


ENV_MODEL_CACHE_DIR = "FASTEMBED_CACHE_DIR"


def embedding_cache_dir(env: dict[str, str] | None = None) -> str:
    """Where the ONNX weights live.

    fastembed's own default is the system temp directory, which Windows is free
    to clean out — that would silently re-download 130 MB on some future run. So
    the default is pinned under the user's home cache instead.

    It must stay OUT of OneDrive: binary indexes plus OneDrive sync have already
    caused file-lock failures in this project (see CONTEXT.md).
    """
    source = os.environ if env is None else env
    override = _clean(source.get(ENV_MODEL_CACHE_DIR))
    if override:
        return override
    return str(Path.home() / ".cache" / "fastembed")


# --------------------------------------------------------------------------
# Chunking
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ChunkConfig:
    """Token budgets for the markdown chunker.

    Rationale for the defaults:

    * ``target_tokens=384`` — bge-small accepts 512 tokens. Leaving ~25% headroom
      means a chunk can pick up a heading breadcrumb and a carried-over overlap
      block without tipping into silent truncation by the tokenizer.
    * ``overlap_tokens=64`` — one sixth of a chunk. Enough that a sentence split
      across a boundary is retrievable from either side, small enough that
      storage and embedding cost only rise ~17%.
    * ``min_tokens=32`` — chunks shorter than this are merged into their
      neighbour. Sub-30-token fragments (a lone heading, a one-line list item)
      embed to near-noise and pollute the top-k.
    * ``hard_max_tokens=480`` — absolute ceiling after breadcrumb + overlap are
      added. Still under 512, so nothing is ever truncated by the model.
    """

    target_tokens: int = 384
    overlap_tokens: int = 64
    min_tokens: int = 32
    hard_max_tokens: int = 480
    # Prefix each chunk with its markdown heading path ("Guide > Setup").
    # Cheap, and it keeps a chunk interpretable once it is torn out of its file.
    include_heading_breadcrumb: bool = True


CHUNKING = ChunkConfig()


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------

RAG_SCHEMA = "rag"
DOCUMENTS_TABLE = f"{RAG_SCHEMA}.documents"
CHUNKS_TABLE = f"{RAG_SCHEMA}.chunks"

# `rag.chunks.embedding` is typed `extensions.vector(384)`, so inserts must cast
# to the same qualified type.
VECTOR_TYPE = "extensions.vector"

SOURCE_OBSIDIAN = "obsidian"
SOURCE_CLAUDE_MEM = "claude-mem"
# Attribution of the retired claude-mem corpus only. Unknown vault authorship
# is handled separately and must never inherit this historical provenance.
DEFAULT_AGENT = "claude-code"

# --------------------------------------------------------------------------
# What is worth indexing
# --------------------------------------------------------------------------

# A raw claude-mem prompt shorter than this is a fragment — "yes", a project
# name, a pasted path. A fragment embeds close to anything sharing a word with it
# (a bare "quant-edge-tracker" scored 0.83 against a question about that project,
# above every real document), so it is left out of the index. Observations and
# summaries are model-written prose and are not subject to it.
MIN_PROMPT_CHARS = 80

# Historical origin grouping for inventory counts only. SDK provenance is not
# an eligibility rule; all runtimes use explicit memory policy metadata.
SDK_ORIGIN_PREFIX = "sdk"

# --------------------------------------------------------------------------
# Realms: which git repo of notes a document belongs to
# --------------------------------------------------------------------------

# `HARNESS_REALMS=projects:push,classes:local,work-vm:push` — the realms this
# machine may hold, each with its sync policy. The loader refuses a realm that
# is on disk but not listed: a realm cloned by mistake must never enter this
# machine's store. The policy is consumed by the sync script, not by ingest.
ENV_REALMS = "HARNESS_REALMS"
REALM_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
REALM_POLICIES = frozenset({"push", "local"})


def parse_realm_policies(raw: str | None) -> dict[str, str] | None:
    """``name:policy`` pairs, or None when the variable is unset or blank."""
    if raw is None or not raw.strip():
        return None
    policies: dict[str, str] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        name, separator, policy = entry.partition(":")
        name, policy = name.strip(), policy.strip()
        if not separator or not REALM_NAME.match(name) or policy not in REALM_POLICIES:
            raise ConfigError(
                f"{ENV_REALMS}: '{entry}' is not <realm>:<push|local>; realm names are "
                "lowercase letters, digits and dashes"
            )
        if name in policies:
            raise ConfigError(f"{ENV_REALMS}: realm '{name}' is listed twice")
        policies[name] = policy
    return policies or None


# Canonical env var names. These are the names actually on disk in the repo's
# .env — see CONTEXT.md "Credentials".
ENV_DATABASE_URL = "DATABASE_URL"
ENV_SUPABASE_URL = "SUPABASE_URL"
ENV_SUPABASE_SERVICE_ROLE = "SUPABASE_SERVICE_ROLE"
# Older name, accepted so a stale shell does not fail confusingly.
ENV_SUPABASE_SERVICE_ROLE_LEGACY = "SUPABASE_SERVICE_KEY"
# Pinned Supabase root CA. Same name as the MCP server; libpq's own name is
# accepted as a fallback so one .env serves both.
ENV_DATABASE_CA_CERT = "DATABASE_CA_CERT"
ENV_PGSSLROOTCERT = "PGSSLROOTCERT"
# `disable` turns TLS off — for a local Postgres only. There is deliberately no
# "prefer" or "no-verify" option: those downgrade silently.
ENV_DATABASE_SSL = "DATABASE_SSL"


@dataclass(frozen=True)
class DbSettings:
    """Connection details, read from the environment. Never hardcoded.

    Writes go over ``DATABASE_URL`` (direct Postgres via psycopg). PostgREST is
    deliberately not an option: the ``rag`` schema is not exposed on ``bb2dash``'s
    REST surface (PGRST106) and will not be. ``SUPABASE_URL`` /
    ``SUPABASE_SERVICE_ROLE`` are carried here only so one env file serves this
    pipeline and the MCP server; this package never sends them anywhere.
    """

    database_url: str | None
    supabase_url: str | None
    supabase_service_role: str | None
    # Absolute path to the pinned root CA. Required unless ``ssl_disabled``:
    # Supabase signs with its own CA, which no default trust store carries, and
    # the connection must verify (``sslmode=verify-full``) rather than fall back.
    ssl_root_cert: str | None = None
    ssl_disabled: bool = False

    @property
    def can_connect(self) -> bool:
        return bool(self.database_url)

    def redacted(self) -> dict[str, str]:
        """Presence report safe to print. Never returns a secret value."""
        if self.ssl_disabled:
            tls = "DISABLED (DATABASE_SSL=disable — local Postgres only)"
        elif self.ssl_root_cert:
            tls = f"verify-full against {self.ssl_root_cert}"
        else:
            tls = "missing — required (sslmode=verify-full)"
        return {
            ENV_DATABASE_URL: "set" if self.database_url else "missing",
            ENV_DATABASE_CA_CERT: tls,
            ENV_SUPABASE_URL: self.supabase_url or "missing",
            ENV_SUPABASE_SERVICE_ROLE: "set" if self.supabase_service_role else "missing",
        }


def load_db_settings(env: dict[str, str] | None = None) -> DbSettings:
    """Read connection details from the environment.

    Accepts an explicit mapping so tests never touch the real process env.
    """
    source = os.environ if env is None else env
    service_role = _clean(source.get(ENV_SUPABASE_SERVICE_ROLE)) or _clean(
        source.get(ENV_SUPABASE_SERVICE_ROLE_LEGACY)
    )
    ca_path = _clean(source.get(ENV_DATABASE_CA_CERT)) or _clean(source.get(ENV_PGSSLROOTCERT))
    ssl_setting = (_clean(source.get(ENV_DATABASE_SSL)) or "").lower()
    return DbSettings(
        database_url=_clean(source.get(ENV_DATABASE_URL)),
        supabase_url=_clean(source.get(ENV_SUPABASE_URL)),
        supabase_service_role=service_role,
        # Resolved now, against the cwd, so a relative path in .env does not
        # silently mean something else once the store is constructed elsewhere.
        ssl_root_cert=str(Path(ca_path).resolve()) if ca_path else None,
        ssl_disabled=ssl_setting in {"disable", "off", "false", "0"},
    )


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None
