#!/usr/bin/env node
/** One scheduled checkpoint and ingestion worker for every agent runtime. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverClaudeSessions, discoverCodexSessions } from './lib/runtime-adapters.mjs';
import { checkpointSessions, saveMemoryCheckpoints } from './lib/memory-checkpoints.mjs';
import { drainIngest, queueIngest } from './lib/ingest-queue.mjs';
import { PERSISTENCE_DISABLED, memoryEligibility, sessionMemoryEligibility } from './lib/memory-policy.mjs';
import { harnessDir, loadMachineEnv } from './lib/machine-env.mjs';
import { hostPathFlavor } from './lib/host-paths.mjs';
import { hostSettings } from './lib/host-settings.mjs';
import { installExtraRulesFrom } from './lib/redact-extra.mjs';
import { createLogger } from './lib/logger.mjs';
import { acquirePathLock, releaseRealmLock } from './lib/realm-lock.mjs';
import { persist } from './lib/notes-io.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { withRealmLocks } from './lib/sweep.mjs';
import { baselineCodex } from './lib/memory-baseline.mjs';

function activationTime(stateDir, now, preview) {
  const file = path.join(stateDir, 'memory-activation.json');
  if (fs.existsSync(file)) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')).since;
    if (!Number.isFinite(value)) throw new Error('invalid memory activation time');
    return value;
  }
  // Existing history requires a separate preview and approval. Recent live
  // activity is eligible without walking older sessions into the vault.
  const since = now - 5 * 60_000;
  if (!preview) {
    const result = persist(file, JSON.stringify({ since, activatedAt: new Date(now).toISOString() }));
    if (!result.ok) throw new Error('memory activation state could not be saved');
  }
  return since;
}

export async function discoverMemorySessions({ home, vaultRoot, stateDir, env, now = Date.now(), preview = false, log }) {
  const since = activationTime(stateDir, now, preview);
  const args = { home, vaultRoot, env, since, log };
  const candidates = [];
  candidates.capabilities = [];
  for (const [runtime, discover] of [['claude-code', discoverClaudeSessions], ['codex', discoverCodexSessions]]) {
    try { candidates.push(...discover(args)); candidates.capabilities.push({ runtime, available: true }); }
    catch { candidates.capabilities.push({ runtime, available: false }); log(`native discovery unavailable (${runtime}); other runtimes continue`); }
  }
  const hermesHome = env.HARNESS_HERMES_HOME || (process.platform === 'win32'
    ? path.join(home, 'AppData', 'Local', 'hermes') : path.join(home, '.hermes'));
  if (hostPathFlavor(env)) {
    // A worker reading another host's sessions does not read Hermes: its
    // database is not mounted there, and its own session hook still captures.
    candidates.capabilities.push({ runtime: 'hermes', available: false, installed: false, reason: 'not read under a host path flavor' });
  } else if (fs.existsSync(hermesHome)) {
    try {
    const { discoverHermesSessions, readHermesSession, captureHermes } = await import('./hermes-session-capture.mjs');
    for (const candidate of discoverHermesSessions({ hermesHome, log })) {
      candidates.push({ ...candidate, runtime: 'hermes', capture: ({ deadlineAt }) => {
        const policy = memoryEligibility({ input: { ...candidate, runtime: 'hermes' }, env });
        if (!policy.allowed) return { written: false, action: 'excluded', touchedPaths: [] };
        return withRealmLocks({ cwd: candidate.cwd, vaultRoot, log, owner: 'memory checkpoint', env,
          // A delegate is filed beside its parent or an older ancestor: lock their realms too.
          sessions: [candidate.sessionId, candidate.parentSession, ...(candidate.ancestorSessions || [])]
            .filter(Boolean).map((sessionId) => ({ sessionId })) }, () => {
          const { snapshot } = readHermesSession({ hermesHome, sessionId: candidate.nativeSessionId, env });
          return captureHermes({ snapshot, vaultRoot, env, deadlineAt, capturedBy: 'sweep' });
        }, () => ({ written: false, action: 'deferred', touchedPaths: [] }));
      } });
    }
    candidates.capabilities.push({ runtime: 'hermes', available: true });
    } catch { candidates.capabilities.push({ runtime: 'hermes', available: false }); log('native discovery unavailable (hermes); other runtimes continue'); }
  } else {
    candidates.capabilities.push({ runtime: 'hermes', available: false, installed: false });
  }
  return candidates;
}

/**
 * What `--preview` says about one session: where it would be filed and why
 * (`basis`: note, record, parent or rules), or only that it is excluded. Folder
 * names and ids, never content, so host and container previews can be diffed.
 */
