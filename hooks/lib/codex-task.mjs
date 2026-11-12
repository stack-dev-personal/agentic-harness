/**
 * A delegated Codex thread's task line, shared by the SQLite and rollout adapters
 * so both write the same note for the same thread.
 *
 * Codex 0.166 stores the spawn prompt encrypted at rest, in SQLite and in the
 * rollout file alike, as a Fernet token. A token is not a task: written into a
 * note it is noise in search and in the store. It counts as "not recorded".
 */
import { toPosix } from './text.mjs';

// Fernet: version byte 0x80, then a 64-bit timestamp whose top bytes are zero,
// so the base64url text starts `gAAAAA`. The shortest token (one cipher block
// and the HMAC) is 73 bytes, about 100 characters.
const FERNET_TOKEN = /^gAAAAA[A-Za-z0-9_-]{80,}={0,2}$/;

/** True when the text is nothing but one encrypted token. */
export function isEncryptedTask(text) {
  return typeof text === 'string' && FERNET_TOKEN.test(text.trim());
}

/**
 * The task line for a delegate whose assignment cannot be read. It names no
 * cause or version: it is persisted into notes, and the reason may change with
 * the next Codex release.
 */
export function placeholderTask({ agentPath = '', agentNickname = '', id = '' } = {}) {
  const name = toPosix(agentPath || '').split('/').filter(Boolean).pop() || agentNickname || id;
  return `Delegated Codex task ${name}: assignment not recorded by Codex`;
}
