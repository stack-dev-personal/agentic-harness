"""Runtime provenance cannot change memory eligibility or embedding inputs."""

from dataclasses import replace

import pytest

from ingest.loaders.obsidian import load_vault, load_vault_notes
from ingest.pipeline import Action
from test_pipeline import pipeline


def session_note(runtime, *, extra="", prompt="Explain the shared index."):
    body = f"""# 2026-11-03 · demo · Explain the shared index

Working directory `/{runtime}/project`. Ran 2m, 1 prompt, 1 shell command, 0 files touched. Ended: other.

## What I asked for

1. {prompt}

## Commands run

1 shell invocation. Sample:

- git status

## Outcome

> Every client searches the same index.

## Session facts

| Field | Value |
| --- | --- |
| Session id | `{runtime}-123` |
| Status | concluded |
| Transcript | `/{runtime}/transcript.jsonl` |
| Machine | `{runtime}-machine` |

---

_Generated mechanically by `session-capture.mjs` at session end — extracted, not summarised. Tool output is never copied; prompts and commands are redacted for secrets._

Handwritten shared context survives.
"""
    return f"---\ntype: session\nschema_version: 2\nid: session-{runtime}-123\ntitle: {runtime} session results\nagent: {runtime}\nruntime: {runtime}\nmodel: model-{runtime}\nprovider: provider-{runtime}\ngenerator: session-capture.mjs 2.4.0\n{extra}---\n\n{body}"


def load_note(root, runtime, **kwargs):
    note = root / f"{runtime}.md"
    note.write_text(session_note(runtime, **kwargs), encoding="utf-8")
    return load_vault_notes(root, [note]).documents[0]


def test_equivalent_session_notes_have_identical_embedding_content_and_chunks(tmp_path, fake_store, fake_embedder):
    docs = [load_note(tmp_path, runtime) for runtime in ("claude-code", "codex", "hermes")]
    assert len({d.embedding_body for d in docs}) == 1
    assert len({d.body for d in docs}) == 3, "raw bodies retain their provenance"
    assert "Handwritten shared context survives." in docs[0].embedding_body
    pipeline(fake_store, fake_embedder).run(docs)
    assert fake_embedder.calls[0] == fake_embedder.calls[1] == fake_embedder.calls[2]
    assert all(d.metadata["runtime"] == d.agent for d in docs)


def test_provenance_only_body_edits_refresh_raw_body_without_reembedding(tmp_path, fake_store, fake_embedder):
    first = load_note(tmp_path, "codex")
    pipeline(fake_store, fake_embedder).run([first])
    changed = load_note(tmp_path, "hermes")
    changed = replace(changed, external_id=first.external_id)
    stats = pipeline(fake_store, fake_embedder).run([changed])
    assert stats.count(Action.METADATA_UPDATED) == 1
    assert len(fake_embedder.calls) == 1
    assert fake_store.bodies[(changed.source, changed.external_id)] == changed.body


def test_sdk_origin_does_not_exclude_meaningful_work(tmp_path):
    doc = load_note(tmp_path, "claude-code", extra="origin: sdk-py\n")
    assert doc.agent == "claude-code"


@pytest.mark.parametrize("runtime", ["claude-code", "codex", "hermes"])
@pytest.mark.parametrize("policy", ["purpose: observer\n", "purpose: housekeeping\n", "memory_excluded: true\n", "classification: TLP:AMBER\n", "data_classification: restricted\n", "restricted: true\n", "persistence: exclude\n"])
def test_policy_exclusions_are_identical_for_every_runtime(tmp_path, runtime, policy):
    (tmp_path / f"{runtime}.md").write_text(session_note(runtime, extra=policy), encoding="utf-8")
    result = load_vault(tmp_path)
    assert not result.documents
    assert len(result.skipped) == 1


def test_unknown_authorship_is_not_attributed_to_claude(tmp_path):
    (tmp_path / "note.md").write_text("# Ordinary note\n\nUseful prose.\n", encoding="utf-8")
    assert load_vault(tmp_path).documents[0].agent == "unknown"


