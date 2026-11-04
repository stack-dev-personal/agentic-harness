/**
 * Windows extended-length and device paths.
 *
 * Codex 0.166 records every thread's `cwd` as `\\?\C:\Users\...`. Left alone,
 * the prefix reached the note as `//?/C:/Users/...`, which `isLocalPath`
 * reads as a UNC path: the session lost its repository, branch and commits,
 * `cwds_seen` listed the same folder twice, and the memory path policy could
 * neither resolve nor refuse the folder.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isLocalPath, toPosix } from '../lib/text.mjs';

test('the extended-length prefix is dropped from a local path', () => {
  assert.equal(toPosix('\\\\?\\C:\\Users\\stack\\projects\\agik-os'), 'C:/Users/stack/projects/agik-os');
  assert.equal(toPosix('//?/C:/Users/stack'), 'C:/Users/stack');
  assert.equal(isLocalPath(toPosix('\\\\?\\C:\\Users\\stack')), true);
});

test('the device prefix is dropped the same way', () => {
  assert.equal(toPosix('\\\\.\\C:\\Users\\stack'), 'C:/Users/stack');
  assert.equal(isLocalPath(toPosix('\\\\.\\C:\\Users\\stack')), true);
});

test('the extended-length UNC form is still a UNC path, and still refused', () => {
  assert.equal(toPosix('\\\\?\\UNC\\evil.example\\share\\x'), '//evil.example/share/x');
  assert.equal(isLocalPath(toPosix('\\\\?\\UNC\\evil.example\\share\\x')), false);
});

test('ordinary paths are untouched', () => {
  assert.equal(toPosix('C:\\Users\\stack'), 'C:/Users/stack');
  assert.equal(toPosix('/home/stack/vault'), '/home/stack/vault');
  assert.equal(toPosix('\\\\evil.example\\share'), '//evil.example/share');
  assert.equal(toPosix(''), '');
  assert.equal(toPosix(undefined), '');
});
