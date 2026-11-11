/** Recover idle Codex main chats whose SessionEnd hook never fired. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSubagentHead, readCodexHead } from './codex-head.mjs';
import { RESUME_REASON } from './constants.mjs';
import { describeHolder, holderAgeMinutes } from './realm-lock.mjs';
import { indexNotedSessions, withRealmLocks } from './sweep.mjs';
import { isSafeFilenameSegment } from './text.mjs';

const HOUR_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 20 * HOUR_MS;
const IDLE_MS = 6 * HOUR_MS;
/** Leaves room for the queue drain inside the scheduled task's 30-minute limit. */
const SWEEP_BUDGET_MS = 15 * 60 * 1000;
const CAPTURE_BUDGET_MS = 30_000;
const LOCK_OWNER = 'codex sweep';
/** Skips that fail every transcript alike: stop scanning and keep the sweep due. */
const SWEEP_BLOCKING_SKIPS = new Set(['vault unavailable']);
/** Skips that mean "nothing to capture", not a failure. */
const QUIET_SKIPS = new Set(['no human prompts']);

function* transcriptFiles(root) {
  if (!fs.existsSync(root)) return;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield file;
    }
  }
}

function readCheckpoints(stateDir, vaultRoot) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'codex-checkpoints.json'), 'utf8'));
    return state.vaultRoot === path.resolve(vaultRoot) ? state.transcripts ?? {} : {};
  } catch { return {}; } // Absent or damaged cache: re-capture, never skip data.
}

/** Commit only after changed notes have been durably queued for ingestion. */
export function saveCodexCheckpoints({ stateDir = path.join(os.homedir(), '.harness'), vaultRoot, checkpoints }) {
  const file = path.join(stateDir, 'codex-checkpoints.json');
  const transcripts = { ...readCheckpoints(stateDir, vaultRoot), ...checkpoints };
  fs.mkdirSync(stateDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ vaultRoot: path.resolve(vaultRoot), transcripts }));
  fs.renameSync(temporary, file);
}

/**
 * The idle recovery mode captures only unnoted chats. Checkpoint mode also
 * revisits changed chats and keeps them active, including chats still open.
 * Its cache records the pre-read file fingerprint so appends during capture
 * are picked up on the next pass. The caller saves it after queueing notes.
 *
 * The 20-hour marker is written unless the run was blocked (vault missing),
 * deferred by a realm lock, or cut short by its time budget; per-transcript
 * errors are logged and retried at the next due sweep.
 */
export function sweepCodex({ home = os.homedir(), vaultRoot, capture, now = Date.now(),
  checkpoint = false, minIdleMs = checkpoint ? 0 : IDLE_MS,
  stateDir = path.join(home, '.harness'), force = false, log = () => {},
  budgetMs = SWEEP_BUDGET_MS, clock = Date.now }) {
  const marker = path.join(stateDir, 'codex-sweep-last.txt');
  if (!checkpoint && !force && fs.existsSync(marker) && now - fs.statSync(marker).mtimeMs < SWEEP_INTERVAL_MS) {
    return { scanned: 0, eligible: 0, written: 0, errors: 0, deferred: 0, touchedPaths: [], due: false };
  }
  const summary = { scanned: 0, eligible: 0, written: 0, errors: 0, deferred: 0, touchedPaths: [], checkpoints: {},
    due: true, blocked: false, truncated: false };
  const noted = indexNotedSessions(vaultRoot);
  const saved = checkpoint ? readCheckpoints(stateDir, vaultRoot) : {};
  const stopAt = clock() + budgetMs;
  roots: for (const root of [path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions')]) {
    for (const file of transcriptFiles(root)) {
      if (clock() > stopAt) {
        summary.truncated = true;
        log('sweep budget spent; the rest waits for the next run');
        break roots;
      }
      summary.scanned += 1;
      try {
        const stat = fs.statSync(file);
        const fingerprint = `${stat.mtimeMs}:${stat.size}`;
        if (minIdleMs > 0 && now - stat.mtimeMs < minIdleMs) continue;
        const { record: head, error: headError } = readCodexHead(file);
        if (!head) {
          summary.errors += 1;
          log(`sweep skip ${path.basename(file)}: transcript head ${headError}`);
          continue;
        }
        if (isSubagentHead(head)) continue;
        const sessionId = String(head.payload?.id || head.payload?.session_id || '');
        if (!isSafeFilenameSegment(sessionId)) continue;
        if (checkpoint ? saved[sessionId] === fingerprint && noted.has(`codex-${sessionId}`) : noted.has(`codex-${sessionId}`)) continue;
        summary.eligible += 1;
        const cwd = head.payload?.cwd || '';
        const outcome = withRealmLocks({ cwd, vaultRoot, log, owner: LOCK_OWNER, sessions: [{ sessionId: `codex-${sessionId}`, briefSessionId: sessionId }] },
          () => capture({ input: { sessionId, transcriptPath: file, cwd, hookEventName: 'SessionEnd',
            endReason: checkpoint ? RESUME_REASON : 'other' }, vaultRoot,
            deadlineAt: clock() + CAPTURE_BUDGET_MS, capturedBy: 'sweep' }),
          (realm, acquired) => {
            const holder = acquired.holder ? `${describeHolder(acquired.holder)}, ${holderAgeMinutes(acquired.holder)} min` : acquired.error;
            return { written: false, action: 'deferred', skip: `realm ${realm} locked (${holder})`, touchedPaths: [] };
          });
        if (outcome.written) {
          summary.written += 1;
          summary.touchedPaths.push(...outcome.touchedPaths);
        } else if (outcome.action === 'deferred') {
          summary.deferred += 1;
          log(`sweep deferred ${sessionId}: ${outcome.skip}`);
        } else if (outcome.action === 'skip' && !QUIET_SKIPS.has(outcome.skip)) {
          summary.errors += 1;
          log(`sweep skip ${sessionId}: ${outcome.skip}`);
          if (SWEEP_BLOCKING_SKIPS.has(outcome.skip)) {
            summary.blocked = true;
            break roots;
          }
        }
        if (checkpoint && (outcome.written || outcome.action === 'noop')) {
          summary.checkpoints[sessionId] = fingerprint;
          // A previous process may have died between saving the note and queueing
          // it. Requeue successful candidates even when this capture is a no-op.
          if (outcome.notePath && !summary.touchedPaths.includes(outcome.notePath)) summary.touchedPaths.push(outcome.notePath);
        }
      } catch (error) {
        summary.errors += 1;
        log(`sweep error ${path.basename(file)}: ${error?.message || error}`);
      }
    }
  }
  if (!checkpoint && !summary.blocked && !summary.truncated && !summary.deferred) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(marker, new Date(now).toISOString());
  }
  return summary;
}