def test_unrecognized_session_prose_is_not_stripped(tmp_path):
    raw = "# Journal\n\nSession facts are important prose, not a generated section.\n"
    (tmp_path / "note.md").write_text("---\ntype: session\n---\n" + raw, encoding="utf-8")
    doc = load_vault(tmp_path).documents[0]
    assert doc.embedding_body is None
    assert doc.body.strip() == raw.strip()


def test_lifecycle_only_edits_update_facts_without_reembedding(tmp_path, fake_store, fake_embedder):
    first = load_note(tmp_path, "codex", extra="status: active\n")
    pipeline(fake_store, fake_embedder).run([first])
    note = tmp_path / "codex.md"
    note.write_text(note.read_text(encoding="utf-8").replace("status: active", "status: concluded").replace("| Status | concluded |", "| Status | superseded |"), encoding="utf-8")
    changed = load_vault_notes(tmp_path, [note]).documents[0]
    stats = pipeline(fake_store, fake_embedder).run([changed])
    assert stats.count(Action.METADATA_UPDATED) == 1
    assert len(fake_embedder.calls) == 1
    assert "superseded" in fake_store.bodies[(changed.source, changed.external_id)]
    assert fake_store.documents[(changed.source, changed.external_id)].metadata["status"] == "concluded"


def test_runtime_names_in_human_prose_are_meaningful_content(tmp_path):
    doc = load_note(tmp_path, "codex", prompt="Compare Claude, Codex, and Hermes models.")
    assert "Compare Claude, Codex, and Hermes models." in doc.embedding_body


@pytest.mark.parametrize("extra,body", [
    ("", "## What I asked for\n\nManually authored session.\n"),
    ("generator: session-capture.mjs 2.4.0\n", "# Journal\n\nManually authored session.\n"),
])
def test_schema_alone_cannot_make_arbitrary_prose_generated(tmp_path, extra, body):
    (tmp_path / "manual.md").write_text(f"---\ntype: session\nschema_version: 2\n{extra}---\n\n{body}", encoding="utf-8")
    doc = load_vault(tmp_path).documents[0]
    assert doc.embedding_body is None
    assert doc.body.strip() == body.strip()


@pytest.mark.parametrize("runtime", ["claude-code", "codex", "hermes"])
@pytest.mark.parametrize("policy", [
    "classification: TLP:AMBER+STRICT\n",
    "data_classification: TLP:AMBER+STRICT\n",
    "classification: public\ndata_classification: TLP:AMBER+STRICT\n",
    "classification: TLP:AMBER+STRICT\ndata_classification: public\n",
])
def test_strict_amber_is_excluded_without_other_field_masking(tmp_path, runtime, policy):
    (tmp_path / f"{runtime}.md").write_text(session_note(runtime, extra=policy), encoding="utf-8")
    result = load_vault(tmp_path)
    assert not result.documents
    assert len(result.skipped) == 1
    assert result.skipped[0].reason == "memory policy: restricted classification"


@pytest.mark.parametrize("field", ["classification", "data_classification"])
@pytest.mark.parametrize("value", ["[private-value]", "{private-value: true}", "42", "true", "null"])
def test_malformed_classification_fails_closed_without_leaking_value(tmp_path, field, value):
    (tmp_path / "bad.md").write_text(session_note("codex", extra=f"{field}: {value}\n"), encoding="utf-8")
    result = load_vault(tmp_path)
    assert not result.documents
    assert len(result.skipped) == 1
    assert "invalid classification metadata" in result.skipped[0].reason
    assert "private-value" not in result.skipped[0].reason


def test_disabled_memory_blocks_library_pipeline_before_consuming_content(monkeypatch, fake_store, fake_embedder):
    from ingest.errors import IngestError
    monkeypatch.setenv("HARNESS_MEMORY_PERSISTENCE", "off")
    def forbidden_content():
        raise AssertionError("disabled pipeline consumed content")
        yield
    with pytest.raises(IngestError, match="memory persistence disabled"):
        pipeline(fake_store, fake_embedder).run(forbidden_content())
    assert fake_store.lookup_calls == 0
    assert fake_embedder.calls == []
