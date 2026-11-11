/**
 * The protected-root check when the worker runs on one operating system and
 * judges paths recorded on another (the jobs container reading a Windows
 * host's transcripts). Every case sets HARNESS_HOST_PATH_FLAVOR, so the result
 * is the same on the Windows and the Ubuntu CI legs: nothing here touches the
 * filesystem or depends on the platform's own path rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isUnplaceableDevicePath } from '../lib/host-paths.mjs';
import { memoryEligibility } from '../lib/memory-policy.mjs';
import { runMemoryWorker } from '../memory-worker.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'C:/Users/alex/private-work';
const PROJECT = 'C:\\Users\\alex\\projects\\app';
const PROTECTED = { allowed: false, reason: 'protected path touched' };
const ALLOWED = { allowed: true, reason: '' };

function env(extra = {}) {
  return { HARNESS_HOST_PATH_FLAVOR: 'win32', HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([ROOT]), ...extra };
}

function decide(input, paths = [], overrides = {}) {
  return memoryEligibility({ input, env: env(overrides), paths });
}

test('a Windows working directory inside the root is protected', () => {
  assert.deepEqual(decide({ cwd: 'C:\\Users\\alex\\private-work\\briefs' }), PROTECTED);
  assert.deepEqual(decide({ cwd: ROOT }), PROTECTED);
});

test('Windows paths match without regard to case or slash direction', () => {
  assert.deepEqual(decide({ cwd: 'c:/users/ALEX/Private-Work/x' }), PROTECTED);
  assert.deepEqual(decide({ cwd: 'C:\\USERS\\alex\\private-work' }), PROTECTED);
});

test('a file opened inside the root is protected from any working directory', () => {
  const file = 'C:\\Users\\alex\\private-work\\research\\build\\archive.json';
  assert.deepEqual(decide({ cwd: PROJECT }, [{ path: file, cwd: PROJECT }]), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, [file]), PROTECTED);
});

test('a relative path is resolved against the recorded Windows working directory', () => {
  assert.deepEqual(decide({ cwd: PROJECT }, [{ path: '..\\..\\private-work\\a.md', cwd: PROJECT }]), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['../../private-work/a.md']), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, [{ path: 'docs\\a.md', cwd: PROJECT }]), ALLOWED);
});

test('the long-path prefix and the MSYS drive form name the same file', () => {
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\?\\C:\\Users\\alex\\private-work\\a.md']), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['/c/Users/alex/private-work/a.md']), PROTECTED);
  assert.deepEqual(decide({ cwd: '/c/Users/alex/private-work' }), PROTECTED);
});

test('spellings Windows treats as the same folder are protected too', () => {
  for (const file of [
    'C:\\Users\\alex\\private-work.\\a.md',
    'C:\\Users\\alex\\private-work \\a.md',
    'C:\\Users\\alex\\private-work...\\sub\\a.md',
    'C:\\Users\\alex\\private-work::$INDEX_ALLOCATION\\a.md',
    'C:\\Users\\alex\\private-work\\a.md:hidden-stream',
    '\\\\.\\C:\\Users\\alex\\private-work\\a.md',
    '/mnt/c/Users/alex/private-work/a.md',
    '/cygdrive/c/Users/alex/private-work/a.md',
  ]) assert.deepEqual(decide({ cwd: PROJECT }, [file]), PROTECTED, file);
});

test('a different folder that only starts with the same name stays allowed', () => {
  for (const file of [
    'C:\\Users\\alex\\private-work.bak\\a.md',
    'C:\\Users\\alex\\private-work2\\a.md',
    'C:\\Users\\alex\\projects\\notes. \\a.md',
  ]) assert.deepEqual(decide({ cwd: PROJECT }, [file]), ALLOWED, file);
});

test('a device path that text cannot place fails closed', () => {
  for (const file of [
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\Users\\alex\\private-work\\a.md',
    '\\\\?\\Volume{4c1b02c1-d990-11dc-99ae-806e6f6e6963}\\Users\\alex\\private-work\\a.md',
    '\\\\.\\HarddiskVolume3\\Users\\alex\\private-work\\a.md',
  ]) {
    const result = decide({ cwd: PROJECT }, [file]);
    assert.deepEqual(result, { allowed: false, reason: 'memory path policy could not be verified' }, file);
  }
});

// ---------------------------------------------------------------------------
// Found by the adversarial review of 2026-11-11: each of these opened the
// protected file on a real Windows volume while an earlier version allowed it,
// or made the Node and Python sides disagree.
// ---------------------------------------------------------------------------

test('a parent segment cannot climb over the drive of a device path', () => {
  for (const file of [
    '\\\\.\\X:\\..\\C:\\Users\\alex\\private-work\\a.md',
    '\\\\.\\UNC\\..\\C:\\Users\\alex\\private-work\\a.md',
    '\\\\.\\C:\\..\\C:\\Users\\alex\\private-work\\a.md',
    '//./X:/../C:/Users/alex/private-work/a.md',
    '\\\\?\\X:\\..\\C:\\Users\\alex\\private-work\\a.md',
    '\\\\.\\C:\\..\\GLOBALROOT\\DosDevices\\C:\\Users\\alex\\private-work\\a.md',
  ]) {
    assert.equal(decide({ cwd: PROJECT }, [file]).allowed, false, file);
    assert.equal(decide({ cwd: file }).allowed, false, `as cwd: ${file}`);
  }
});

test('the administrative share of a drive is that drive, whatever the host is called', () => {
  for (const file of [
    '\\\\localhost\\C$\\Users\\alex\\private-work\\a.md',
    '\\\\127.0.0.1\\C$\\Users\\alex\\private-work\\a.md',
    '\\\\devbox\\c$\\Users\\alex\\private-work\\a.md',
    '\\\\--1.ipv6-literal.net\\C$\\Users\\alex\\private-work\\a.md',
    '\\\\?\\UNC\\localhost\\C$\\Users\\alex\\private-work\\a.md',
    '\\\\.\\UNC\\localhost\\C$\\Users\\alex\\private-work\\a.md',
    '//localhost/C$/Users/alex/private-work/a.md',
    '\\\\localhost\\\\C$\\Users\\alex\\private-work\\a.md',
  ]) assert.deepEqual(decide({ cwd: PROJECT }, [file]), PROTECTED, file);
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\localhost\\C$\\Users\\alex\\projects\\a.md']), ALLOWED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\localhost\\D$\\Users\\alex\\private-work\\a.md']), ALLOWED);
});

test('the NT object prefix is a device prefix too', () => {
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\??\\C:\\Users\\alex\\private-work\\a.md']), PROTECTED);
  assert.equal(decide({ cwd: PROJECT }, ['\\??\\GLOBALROOT\\Device\\HarddiskVolume3\\a.md']).reason, 'memory path policy could not be verified');
});

test('a line separator in a name does not hide a Unix-shell drive path', () => {
  for (const separator of ['\u2028', '\u2029', '\r', '\n']) {
    const file = `/c/Users/alex/private-work/a${separator}b.md`;
    assert.deepEqual(decide({ cwd: PROJECT }, [file]), PROTECTED, JSON.stringify(file));
    assert.deepEqual(decide({}, [file]), PROTECTED, `no cwd: ${JSON.stringify(file)}`);
  }
  assert.deepEqual(decide({ cwd: PROJECT }, ['/proc/cygdrive/c/Users/alex/private-work/a.md']), PROTECTED);
});

test('extra separators are read the way Windows reads them', () => {
  // Three or more at the start are one: rooted on the working directory's drive.
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\\\Users\\alex\\private-work\\a.md']), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['///Users/alex/private-work/a.md']), PROTECTED);
  const share = { HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify(['//fileserver/its/briefs']) };
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\fileserver\\\\its\\briefs\\a.html'], share), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['//fileserver//its//briefs//a.html'], share), PROTECTED);
});

test('a drive-relative path is placed only on its own drive', () => {
  assert.deepEqual(decide({ cwd: 'C:\\Users\\alex' }, ['C:private-work\\a.md']), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['C:docs\\a.md']), ALLOWED);
  for (const file of ['C:Users\\alex\\private-work\\a.md', 'C:..\\private-work\\a.md', 'C:']) {
    const result = decide({ cwd: 'D:\\work\\x' }, [file]);
    assert.deepEqual(result, { allowed: false, reason: 'memory path policy could not be verified' }, file);
  }
});

test('a name that could be the short name of a protected folder counts as it', () => {
  for (const file of [
    'C:\\Users\\alex\\PRIVAT~1\\a.md',
    'C:\\Users\\alex\\privat~2\\sub\\a.md',
    'C:\\Users\\alex\\PRF1A3~1\\a.md',
    'C:\\Users\\alex\\PRIVA~12\\a.md',
  ]) assert.deepEqual(decide({ cwd: PROJECT }, [file]), PROTECTED, file);
  for (const file of ['C:\\Users\\alex\\PROJEC~1\\a.md', 'C:\\Users\\alex\\privatework~1\\a.md']) {
    assert.deepEqual(decide({ cwd: PROJECT }, [file]), ALLOWED, file);
  }
});

test('a NUL character and a very long name fail closed or finish quickly', () => {
  assert.equal(decide({ cwd: PROJECT }, ['C:\\Users\\alex\\private-work\0junk']).reason, 'memory path policy could not be verified');
  const started = Date.now();
  assert.deepEqual(decide({ cwd: PROJECT }, [`C:\\Users\\alex\\${' '.repeat(200000)}x\\a.md`]), ALLOWED);
  assert.ok(Date.now() - started < 2000, 'a long run of spaces must not stall the check');
});

test('a flavor with no roots passed at all is a configuration error; an empty list is a choice', () => {
  const missing = memoryEligibility({ input: { cwd: PROJECT }, env: { HARNESS_HOST_PATH_FLAVOR: 'win32' } });
  assert.deepEqual(missing, { allowed: false, reason: 'invalid memory exclusion configuration' });
  const blank = memoryEligibility({ input: { cwd: PROJECT }, env: { HARNESS_HOST_PATH_FLAVOR: 'win32', HARNESS_MEMORY_EXCLUDED_ROOTS: '' } });
  assert.deepEqual(blank, { allowed: false, reason: 'invalid memory exclusion configuration' });
  assert.deepEqual(decide({ cwd: ROOT }, [], { HARNESS_MEMORY_EXCLUDED_ROOTS: '[]' }), ALLOWED);
});

test('a share root must name a server and a share', () => {
  for (const root of ['\\\\server', '\\\\server\\', '\\\\?\\UNC\\server', '\\\\?\\UNC\\', '\\\\', '//', '/c\n']) {
    const result = decide({ cwd: PROJECT }, [], { HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([root]) });
    assert.deepEqual(result, { allowed: false, reason: 'invalid memory exclusion configuration' }, JSON.stringify(root));
  }
});

test('the folder a tool call ran in is checked, not only the file it named', () => {
  const entry = { path: '..\\..\\projects\\x.md', cwd: `${ROOT}\\sub` };
  assert.deepEqual(decide({ cwd: PROJECT }, [entry]), PROTECTED);
});

test('a path list in a shape the check cannot walk fails closed', () => {
  const inside = 'C:\\Users\\alex\\private-work\\a.md';
  const unverified = { allowed: false, reason: 'memory path policy could not be verified' };
  assert.deepEqual(memoryEligibility({ input: { cwd: PROJECT }, env: env(), paths: inside }), unverified);
  assert.deepEqual(decide({ cwd: PROJECT }, [[inside]]), unverified);
  assert.deepEqual(decide({ cwd: PROJECT }, [{ path: [inside] }]), unverified);
  assert.deepEqual(decide({ cwd: [inside] }), unverified);
  assert.deepEqual(decide({ cwd: PROJECT }, [{ path: '' }, '', null, undefined]), ALLOWED);
});

test('a rooted path with no drive and no working directory is compared without the drive', () => {
  assert.deepEqual(decide({}, ['\\Users\\alex\\private-work\\a.md']), PROTECTED);
  assert.deepEqual(decide({}, ['\\Users\\alex\\projects\\a.md']), ALLOWED);
});

test('a sibling folder, another drive and an ordinary project are allowed', () => {
  assert.deepEqual(decide({ cwd: 'C:/Users/alex/private-work-other/x' }), ALLOWED);
  assert.deepEqual(decide({ cwd: 'D:/Users/alex/private-work/x' }), ALLOWED);
  assert.deepEqual(decide({ cwd: PROJECT }, [{ path: 'C:/Users/alex/projects/app/README.md', cwd: PROJECT }]), ALLOWED);
});

test("the container's own transcript path never matches a Windows root", () => {
  const transcriptPath = '/home/harness/.claude/projects/C--Users-alex-projects-app/abc.jsonl';
  assert.deepEqual(decide({ cwd: PROJECT, transcriptPath }), ALLOWED);
  assert.deepEqual(decide({ transcriptPath }), ALLOWED);
});

test('a share root protects files on that share', () => {
  const overrides = { HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify(['//fileserver/its/briefs']) };
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\fileserver\\its\\briefs\\2026\\a.html'], overrides), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\?\\UNC\\fileserver\\its\\briefs\\a.html'], overrides), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\fileserver\\its\\other\\a.html'], overrides), ALLOWED);
});

test('a relative path with no working directory is protected when it could land in the root', () => {
  // The starting folder is unknown, so a path that begins with the root's
  // last names counts as inside it; one that does not is an ordinary file.
  assert.deepEqual(decide({}, ['private-work\\a.md']), PROTECTED);
  assert.deepEqual(decide({}, ['alex\\private-work\\sub\\a.md']), PROTECTED);
  assert.deepEqual(decide({}, ['..\\private-work\\a.md']), PROTECTED);
  assert.deepEqual(decide({}, ['notes\\a.md']), ALLOWED);
  assert.deepEqual(decide({}, ['local\\a.md']), ALLOWED);
});

test('a Mac or Linux session is judged by its names, not refused', () => {
  // Notes store modified files repo-relative; a session from another machine
  // has a working directory with no drive.
  assert.deepEqual(decide({ cwd: '/Users/alex/projects/app' }, ['src/app/page.tsx']), ALLOWED);
  assert.deepEqual(decide({ cwd: '/home/harness/work/repo' }, [{ path: 'a/b.py', cwd: '/home/harness/work/repo' }]), ALLOWED);
  assert.deepEqual(decide({ cwd: '/Users/alex' }, ['private-work/a.md']), PROTECTED);
  assert.deepEqual(decide({ cwd: '/Users/alex/private-work/x' }), PROTECTED);
});

// ---------------------------------------------------------------------------
// Second review round, 2026-11-11.
// ---------------------------------------------------------------------------

test('a parent segment cancels the odd name before it, as Windows does, not the folder', () => {
  for (const odd of ['...', ' ', ':x', '. .', '.. ', '....']) {
    const file = `C:\\Users\\alex\\private-work\\${odd}\\..\\a.md`;
    assert.deepEqual(decide({ cwd: PROJECT }, [file]), PROTECTED, JSON.stringify(file));
  }
  assert.deepEqual(decide({ cwd: PROJECT }, ['..\\..\\private-work\\...\\..\\a.md']), PROTECTED);
  assert.deepEqual(decide({ cwd: 'C:\\Users\\alex\\private-work\\...\\..' }), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['C:\\Users\\alex\\private-work\\..\\projects\\a.md']), ALLOWED);
});

test('a current-folder segment in a device path is refused like a parent segment', () => {
  for (const file of [
    '\\\\.\\UNC\\.\\localhost\\C$\\Users\\alex\\private-work\\a.md',
    '\\\\.\\UNC\\localhost\\.\\C$\\Users\\alex\\private-work\\a.md',
    '//./UNC/./localhost/C$/Users/alex/private-work/a.md',
  ]) assert.equal(decide({ cwd: PROJECT }, [file]).allowed, false, file);
});

test('a caller that strips device prefixes can ask first whether the path hides its target', () => {
  for (const hidden of ['\\\\.\\X:\\..\\C:\\x', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\x', '\\\\.\\UNC\\.\\host\\share\\x', '//?/Volume{0}/x', '\\??\\Global\\C:\\x']) {
    assert.equal(isUnplaceableDevicePath(hidden), true, hidden);
  }
  for (const plainPath of ['\\\\?\\C:\\Users\\x', '\\\\?\\UNC\\server\\share\\x', '//./C:/x', 'C:\\Users\\x', '\\\\server\\share\\x', '/c/Users/x', 'docs\\a.md', '']) {
    assert.equal(isUnplaceableDevicePath(plainPath), false, plainPath);
  }
});

test('a share reached through a named redirector is refused', () => {
  const result = decide({ cwd: PROJECT }, ['\\\\;LanmanRedirector\\localhost\\C$\\Users\\alex\\private-work\\a.md']);
  assert.deepEqual(result, { allowed: false, reason: 'memory path policy could not be verified' });
});

test('a drive named inside a path is refused: a device prefix was stripped somewhere', () => {
  for (const file of ['X:/../C:/Users/alex/private-work/a.md', 'GLOBALROOT/DosDevices/C:/Users/alex/private-work/a.md', 'Global/C:/Users/alex/private-work/a.md']) {
    assert.equal(decide({ cwd: PROJECT }, [file]).allowed, false, file);
  }
});

test('Unix-shell spellings are read the way the shell reads them', () => {
  for (const file of [
    '/c/../c/Users/alex/private-work/a.md',
    '/./c/Users/alex/private-work/a.md',
    '///c/Users/alex/private-work/a.md',
    '/../c/Users/alex/private-work/a.md',
    '/usr/../c/Users/alex/private-work/a.md',
    '/tmp/../c/Users/alex/private-work/a.md',
    '/proc/cygdrive//c/Users/alex/private-work/a.md',
    '/proc//cygdrive/c/Users/alex/private-work/a.md',
    '/proc/./cygdrive/c/Users/alex/private-work/a.md',
    '/proc/self/root/c/Users/alex/private-work/a.md',
    '/c\\Users\\alex\\private-work\\a.md',
    '/mnt//c/Users/alex/private-work/a.md',
  ]) assert.deepEqual(decide({ cwd: PROJECT }, [file]), PROTECTED, file);
  assert.deepEqual(decide({ cwd: PROJECT }, ['/tmp/build/a.md']), ALLOWED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['/c/Users/alex/projects/a.md']), ALLOWED);
});

test('a home-relative path is protected when it could land in the root', () => {
  assert.deepEqual(decide({ cwd: PROJECT }, ['~/private-work/a.md']), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['~\\private-work']), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['~/.bashrc']), ALLOWED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['~/projects/a.md']), ALLOWED);
});

test('short names follow how Windows builds them', () => {
  const cases = [
    ['a.verylongext', 'A7903~1.VER'],
    ['r\u00e9sum\u00e9 private', 'RSUMPR~1'],
    ['\u79d8\u5bc6\u30d5\u30a9\u30eb\u30c0-private', '-PRIVA~1'],
    ['...dots first', 'DOTSFI~1'],
    ['tilde~in~name-long', 'TILDE~~1'],
    ['stra\u00dfe-root', 'STRAE-~1'],
    ['\u0130stanbul-root', 'STANBU~1'],
    ['private-work', 'PR36C7~1'],
  ];
  for (const [folder, shortName] of cases) {
    const overrides = { HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify([`C:/Users/alex/${folder}`]) };
    assert.deepEqual(decide({ cwd: PROJECT }, [`C:\\Users\\alex\\${shortName}\\a.md`], overrides), PROTECTED, `${folder} as ${shortName}`);
    assert.deepEqual(decide({ cwd: PROJECT }, ['C:\\Users\\alex\\OTHER~1\\a.md'], overrides), ALLOWED, `${folder} against OTHER~1`);
  }
});

test('names fold the way Windows folds them, by upper case too', () => {
  const overrides = { HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify(['C:/Users/alex/\u0391\u03a3-root']) };
  assert.deepEqual(decide({ cwd: PROJECT }, ['C:\\Users\\alex\\\u03b1\u03c3-root\\a.md'], overrides), PROTECTED);
});

// ---------------------------------------------------------------------------
// Third review round, 2026-11-11.
// ---------------------------------------------------------------------------

test('a device share path is read with its separator runs and trailing dots as Windows reads them', () => {
  for (const file of [
    '\\\\.\\UNC\\\\localhost\\C$\\Users\\alex\\private-work\\a.md',
    '//./UNC//localhost/C$/Users/alex/private-work/a.md',
    '\\\\.\\unc\\\\\\localhost\\C$\\Users\\alex\\private-work\\a.md',
    '\\\\?\\UNC\\\\localhost\\C$\\Users\\alex\\private-work\\a.md',
    '\\\\.\\UNC\\localhost\\C$.\\Users\\alex\\private-work\\a.md',
    '\\\\localhost.\\C$ \\Users\\alex\\private-work\\a.md',
  ]) assert.deepEqual(decide({ cwd: PROJECT }, [file]), PROTECTED, file);
  const share = { HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify(['//fileserver/its/briefs']) };
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\.\\UNC\\\\fileserver\\its.\\briefs\\a.html'], share), PROTECTED);
});

test('process links in a Unix-shell path are followed or refused, never ignored', () => {
  for (const file of [
    '/proc/self/root/../c/Users/alex/private-work/a.md',
    '/proc/cygdrive/proc/self/root/c/Users/alex/private-work/a.md',
    '/proc/1234/root/c/Users/alex/private-work/a.md',
    '/proc/self/root/proc/self/root/c/Users/alex/private-work/a.md',
    '/cygdrive/cygdrive/c/Users/alex/private-work/a.md',
  ]) assert.deepEqual(decide({ cwd: PROJECT }, [file]), PROTECTED, file);
  for (const file of ['/proc/self/cwd/../../private-work/a.md', '/proc/1234/cwd/a.md', '/proc/self/task/9/root/c/Users/alex/private-work/a.md']) {
    assert.deepEqual(decide({ cwd: PROJECT }, [file]), { allowed: false, reason: 'memory path policy could not be verified' }, file);
  }
  assert.deepEqual(decide({ cwd: PROJECT }, ['/proc/cpuinfo']), ALLOWED);
});

test('a slash-drive spelling names its drive', () => {
  assert.deepEqual(decide({ cwd: PROJECT }, ['/c:/Users/alex/private-work/a.md']), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['/c:/Users/alex/projects/app/a.ts']), ALLOWED);
});

// ---------------------------------------------------------------------------
// Fourth review round, 2026-11-11.
// ---------------------------------------------------------------------------

test('a file URL is refused, not half-read: it can spell a path too many ways', () => {
  const unverified = { allowed: false, reason: 'memory path policy could not be verified' };
  for (const file of [
    'file:///C:/Users/alex/private-work/a.md',
    'file:///C:/Users/alex/private%2Dwork/a.md',
    'file:///C:/Users/alex/%70rivate-work/a.md',
    'file:///C:/Users/alex/PRIVAT%7E1/a.md',
    'file:///C%3A/Users/alex/private-work/a.md',
    'file:///C:/Users/alex/x/%2E%2E/private-work/a.md',
    'file://localhost/C:/Users/alex/private-work/a.md',
    'file://C:/Users/alex/private-work/a.md',
    'file:///C|/Users/alex/private-work/a.md',
    'file:C:/Users/alex/private-work/a.md',
    'FILE:///C:/Users/alex/projects/app/a.ts',
  ]) assert.deepEqual(decide({ cwd: PROJECT }, [file]), unverified, file);
  assert.deepEqual(decide({ cwd: PROJECT }, ['file:///C:/Users/alex/projects/app/a.ts', 'C:\\Users\\alex\\private-work\\a.md']), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['docs\\file-list.md', 'profile:x']), ALLOWED);
  // A dotless i is not an i: the Python side must agree.
  assert.deepEqual(decide({ cwd: PROJECT }, ['fıle:x/a.md']), ALLOWED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['FiLe:x/a.md']), unverified);
});

test('a parent step under /proc or /dev is refused: /dev/fd leads back into /proc/self', () => {
  const unverified = { allowed: false, reason: 'memory path policy could not be verified' };
  for (const file of [
    '/dev/fd/../root/c/Users/alex/private-work/a.md',
    '/proc/self/root/dev/fd/../root/c/Users/alex/private-work/a.md',
    '/dev/fd/../cwd/../../private-work/a.md',
    '/proc/self/../self/root/c/Users/alex/private-work/a.md',
    '/Dev/fd/../root/c/Users/alex/private-work/a.md',
    '/DEV/FD/../root/c/Users/alex/private-work/a.md',
  ]) assert.deepEqual(decide({ cwd: PROJECT }, [file]), unverified, file);
  assert.deepEqual(decide({ cwd: PROJECT }, ['/dev/null', '/proc/self/status', '/usr/../tmp/a.md']), ALLOWED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['/proc/self/root/../c/Users/alex/private-work/a.md']), PROTECTED);
});

test('a whole-drive or whole-share root does not swallow paths that have no drive', () => {
  const rooted = roots => ({ HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify(roots) });
  for (const roots of [['D:\\'], ['//fs/its']]) {
    // The container's own transcript path, a Mac session and a Linux session.
    assert.deepEqual(decide({ cwd: 'C:\\Users\\alex\\projects\\app', transcriptPath: '/home/harness/.claude/projects/x/a.jsonl' }, [], rooted(roots)), ALLOWED, JSON.stringify(roots));
    assert.deepEqual(decide({ cwd: '/Users/alex/projects/app' }, ['src/a.ts'], rooted(roots)), ALLOWED, JSON.stringify(roots));
    assert.deepEqual(decide({ cwd: '/home/alex/repo' }, [], rooted(roots)), ALLOWED, JSON.stringify(roots));
  }
  assert.deepEqual(decide({ cwd: 'D:\\work' }, ['a.md'], rooted(['D:\\'])), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\fs\\its\\briefs\\a.md'], rooted(['//fs/its'])), PROTECTED);
});

test('a drive named inside a path is refused even with a trailing dot or space', () => {
  for (const file of ['X:/../C:./Users/alex/private-work/a.md', 'X:\\..\\C: \\Users\\alex\\private-work\\a.md']) {
    assert.equal(decide({ cwd: PROJECT }, [file]).allowed, false, file);
  }
});

test('a root that is a whole drive, a whole share or a home folder covers what could be inside it', () => {
  const rooted = roots => ({ HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify(roots) });
  assert.deepEqual(decide({}, ['notes\\a.md'], rooted(['C:\\'])), PROTECTED);
  assert.deepEqual(decide({}, ['notes\\a.md'], rooted(['//fs/its'])), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['~/Documents/a.md'], rooted(['C:\\Users\\alex'])), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['~'], rooted(['C:\\Users'])), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['~/Documents/a.md'], rooted(['C:\\Users\\alex\\private-work'])), ALLOWED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['~/Documents/a.md'], rooted(['D:\\work\\private'])), ALLOWED);
});

test('with no roots there is nothing to judge, whatever shape the paths have', () => {
  const none = { HARNESS_MEMORY_EXCLUDED_ROOTS: '[]' };
  assert.deepEqual(decide({ cwd: [] }, [5, {}], none), ALLOWED);
  assert.deepEqual(memoryEligibility({ input: { cwd: PROJECT }, env: {}, paths: [5, {}] }), ALLOWED);
  assert.deepEqual(decide({ cwd: 0 }, ['a.md']), { allowed: false, reason: 'memory path policy could not be verified' });
});

test('a protected path wins over a malformed entry beside it', () => {
  const inside = 'C:\\Users\\alex\\private-work\\a.md';
  assert.deepEqual(decide({ cwd: PROJECT }, [inside, 5]), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, [5, { file_path: inside }, inside]), PROTECTED);
  assert.deepEqual(decide({ cwd: PROJECT }, ['\\\\?\\GLOBALROOT\\x', inside]), PROTECTED);
});

test('an entry object with neither a path nor a folder fails closed', () => {
  const unverified = { allowed: false, reason: 'memory path policy could not be verified' };
  assert.deepEqual(decide({ cwd: PROJECT }, [{ file_path: 'C:\\Users\\alex\\private-work\\a.md' }]), unverified);
  assert.deepEqual(decide({ cwd: PROJECT }, [{}]), unverified);
  assert.deepEqual(decide({ cwd: PROJECT }, [new String('C:\\Users\\alex\\private-work\\a.md')]), unverified);
});

test('a root that is not a full Windows path is a configuration error, not a pass', () => {
  for (const roots of [['/home/harness/private-work'], ['private-work'], ['C:private-work'], ['\\Users\\alex\\private-work']]) {
    const result = decide({ cwd: PROJECT }, [], { HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify(roots) });
    assert.deepEqual(result, { allowed: false, reason: 'invalid memory exclusion configuration' }, JSON.stringify(roots));
  }
});

test('an unknown flavor is a configuration error even with no roots', () => {
  const result = memoryEligibility({ input: { cwd: PROJECT }, env: { HARNESS_HOST_PATH_FLAVOR: 'beos' } });
  assert.deepEqual(result, { allowed: false, reason: 'invalid memory exclusion configuration' });
});

test('classification and explicit exclusion still win under a flavor', () => {
  assert.equal(decide({ cwd: PROJECT, classification: 'TLP:AMBER' }).reason, 'restricted session');
  assert.equal(decide({ cwd: PROJECT, memory_excluded: true }).reason, 'session excluded from memory');
});

test('a worker blocked by its own configuration says so and fails, instead of exiting clean', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-worker-blocked-'));
  try {
    const lines = [];
    const result = await runMemoryWorker({
      home,
      env: { HARNESS_HOST_PATH_FLAVOR: 'win32', HARNESS_MEMORY_EXCLUDED_ROOTS: JSON.stringify(['/not/a/windows/root']) },
      log: line => lines.push(line),
      candidates: [],
    });
    assert.equal(result.disabled, true);
    assert.equal(result.failed, 1);
    assert.ok(lines.some(line => /invalid memory exclusion configuration/.test(line)), lines.join('\n'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a worker switched off on purpose stays a clean no-op', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-worker-off-'));
  try {
    const result = await runMemoryWorker({ home, env: { HARNESS_MEMORY_PERSISTENCE: 'off' }, log: () => {}, candidates: [] });
    assert.deepEqual(result, { disabled: true, failed: 0 });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
