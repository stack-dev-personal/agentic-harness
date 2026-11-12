/** Read Codex paginated native history, using the documented app-server item union.
 * Native SQLite schemas are versioned capabilities: unsupported schemas fail
 * closed, and all connections are read-only. No native runtime state is changed.
 * Item shapes: https://learn.chatgpt.com/docs/app-server#items
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { captureSession } from './capture.mjs';
import { humanText } from './codex-prompt.mjs';
import { isEncryptedTask, placeholderTask } from './codex-task.mjs';
import { openNativeDatabase } from './native-sqlite.mjs';
import { hostPathFlavor, isUnplaceableDevicePath, joinHostPath } from './host-paths.mjs';
import { sessionMemoryEligibility } from './memory-policy.mjs';
import { parseRagResult } from './rag-result.mjs';
import { isSafeFilenameSegment, toPosix } from './text.mjs';

const MAX_ROWS = 5000;
const MAX_BYTES = 16 * 1024 * 1024;
const TYPES = ['userMessage', 'agentMessage', 'commandExecution', 'fileChange', 'mcpToolCall', 'collabAgentToolCall', 'collabToolCall', 'imageView'];
const TYPE_SQL = TYPES.map(() => '?').join(',');
// Project only capture inputs in SQLite. Tool output, reasoning and patch diffs
// can be megabytes and must neither consume the note budget nor escape parsing.
const ITEM_PROJECTION = `CASE item_type
  WHEN 'userMessage' THEN json_object('type',item_type,'id',item_id,'content',json_extract(item_json,'$.content'))
  WHEN 'agentMessage' THEN json_object('type',item_type,'id',item_id,'text',json_extract(item_json,'$.text'),'phase',json_extract(item_json,'$.phase'))
  WHEN 'commandExecution' THEN json_object('type',item_type,'id',item_id,'command',json_extract(item_json,'$.command'),'cwd',json_extract(item_json,'$.cwd'))
  WHEN 'fileChange' THEN json_object('type',item_type,'id',item_id,'changes',json((SELECT json_group_array(json_object('path',json_extract(change.value,'$.path'))) FROM json_each(item_json,'$.changes') change)))
  WHEN 'mcpToolCall' THEN json_object('type',item_type,'id',item_id,'server',json_extract(item_json,'$.server'),'tool',json_extract(item_json,'$.tool'),'arguments',json_extract(item_json,'$.arguments'),
    'result',CASE WHEN json_extract(item_json,'$.server')='rag' AND json_extract(item_json,'$.tool') IN ('search_context','get_document') THEN json_extract(item_json,'$.result') END,'error',json_extract(item_json,'$.error'))
  WHEN 'imageView' THEN json_object('type',item_type,'id',item_id,'path',json_extract(item_json,'$.path'))
  ELSE json_object('type',item_type,'id',item_id,'tool',json_extract(item_json,'$.tool'),'prompt',json_extract(item_json,'$.prompt'),'receiverThreadIds',json_extract(item_json,'$.receiverThreadIds'),'receiverThreadId',json_extract(item_json,'$.receiverThreadId'),'newThreadId',json_extract(item_json,'$.newThreadId')) END`;
// Descendant preflight returns paths only. Never select message text, commands,
// reasoning, patch diffs or results while deciding whether a parent can persist.
const PATH_SQL = `WITH items AS (
  SELECT item_json,item_type FROM thread_items WHERE thread_id=?
  AND (?=1 OR item_type <> 'userMessage')
  AND item_type IN ('userMessage','imageView','fileChange','commandExecution','mcpToolCall')
), paths AS (
  SELECT json_extract(image.value,'$.path') AS path, ? AS cwd
  FROM items,json_each(items.item_json,'$.content') image
  WHERE item_type='userMessage' AND json_extract(image.value,'$.type')='localImage'
  UNION ALL SELECT json_extract(item_json,'$.path'), ? FROM items WHERE item_type='imageView'
  UNION ALL SELECT json_extract(change.value,'$.path'), ?
  FROM items,json_each(items.item_json,'$.changes') change WHERE item_type='fileChange'
  UNION ALL SELECT json_extract(item_json,'$.cwd'), ? FROM items WHERE item_type='commandExecution'
  UNION ALL SELECT action.value,coalesce(nullif(json_extract(items.item_json,'$.cwd'),''),?)
  FROM items,json_tree(items.item_json,'$.commandActions') action
  WHERE item_type='commandExecution' AND action.key IN ('path','file_path','notebook_path') AND action.type <> 'null'
  UNION ALL SELECT argument.value,? FROM items,json_tree(items.item_json,'$.arguments') argument
  WHERE item_type='mcpToolCall' AND argument.key IN ('path','file_path','notebook_path') AND argument.type <> 'null'
) SELECT path,cwd FROM paths WHERE path IS NOT NULL AND path <> '' LIMIT ?`;
const nativeId = id => String(id || '').replace(/^codex-/, '');
const qualify = id => `codex-${nativeId(id)}`;
const millis = value => Number(value || 0) < 1e12 ? Number(value || 0) * 1000 : Number(value || 0);
const iso = value => new Date(millis(value) || Date.now()).toISOString();
// A thread with no note to belong to is reported as unsupported: not written,
// not a failure, never with inherited prompts. Two cases: a delegate whose parent
// cannot be resolved, and a spawn edge whose thread does not say it is a delegate
// and whose parent recorded no assignment (a fork, not a delegation).
const UNSUPPORTED_CHILD_SKIP = 'child task unavailable; inherited context excluded';
const UNSUPPORTED_CHILD_LOG = 'Codex SQLite capability unavailable: child task unavailable (no resolvable parent thread)';
const UNSUPPORTED_EDGE_LOG = 'Codex SQLite capability unavailable: child task unavailable (spawn edge without a delegated source or a recorded assignment)';
// Logged once per run so a regression in spawn-prompt detection stays visible.
const PLACEHOLDER_LOG = 'Codex delegated assignment not in native history; writing the note with a placeholder task';

/**
 * The task line for a delegated thread whose assignment Codex did not record.
 * Per the contract change of 2026-11-04 the note is written anyway: labelled by
 * its task name and parent, carrying the child's own results and activity, with
 * the placeholder (codex-task.mjs) where the task would be.
 */
