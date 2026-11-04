/**
 * `node:sqlite`, loaded on first use rather than on import.
 *
 * Node 22 prints `ExperimentalWarning: SQLite is an experimental feature` to
 * stderr the moment the module loads. A hook that is merely imported (the
 * entry-point tests, a `--help`, a settings check) must stay silent, so the
 * adapters that read Codex and Hermes history pull the module in here, only
 * when they actually open a database. Node 24 has no warning; the shape is the
 * same on both.
 */

import { createRequire } from 'node:module';

const requireNative = createRequire(import.meta.url);
let nativeSqlite;

/** The `node:sqlite` module, required lazily. */
export function sqlite() {
  nativeSqlite ??= requireNative('node:sqlite');
  return nativeSqlite;
}

/** `new DatabaseSync(file, options)` without importing `node:sqlite` up front. */
export function openNativeDatabase(file, options) {
  return new (sqlite().DatabaseSync)(file, options);
}

/**
 * A TEXT column that may hold an embedded NUL, read back whole.
 *
 * Node 22's `node:sqlite` cuts a text value at the first NUL when it builds
 * the JavaScript string (Hermes's multimodal encoding starts with one, so the
 * whole message read as empty). Select the column as `CAST(col AS BLOB)` and
 * pass the bytes here; a plain string passes through.
 */
export function textFromColumn(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  return String(value);
}
