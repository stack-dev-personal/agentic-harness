/**
 * String and path helpers shared by every other module.
 *
 * Nothing here touches the filesystem, which is what makes the rest testable.
 */

/**
 * Windows backslashes to forward slashes. Vault paths are always POSIX.
 *
 * A Windows extended-length prefix (`\\?\C:\x`, which Codex 0.166 writes into
 * every thread's `cwd`) or device prefix (`\\.\C:\x`) is dropped, so the path
 * can be matched against a repository root. The UNC form (`\\?\UNC\host\share`)
 * becomes the plain UNC path, which `isLocalPath` still refuses.
 */
export function toPosix(value) {
  if (typeof value !== 'string') return '';
  const posix = value.replace(/\\/g, '/');
  if (!/^\/\/[?.]\//.test(posix)) return posix;
  const rest = posix.slice(4);
  return /^UNC\//i.test(rest) ? `//${rest.slice(4)}` : rest;
}

/** CRLF, a bare CR, U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR. Built from char codes: neither separator may appear literally inside a regex literal. */
const LINE_BREAKS = new RegExp(`\\r\\n|[\\r${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

/**
 * Every kind of line break to `\n`.
 *
 * A note is built and re-read line by line, and "line" has three definitions
 * that disagree: this code splits on `\n`; CommonMark (so Obsidian) also breaks
 * on a bare `\r`; and a JS regex with the `m` flag breaks on `\r`, U+2028 and
 * U+2029 as well. Text that is about to be quoted or indented line by line goes
 * through here first, or a pasted carriage return starts a line that never got
 * its prefix — and `## Session facts` at the start of a line is a heading.
 */
export function normalizeLineBreaks(value) {
  return String(value ?? '').replace(LINE_BREAKS, '\n');
}

/**
 * Single-quoted YAML.
 *
 * The only scalar style where a Windows backslash stays literal and a leading
 * `#`, `@` or digit cannot change the type. Newlines are folded to spaces: a
 * frontmatter value is an index entry, not a document.
 */
export function yamlStr(value) {
  return `'${String(value ?? '').replace(/'/g, "''").replace(/[\r\n]+/g, ' ')}'`;
}

/**
 * A filesystem-safe, lowercase slug for a collection folder.
 *
 * Returns `''` for input that slugs to nothing, so the caller decides the
 * fallback rather than inheriting an invented name.
 */
export function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ._-]+/g, '-')
    .replace(/[-\s]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .trim();
  if (!slug) return '';
  // A reserved Windows device name would produce an uncreatable folder.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug)) return `${slug}-dir`;
  return slug.slice(0, 64);
}

/** First non-empty trimmed string among `names` on `obj`, else `''`. */
export function pick(obj, ...names) {
  for (const name of names) {
    const value = obj?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** Order-preserving dedupe with an optional cap. Returns a new array. */
export function uniqueCapped(values, cap) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (value === '' || value === null || value === undefined) continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (Number.isInteger(cap) && out.length >= cap) break;
  }
  return out;
}

/** `4h 12m` / `37m` / `unknown`. Body prose only; the frontmatter keeps minutes. */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** ISO instant to `YYYY-MM-DD`, or `''` when the input is not one. */
export function isoDate(value) {
  const text = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

/** Milliseconds since epoch for an ISO instant, or NaN. */
export function isoToMillis(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * A path beginning `\host\...` or `//host/...` is a UNC path.
 *
 * Windows resolves one by connecting to `host` over SMB and authenticating as
 * the logged-in user, which hands that host a Net-NTLMv2 exchange. This hook
 * stats and reads paths that came out of a transcript — a tool input naming
 * `//attacker/share/x` is recorded even when the write was *denied* — and it
 * runs unattended at session exit with nobody watching. So a path that points
 * at another machine is simply not a path this package touches.
 *
 * `path.isAbsolute('//host/share')` is true, so an absoluteness check does not
 * cover this.
 */
const UNC_PREFIX = /^[\\/]{2}[^\\/]/;

/** Is this a local path — one no other host can answer for? */
export function isLocalPath(candidate) {
  const text = String(candidate ?? '');
  if (!text) return false;
  return !UNC_PREFIX.test(text);
}

/**
 * Identifiers that are allowed to become a filename.
 *
 * Session ids are UUIDs today; the allow-list is a little wider and no wider. It
 * is an allow-list rather than a sanitiser because sanitising a path is a game
 * you lose eventually — `..%2f`, a UNC prefix, a trailing dot on Windows.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PATH_CLIMB = /(^|[/\\])\.\.([/\\]|$)/;

/**
 * May `value` be used as one path segment?
 *
 * Every filename the hook and its tools build from data — a session id from
 * stdin, a session id read back out of a vault note — passes through here. One
 * rule, one place.
 */
export function isSafeFilenameSegment(value) {
  const text = String(value ?? '');
  return SAFE_SEGMENT.test(text) && !PATH_CLIMB.test(text);
}
