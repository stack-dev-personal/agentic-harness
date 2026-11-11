#!/usr/bin/env node
/** Hermes native-format adapter. Shared capture owns memory policy and rendering. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMachineEnv } from './lib/machine-env.mjs';
import * as captureModule from './lib/capture.mjs';
import { openNativeDatabase, textFromColumn } from './lib/native-sqlite.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { isSafeFilenameSegment } from './lib/text.mjs';
import { memoryEligibility } from './lib/memory-policy.mjs';

const REGISTRY_NAME = 'harness-memory-sessions.json';
const MAX_MESSAGES = 20_000;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const POLICY_FIELDS = ['memory_excluded', 'restricted', 'persistence', 'purpose', 'classification', 'data_classification'];
const TOOL_NAMES = { terminal: 'Bash', execute_code: 'Bash', file_edit: 'Edit', write_file: 'Write', read_file: 'Read' };

function iso(value, fallback = '') {
  if (typeof value === 'number') value = new Date(value < 1e12 ? value * 1000 : value);
  const timestamp = new Date(value || fallback);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString();
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => ['text', 'input_text', 'output_text'].includes(block?.type) && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

/** Hermes SessionDB sentinel encoding, reduced to text before recovery snapshots. */
function nativeTextContent(content) {
  // Message bodies are selected as bytes (see the queries below) and decoded here.
  if (content instanceof Uint8Array) content = textFromColumn(content);
  if (typeof content === 'string' && content.startsWith('\u0000json:')) {
    try { content = JSON.parse(content.slice(6)); }
    catch { throw new Error('Hermes native message encoding is invalid'); }
  }
  return textContent(content);
}