function previewOf(candidate, env) {
  const base = { runtime: candidate.runtime, sessionId: candidate.sessionId };
  if (candidate.input && !sessionMemoryEligibility({ input: { ...candidate.input, runtime: candidate.runtime }, env }).allowed) return { ...base, excluded: true };
  if (typeof candidate.place !== 'function') return base;
  try {
    const { area, collection, basis } = candidate.place();
    return { ...base, area, collection, basis };
  } catch (error) {
    return { ...base, conflict: error.message };
  }
}

/**
 * The settings every worker mode needs, or why it must not run: switched off on
 * purpose is a clean no-op; any other reason is a broken setting (a protected
 * root this platform cannot read, an unknown path flavor, a missing host home or
 * vault under a flavor), and the worker must not look healthy while it does nothing.
 */
function prepare({ home, env, log }) {
  const loaded = loadMachineEnv(env, home, log);
  const gate = memoryEligibility({ env: loaded });
  if (!gate.allowed) {
    if (gate.reason === PERSISTENCE_DISABLED) return { stop: { disabled: true, failed: 0 } };
    log(`memory worker blocked: ${gate.reason}; nothing was captured or ingested`);
    return { stop: { disabled: true, failed: 1 } };
  }
  try { hostSettings(loaded); } catch (error) {
    log(`memory worker blocked: ${error.message}; nothing was captured or ingested`);
    return { stop: { disabled: true, failed: 1 } };
  }
  installExtraRulesFrom(loaded, log);
  const stateDir = harnessDir(home);
  fs.mkdirSync(stateDir, { recursive: true });
  return { loaded, stateDir, vaultRoot: loaded.HARNESS_VAULT || path.join(home, 'vault') };
}

const lockWorker = (stateDir) => acquirePathLock(path.join(stateDir, 'memory-worker.lock'), { owner: 'memory worker', staleMs: 90 * 60_000 });

/**
 * `--baseline codex`: record each Codex rollout that its note already covers as
 * captured (memory-baseline.mjs), so a worker that switches from the database
 * to the rollouts does not recapture them. Run once at cutover, after the host
 * worker's last run. `dryRun` counts without saving.
 */
export async function runCodexBaseline({ home = os.homedir(), env = process.env, log = () => {}, dryRun = false } = {}) {
  const ready = prepare({ home, env, log });
  if (ready.stop) return ready.stop;
  const { loaded, stateDir, vaultRoot } = ready;
  const lock = lockWorker(stateDir);
  if (!lock.ok) return { busy: true, failed: 0 };
  try {
    const since = activationTime(stateDir, Date.now(), true);
    const candidates = discoverCodexSessions({ home, vaultRoot, env: loaded, since, log });
    const { checkpoints, counts } = baselineCodex({ candidates, vaultRoot, env: loaded });
    if (!dryRun) saveMemoryCheckpoints({ stateDir, vaultRoot, checkpoints, env: loaded });
    log(`baseline codex${dryRun ? ' (dry run)' : ''}: ${JSON.stringify(counts)}`);
    return { ...counts, saved: !dryRun, failed: counts.unreadable };
  } finally { releaseRealmLock(lock); }
}

