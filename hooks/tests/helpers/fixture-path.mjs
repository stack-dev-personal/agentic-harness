import fs from 'node:fs';

/** Preserve Windows long-name expansion, with the standard resolver as a portable fallback. */
export function canonicalFixturePath(value, {
  nativeRealpath = fs.realpathSync.native,
  realpath = fs.realpathSync,
} = {}) {
  try {
    return nativeRealpath(value);
  } catch (error) {
    if (!['EPERM', 'ENOSYS'].includes(error.code)) throw error;
    return realpath(value);
  }
}
