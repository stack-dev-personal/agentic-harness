/**
 * Paths a session recorded on another operating system, judged by that
 * system's rules.
 *
 * The memory worker normally runs where its sessions ran, and the policy
 * resolves their paths on the real filesystem (junctions included). In the
 * jobs container it reads a Windows host's transcripts from Linux: the paths
 * in them are Windows text, and Node's own `path` would call
 * `C:/Users/x/private` relative and resolve it under the container's working
 * directory, so a protected root would never match.
 *
 * `HARNESS_HOST_PATH_FLAVOR=win32` says "session paths are Windows paths".
 * The comparison is then text only, with no filesystem call. Unset, nothing
 * here is used and every caller keeps its native behaviour.
 *
 * The rules are written out here rather than borrowed from `path.win32`, and
 * ingest/src/ingest/memory_policy.py repeats them step for step: the two must
 * give the same answer for the same text, and the two standard libraries do
 * not. A change here is a change there.
 *
 * Every doubt resolves toward "inside": a spelling that could name the
 * protected folder is treated as naming it, and a spelling text cannot place
 * throws, which the caller turns into a refusal.
 *
 * What text cannot see: a junction or symlink that leads into a protected
 * folder under another name, and the same share reached by another server
 * name (short name, full name, address, mapped drive). List each such alias
 * as its own root. The host's own hooks still resolve junctions at session
 * start and session end.
 */

export const HOST_PATH_FLAVOR_VAR = 'HARNESS_HOST_PATH_FLAVOR';
const SUPPORTED = Object.freeze(['win32']);

/** `\\?\`, `\\.\` and the NT form `\??\`: device prefixes in front of an ordinary path. */
const DEVICE_PREFIX = /^(?:[\\/]{2}[?.][\\/]|[\\/]\?\?[\\/])/;
const DEVICE_UNC = /^UNC[\\/]/i;
/** `\\host\C$\x`: the administrative share of a drive, on this machine or any other. */
const ADMIN_SHARE = /^\\\\[^\\]+\\([A-Za-z])\$(?:\\(.*))?$/s;
const DRIVE_FULL = /^[A-Za-z]:\\/;
const SHARE_FULL = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/;
const DRIVE_RELATIVE = /^[A-Za-z]:(?!\\)/;
const DRIVE_LETTER = /^[A-Za-z]$/;
const DRIVE_SEGMENT = /^[A-Za-z]:$/;
const FILE_SCHEME = /^file:/i;
/** The owner in `/proc/<owner>/root`: this process, this thread, or a process id. */
const PROCESS_NAME = /^(?:self|thread-self|[0-9]+)$/;
/** Folders a home folder normally sits directly inside. */
const HOME_PARENTS = Object.freeze(['users', 'home', 'documents and settings']);
/** An 8.3 short name: up to six characters, a tilde, a number, an optional short extension. */
const SHORT_NAME = /^([^\\]{1,6})~[0-9]{1,6}(?:\.[^.\\]{0,3})?$/su;
const HEX4 = /^[0-9A-F]{4}$/;

/**
 * The flavor the environment names, or null when it names none. An unknown
 * value throws: a typo must not quietly fall back to the native rules.
 */
export function hostPathFlavor(env = process.env) {
  const value = String(env?.[HOST_PATH_FLAVOR_VAR] ?? '').trim().toLowerCase();
  if (!value) return null;
  if (!SUPPORTED.includes(value)) throw new RangeError(`${HOST_PATH_FLAVOR_VAR} must be one of: ${SUPPORTED.join(', ')}`);
  return value;
}

/**
 * True for a device path whose target text cannot say: one with a `.` or `..`
 * segment (Windows applies those before it reads the drive or the server), or
 * one that names neither a drive nor a share (`\\?\GLOBALROOT\...`,
 * `\\?\Volume{...}\...`). A caller that strips device prefixes for display
 * must ask this first, on the raw text, and refuse the session.
 */
export function isUnplaceableDevicePath(file) {
  const text = String(file);
  const device = DEVICE_PREFIX.exec(text);
  if (!device) return false;
  const rest = deviceRemainder(text, device);
  const segments = rest.split('\\');
  if (segments.includes('..') || segments.includes('.')) return true;
  return !DEVICE_UNC.test(rest) && !DRIVE_FULL.test(rest);
}

/**
 * What follows a device prefix, with separator runs read as one, as Windows
 * reads them there: `\\.\UNC\\host\share` is `\\host\share`.
 */