function callInput(call) {
  const value = call?.function?.arguments ?? call?.arguments ?? {};
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

/** Only activity fields used by shared analysis survive; no raw tools or patches. */
function normalizedTool(call, index) {
  const name = call?.function?.name || call?.name || '';
  const args = callInput(call);
  const input = {};
  const normalizedName = TOOL_NAMES[name] || name;
  if (normalizedName === 'Bash' && typeof args.command === 'string') input.command = args.command;
  for (const key of ['file_path', 'path']) if (typeof args[key] === 'string') input.file_path = args[key];
  if (name === 'search_context' || name === 'get_document') {
    for (const key of ['query', 'collection', 'source', 'external_id', 'repo', 'phase']) {
      if (typeof args[key] === 'string') input[key] = args[key];
    }
  }
  return { type: 'tool_use', id: String(call?.id || `hermes-tool-${index}`),
    name: ['search_context', 'get_document'].includes(name) ? `mcp__rag__${name}` : normalizedName, input };
}

function qualifiedId(id) {
  const value = String(id || '');
  return value.startsWith('hermes-') ? value : `hermes-${value}`;
}

/** Parent metadata only: bounded and fail closed on corrupt/unverifiable lineage. */
function nativeAncestors(db, sessionId, parentId) {
  const seen = new Set([sessionId]);
  const ancestors = [];
  const lookup = db.prepare('SELECT parent_session_id FROM sessions WHERE id = ?');
  let next = parentId;
  while (next) {
    if (!isSafeFilenameSegment(String(next)) || seen.has(next) || ancestors.length >= 128) throw new Error('Hermes session ancestry is invalid or exceeds its limit');
    seen.add(next);
    ancestors.push(qualifiedId(next));
    const row = lookup.get(next);
    if (!row) throw new Error('Hermes session ancestry cannot be verified');
    next = row.parent_session_id;
  }
  return ancestors;
}

export function normalizeHermesSession(snapshot) {
  const nativeId = String(snapshot.session_id || snapshot.sessionId || '');
  if (!isSafeFilenameSegment(nativeId)) throw new Error('invalid Hermes session id');
  const cwd = String(snapshot.cwd || '');
  const parent = snapshot.parent_session_id || snapshot.parentSession || '';
  // /new, /branch and compression also carry lineage. Only native delegates
  // (or parent-side callbacks with their own task) suppress inherited users.
  const delegated = Boolean(parent && (snapshot.source === 'subagent' || snapshot.task));
  const ancestors = snapshot.ancestorSessions || [];
  if (!Array.isArray(ancestors) || ancestors.length > 128 || ancestors.some(id => !isSafeFilenameSegment(String(id)))) throw new Error('Hermes session ancestry is invalid');
  const entries = [];
  const startedAt = iso(snapshot.started_at, '');
  if (startedAt) entries.push({ type: 'progress', timestamp: startedAt, cwd });
  if (delegated && snapshot.task) entries.push({ type: 'user', origin: { kind: 'human' }, cwd,
    timestamp: startedAt, message: { content: String(snapshot.task) } });
  for (const message of (Array.isArray(snapshot.messages) ? snapshot.messages : []).slice(-MAX_MESSAGES)) {
    if (!message || message._hermes_synthetic || message._compressed_summary || message.isMeta || message.inherited) continue;
    const timestamp = iso(message.timestamp || message.created_at, startedAt);
    if (message.role === 'user' && !delegated) {
      const content = textContent(message.content);
      if (content && !/^<(?:system-reminder|environment_context|user_instructions)>/.test(content)) {
        entries.push({ type: 'user', origin: { kind: 'human' }, timestamp, cwd, message: { content } });
      }
    } else if (message.role === 'assistant') {
      const tools = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(normalizedTool);
      const content = tools.length ? tools : [{ type: 'text', text: textContent(message.content) }];
      if (tools.length || content[0].text) entries.push({ type: 'assistant', timestamp, cwd,
        message: { model: snapshot.model || 'unknown', content } });
    }
  }
  return { sessionId: qualifiedId(nativeId), nativeSessionId: nativeId.replace(/^hermes-/, ''), cwd, entries,
    parentSession: parent ? qualifiedId(parent) : '', ancestorSessions: ancestors.map(qualifiedId), model: String(snapshot.model || ''),
    provider: String(snapshot.provider || ''), origin: String(snapshot.source || snapshot.platform || 'hermes'),
    ...Object.fromEntries(POLICY_FIELDS.filter(key => snapshot[key] !== undefined).map(key => [key, snapshot[key]])) };
}

export function captureHermes({ snapshot, vaultRoot, capture = captureModule.captureSession, ...options }) {
  if (typeof capture !== 'function') throw new Error('shared captureSession is unavailable');
  const normalized = normalizeHermesSession(snapshot);
  const input = { sessionId: normalized.sessionId, cwd: normalized.cwd,
    parentSession: normalized.parentSession, ancestorSessions: normalized.ancestorSessions,
    transcriptPath: snapshot.transcriptPath || '', hookEventName: 'SessionEnd',
    endReason: snapshot.concluded ? 'other' : 'resume',
    ...Object.fromEntries(POLICY_FIELDS.filter(key => normalized[key] !== undefined).map(key => [key, normalized[key]])) };
  return capture({ ...options, input, entries: normalized.entries, vaultRoot, agent: 'hermes', runtime: 'hermes',
    model: normalized.model, provider: normalized.provider, origin: normalized.origin,
    parentSession: normalized.parentSession, promptTask: snapshot.task || '' });
}

export function readHermesRegistry(hermesHome) {
  const file = path.join(hermesHome, 'state', REGISTRY_NAME);
  if (!fs.existsSync(file)) return {};
  if (fs.statSync(file).size > MAX_REGISTRY_BYTES) throw new Error('Hermes registration index exceeds its size limit');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions) ? parsed.sessions : {};
}

/** Metadata only: source and producer lineage establish a fresh delegated conversation.
 * Hermes prefill is API-only (turn_request_assembly.py); delegation's own goal is
 * the first durable user turn (delegate_tool_child_run.py:928-939).
 */
function verifyDelegation(session) {
  if (session.source !== 'subagent' || !session.parent_session_id) throw new Error('Hermes delegated ancestry cannot be verified');
  if (session.model_config) {
    let config;
    try { config = JSON.parse(session.model_config); } catch { throw new Error('Hermes delegated metadata is invalid'); }
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || (config._delegate_from !== undefined && config._delegate_from !== session.parent_session_id)) {
      throw new Error('Hermes delegated ancestry does not match its producer metadata');
    }
  }
}