const placeholderAssignment = (thread) => placeholderTask({ agentPath: thread.agentPath, agentNickname: thread.agentNickname, id: thread.id });

function capability(message) {
  const error = new Error(`Codex SQLite capability unavailable: ${message}`);
  error.code = 'CODEX_SQLITE_CAPABILITY';
  return error;
}

function ancestry(id, parentById) {
  const result = [];
  const seen = new Set([id]);
  let current = parentById.get(id);
  while (current) {
    if (seen.has(current) || result.length >= 128) throw capability('invalid session ancestry');
    if (!isSafeFilenameSegment(current)) throw capability('invalid parent identity');
    seen.add(current); result.push(current); current = parentById.get(current);
  }
  return result;
}

function readThreadMetadata(state) {
  const rows = state.prepare('SELECT id,cwd,source,model_provider,model,created_at_ms,updated_at_ms,history_mode,archived,originator FROM threads').all();
  // Native paths are normalized at this boundary: Codex 0.166 records every cwd
  // as `\\?\C:\...`, which realpath cannot resolve and pathWithin never matches,
  // so the path policy could neither verify nor refuse the session.
  for (const row of rows) {
    // Asked of the raw text, before the prefix is gone (see structured paths).
    row.cwdUnplaceable = isUnplaceableDevicePath(row.cwd || '');
    row.cwdRaw = row.cwd || '';
    row.cwd = toPosix(row.cwd || '');
  }
  const threads = new Map(rows.map(row => [row.id, row]));
  const parentById = new Map();
  for (const row of state.prepare('SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges').all()) parentById.set(row.child_thread_id, row.parent_thread_id);
  for (const row of rows) {
    if (typeof row.source !== 'string' || !row.source.startsWith('{')) continue;
    let source;
    try { source = JSON.parse(row.source); } catch { throw capability('invalid native thread source'); }
    const parent = source?.subagent?.thread_spawn?.parent_thread_id;
    row.isSubagent = Boolean(source?.subagent);
    const spawn = source?.subagent?.thread_spawn;
    row.agentPath = typeof spawn?.agent_path === 'string' ? spawn.agent_path : '';
    row.agentNickname = typeof spawn?.agent_nickname === 'string' ? spawn.agent_nickname : '';
    // Translate the native internal observer role to shared purpose policy.
    if (source?.subagent?.other === 'guardian') row.purpose = 'observer';
    if (parent && !parentById.has(row.id)) parentById.set(row.id, parent);
    else if (source?.subagent && !parentById.has(row.id)) parentById.set(row.id, '');
  }
  return { rows, threads, parentById };
}

