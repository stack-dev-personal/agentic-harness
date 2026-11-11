/** Native file discovery and lifecycle translation; shared worker owns checkpoint policy. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from './capture.mjs';
import { captureSubagent } from './subagent.mjs';
import { captureCodex } from '../codex-session-capture.mjs';
import { discoverCodexSqliteSessions } from './codex-sqlite.mjs';
import { readCodexHead, isSubagentHead } from './codex-head.mjs';
import { fileSession } from './filing.mjs';
import { hostPathFlavor } from './host-paths.mjs';
import { defaultStateDir } from './session-start.mjs';
import { MAIN_TRANSCRIPT_MAX_BYTES } from './constants.mjs';
import { sessionMemoryEligibility } from './memory-policy.mjs';
import { readEntries } from './transcript.mjs';
import { readTranscriptHead } from './transcript-head.mjs';
import { listCandidateTranscripts, listSubagentTranscripts, withRealmLocks } from './sweep.mjs';

function* files(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile() && file.endsWith('.jsonl')) yield file;
  }
}

/**
 * `lockSessions` are the ids the capture files by (filing.mjs): its own, and
 * the parent and ancestors it may be placed beside. Their notes' and records'
 * realms are locked with the cwd's, so the write never lands in a realm the
 * worker does not hold.
 */
function wrapped({ lockSessions, ...candidate }, { vaultRoot, env, log }) {
  const invoke = candidate.capture;
  return { ...candidate, capture: ({ deadlineAt }) => {
    const policy = sessionMemoryEligibility({ input: { ...candidate.input, runtime: candidate.runtime }, env });
    if (!policy.allowed) return { written: false, action: 'excluded', skip: policy.reason, touchedPaths: [] };
    return withRealmLocks({ cwd: candidate.input.cwd, vaultRoot, log, owner: 'memory checkpoint', env, sessions: lockSessions },
      () => invoke({ deadlineAt }), () => ({ written: false, action: 'deferred', touchedPaths: [] }));
  } };
}

export function discoverClaudeSessions({ home = os.homedir(), vaultRoot, env = process.env, since = 0, log = () => {} }) {
  const projectsRoot = path.join(home, '.claude', 'projects');
  const { candidates } = listCandidateTranscripts({ projectsRoot, noted: new Set(), minIdleMs: 0, now: Date.now() + 1000 });
  const result = [];
  for (const candidate of candidates) {
    const stat = fs.statSync(candidate.transcriptPath);
    const head = readTranscriptHead(candidate.transcriptPath);
    const input = { ...candidate, cwd: head.cwd, hookEventName: 'SessionEnd', endReason: 'resume' };
    if (candidate.mtimeMs >= since) result.push(wrapped({ runtime: 'claude-code', sessionId: candidate.sessionId, fingerprint: `${stat.mtimeMs}:${stat.size}`, input,
      lockSessions: [{ sessionId: candidate.sessionId }],
      place: () => fileSession({ sessionId: candidate.sessionId, cwd: input.cwd, vaultRoot, env, stateDir: defaultStateDir(env) }),
      capture: ({ deadlineAt }) => capture({ input, vaultRoot, projectsRoot, deadlineAt, capturedBy: 'sweep', env }),
    }, { vaultRoot, env, log }));
    for (const worker of listSubagentTranscripts(candidate.transcriptPath, candidate.sessionId)) {
      const childStat = fs.statSync(worker.agentTranscriptPath);
      if (childStat.mtimeMs < since) continue;
      const childInput = { ...input, ...worker, hookEventName: 'SubagentStop' };
      result.push(wrapped({ runtime: 'claude-code', sessionId: `${candidate.sessionId}--${worker.agentId}`,
        fingerprint: `${childStat.mtimeMs}:${childStat.size}`, input: childInput,
        lockSessions: [{ sessionId: `${candidate.sessionId}--${worker.agentId}` }, { sessionId: candidate.sessionId }],
        // A worker files beside its parent: the parent's placement is the preview's answer.
        place: () => fileSession({ sessionId: candidate.sessionId, cwd: input.cwd, vaultRoot, env, stateDir: defaultStateDir(env) }),
        capture: ({ deadlineAt }) => captureSubagent({ input: childInput, vaultRoot, projectsRoot, deadlineAt, capturedBy: 'sweep', env }),
      }, { vaultRoot, env, log }));
    }
  }
  return result;
}