function nativeSessionLookup(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name));
  const optional = ['source', 'model_config', 'transcript_revision', 'billing_provider'].filter(key => columns.has(key));
  const statement = db.prepare(`SELECT id, cwd, model, parent_session_id, started_at, ended_at${optional.map(key => `, ${key}`).join('')} FROM sessions WHERE id = ?`);
  return { columns, get: id => statement.get(id) };
}

/** Unregistered descendants must postdate an explicit ancestor's first opt-in. */
function recoveryRegistration(session, registered, get) {
  const delegated = [];
  const seen = new Set();
  let current = session;
  while (!Object.hasOwn(registered, current.id)) {
    if (seen.has(current.id) || seen.size >= 128) throw new Error('Hermes session ancestry is invalid');
    seen.add(current.id);
    if (!current.parent_session_id) throw new Error('Hermes session is not registered for harness capture');
    verifyDelegation(current);
    delegated.push(current);
    current = get(current.parent_session_id);
    if (!current) throw new Error('Hermes session is not registered for harness capture');
  }
  const registration = registered[current.id];
  if (!registration || typeof registration !== 'object' || Array.isArray(registration)) throw new Error('Hermes session registration is invalid');
  if (delegated.length && (typeof registration.registered_at !== 'number' || !Number.isFinite(registration.registered_at) || registration.registered_at <= 0
    || delegated.some(child => !Number.isFinite(child.started_at) || child.started_at < registration.registered_at))) {
    throw new Error('Hermes delegated session is not eligible for recovery before registration');
  }
  return registration;
}

/** Metadata-only discovery. Only newly delegated descendants inherit registration. */
export function discoverHermesSessions({ hermesHome, log = () => {} }) {
  const database = path.join(hermesHome, 'state.db');
  if (!fs.existsSync(database)) return [];
  const registered = readHermesRegistry(hermesHome);
  if (!Object.keys(registered).length) return [];
  const db = openNativeDatabase(database, { readOnly: true });
  try {
    const { columns, get } = nativeSessionLookup(db);
    const children = columns.has('source') ? db.prepare("SELECT id FROM sessions WHERE parent_session_id = ? AND source = 'subagent' AND started_at >= ?") : null;
    const pending = Object.keys(registered);
    const seen = new Set();
    const rows = [];
    for (let index = 0; index < pending.length; index += 1) {
      if (index >= MAX_MESSAGES) throw new Error('Hermes delegated discovery exceeds its limit');
      const nativeId = pending[index];
      if (!isSafeFilenameSegment(nativeId) || seen.has(nativeId)) continue;
      seen.add(nativeId);
      const session = get(nativeId);
      if (!session) { log('Hermes registered session is not yet available in native storage'); continue; }
      const registration = recoveryRegistration(session, registered, get);
      const ancestorSessions = nativeAncestors(db, nativeId, session.parent_session_id);
      if (session.source === 'subagent') verifyDelegation(session);
      const tail = db.prepare('SELECT MAX(id) AS last_id, COUNT(*) AS count FROM messages WHERE session_id = ?').get(nativeId);
      rows.push({ sessionId: qualifiedId(nativeId), nativeSessionId: nativeId, cwd: session.cwd || registration.cwd || '',
        parentSession: session.parent_session_id ? qualifiedId(session.parent_session_id) : '', ancestorSessions,
        fingerprint: `${session.transcript_revision || 0}:${tail.last_id || 0}:${tail.count}:${session.ended_at || 0}`,
        hermesHome, transcriptPath: database, ...Object.fromEntries(POLICY_FIELDS.filter(key => registration[key] !== undefined).map(key => [key, registration[key]])) });
      if (children && typeof registration.registered_at === 'number' && Number.isFinite(registration.registered_at) && registration.registered_at > 0) {
        pending.push(...children.all(nativeId, registration.registered_at).map(row => row.id));
      }
    }
    return rows;
  } finally { db.close(); }
}

