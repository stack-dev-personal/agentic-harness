#!/usr/bin/env node
/** Narrow native-plugin bridge. All ranked retrieval goes through the existing MCP tools. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run as startBrief } from '../hooks/session-start.mjs';
import { captureHermes } from '../hooks/hermes-session-capture.mjs';
import { loadMachineEnv, loadRepoEnv } from '../hooks/lib/machine-env.mjs';
import { installExtraRulesFrom } from '../hooks/lib/redact-extra.mjs';
import { memoryPolicyFields, sessionMemoryEligibility } from '../hooks/lib/memory-policy.mjs';
import { withRealmLocks } from '../hooks/lib/sweep.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_TOOLS = new Set(['search_context', 'get_document']);

async function mcp(request, env) {
  const sdk = path.join(repo, 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(path.join(sdk, 'index.js'))), import(pathToFileURL(path.join(sdk, 'stdio.js'))),
  ]);
  const client = new Client({ name: 'agentic-harness-hermes', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(repo, 'mcp-server', 'dist', 'index.js')], env, stderr: 'ignore' });
  try {
    await client.connect(transport);
    if (request.operation === 'tools') {
      const response = await client.listTools();
      return { tools: response.tools.filter(tool => ALLOWED_TOOLS.has(tool.name)) };
    }
    if (!ALLOWED_TOOLS.has(request.name)) throw new Error('unsupported shared memory tool');
    return await client.callTool({ name: request.name, arguments: request.arguments ?? {} });
  } finally { await client.close(); }
}

export async function runBridge(request, { env = process.env, policy, capture = captureHermes, brief = startBrief, retrieval = mcp,
  repoRoot = repo, repoEnv = loadRepoEnv } = {}) {
  const loaded = loadMachineEnv(repoEnv(env, repoRoot));
  installExtraRulesFrom(loaded);
  const eligibility = policy || sessionMemoryEligibility;
  const source = request.input || request.snapshot || request;
  const input = { ...source, runtime: 'hermes', sessionId: source.sessionId || source.session_id || request.session_id,
    parentSession: source.parentSession || source.parent_session_id || request.snapshot?.parent_session_id || request.parent_session_id,
    ancestorSessions: source.ancestorSessions || request.snapshot?.ancestorSessions || request.ancestorSessions || [] };
  if (!Array.isArray(input.ancestorSessions) || input.ancestorSessions.length > 128) return { excluded: true, reason: 'invalid session ancestry' };
  const decision = eligibility({ input, env: loaded, paths: [input.cwd].filter(Boolean) });
  if (request.operation === 'policy') return decision;
  if (!decision.allowed) return { excluded: true, reason: decision.reason };
  if (request.operation === 'brief') {
    const sessionId = String(input.sessionId || '');
    const qualified = sessionId.startsWith('hermes-') ? sessionId : `hermes-${sessionId}`;
    const result = await brief({ raw: JSON.stringify({ session_id: qualified, cwd: request.cwd || input.cwd,
      parent_session_id: input.parentSession, ancestorSessions: input.ancestorSessions,
      ...memoryPolicyFields(input) }), env: loaded, runtime: 'hermes' });
    return { context: JSON.parse(result.stdout).hookSpecificOutput.additionalContext };
  }
  if (request.operation === 'capture') {
    const vaultRoot = loaded.HARNESS_VAULT || path.join(os.homedir(), 'vault');
    const result = withRealmLocks({ cwd: request.snapshot?.cwd || input.cwd, vaultRoot, owner: 'Hermes memory capture' },
      () => capture({ snapshot: request.snapshot, vaultRoot, env: loaded }),
      () => ({ written: false, action: 'deferred', skip: 'realm locked; capture will retry', touchedPaths: [] }));
    if (result.touchedPaths?.length) {
      const { queueIngest } = await import('../hooks/lib/ingest-queue.mjs');
      const queued = queueIngest({ notePaths: result.touchedPaths, vaultRoot: result.vaultRoot, env: loaded });
      if (!queued.queued) throw new Error('shared memory note not queued');
    }
    return { written: result.written, action: result.action, reason: result.skip || '' };
  }
  if (request.operation === 'tools' || request.operation === 'call') return retrieval(request, loaded);
  throw new Error('unsupported shared memory operation');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('oversized native request');
    process.stdout.write(JSON.stringify(await runBridge(JSON.parse(raw))));
  } catch { process.stderr.write('Shared memory bridge failed\n'); process.exitCode = 1; }
}
