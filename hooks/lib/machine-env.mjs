/**
 * `~/.harness/machine.env`: what this machine is.
 *
 * The vault root, the realms it may hold, its name in `machine:` — everything
 * that differs from one machine to the next and used to be a hard-coded
 * default. KEY=value, because both tiers already read that without a
 * dependency (the Python side is `ingest/src/ingest/envfile.py`, and this is a
 * deliberate mirror of its rules): the process environment always wins, a
 * malformed line is reported by number, values are never logged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MACHINE_NAME_PATTERN, MACHINE_NAME_VAR, VAULT_ENV_VAR } from './constants.mjs';

/** Overrides the file's location — the tests use it; a VM may too. */
export const MACHINE_ENV_VAR = 'HARNESS_MACHINE_ENV';
/** The harness's own folder under home: state, logs, queue, machine file. */
export const HARNESS_DIR = '.harness';
export const MACHINE_ENV_SEGMENTS = Object.freeze([HARNESS_DIR, 'machine.env']);

/** `<home>/.harness`, the one spelling of it. A container mounts the host's folder there. */
export function harnessDir(home = os.homedir()) {
  return path.join(home, HARNESS_DIR);
}

const KEY = /^[A-Z_][A-Z0-9_]*$/;

/** Parse KEY=value lines: `export` prefixes, single or double quotes, `#` comments. */
export function parseEnvText(text) {
  const values = {};
  const lines = String(text ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const pair = line.startsWith('export ') ? line.slice(7).trim() : line;
    const at = pair.indexOf('=');
    const key = at === -1 ? '' : pair.slice(0, at).trim();
    if (!KEY.test(key)) throw new Error(`machine.env line ${index + 1}: expected KEY=value`);
    values[key] = unquote(pair.slice(at + 1).trim());
  }
  return values;
}

function unquote(value) {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) return value.slice(1, -1);
  return value;
}

/** This machine's name for `machine:`, or '' when unset or not a name. */
export function machineName(env = process.env) {
  const value = String(env?.[MACHINE_NAME_VAR] ?? '').trim();
  return MACHINE_NAME_PATTERN.test(value) ? value : '';
}

/**
 * The author and committer email of unattended realm commits (R-B4); the
 * name comes from HARNESS_MACHINE.
 */
export const GIT_EMAIL_VAR = 'HARNESS_GIT_EMAIL';
/** One `@`, no spaces or angle brackets: anything else would break `Name <email>`. */
const GIT_EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+$/;

/** The email for realm commits, or '' when unset or not an email. */
export function gitEmail(env = process.env) {
  const value = String(env?.[GIT_EMAIL_VAR] ?? '').trim();
  return GIT_EMAIL_PATTERN.test(value) ? value : '';
}

/**
 * The environment with the repo's `.env` filled in underneath it.
 *
 * For the installer and the doctor only: the hook never loads secrets, and the
 * detached ingest reads the same file itself. Same rules as the machine file.
 */
export function loadRepoEnv(env = process.env, repoRoot, report = () => {}) {
  const file = path.join(repoRoot, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') report(`.env unreadable (${err?.code || err?.message}): ${file}`);
    return { ...env };
  }
  try {
    return { ...parseEnvText(text), ...env };
  } catch (err) {
    report(`${err.message} (${file})`);
    return { ...env };
  }
}

/**
 * The environment with the machine file's values filled in underneath it.
 *
 * Returns a new object; `env` is not touched. A missing file is the ordinary
 * case on a machine that has not been set up, so it is not an error. A file
 * that will not parse is reported through `report` and ignored: a hook must
 * still write its note.
 */
export function loadMachineEnv(env = process.env, home = os.homedir(), report = () => {}) {
  const file = env[MACHINE_ENV_VAR] || path.join(home, ...MACHINE_ENV_SEGMENTS);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') report(`machine.env unreadable (${err?.code || err?.message}): ${file}`);
    return { ...env };
  }
  let values;
  try {
    values = parseEnvText(text);
  } catch (err) {
    report(`${err.message} (${file})`);
    return { ...env };
  }
  return { ...values, ...env };
}

// ------------------------------------------------------------ resolved config

/** The ingest project and the realm list, as the machine file names them. */
export const INGEST_PROJECT_VAR = 'HARNESS_INGEST_PROJECT';
export const REALMS_VAR = 'HARNESS_REALMS';