/** A delegated task comes from the parent's explicit spawn call, never inherited child user context. */
function ownCodexTask(child, parent, deadlineAt) {
  if (!parent) return '';
  const agentPath = child.head.payload?.source?.subagent?.thread_spawn?.agent_path || '';
  const taskName = agentPath.split('/').at(-1);
  const records = readEntries(parent.file, MAIN_TRANSCRIPT_MAX_BYTES, deadlineAt);
  for (const record of records) {
    const payload = record.payload;
    if (!/spawn_agent$/.test(payload?.name || '')) continue;
    let args;
    try { args = JSON.parse(payload.arguments); } catch { continue; }
    if (args.task_name === taskName && typeof args.message === 'string') return args.message;
  }
  return '';
}

export function discoverCodexSessions({ home = os.homedir(), vaultRoot, env = process.env, since = 0, log = () => {} }) {
  // A worker reading another host's sessions never opens its live Codex
  // database: a read-only open of a WAL database across a host bind is not
  // safe. The rollout files below cover those sessions.
  const native = hostPathFlavor(env) ? Object.assign([], { authoritativeIds: new Set() })
    : discoverCodexSqliteSessions({ home, vaultRoot, env, since, log });
  const all = new Map();
  for (const root of ['sessions', 'archived_sessions']) for (const file of files(path.join(home, '.codex', root))) {
    const stat = fs.statSync(file);
    const { record: head } = readCodexHead(file);
    if (!head?.payload?.id) { log('Codex transcript metadata unavailable'); continue; }
    if (native.authoritativeIds.has(head.payload.id)) continue;
    all.set(head.payload.id, { file, head, stat });
  }
  return [...native, ...[...all.entries()].filter(([, record]) => record.stat.mtimeMs >= since).map(([id, record]) => {
    const parentId = record.head.payload.parent_thread_id || record.head.payload.source?.subagent?.thread_spawn?.parent_thread_id;
    const ancestorSessions = [];
    let parent = parentId;
    while (parent && !ancestorSessions.includes(parent) && ancestorSessions.length < 128) {
      ancestorSessions.push(parent);
      const metadata = all.get(parent)?.head.payload;
      parent = metadata?.parent_thread_id || metadata?.source?.subagent?.thread_spawn?.parent_thread_id;
    }
    const input = { sessionId: id, parentSession: parentId || '', ancestorSessions, transcriptPath: record.file, cwd: record.head.payload.cwd || '', hookEventName: 'SessionEnd', endReason: 'resume' };
    return wrapped({ runtime: 'codex', sessionId: `codex-${id}`, fingerprint: `${record.stat.mtimeMs}:${record.stat.size}`, input,
      lockSessions: [id, ...ancestorSessions].map((each) => ({ sessionId: `codex-${each}`, briefSessionId: each })),
      place: () => fileSession({ sessionId: `codex-${id}`, briefSessionId: id, cwd: input.cwd, vaultRoot, env, stateDir: defaultStateDir(env),
        ancestors: ancestorSessions.map((each) => ({ sessionId: `codex-${each}`, briefSessionId: each })) }),
      capture: ({ deadlineAt }) => captureCodex({ input, home, vaultRoot, env, deadlineAt, capturedBy: 'sweep', allowSubagent: true,
        ownTask: isSubagentHead(record.head) ? ownCodexTask(record, all.get(parentId), deadlineAt) : '',
        childSessions: [...all.entries()].filter(([, child]) => child.head.payload.parent_thread_id === id).map(([childId]) => `session-codex-${childId}`),
      }),
    }, { vaultRoot, env, log });
  })];
}
