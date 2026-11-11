/**
 * Where the host keeps things, for a worker that reads its sessions from
 * another operating system (the jobs container reading a Windows host).
 *
 * Read only when `HARNESS_HOST_PATH_FLAVOR` is set. Then both are required:
 *   HARNESS_HOST_HOME   the host's home folder, which the home-relative routing
 *                       rules compare against (`~/.claude`, `~/projects`);
 *   HARNESS_HOST_VAULT  the vault root as the host spells it: the key the host
 *                       and the container share their checkpoint state under,
 *                       and the prefix of queue entries written by older hosts.
 *
 * Both are compared as text, so only a plain drive path with no `.` or `..`
 * step is accepted: anything else would make a comparison guess. A missing or
 * malformed value throws, and the worker turns that into a logged failure,
 * never a quiet fallback to this process's own home.
 */

import { hostPathFlavor } from './host-paths.mjs';

export const HOST_HOME_VAR = 'HARNESS_HOST_HOME';
export const HOST_VAULT_VAR = 'HARNESS_HOST_VAULT';

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

function hostFolder(env, name) {
  const raw = String(env?.[name] ?? '').trim();
  if (!raw) throw new RangeError(`${name} is required when a host path flavor is set`);
  const segments = raw.slice(3).split(/[\\/]/).filter(Boolean);
  if (!DRIVE_PATH.test(raw) || raw.includes('\0') || segments.some((part) => part === '.' || part === '..' || part.includes(':'))) {
    throw new RangeError(`${name} must be a plain drive path such as C:/Users/...`);
  }
  return `${raw[0].toUpperCase()}:/${segments.join('/')}`;
}

/**
 * `{flavor, home, vault}` with both folders in `C:/a/b` form, or null when no
 * flavor is set. Throws when a flavor is set and either folder is unusable.
 */
export function hostSettings(env = process.env) {
  const flavor = hostPathFlavor(env);
  if (!flavor) return null;
  return { flavor, home: hostFolder(env, HOST_HOME_VAR), vault: hostFolder(env, HOST_VAULT_VAR) };
}
