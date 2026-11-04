/**
 * A later capture merged into an `-r2` head keeps the head's own id.
 *
 * Found 2026-11-04: the five-minute checkpoint re-captured a resumed session,
 * `writeNote` planned the merge with the base id, and the `-r2` note came out
 * carrying `session-<id>` again. The store, which keys on that id, then filed
 * the head's content under the base note's row and left the `-r2` row stale.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { createSandbox } from './helpers/sandbox.mjs';
import { runScenario } from './helpers/scenarios.mjs';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const SESSIONS_DIR = 'projects/agentic-harness/sessions';
const FIRST_NOTE = `${SESSIONS_DIR}/${SESSION_ID}.md`;
const RESUMED_NOTE = `${SESSIONS_DIR}/${SESSION_ID}-r2.md`;

function scenario(fixture, reason) {
  return { fixture, sessionId: SESSION_ID, cwd: '__SANDBOX__/repos/agentic-harness', reason, note: FIRST_NOTE };
}

function readFields(sandbox, relativePath) {
  const parsed = parseFrontmatter(fs.readFileSync(path.join(sandbox.vaultRoot, relativePath), 'utf8'));
  assert.equal(parsed.ok, true, parsed.error);
  return parsed.fields;
}

test('a merge into the `-r2` head keeps `session-<id>-r2` and changes nothing else', () => {
  const sandbox = createSandbox();
  try {
    runScenario(sandbox, scenario('resume-first', 'clear'));

    // Real new activity after the note concluded, with the session only
    // pausing: the chain grows an `-r2` head that is still active.
    const resumed = runScenario(sandbox, scenario('resume-second', 'resume'));
    assert.equal(resumed.action, 'resume');
    assert.equal(readFields(sandbox, RESUMED_NOTE).id, `session-${SESSION_ID}-r2`);
    assert.equal(readFields(sandbox, RESUMED_NOTE).status, 'active');

    // The checkpoint captures the same session again: a merge into the head.
    const again = runScenario(sandbox, scenario('resume-second', 'resume'));
    assert.equal(again.action, 'merge');
    assert.ok(again.notePath.endsWith(`${SESSION_ID}-r2.md`), again.notePath);

    const head = readFields(sandbox, RESUMED_NOTE);
    assert.equal(head.id, `session-${SESSION_ID}-r2`, 'the head must not be renamed back to the base id');
    assert.equal(head.resumed_from, `session-${SESSION_ID}`);
    assert.deepEqual(again.touchedPaths, [], 'nothing changed, so the ingest is handed nothing');
    assert.equal(readFields(sandbox, FIRST_NOTE).status, 'superseded');
    assert.equal(readFields(sandbox, FIRST_NOTE).id, `session-${SESSION_ID}`);
  } finally {
    sandbox.cleanup();
  }
});