function baseInput(thread, parentById, historyFile) {
  const ancestors = ancestry(thread.id, parentById);
  return { runtime: 'codex', sessionId: thread.id, cwd: toPosix(thread.cwd || ''),
    parentSession: ancestors[0] || '', ancestorSessions: ancestors,
    ...(thread.purpose ? { purpose: thread.purpose } : {}),
    transcriptPath: toPosix(historyFile), hookEventName: 'SessionEnd', endReason: 'resume' };
}

function policyFor(thread, threads, parentById, historyFile, env) {
  const input = baseInput(thread, parentById, historyFile);
  for (const ancestorId of input.ancestorSessions) {
    const ancestor = threads.get(ancestorId);
    if (!ancestor) return { allowed: false, reason: 'ancestor session metadata unavailable' };
    const result = sessionMemoryEligibility({ input: baseInput(ancestor, parentById, historyFile), env });
    if (!result.allowed) return result;
  }
  return sessionMemoryEligibility({ input, env });
}

function parseItem(row) {
  let item;
  try { item = JSON.parse(row.item_json); } catch { throw capability('invalid native item JSON'); }
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.type !== row.item_type) throw capability('invalid native item shape');
  return item;
}

/** Normalize only supported content; raw reasoning, output, and patch diffs are omitted. */
function entriesFromItems(rows, thread, ownTask, { env = process.env } = {}) {
  // Under a host path flavor tool paths keep their recorded spelling (toPosix
  // strips device prefixes) and relative ones are joined as Windows text.
  const flavor = Boolean(hostPathFlavor(env));
  const asRecorded = flavor ? (value) => String(value) : toPosix;
  const cwd = toPosix(thread.cwd || '');
  const entries = [{ type: 'progress', timestamp: iso(thread.created_at_ms), cwd }];
  if (ownTask) entries.push({ type: 'user', origin: { kind: 'human' }, timestamp: iso(thread.created_at_ms), cwd, message: { content: ownTask } });
  let total = 0;
  for (const row of rows) {
    total += Buffer.byteLength(row.item_json, 'utf8');
    if (total > MAX_BYTES) throw capability('native history exceeds capture budget');
    const item = parseItem(row);
    const timestamp = iso(row.completed_at_ms || row.created_at_ms);
    const content = [];
    if (item.type === 'userMessage' && !ownTask) {
      const text = humanText(item.content, 'text');
      if (text) entries.push({ type: 'user', origin: { kind: 'human' }, timestamp, cwd, message: { content: text } });
      const images = Array.isArray(item.content) ? item.content.filter(block => block?.type === 'localImage' && typeof block.path === 'string') : [];
      if (images.length) entries.push({ type: 'assistant', timestamp, cwd, message: { content: images.map((image, index) => ({ type: 'tool_use', id: `${item.id}:image:${index}`, name: 'Read', input: { file_path: asRecorded(image.path) } })) } });
      continue;
    }
    if (item.type === 'agentMessage' && (item.phase == null || ['final', 'final_answer', 'partial_answer'].includes(item.phase))) {
      if (typeof item.text === 'string' && item.text.trim()) entries.push({ type: 'assistant', timestamp, cwd,
        message: { model: thread.model || '', content: [{ type: 'text', text: item.text }] } });
      continue;
    }
    if (item.type === 'commandExecution' && typeof item.command === 'string') content.push({ type: 'tool_use', id: item.id,
      name: 'PowerShell', input: { command: item.command } });
    if (item.type === 'imageView' && typeof item.path === 'string') content.push({ type: 'tool_use', id: item.id,
      name: 'Read', input: { file_path: asRecorded(item.path) } });
    if (item.type === 'fileChange' && Array.isArray(item.changes)) {
      for (const [index, change] of item.changes.entries()) {
        if (typeof change?.path !== 'string') continue;
        const changePath = asRecorded(change.path);
        const absolute = flavor ? joinHostPath(thread.cwdRaw || thread.cwd || '', changePath)
          : path.isAbsolute(changePath) ? changePath : path.resolve(cwd, changePath);
        content.push({ type: 'tool_use', id: `${item.id}:${index}`, name: 'Write', input: { file_path: absolute } });
      }
    }
    if (item.type === 'mcpToolCall' && typeof item.server === 'string' && typeof item.tool === 'string') {
      const input = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? item.arguments : {};
      content.push({ type: 'tool_use', id: item.id, name: `mcp__${item.server}__${item.tool}`, input });
    }
    if (['collabAgentToolCall', 'collabToolCall'].includes(item.type) && typeof item.prompt === 'string') {
      content.push({ type: 'tool_use', id: item.id, name: 'Agent', input: { description: item.prompt } });
    }
    if (content.length) entries.push({ type: 'assistant', timestamp, cwd: toPosix(item.cwd || cwd), message: { content } });
    if (item.type === 'mcpToolCall' && item.server === 'rag' && ['search_context', 'get_document'].includes(item.tool) && !item.error) {
      const text = typeof item.result === 'string' ? item.result : (item.result?.content || [])
        .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
      if (parseRagResult(item.tool, text)) entries.push({ type: 'user', timestamp, cwd,
        message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: [{ type: 'text', text }] }] } });
    }
  }
  return entries;
}