/** All hooks use the same queue. Legacy queue names are drained during migration. */
export async function runMemoryWorker({ home = os.homedir(), env = process.env, log = () => {},
  preview = false, candidates: suppliedCandidates, drain = drainIngest, queue = queueIngest } = {}) {
  const ready = prepare({ home, env, log });
  if (ready.stop) return ready.stop;
  const { loaded, stateDir, vaultRoot } = ready;
  const lock = lockWorker(stateDir);
  if (!lock.ok) return { busy: true, failed: 0 };
  try {
    const before = preview ? { ingested: 0, failed: [] } : drain({ env: loaded, log });
    const legacy = preview ? { ingested: 0, failed: [] } : drain({ env: loaded, log, queueName: 'codex-ingest-queue.jsonl' });
    const candidates = suppliedCandidates ?? await discoverMemorySessions({ home, vaultRoot, stateDir, env: loaded, preview, log });
    if (preview) return { candidates: candidates.map((candidate) => previewOf(candidate, loaded)), failed: 0 };
    const result = checkpointSessions({ candidates, vaultRoot, stateDir, log, env: loaded });
    const counts = { 'claude-code': 0, codex: 0, hermes: 0 };
    for (const candidate of candidates) counts[candidate.runtime] = (counts[candidate.runtime] || 0) + 1;
    log(`checkpoint: runtimes=${JSON.stringify(counts)} eligible=${result.eligible} written=${result.written} excluded=${result.excluded} unsupported=${result.unsupported} errors=${result.errors} deferred=${result.deferred}`);
    if (result.touchedPaths.length) {
      const queued = queue({ notePaths: result.touchedPaths, vaultRoot, env: loaded, log, startTask: false });
      if (!queued.queued) throw new Error('checkpoint queue handoff failed; capture will retry');
    }
    saveMemoryCheckpoints({ stateDir, vaultRoot, checkpoints: result.checkpoints, env: loaded });
    const after = drain({ env: loaded, log });
    const capabilities = candidates.capabilities || [];
    const discoveryFailures = capabilities.filter(item => !item.available && item.installed !== false).length;
    const health = { ...result, failed: after.failed.length + legacy.failed.length + result.errors + result.deferred + Number(result.truncated) + discoveryFailures,
      ingested: before.ingested + legacy.ingested + after.ingested };
    persist(path.join(stateDir, 'memory-health.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
      runtimes: counts, capabilities, eligible: result.eligible, written: result.written, excluded: result.excluded, unsupported: result.unsupported,
      errors: result.errors, deferred: result.deferred, failed: health.failed, ingested: health.ingested }));
    return health;
  } finally { releaseRealmLock(lock); }
}

if (isEntryPoint(import.meta.url)) {
  const log = createLogger(path.join(harnessDir(), 'memory-worker.log'));
  try {
    const healthOnly = process.argv.includes('--health');
    const baseline = process.argv.indexOf('--baseline');
    if (baseline !== -1 && process.argv[baseline + 1] !== 'codex') throw new Error('usage: memory-worker.mjs --baseline codex [--dry-run]');
    const result = healthOnly ? JSON.parse(fs.readFileSync(path.join(harnessDir(), 'memory-health.json'), 'utf8'))
      : baseline !== -1 ? await runCodexBaseline({ log, dryRun: process.argv.includes('--dry-run') })
        : await runMemoryWorker({ log, preview: process.argv.includes('--preview') });
    if (healthOnly && Date.now() - Date.parse(result.checkedAt) > 15 * 60_000) result.failed = (result.failed || 0) + 1;
    if (healthOnly || baseline !== -1 || process.argv.includes('--preview')) process.stdout.write(JSON.stringify(result) + '\n');
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    if (/^usage:/.test(error?.message || '')) process.stderr.write(`${error.message}\n`);
    else log('memory worker failed; pending work retained');
    process.exitCode = 1;
  }
}
