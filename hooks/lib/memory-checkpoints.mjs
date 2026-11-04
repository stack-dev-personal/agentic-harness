/** Incremental capture is shared; adapters supply native discovery and parsing. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persist } from './notes-io.mjs';

function readState(stateDir, vaultRoot) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'memory-checkpoints.json'), 'utf8'));
    return state.vaultRoot === path.resolve(vaultRoot) ? state.checkpoints ?? {} : {};
  } catch { return {}; }
}

export function saveMemoryCheckpoints({ stateDir = path.join(os.homedir(), '.harness'), vaultRoot, checkpoints }) {
  const state = { vaultRoot: path.resolve(vaultRoot), checkpoints: { ...readState(stateDir, vaultRoot), ...checkpoints } };
  const written = persist(path.join(stateDir, 'memory-checkpoints.json'), JSON.stringify(state));
  if (!written.ok) throw new Error(`checkpoint state write failed (${written.error})`);
}

/** The caller commits fingerprints only after every successful candidate has a durable queue entry. */
export function checkpointSessions({ candidates, vaultRoot, stateDir = path.join(os.homedir(), '.harness'),
  budgetMs = 15 * 60 * 1000, clock = Date.now, log = () => {} }) {
  const saved = readState(stateDir, vaultRoot);
  const result = { scanned: 0, eligible: 0, written: 0, errors: 0, excluded: 0, deferred: 0, truncated: false, touchedPaths: [], checkpoints: {} };
  const deadline = clock() + budgetMs;
  for (const candidate of candidates) {
    if (clock() >= deadline) { result.truncated = true; break; }
    result.scanned += 1;
    const key = `${candidate.runtime}:${candidate.sessionId}`;
    const previous = saved[key];
    if (previous?.fingerprint === candidate.fingerprint && previous.paths?.length && previous.paths.every(file => fs.existsSync(file))) continue;
    result.eligible += 1;
    try {
      const outcome = candidate.capture({ deadlineAt: Math.min(deadline, clock() + 30_000) });
      if (outcome.action === 'excluded') { result.excluded += 1; continue; }
      if (outcome.action === 'deferred') { result.deferred += 1; continue; }
      if (!(outcome.written || outcome.action === 'noop')) {
        if (!/no (?:human|user) prompts|subagent did nothing/.test(outcome.skip || '')) result.errors += 1;
        continue;
      }
      if (outcome.written) result.written += 1;
      const paths = [...new Set([...(outcome.touchedPaths || []), outcome.notePath, ...(previous?.paths || [])].filter(file => file && fs.existsSync(file)))];
      result.touchedPaths.push(...paths);
      result.checkpoints[key] = { fingerprint: candidate.fingerprint, paths };
    } catch { result.errors += 1; log(`capture failed (${candidate.runtime})`); }
  }
  result.touchedPaths = [...new Set(result.touchedPaths)];
  return result;
}