function childTask(history, id, parentId) {
  const rows = history.prepare("SELECT item_json,item_type FROM thread_items WHERE thread_id=? AND item_type IN ('collabAgentToolCall','collabToolCall') ORDER BY rollout_ordinal").all(parentId);
  let bytes = 0;
  for (const row of rows) {
    bytes += Buffer.byteLength(row.item_json, 'utf8');
    if (bytes > MAX_BYTES) throw capability('parent assignment exceeds capture budget');
    const item = parseItem(row);
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [item.receiverThreadId, item.newThreadId];
    if (receivers.includes(id) && ['spawnAgent', 'spawn_agent', 'spawn'].includes(item.tool)
      && typeof item.prompt === 'string' && item.prompt.trim() && !isEncryptedTask(item.prompt)) return item.prompt;
  }
  return '';
}

function preflightPaths({ db, thread, parentById, historyFile, env, deadlineAt,
  includeUserMessages = true, budget = { rows: 0, bytes: 0 } }) {
  if (Date.now() >= deadlineAt) throw capability('structured path policy budget exceeded');
  const include = includeUserMessages ? 1 : 0;
  const count = db.prepare("SELECT count(*) AS items FROM thread_items WHERE thread_id=? AND (?=1 OR item_type <> 'userMessage') AND item_type IN ('userMessage','imageView','fileChange','commandExecution','mcpToolCall')").get(thread.id, include).items;
  budget.rows += count;
  if (budget.rows > MAX_ROWS) throw capability('structured path activity exceeds row budget');
  const cwd = thread.cwd || '';
  const rows = db.prepare(PATH_SQL).all(thread.id, include, cwd, cwd, cwd, cwd, cwd, cwd, MAX_ROWS + 1);
  budget.rows += rows.length;
  if (budget.rows > MAX_ROWS) throw capability('structured paths exceed row budget');
  // Under a path flavor the policy reads Windows text itself, device prefixes
  // included, so it gets the paths as recorded. Natively they are normalized
  // first (see readThreadMetadata). An unknown flavor is the policy's to refuse.
  let flavor = null;
  try { flavor = hostPathFlavor(env); } catch { /* refused below by the policy */ }
  const paths = [];
  // `toPosix` drops a device prefix. For `\\?\C:\x` that loses nothing, but
  // `\\.\X:\..\C:\x` or `\\?\GLOBALROOT\...` would turn into an ordinary-looking
  // path that hides where it leads, so those refuse the session outright.
  let unplaceable = thread.cwdUnplaceable === true;
  // The thread's own folder, as recorded: its normalized form (the input's
  // cwd) reads `\\.\UNC\\host\share` as a rooted path, the raw text does not.
  if (flavor && thread.cwdRaw) paths.push(thread.cwdRaw);
  for (const item of rows) {
    if (typeof item.path !== 'string' || typeof item.cwd !== 'string') throw capability('invalid structured path metadata');
    budget.bytes += Buffer.byteLength(item.path, 'utf8') + Buffer.byteLength(item.cwd, 'utf8');
    if (budget.bytes > MAX_BYTES) throw capability('structured paths exceed capture budget');
    if (isUnplaceableDevicePath(item.path) || isUnplaceableDevicePath(item.cwd)) unplaceable = true;
    // Item paths and cwds come raw from native JSON; see readThreadMetadata.
    paths.push(flavor ? { path: item.path, cwd: item.cwd } : { path: toPosix(item.path), cwd: toPosix(item.cwd) });
  }
  if (Date.now() >= deadlineAt) throw capability('structured path policy budget exceeded');
  const decision = sessionMemoryEligibility({ input: baseInput(thread, parentById, historyFile), env, paths });
  if (decision.allowed && unplaceable) return { allowed: false, reason: 'memory path policy could not be verified' };
  return decision;
}

