/**
 * Note paths written as their place inside the vault (`area/collection/
 * sessions/<id>.md`), so state written by the host and by a container that
 * mounts the same vault at another path name the same notes.
 *
 * Reading one back is strict: `/`-separated, no empty, `.` or `..` segment, no
 * backslash, no NUL, no root or drive. Anything else names no note. Callers
 * still check that the result is a real file inside the vault.
 */

import path from 'node:path';

/** `a/b/c.md` as a path under `vaultRoot`, or '' when it is not plainly that. */
export function fromVaultRelative(relative, vaultRoot) {
  if (typeof relative !== 'string' || !relative || /[\\\0]/.test(relative) || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return '';
  const parts = relative.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return '';
  return path.join(vaultRoot, ...parts);
}

/** A vault root as a comparison key: `/` separators, no trailing one, lower case. */
export function vaultKeyOf(spelled) {
  return String(spelled).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The part of `file` after the vault root that `key` names (`vaultKeyOf`),
 * `/`-separated and in its own letter case; '' when `file` is not under it.
 * Text only: a device or share spelling is never mapped.
 */
export function relativeToKey(file, key) {
  const text = String(file);
  if (/^[\\/]{2}/.test(text) || !key) return '';
  const posix = text.replace(/\\/g, '/');
  return posix.toLowerCase().startsWith(`${key}/`) ? posix.slice(key.length + 1) : '';
}

/** `file` (a path on this side) as its place inside `vaultRoot`, or '' when it is outside. */
export function toVaultRelative(file, vaultRoot) {
  const relative = path.relative(path.resolve(vaultRoot), path.resolve(String(file)));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.split(path.sep).join('/');
}
