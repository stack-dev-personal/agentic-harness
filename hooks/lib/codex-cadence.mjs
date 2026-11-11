/** Incremental snapshots of local main chats, including chats still open. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexHead, isSubagentHead } from './codex-head.mjs';
import { RESUME_REASON } from './constants.mjs';
import { withRealmLocks } from './sweep.mjs';
import { isSafeFilenameSegment } from './text.mjs';
import { harnessDir } from './machine-env.mjs';

export function captureChangedCodex({ home = os.homedir(), vaultRoot, capture, queue,
  stateDir = harnessDir(home), log = () => {}, budgetMs = 120000 }) {
  const stateFile = path.join(stateDir, 'codex-cadence.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') log('cadence state unreadable; rechecking transcripts'); }
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  const result = { scanned: 0, captured: 0, unchanged: 0, errors: 0, deferred: 0 };
  const deadline = Date.now() + budgetMs;
  const pending = ['sessions', 'archived_sessions'].map(name => path.join(home, '.codex', name));
  while (pending.length && Date.now() < deadline) {
    const dir = pending.pop();
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (Date.now() >= deadline) { result.deferred++; break; }
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { pending.push(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      result.scanned++;
      try {
        const stat = fs.statSync(file);
        const stamp = `${stat.size}:${stat.mtimeMs}`;
        if (state[file] === stamp) { result.unchanged++; continue; }
        const { record: head } = readCodexHead(file);
        if (!head) { result.errors++; continue; }
        if (isSubagentHead(head)) { state[file] = stamp; continue; }
        const sessionId = String(head.payload?.id || head.payload?.session_id || '');
        if (!isSafeFilenameSegment(sessionId)) { result.errors++; continue; }
        const cwd = head.payload?.cwd || '';
        const outcome = withRealmLocks({ cwd, vaultRoot, log, owner: 'codex cadence', sessions: [{ sessionId: `codex-${sessionId}`, briefSessionId: sessionId }] },
          () => capture({ input: { sessionId, transcriptPath: file, cwd,
            hookEventName: 'SessionEnd', endReason: RESUME_REASON }, vaultRoot,
            deadlineAt: Math.min(deadline, Date.now() + 30000), capturedBy: 'sweep' }),
          () => ({ action: 'deferred' }));
        if (outcome.action === 'deferred') { result.deferred++; continue; }
        if (outcome.written || outcome.action === 'noop') {
          const notePaths = outcome.touchedPaths?.length ? outcome.touchedPaths : [outcome.notePath].filter(Boolean);
          const queued = queue({ notePaths, vaultRoot, log, startTask: false });
          if (!queued.queued) { result.errors++; continue; }
          if (outcome.written) result.captured++;
        } else if (outcome.action !== 'noop' && outcome.skip !== 'no human prompts') {
          result.errors++;
          continue;
        }
        state[file] = stamp;
      } catch (error) { result.errors++; log(`cadence error: ${error.code || error.name}`); }
    }
  }
  if (pending.length) result.deferred++;
  fs.mkdirSync(stateDir, { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state));
  fs.renameSync(temp, stateFile);
  return result;
}
