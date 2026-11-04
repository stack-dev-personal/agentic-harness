/** One persistence policy for every runtime. Classification is explicit, never inferred from model identity. */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { persist } from './notes-io.mjs';

const DISABLED = /^(?:0|false|off|no|exclude)$/i;
const EXCLUDED_PURPOSES = new Set(['housekeeping', 'observer', 'derivative']);

/** Native callbacks and serialized vault notes use different ancestry aliases. */
function sessionAncestors(input) {
  const ancestors = [];
  for (const key of ['ancestorSessions', 'ancestor_sessions']) {
    if (!Object.hasOwn(input, key)) continue;
    const values = input[key];
    if (!Array.isArray(values) || values.length > 128 || values.some(id => typeof id !== 'string' || !id)) {
      throw new TypeError('invalid session ancestry');
    }
    ancestors.push(...values);
  }
  const unique = [...new Set(ancestors)];
  if (unique.length > 128) throw new TypeError('invalid session ancestry');
  return unique;
}

function exclusionFile(input, env, id) {
  const runtime = input.runtime || input.agent;
  if (!runtime || !id) return '';
  let nativeId = String(id);
  const prefix = `${runtime}-`;
  while (nativeId.startsWith(prefix)) nativeId = nativeId.slice(prefix.length);
  const key = createHash('sha256').update(`${runtime}:${nativeId}`).digest('hex');
  return path.join(env.HARNESS_MEMORY_STATE_DIR || path.join(env.USERPROFILE || os.homedir(), '.harness'), 'memory-exclusions', `${key}.json`);
}

/** A content-free exclusion is sticky across hooks, recovery, and runtime restarts. */
export function recordMemoryExclusion({ input, env = process.env, reason = 'session excluded from memory',
  propagate = ['session excluded from memory', 'restricted session', 'protected path touched'].includes(reason) }) {
  const ids = [input.sessionId || input.session_id,
    ...(propagate ? [input.parentSession || input.parent_session || input.parent_session_id, ...sessionAncestors(input)] : [])];
  for (const id of ids) {
    const file = exclusionFile(input, env, id);
    if (!file) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, JSON.stringify({ excluded: true, reason, taint: propagate }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A privacy restriction can strengthen a previous housekeeping opt-out,
      // while a later ordinary opt-out can never weaken an existing restriction.
      if (propagate && JSON.parse(fs.readFileSync(file, 'utf8')).taint === false) {
        const result = persist(file, JSON.stringify({ excluded: true, reason, taint: true }));
        if (!result.ok) throw new Error('exclusion escalation failed');
      }
    }
  }
}

export function sessionMemoryEligibility(options) {
  const result = memoryEligibility(options);
  if (!result.allowed && ['session excluded from memory', 'restricted session', 'excluded session purpose', 'protected path touched', 'previously excluded session'].includes(result.reason)) {
    try { recordMemoryExclusion({ ...options, reason: result.reason,
      propagate: result.taint || ['session excluded from memory', 'restricted session', 'protected path touched'].includes(result.reason) }); }
    catch { return { allowed: false, reason: 'session exclusion could not be saved; persistence blocked' }; }
  }
  return result;
}

/** Resolve junctions even when a prospective output's last components do not exist. */
export function canonicalPath(file, cwd = process.cwd()) {
  let current = path.resolve(cwd, file);
  const suffix = [];
  while (true) {
    try { return path.join(fs.realpathSync(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function pathWithin(root, file) {
  const relative = path.relative(root, file);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function entryPaths(entries) {
  return entries.flatMap(entry => (Array.isArray(entry.message?.content) ? entry.message.content : [])
    .filter(block => block.type === 'tool_use').flatMap(block => ['file_path', 'notebook_path', 'path']
      .filter(key => typeof block.input?.[key] === 'string').map(key => ({ path: block.input[key], cwd: entry.cwd }))));
}

export function memoryEligibility({ input = {}, env = process.env, paths = [] } = {}) {
  if (DISABLED.test(String(env.HARNESS_MEMORY_PERSISTENCE ?? ''))) return { allowed: false, reason: 'memory persistence disabled' };
  let ancestors;
  try { ancestors = sessionAncestors(input); }
  catch { return { allowed: false, reason: 'invalid session ancestry' }; }
  let previousDecision = null;
  for (const id of [input.sessionId || input.session_id, input.parentSession || input.parent_session || input.parent_session_id,
    ...ancestors]) {
    const file = exclusionFile(input, env, id);
    if (file) {
      try {
        const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
        const decision = { allowed: false, reason: 'previously excluded session', taint: previous.taint ?? previous.reason !== 'excluded session purpose' };
        if (!previousDecision || decision.taint) previousDecision = decision;
      }
      catch (error) { if (error.code !== 'ENOENT') return { allowed: false, reason: 'session exclusion state unavailable' }; }
    }
  }
  if (input.memory_excluded === true || input.persistence === 'exclude' || input.restricted === true) return { allowed: false, reason: 'session excluded from memory' };
  for (const key of ['classification', 'data_classification']) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (typeof value !== 'string') return { allowed: false, reason: 'invalid classification metadata' };
    const classification = String(value || '').trim().toLowerCase().replace(/[\s:_+\-]+/g, '');
    if (['tlpamber', 'tlpamberstrict', 'tlpred', 'restricted'].includes(classification)) return { allowed: false, reason: 'restricted session' };
  }
  if (previousDecision?.taint) return previousDecision;
  let roots = [];
  try {
    roots = env.HARNESS_MEMORY_EXCLUDED_ROOTS ? JSON.parse(env.HARNESS_MEMORY_EXCLUDED_ROOTS) : [];
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('invalid roots');
  } catch { return { allowed: false, reason: 'invalid memory exclusion configuration' }; }
  try {
    for (const item of [input.cwd, input.transcriptPath, ...paths].filter(Boolean)) {
      const file = typeof item === 'string' ? item : item.path;
      if (typeof file !== 'string' || !file) continue;
      const cwd = (typeof item === 'object' ? item.cwd : '') || input.cwd || process.cwd();
      for (const root of roots) if (pathWithin(canonicalPath(root), canonicalPath(file, cwd))) return { allowed: false, reason: 'protected path touched' };
    }
  } catch { return { allowed: false, reason: 'memory path policy could not be verified' }; }
  if (previousDecision) return previousDecision;
  if (EXCLUDED_PURPOSES.has(String(input.purpose ?? '').trim().toLowerCase())) return { allowed: false, reason: 'excluded session purpose' };
  return { allowed: true, reason: '' };
}

/** Only declarative policy crosses adapters; machine-generated input is not a policy override. */
export function memoryPolicyFields(input = {}) {
  return Object.fromEntries(['memory_excluded', 'purpose', 'classification', 'data_classification', 'restricted', 'persistence']
    .filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}