function deviceRemainder(text, device) {
  return text.slice(device[0].length).replace(/[\\/]+/g, '\\');
}

function leadingSeparators(text) {
  let count = 0;
  while (count < text.length && (text[count] === '\\' || text[count] === '/')) count += 1;
  return count;
}

/**
 * A path that starts with `/`, read the way a Unix shell on Windows reads it:
 * either slash separates, runs collapse, `.` and `..` apply, and `/c/x`
 * (Git Bash), `/mnt/c/x` (WSL), `/cygdrive/c/x` and `/proc/cygdrive/c/x`
 * (Cygwin, MSYS) name drive C:, also behind `/proc/self/root`.
 */
function fromUnixShell(text) {
  const segments = [];
  for (const raw of text.split(/[\\/]/)) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      // `/dev/fd` is a link into `/proc/self`, and `..` there leads to that
      // process's `root` and `cwd`. Under either tree a parent step is a
      // step through a link text cannot follow.
      // Git Bash finds `/dev` whatever its letter case.
      if (segments[0] === 'proc' || segments[0]?.toLowerCase() === 'dev') throw new Error('parent step under a process tree');
      segments.pop();
      continue;
    }
    segments.push(raw);
    // Links the shell follows as it walks, before any later `..` applies:
    // `/proc/cygdrive` and `/cygdrive` are the list of drives, and
    // `/proc/<process>/root` is the top of the filesystem again.
    const depth = segments.length;
    if (depth === 1 && raw === 'cygdrive') { segments.length = 0; continue; }
    if (segments[0] !== 'proc') continue;
    if (depth === 2 && raw === 'cygdrive') { segments.length = 0; continue; }
    if (depth === 3 && PROCESS_NAME.test(segments[1])) {
      if (raw === 'root') { segments.length = 0; continue; }
      // `/proc/self/cwd` is wherever that process happened to be.
      if (raw === 'cwd' || raw === 'exe' || raw === 'fd') throw new Error('path through a process link');
    }
  }
  if (segments[0] === 'proc' && segments.some(name => name === 'root' || name === 'cwd' || name === 'cygdrive')) {
    throw new Error('path through a process link');
  }
  if (segments.length && (DRIVE_LETTER.test(segments[0]) || DRIVE_SEGMENT.test(segments[0]))) {
    return `${segments[0][0]}:\\${segments.slice(1).join('\\')}`;
  }
  if (segments[0] === 'mnt' && segments.length > 1 && DRIVE_LETTER.test(segments[1])) {
    return `${segments[1]}:\\${segments.slice(2).join('\\')}`;
  }
  return `\\${segments.join('\\')}`;
}

/**
 * One spelling for every path: backslashes, no device prefix, no Unix-shell
 * drive form, no administrative share. Throws for text that names no place a
 * comparison can use.
 */
function plain(file) {
  let text = String(file);
  if (text.includes('\0')) throw new Error('path with a NUL character');
  // A file URL is not a path: it can percent-encode any character, name a
  // host, and write a drive three ways. No tool records one where a path
  // belongs, so it is refused rather than half-read.
  if (FILE_SCHEME.test(text)) throw new Error('file URL where a path belongs');
  const device = DEVICE_PREFIX.exec(text);
  if (device) {
    if (isUnplaceableDevicePath(text)) throw new Error('device path text cannot place');
    const rest = deviceRemainder(text, device);
    text = DEVICE_UNC.test(rest) ? `\\\\${rest.slice(4)}` : rest;
  } else if (text[0] === '/' && leadingSeparators(text) !== 2) {
    text = fromUnixShell(text);
  }
  // Windows reads a run of separators as one, except the two that open a
  // share path; three or more at the start are one again.
  const lead = leadingSeparators(text);
  const body = text.slice(lead).replace(/[\\/]+/g, '\\');
  text = (lead === 2 ? '\\\\' : lead > 0 ? '\\' : '') + body;
  if (text.startsWith('\\\\')) {
    // Server and share lose trailing dots and spaces like any other name.
    const parts = text.slice(2).split('\\');
    parts[0] = trimmed(parts[0]);
    if (parts.length > 1) parts[1] = trimmed(parts[1]);
    text = `\\\\${parts.join('\\')}`;
  }
  // `\\;LanmanRedirector\host\share\x` reaches `\\host\share\x` by another door.
  if (text.startsWith('\\\\;')) throw new Error('share path through a named redirector');
  const admin = ADMIN_SHARE.exec(text);
  if (admin) text = `${admin[1]}:\\${admin[2] ?? ''}`;
  return text;
}