/**
 * A realm name, and the policies a realm may carry. The same rules as
 * `realm-sync.mjs` `parseRealmPolicies` (a test holds them equal); repeated
 * here because this module is deployed with the hook and must not pull the
 * sync's git code into the hook's import graph.
 */
const REALM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REALM_POLICIES = Object.freeze(['push', 'local']);
const REALM_MARKER_FILE = '.realm';

/**
 * `projects:push,classes:local` → [{name, policy}], any number of entries.
 * Unlike the sync, a bad entry is reported and left out rather than thrown:
 * a reader of the config should still see the realms that are well formed.
 */
function readRealms(text, report) {
  const realms = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const at = entry.indexOf(':');
    const name = at === -1 ? '' : entry.slice(0, at).trim();
    const policy = at === -1 ? '' : entry.slice(at + 1).trim();
    if (!REALM_NAME_PATTERN.test(name) || !REALM_POLICIES.includes(policy)) {
      report(`${REALMS_VAR}: '${entry.slice(0, 80)}' is not <realm>:<push|local>; left out`);
      continue;
    }
    if (seen.has(name)) {
      report(`${REALMS_VAR}: realm '${name}' is listed twice; the first entry is kept`);
      continue;
    }
    seen.add(name);
    realms.push(Object.freeze({ name, policy }));
  }
  return Object.freeze(realms);
}

/**
 * Does `<vault>/<name>/.realm` read `<name>`? `{ realm, marker, ok, problem }`,
 * `marker` being the path it read, so a refusal can name it.
 */
function checkRealm(vault, name) {
  const realm = String(name ?? '');
  if (!REALM_NAME_PATTERN.test(realm)) {
    return Object.freeze({ realm, marker: '', ok: false, problem: `'${realm.slice(0, 64)}' is not a realm name` });
  }
  if (!vault) return Object.freeze({ realm, marker: '', ok: false, problem: `${VAULT_ENV_VAR} is not set` });
  const marker = path.join(vault, realm, REALM_MARKER_FILE);
  let content;
  try {
    content = fs.readFileSync(marker, 'utf8').trim();
  } catch (err) {
    const why = err?.code === 'ENOENT' ? 'no marker' : `marker unreadable (${err?.code || 'error'})`;
    return Object.freeze({ realm, marker, ok: false, problem: `${why} at ${marker}` });
  }
  if (content !== realm) {
    return Object.freeze({ realm, marker, ok: false, problem: `${marker} reads '${content.slice(0, 64)}', not '${realm}'` });
  }
  return Object.freeze({ realm, marker, ok: true, problem: '' });
}

/**
 * Where this machine keeps things: the machine file read, its name, the vault,
 * the ingest project and the realms it holds (P-110). Built on
 * `loadMachineEnv`, so the shell wins over `$HARNESS_MACHINE_ENV` or
 * `~/.harness/machine.env`. There is no OneDrive fallback: an unset vault is
 * `''`, and the caller refuses it.
 *
 * With `requireRealm`, `realmCheck` says whether `<vault>/<name>/.realm` reads
 * that name; otherwise it is null. Nothing else from the machine file is
 * returned (it may carry an email or other values no caller needs to print).
 *
 * @returns {Readonly<{machineFile: string, machine: string, vault: string,
 *   ingestProject: string, realms: readonly {name: string, policy: string}[],
 *   realmCheck: null | Readonly<{realm: string, marker: string, ok: boolean, problem: string}>}>}
 */
export function resolveHarnessConfig({ env = process.env, home = os.homedir(), report = () => {}, requireRealm } = {}) {
  const machineFile = env?.[MACHINE_ENV_VAR] || path.join(home, ...MACHINE_ENV_SEGMENTS);
  const merged = loadMachineEnv(env ?? {}, home, report);
  const vault = String(merged[VAULT_ENV_VAR] ?? '').trim();
  return Object.freeze({
    machineFile,
    machine: machineName(merged),
    vault,
    ingestProject: String(merged[INGEST_PROJECT_VAR] ?? '').trim(),
    realms: readRealms(merged[REALMS_VAR], report),
    realmCheck: requireRealm === undefined ? null : checkRealm(vault, requireRealm),
  });
}