export function readHermesSession({ hermesHome, sessionId, env = process.env }) {
  const nativeId = String(sessionId).replace(/^hermes-/, '');
  if (!isSafeFilenameSegment(nativeId)) throw new Error('invalid Hermes session id');
  const registry = readHermesRegistry(hermesHome);
  const database = path.join(hermesHome, 'state.db');
  const db = openNativeDatabase(database, { readOnly: true });
  try {
    const { get } = nativeSessionLookup(db);
    const session = get(nativeId);
    if (!session) throw new Error('Hermes session does not exist');
    const registration = recoveryRegistration(session, registry, get);
    const ancestorSessions = nativeAncestors(db, nativeId, session.parent_session_id);
    if (session.source === 'subagent') verifyDelegation(session);
    const input = { ...registration, runtime: 'hermes', sessionId: qualifiedId(nativeId),
      parentSession: session.parent_session_id ? qualifiedId(session.parent_session_id) : '', ancestorSessions,
      cwd: session.cwd || registration.cwd || '', transcriptPath: database };
    // Evaluate every registered ancestor as well: child metadata cannot weaken an opt-out.
    for (const id of [nativeId, ...ancestorSessions.map(id => id.replace(/^hermes-/, ''))]) {
      const ancestor = Object.hasOwn(registry, id) ? registry[id] : {};
      const policy = { ...input, ...Object.fromEntries(POLICY_FIELDS.filter(key => ancestor[key] !== undefined).map(key => [key, ancestor[key]])) };
      const paths = [ancestor.cwd, get(id)?.cwd].filter(Boolean);
      if (!memoryEligibility({ input: policy, env, paths }).allowed) throw new Error('Hermes session is excluded from memory');
    }
    const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(row => row.name));
    const active = columns.has('active') ? (columns.has('compacted') ? '(active = 1 OR compacted = 1)' : 'active = 1') : '';
    const filters = [active, columns.has('_compressed_summary') && '_compressed_summary = 0'].filter(Boolean);
    const predicate = `session_id = ? AND role IN ('user','assistant')${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`;
    let task = '';
    if (session.parent_session_id && session.source === 'subagent') {
      // `content` is read as bytes: Node 22's node:sqlite cuts a text value at the
      // NUL that starts Hermes's multimodal encoding, which emptied every such message.
      const assignment = db.prepare(`SELECT CAST(content AS BLOB) AS content FROM messages WHERE ${predicate} AND role = 'user' ORDER BY id LIMIT 1`).get(nativeId);
      task = nativeTextContent(assignment?.content);
      if (!task) throw new Error('Hermes delegated assignment is not yet available for recovery');
    }
    const rows = db.prepare(`SELECT role, CAST(content AS BLOB) AS content, tool_calls, timestamp FROM messages WHERE ${predicate} ORDER BY id DESC LIMIT ?`).all(nativeId, MAX_MESSAGES).reverse();
    const messages = rows.map(row => { let tool_calls; try { tool_calls = JSON.parse(row.tool_calls || '[]'); } catch { tool_calls = []; }
      return { role: row.role, content: nativeTextContent(row.content), timestamp: row.timestamp, tool_calls }; });
    const snapshot = { ...registration, session_id: nativeId, cwd: input.cwd, model: session.model,
      provider: session.billing_provider || '', source: session.source, parent_session_id: session.parent_session_id, started_at: session.started_at,
      ancestorSessions, concluded: Boolean(session.ended_at), transcriptPath: database, task, messages };
    return { ...normalizeHermesSession(snapshot), snapshot };
  } finally { db.close(); }
}

if (isEntryPoint(import.meta.url)) {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const snapshot = JSON.parse(raw);
    // machine.env underneath, as every host hook reads it: the protected
    // folders, the vault and the worker-start switch live there.
    const env = loadMachineEnv(process.env, os.homedir());
    const result = captureHermes({ snapshot, vaultRoot: env.HARNESS_VAULT || path.join(env.USERPROFILE || os.homedir(), 'vault'), env });
    if (result.touchedPaths?.length) {
      const { queueIngest } = await import('./lib/ingest-queue.mjs');
      queueIngest({ notePaths: result.touchedPaths, vaultRoot: result.vaultRoot, env });
    }
    process.stdout.write(JSON.stringify({ written: result.written, action: result.action, reason: result.skip || '' }));
  } catch { process.stderr.write('Hermes shared capture failed\n'); process.exitCode = 1; }
}