const isFull = text => DRIVE_FULL.test(text) || SHARE_FULL.test(text);
const isRootedWithoutDrive = text => text.startsWith('\\') && !text.startsWith('\\\\');

/** `C:\` or `\\server\share\`, as it starts a full path. */
function rootOf(full) {
  if (DRIVE_FULL.test(full)) return full.slice(0, 3);
  const server = full.indexOf('\\', 2);
  const share = full.indexOf('\\', server + 1);
  return share === -1 ? `${full}\\` : full.slice(0, share + 1);
}

/** A name without the trailing dots and spaces Windows drops when it opens it. */
function trimmed(name) {
  let end = name.length;
  while (end > 0 && (name[end - 1] === '.' || name[end - 1] === ' ')) end -= 1;
  return name.slice(0, end);
}

/**
 * The folder and file names of `body`, each as Windows opens it.
 *
 * In Windows' own order: `.` and `..` are applied to the segments as written,
 * and only then does each name lose a stream suffix (`name:stream`,
 * `folder::$INDEX_ALLOCATION`) and its trailing dots and spaces. The order
 * matters: in `private\...\..\a` the `..` cancels the `...`, not `private`.
 */
function namesOf(body) {
  const written = [];
  for (const raw of body.split('\\')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') { written.pop(); continue; }
    written.push(raw);
  }
  const names = [];
  for (const raw of written) {
    // `X:\..\C:\x` with its device prefix already stripped by some caller.
    if (DRIVE_SEGMENT.test(trimmed(raw))) throw new Error('drive named inside a path');
    const colon = raw.indexOf(':');
    const opened = trimmed(colon === -1 ? raw : raw.slice(0, colon));
    if (opened !== '') names.push(opened);
  }
  return names;
}

/** A full path as a root (lower case, or '' when the drive is unknown) and its names. */
function located(full) {
  const root = rootOf(full);
  return { root: root.toLowerCase(), names: namesOf(full.slice(root.length)) };
}

function asciiOnly(text) {
  let kept = '';
  for (const character of text) if (character.codePointAt(0) < 128) kept += character;
  return kept;
}

/**
 * Whether `candidate` could be the 8.3 short name Windows gave `longName`
 * (`PRIVAT~1` for `private-work`). Text cannot know which short names
 * exist, so every plausible one counts. Windows builds one from the name's
 * ASCII characters only, without leading dots, spaces or inner dots.
 */
function couldBeShortNameOf(longName, candidate) {
  const match = SHORT_NAME.exec(candidate);
  if (!match) return false;
  let stem = longName;
  while (stem.startsWith('.')) stem = stem.slice(1);
  const dot = stem.lastIndexOf('.');
  if (dot > 0) stem = stem.slice(0, dot);
  const base = asciiOnly(stem).replace(/[ .]/g, '').replace(/[+,;=[\]]/g, '_').toUpperCase();
  const prefix = asciiOnly(match[1]).toUpperCase();
  if (prefix.length !== [...match[1]].length) return false;
  if (base !== '' && base.startsWith(prefix)) return true;
  // After a few collisions, or for a very short name: up to two characters of
  // the name, then four of a hash.
  if (prefix.length < 4 || !HEX4.test(prefix.slice(-4))) return false;
  const head = prefix.slice(0, -4);
  return head === '' ? base === '' : base.startsWith(head);
}

function sameName(rootName, fileName) {
  // Windows folds by upper case; lower case alone misses a final capital sigma.
  return rootName.toLowerCase() === fileName.toLowerCase()
    || rootName.toUpperCase() === fileName.toUpperCase()
    || couldBeShortNameOf(rootName, fileName);
}

function startsWithNames(wanted, names) {
  return names.length >= wanted.length && wanted.every((name, index) => sameName(name, names[index]));
}

function within(root, file) {
  if (file.root === '') {
    // A path with no drive is compared by names alone. A root that is a whole
    // drive or share has no names to compare, and every Mac path, Linux path
    // and container path would match it: there is no evidence either way, so
    // it does not.
    return root.names.length > 0 && startsWithNames(root.names, file.names);
  }
  return root.root === file.root && startsWithNames(root.names, file.names);
}