/** Sensitive child activity taints its ancestors before a parent body is loaded. */
function preflightDescendants({ db, thread, threads, parentById, historyFile, env, deadlineAt }) {
  const pending = [thread.id];
  const seen = new Set(pending);
  const budget = { rows: 0, bytes: 0 };
  while (pending.length) {
    const parent = pending.pop();
    for (const [id, parentId] of parentById) {
      if (parentId !== parent) continue;
      if (seen.has(id) || seen.size >= MAX_ROWS) throw capability('invalid descendant session graph');
      seen.add(id);
      const descendant = threads.get(id);
      if (!descendant) throw capability('descendant session metadata unavailable');
      const policy = policyFor(descendant, threads, parentById, historyFile, env);
      if (!policy.allowed) {
        if (policy.reason === 'excluded session purpose' || (policy.reason === 'previously excluded session' && policy.taint === false)) continue;
        return policy;
      }
      pending.push(id);
      const touched = preflightPaths({ db, thread: descendant, parentById, historyFile, env, deadlineAt, budget });
      if (!touched.allowed) return touched;
    }
  }
  return { allowed: true };
}

function captureNative({ thread, threads, parentById, stateFile, historyFile, vaultRoot, env, openDatabase, log, runGit,
  deadlineAt = Date.now() + 30_000, endReason = 'resume', stateDir, capturedBy = 'sweep' }) {
  const skip = reason => ({ written: false, action: 'skip', skip: reason, notePath: '', touchedPaths: [], vaultRoot });
  let input = baseInput(thread, parentById, historyFile);
  const policy = policyFor(thread, threads, parentById, historyFile, env);
  if (!policy.allowed) return { ...skip(policy.reason), action: 'excluded' };
  if (Date.now() >= deadlineAt) return skip('capture budget spent');
  if (!fs.existsSync(historyFile)) { log('Codex SQLite capability unavailable: native history missing'); return skip('native history missing'); }
  let db;
  let state;
  try {
    db = openDatabase(historyFile, { readOnly: true });
    db.prepare('BEGIN').run();
    // Establish the history snapshot before refreshing family metadata. New
    // descendants created since discovery cannot be omitted from preflight,
    // and a later parent result cannot race ahead of its child's path check.
    db.prepare('SELECT max(rowid) AS watermark FROM thread_items').get();
    state = openDatabase(stateFile, { readOnly: true });
    state.prepare('BEGIN').run();
    const refreshed = readThreadMetadata(state);
    thread = refreshed.threads.get(thread.id);
    if (!thread || thread.history_mode !== 'paginated') throw capability('native session metadata changed');
    threads = refreshed.threads;
    parentById = refreshed.parentById;
    state.close(); state = null;
    input = baseInput(thread, parentById, historyFile);
    const currentPolicy = policyFor(thread, threads, parentById, historyFile, env);
    if (!currentPolicy.allowed) return { ...skip(currentPolicy.reason), action: 'excluded' };
    const rootPaths = preflightPaths({ db, thread, parentById, historyFile, env, deadlineAt,
      includeUserMessages: !thread.isSubagent && !input.parentSession });
    if (!rootPaths.allowed) return { ...skip(rootPaths.reason), action: 'excluded' };
    const descendantPolicy = preflightDescendants({ db, thread, threads, parentById, historyFile, env, deadlineAt });
    if (!descendantPolicy.allowed) return { ...skip(descendantPolicy.reason), action: 'excluded' };
    const parent = input.parentSession;
    if (thread.isSubagent && !parent) { log(UNSUPPORTED_CHILD_LOG); return { ...skip(UNSUPPORTED_CHILD_SKIP), action: 'unsupported' }; }
    const recorded = parent ? childTask(db, thread.id, parent) : '';
    if (parent && !recorded && !thread.isSubagent) { log(UNSUPPORTED_EDGE_LOG); return { ...skip(UNSUPPORTED_CHILD_SKIP), action: 'unsupported' }; }
    const childGuard = parent ? " AND item_type <> 'userMessage'" : '';
    const rows = db.prepare(`SELECT ${ITEM_PROJECTION} AS item_json,item_type,created_at_ms,completed_at_ms FROM thread_items WHERE thread_id=? AND item_type IN (${TYPE_SQL})${childGuard} ORDER BY rollout_ordinal LIMIT ?`).all(thread.id, ...TYPES, MAX_ROWS + 1);
    if (rows.length > MAX_ROWS) throw capability('native history exceeds row budget');
    // A placeholder stands in for a task only above the delegate's own activity;
    // a delegate that did nothing would otherwise become a note of one synthetic line.
    if (parent && !recorded && !rows.length) return skip('subagent did nothing; assignment not recorded');
    if (parent && !recorded) log(PLACEHOLDER_LOG);
    const ownTask = parent ? (recorded || placeholderAssignment(thread)) : '';
    const entries = entriesFromItems(rows, thread, ownTask, { env });
    if (Date.now() >= deadlineAt) return skip('capture budget spent');
    const children = [...parentById.entries()].filter(([, parentId]) => parentId === thread.id).map(([id]) => `session-${qualify(id)}`);
    return captureSession({ input: { ...input, sessionId: qualify(thread.id), parentSession: parent ? qualify(parent) : '', endReason },
      entries, vaultRoot, env, runGit, deadlineAt, capturedBy, stateDir,
      runtime: 'codex', agent: 'codex', model: thread.model || '', provider: thread.model_provider || '',
      origin: thread.originator || 'codex', generator: 'codex-session-capture.mjs 1.0.0',
      briefSessionId: thread.id, parentSession: parent ? qualify(parent) : '', childSessions: children, promptTask: ownTask });
  } catch (error) {
    log(error.code === 'CODEX_SQLITE_CAPABILITY' ? error.message : 'Codex SQLite capability unavailable: native history could not be read');
    return skip(error.code === 'CODEX_SQLITE_CAPABILITY' ? error.message : 'native history could not be read');
  } finally { state?.close(); db?.close(); }
}

