/** Incremental capture is shared; adapters supply native discovery and parsing. */
import fs from 'node:fs';
import path from 'node:path';
import { hostSettings } from './host-settings.mjs';
import { persist } from './notes-io.mjs';
import { fromVaultRelative, relativeToKey, toVaultRelative, vaultKeyOf } from './vault-relative.mjs';
import { harnessDir } from './machine-env.mjs';

/**
 * Bumped whenever an adapter learns to write a thread it used to report as
 * unsupported. A remembered verdict from an older generation is looked at again
 * once; one from the current generation is trusted until the native revision
 * changes. Generation 2: Codex delegated threads without a recorded assignment
 * are written (2026-11-04).
 */
export const UNSUPPORTED_GENERATION = 2;

/**
 * State file version 2: `{version: 2, vaults: {<key>: {checkpoints}}}`, each
 * vault keyed by its root as the host spells it (`vaultKeyOf`) and each
 * checkpoint's `paths` stored inside the vault (`area/collection/...`). The
 * host and a container that mounts the same vault elsewhere then share one
 * entry, and a save keeps every other vault's. Version 1 was
 * `{vaultRoot, checkpoints}` with absolute paths; it is read as one vault.
 */
const STATE_FILE = 'memory-checkpoints.json';
const STATE_VERSION = 2;

/** This side's key for `vaultRoot`: under a host path flavor the host's own spelling. */
function vaultKey(vaultRoot, env) {
  const host = hostSettings(env);
  return vaultKeyOf(host ? host.vault : path.resolve(vaultRoot));
}

/** One checkpoint with each path in stored form; a path outside the vault is dropped. */
function storedCheckpoint(checkpoint, toStored) {
  const paths = Array.isArray(checkpoint?.paths) ? checkpoint.paths.map(toStored).filter(Boolean) : [];
  return { ...checkpoint, paths };
}

function mapValues(object, map) {
  return Object.fromEntries(Object.entries(object && typeof object === 'object' ? object : {}).map(([key, value]) => [key, map(value)]));
}

/** Every vault in the file, version 2 in shape whatever version it was written in. */
function loadVaults(stateDir) {
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILE), 'utf8')); } catch { return {}; }
  if (state?.version === STATE_VERSION && state.vaults && typeof state.vaults === 'object' && !Array.isArray(state.vaults)) return state.vaults;
  if (typeof state?.vaultRoot !== 'string') return {};
  const key = vaultKeyOf(state.vaultRoot);
  return { [key]: { checkpoints: mapValues(state.checkpoints, (checkpoint) => storedCheckpoint(checkpoint, (file) => relativeToKey(file, key))) } };
}

/** This vault's checkpoints, with paths as this side's own. */
function readState(stateDir, vaultRoot, env) {
  const stored = loadVaults(stateDir)[vaultKey(vaultRoot, env)]?.checkpoints;
  return mapValues(stored, (checkpoint) => ({ ...checkpoint,
    paths: (Array.isArray(checkpoint?.paths) ? checkpoint.paths : []).map((file) => fromVaultRelative(file, vaultRoot)) }));
}

export function saveMemoryCheckpoints({ stateDir = harnessDir(), vaultRoot, checkpoints, env = process.env }) {
  const vaults = loadVaults(stateDir);
  const key = vaultKey(vaultRoot, env);
  const fresh = mapValues(checkpoints, (checkpoint) => storedCheckpoint(checkpoint, (file) => toVaultRelative(file, vaultRoot)));
  const state = { version: STATE_VERSION, vaults: { ...vaults, [key]: { checkpoints: { ...vaults[key]?.checkpoints, ...fresh } } } };
  const written = persist(path.join(stateDir, STATE_FILE), JSON.stringify(state));
  if (!written.ok) throw new Error(`checkpoint state write failed (${written.error})`);
}

/** The caller commits fingerprints only after every successful candidate has a durable queue entry. */
export function checkpointSessions({ candidates, vaultRoot, stateDir = harnessDir(),
  budgetMs = 15 * 60 * 1000, clock = Date.now, log = () => {}, env = process.env }) {
  const saved = readState(stateDir, vaultRoot, env);
  const result = { scanned: 0, eligible: 0, written: 0, errors: 0, excluded: 0, unsupported: 0, deferred: 0, truncated: false, touchedPaths: [], checkpoints: {} };
  const deadline = clock() + budgetMs;
  for (const candidate of candidates) {
    if (clock() >= deadline) { result.truncated = true; break; }
    result.scanned += 1;
    const key = `${candidate.runtime}:${candidate.sessionId}`;
    const previous = saved[key];
    if (previous?.fingerprint === candidate.fingerprint) {
      // An unsupported thread is remembered at its native revision: the same
      // history gives the same answer, so it is counted without being reopened.
      if (previous.unsupported && previous.generation === UNSUPPORTED_GENERATION) { result.unsupported += 1; continue; }
      if (previous.paths?.length && previous.paths.every(file => fs.existsSync(file))) continue;
    }
    result.eligible += 1;
    try {
      const outcome = candidate.capture({ deadlineAt: Math.min(deadline, clock() + 30_000) });
      if (outcome.action === 'excluded') { result.excluded += 1; continue; }
      // A runtime that cannot supply what a note needs (a delegated Codex thread
      // with no resolvable parent) is reported, not retried as a failure.
      if (outcome.action === 'unsupported') {
        result.unsupported += 1;
        result.checkpoints[key] = { fingerprint: candidate.fingerprint, paths: [], unsupported: true, generation: UNSUPPORTED_GENERATION };
        continue;
      }
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