/**
 * For a path whose starting folder is unknown (a relative path with no
 * recorded working directory, `~/x`): could it land in the root? Yes when it
 * begins with the last names of the root, as `private\a` does under
 * `C:\Users\me` for the root `C:\Users\me\private`.
 */
function couldLandIn(root, names) {
  // A whole drive or share: everything on it is inside.
  if (root.names.length === 0) return true;
  for (let from = 0; from < root.names.length; from += 1) {
    if (startsWithNames(root.names.slice(from), names)) return true;
  }
  return false;
}

/** A root that is a home folder, or the folder that holds them: every `~` path is inside it. */
function couldHoldHome(root) {
  if (root.names.length === 0) return true;
  return root.names.length <= 2 && HOME_PARENTS.includes(root.names[0].toLowerCase());
}

/** True when `root` can be a protected root: a full path, so one folder and no other. */
export function isHostRoot(flavor, root) {
  assertFlavor(flavor);
  if (typeof root !== 'string' || root === '') return false;
  try {
    const text = plain(root);
    if (!isFull(text)) return false;
    located(text);
    return true;
  } catch { return false; }
}

/**
 * Whether `file` lies inside `root` (or is it), by the flavor's rules.
 * `cwd` is the working directory the session recorded, used for a `file`
 * that does not name its own drive. Throws when `file` cannot be placed.
 */
export function hostPathWithin(flavor, root, file, cwd = '') {
  assertFlavor(flavor);
  const base = plain(root);
  if (!isFull(base)) throw new Error('protected root is not a full path');
  const target = plain(file);
  const rootAt = located(base);
  if (isFull(target)) return within(rootAt, located(target));
  const start = cwd ? plain(cwd) : '';
  if (DRIVE_RELATIVE.test(target)) {
    // `C:notes\a` means "under the current folder of drive C:". That is the
    // recorded working directory only when it is on the same drive.
    if (!DRIVE_FULL.test(start) || start[0].toLowerCase() !== target[0].toLowerCase()) throw new Error('drive-relative path on another drive');
    return within(rootAt, located(`${start}\\${target.slice(2)}`));
  }
  if (target.startsWith('\\\\')) throw new Error('share path that names no share');
  if (target.startsWith('\\')) {
    // Rooted, with no drive of its own: on the working directory's drive.
    if (isFull(start)) return within(rootAt, located(rootOf(start) + target.slice(1)));
    // No drive to borrow (`\Users\x`, a Mac or Linux path, the container's
    // own `/home/...`): inside the root on some drive counts as inside it.
    return within(rootAt, { root: '', names: namesOf(target) });
  }
  // The home folder is not recorded: `~\private\a` could be anywhere.
  if (target === '~' || target.startsWith('~\\')) return couldHoldHome(rootAt) || couldLandIn(rootAt, namesOf(target.slice(1)));
  if (isFull(start)) return within(rootAt, located(`${start}\\${target}`));
  if (isRootedWithoutDrive(start)) return within(rootAt, { root: '', names: namesOf(`${start}\\${target}`) });
  return couldLandIn(rootAt, namesOf(target));
}

/**
 * A tool path recorded by a Windows session, made absolute against the
 * working directory it ran in, as text. The cwd is read by this file's own
 * rules (`plain`: device prefix, separators, Unix-shell drive spellings), the
 * way `hostPathWithin` reads it, and the file is appended exactly as written,
 * so the policy applies its `..`, short names and every other spelling itself.
 *
 * Only a plainly relative file is joined, and only to a cwd that is a full
 * path. A file that names its own drive, root, share, device, home or URL is
 * returned as it is, and so is any file whose cwd is missing, not full, or not
 * placeable: the policy then judges both as recorded and refuses what it
 * cannot place. Native `path.resolve` must not be used for these: on Linux it
 * reads `C:/x` as relative and puts it under the process's own folder.
 */
export function joinHostPath(cwd, file) {
  const text = String(file);
  if (text === '' || /^[A-Za-z]:/.test(text) || /^[\\/~]/.test(text) || FILE_SCHEME.test(text)) return text;
  let base;
  try { base = plain(String(cwd ?? '')); } catch { return text; }
  if (!isFull(base)) return text;
  // `plain` has collapsed separator runs, so at most one trails.
  return `${base.endsWith('\\') ? base.slice(0, -1) : base}\\${text}`;
}

function assertFlavor(flavor) {
  if (!SUPPORTED.includes(flavor)) throw new RangeError(`unsupported host path flavor: ${flavor}`);
}