/** Discovery never selects item_json. authoritativeIds includes old paginated IDs. */
export function discoverCodexSqliteSessions({ home = os.homedir(), vaultRoot, env = process.env, since = 0,
  log = () => {}, openDatabase = openNativeDatabase, runGit, stateDir, capturedBy = 'sweep' } = {}) {
  const candidates = [];
  candidates.authoritativeIds = new Set();
  // One line per distinct capability message per run: fifty delegated threads
  // with the same gap used to write fifty identical lines every five minutes.
  const seenMessages = new Set();
  const logOnce = message => { if (seenMessages.has(message)) return; seenMessages.add(message); log(message); };
  const stateFile = path.join(home, '.codex', 'state_5.sqlite');
  const historyFile = path.join(home, '.codex', 'thread_history_1.sqlite');
  if (!fs.existsSync(stateFile)) return candidates;
  let state;
  let history;
  try {
    state = openDatabase(stateFile, { readOnly: true });
    state.prepare('BEGIN').run();
    const { rows, threads, parentById } = readThreadMetadata(state);
    for (const row of rows) {
      if (row.history_mode === 'paginated' && isSafeFilenameSegment(row.id)) candidates.authoritativeIds.add(row.id);
    }
    if (fs.existsSync(historyFile)) history = openDatabase(historyFile, { readOnly: true });
    for (const thread of rows) {
      if (thread.history_mode !== 'paginated' || !isSafeFilenameSegment(thread.id)) continue;
      const policy = policyFor(thread, threads, parentById, historyFile, env);
      if (!policy.allowed) continue;
      const stats = history?.prepare('SELECT count(*) AS items,max(updated_at_ordinal) AS updated_ordinal,max(rollout_ordinal) AS ordinal,max(created_at_ms) AS latest_ms,max(rowid) AS latest_row FROM thread_items WHERE thread_id=?').get(thread.id) || {};
      const turn = history?.prepare('SELECT status,started_at,completed_at,rollout_ordinal FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(thread.id) || {};
      if (Math.max(millis(thread.updated_at_ms), millis(stats.latest_ms), millis(turn.completed_at)) < Number(since || 0)) continue;
      // A delegate's revision includes its parent's collab items: a spawn record that
      // lands after the child's first capture must replace the placeholder task.
      const parentId = parentById.get(thread.id) || '';
      const parentCollab = parentId && history ? history.prepare("SELECT count(*) AS items,max(rowid) AS latest_row FROM thread_items WHERE thread_id=? AND item_type IN ('collabAgentToolCall','collabToolCall')").get(parentId) || {} : {};
      const fingerprint = JSON.stringify([thread.updated_at_ms, thread.cwd, thread.model, thread.model_provider, stats.items, stats.updated_ordinal, stats.ordinal, stats.latest_ms, stats.latest_row, turn.status, turn.started_at, turn.completed_at, parentCollab.items, parentCollab.latest_row]);
      const input = baseInput(thread, parentById, historyFile);
      candidates.push({ runtime: 'codex', sessionId: qualify(thread.id), nativeSessionId: thread.id,
        sourceKind: 'sqlite', authoritative: true, cwd: input.cwd, input, fingerprint,
        capture: options => captureNative({ thread, threads, parentById, stateFile, historyFile, vaultRoot, env,
          openDatabase, log: logOnce, runGit, stateDir, capturedBy, ...options }) });
    }
    return candidates;
  } catch (error) {
    log('Codex SQLite capability unavailable: metadata schema could not be read');
    if (error.code === 'CODEX_SQLITE_CAPABILITY') throw error;
    throw capability('metadata schema could not be read');
  } finally { history?.close(); state?.close(); }
}

/** null means no authoritative native thread; other failures must not use stale rollouts. */
export function captureCodexSqliteSession({ sessionId, endReason = 'resume', deadlineAt, ...options }) {
  const candidates = discoverCodexSqliteSessions({ ...options, since: 0 });
  const candidate = candidates.find(item => item.nativeSessionId === nativeId(sessionId));
  if (candidate) return candidate.capture({ deadlineAt, endReason });
  if (candidates.authoritativeIds.has(nativeId(sessionId))) return { written: false, action: 'excluded', skip: 'native session excluded from memory', touchedPaths: [], vaultRoot: options.vaultRoot };
  return null;
}
