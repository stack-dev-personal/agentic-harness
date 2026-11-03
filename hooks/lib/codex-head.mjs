/** The first record of a Codex rollout transcript: its `session_meta`. */
import fs from 'node:fs';

const CHUNK_BYTES = 64 * 1024;
/** `session_meta` carries the base instructions, so its line can run long. */
export const MAX_HEAD_BYTES = 4 * 1024 * 1024;

/**
 * Read the first line of `file` and parse it as the `session_meta` record.
 * Returns `{ record }` on success, or `{ record: null, error }` with a reason
 * that never quotes the file, so callers can fail closed and log why.
 */
export function readCodexHead(file, maxBytes = MAX_HEAD_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, maxBytes - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (count === 0) break;
      const newline = buffer.subarray(0, count).indexOf(0x0a);
      chunks.push(buffer.subarray(0, newline === -1 ? count : newline));
      total += count;
      if (newline !== -1) return parseHead(Buffer.concat(chunks).toString('utf8'));
    }
    if (total >= maxBytes) return { record: null, error: 'first line too long' };
    return parseHead(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    return { record: null, error: `unreadable (${error?.code || error?.name || 'error'})` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseHead(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return { record: null, error: 'first line is not JSON' };
  }
  if (record?.type !== 'session_meta') return { record: null, error: 'first record is not session_meta' };
  return { record };
}

/** A subagent rollout: it inherits its parent's context, so it is never captured on its own. */
export function isSubagentHead(record) {
  return Boolean(record?.payload?.parent_thread_id) || typeof record?.payload?.source === 'object';
}
