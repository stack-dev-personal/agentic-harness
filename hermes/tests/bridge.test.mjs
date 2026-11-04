import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runBridge } from '../bridge.mjs';
import { installHermes } from '../install.mjs';
import { recordMemoryExclusion } from '../../hooks/lib/memory-policy.mjs';
import { acquireRealmLock, lockPathFor, releaseRealmLock } from '../../hooks/lib/realm-lock.mjs';

test('Hermes delegates tool arguments unchanged to shared retrieval, without source/runtime filters', async () => {
  const requests = [];
  const request = { operation: 'call', name: 'search_context', arguments: { query: 'invariant', collection: 'demo' } };
  const result = await runBridge(request, { env: {}, policy: () => ({ allowed: true }),
    retrieval: async value => { requests.push(value); return { content: [{ type: 'text', text: 'shared result' }] }; } });
  assert.deepEqual(requests, [request]);
  assert.equal(result.content[0].text, 'shared result');
});

test('Hermes exclusion reaches no brief, capture, or retrieval implementation', async () => {
  const fail = () => { throw new Error('excluded content reached memory'); };
  for (const operation of ['brief', 'capture', 'call', 'tools']) {
    const result = await runBridge({ operation, snapshot: { memory_excluded: true } }, { env: {},
      policy: () => ({ allowed: false, reason: 'excluded' }), brief: fail, capture: fail, retrieval: fail });
    assert.equal(result.excluded, true);
  }
});

test('Hermes obtains exactly the shared startup brief', async () => {
  const requests = [];
  const result = await runBridge({ operation: 'brief', session_id: 's1', cwd: 'C:/work' }, { env: {},
    policy: () => ({ allowed: true }), brief: async request => {
      requests.push(JSON.parse(request.raw));
      return { stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'common brief' } }) };
    } });
  assert.equal(result.context, 'common brief');
  assert.deepEqual(requests, [{ session_id: 'hermes-s1', cwd: 'C:/work', ancestorSessions: [] }]);
});

test('Hermes desktop bridge loads repository configuration when its launch environment is empty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-env-'));
  try {
    fs.writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgresql://synthetic@localhost/memory\n');
    let forwarded;
    await runBridge({ operation: 'tools' }, { env: {}, repoRoot: root,
      policy: () => ({ allowed: true }), retrieval: async (_request, env) => { forwarded = env; return { tools: [] }; } });
    assert.equal(forwarded.DATABASE_URL, 'postgresql://synthetic@localhost/memory');
    let captureEnv;
    await runBridge({ operation: 'capture', snapshot: { session_id: 's1' } }, { env: { HARNESS_VAULT: path.join(root, 'vault') }, repoRoot: root,
      policy: () => ({ allowed: true }), capture: options => { captureEnv = options.env; return { written: false, touchedPaths: [] }; } });
    assert.equal(captureEnv.DATABASE_URL, forwarded.DATABASE_URL);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Hermes installation previews changes and refuses to overwrite profile files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-install-'));
  try {
    const preview = installHermes({ hermesHome: root });
    assert.equal(preview.files.length, 3);
    assert.ok(!fs.existsSync(path.join(root, 'harness-memory.json')));
    installHermes({ hermesHome: root, apply: true });
    assert.equal(installHermes({ hermesHome: root, apply: true }).files.length, 0);
    fs.writeFileSync(path.join(root, 'harness-memory.json'), '{"my_setting":true}');
    assert.throws(() => installHermes({ hermesHome: root, apply: true }), /review before replacing/);
    assert.equal(fs.readFileSync(path.join(root, 'harness-memory.json'), 'utf8'), '{"my_setting":true}');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Hermes bridge enforces real sticky session exclusions before every memory operation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-policy-'));
  try {
    const env = { USERPROFILE: root, HARNESS_MACHINE_ENV: path.join(root, 'absent.env') };
    recordMemoryExclusion({ input: { runtime: 'hermes', sessionId: 's1' }, env });
    const fail = () => { throw new Error('excluded session reached memory'); };
    for (const operation of ['call', 'tools', 'brief', 'capture']) {
      const result = await runBridge({ operation, name: 'search_context', session_id: 's1', cwd: root,
        input: { sessionId: 's1', cwd: root }, snapshot: { session_id: 's1', cwd: root } }, {
        env, repoEnv: value => value, retrieval: fail, brief: fail, capture: fail,
      });
      assert.equal(result.excluded, true);
    }
    const denied = await runBridge({ operation: 'policy', input: { sessionId: 's2', cwd: root, classification: 'TLP:RED' } },
      { env, repoEnv: value => value });
    assert.equal(denied.allowed, false);
    const later = await runBridge({ operation: 'call', name: 'search_context', input: { sessionId: 'hermes-s2', cwd: root } },
      { env, repoEnv: value => value, retrieval: fail });
    assert.equal(later.excluded, true, 'omitting later classification cannot clear an excluded session');
    const child = await runBridge({ operation: 'call', name: 'search_context', input: { sessionId: 'child', parent_session_id: 's1', cwd: root } },
      { env, repoEnv: value => value, retrieval: fail });
    assert.equal(child.excluded, true, 'parent exclusion applies to a delegated child');
    const grandchild = await runBridge({ operation: 'call', name: 'search_context', input: {
      sessionId: 'grandchild', parent_session_id: 'uncaptured-parent', ancestorSessions: ['uncaptured-parent', 's1'], cwd: root } },
      { env, repoEnv: value => value, retrieval: fail });
    assert.equal(grandchild.excluded, true, 'full native ancestry blocks an excluded grandparent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Hermes bridge defers capture while its realm is held and captures under the shared lock on retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bridge-lock-'));
  let held;
  try {
    const vaultRoot = path.join(root, 'vault');
    const realm = path.join(vaultRoot, 'projects');
    fs.mkdirSync(path.join(realm, '.git'), { recursive: true });
    fs.writeFileSync(path.join(realm, '.realm'), 'projects\n');
    const env = { USERPROFILE: root, HARNESS_VAULT: vaultRoot, HARNESS_MACHINE_ENV: path.join(root, 'absent.env') };
    const request = { operation: 'capture', snapshot: { session_id: 's1', cwd: root } };
    let calls = 0;
    const capture = () => {
      calls++;
      assert.equal(fs.existsSync(lockPathFor(realm)), true, 'capture transaction holds the realm lock');
      return { written: false, action: 'noop', touchedPaths: [] };
    };
    held = acquireRealmLock(realm, { owner: 'other memory writer' });
    assert.equal(held.ok, true);
    const deferred = await runBridge(request, { env, repoEnv: value => value, capture });
    assert.equal(deferred.action, 'deferred');
    assert.equal(calls, 0, 'contended capture cannot inspect or update the note');
    releaseRealmLock(held);
    held = null;
    const retried = await runBridge(request, { env, repoEnv: value => value, capture });
    assert.equal(retried.action, 'noop');
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(lockPathFor(realm)), false, 'capture releases its lock');
  } finally {
    if (held) releaseRealmLock(held);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
