/**
 * The hook's only untrusted input: the JSON Claude Code writes to stdin.
 *
 * `session_id` becomes a **filename** in the vault, so it is validated as
 * strictly as anything in this repo: an allow-list of characters, no separators,
 * no dots that could climb a directory. Everything else is normalised to a known
 * shape or dropped. Nothing here throws; a malformed payload is a logged skip.
 */

import fs from 'node:fs';

import { END_REASONS, PARENT_SESSION_ENV_VAR } from './constants.mjs';
import { isSafeFilenameSegment, pick, toPosix } from './text.mjs';

/**
 * Read stdin without ever blocking session exit.
 *
 * `fs.readFileSync(0)` works for a file redirect but returns nothing on some
 * Windows pipe handles — verified: `node hook.mjs < payload.json` reads fine
 * while `echo … | node hook.mjs` does not. A hook that silently reads nothing
 * captures nothing forever, so the fallback is a chunked `readSync` loop that
 * tolerates EAGAIN on a non-blocking pipe and is bounded by the deadline.
 */
export function readStdin(deadlineAt) {
  try {
    const direct = fs.readFileSync(0, 'utf8');
    if (direct && direct.trim()) return direct;
  } catch {
    /* fall through to the chunked reader */
  }

  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  while (Date.now() < deadlineAt) {
    let read;
    try {
      read = fs.readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err && err.code === 'EAGAIN') {
        // The pipe has nothing yet. Spinning here would burn a core for the
        // whole budget before the capture even starts, so wait a millisecond —
        // Atomics.wait is the only synchronous sleep Node has without a
        // dependency.
        pause(1);
        continue;
      }
      break; // EOF, EBADF, or a closed handle
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A synchronous sleep, for the one place that genuinely needs one. */
function pause(milliseconds) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    /* SharedArrayBuffer unavailable: fall through and spin, as before */
  }
}

/**
 * Validate and normalise the payload.
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function parseHookInput(raw, env = process.env) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'stdin was not JSON' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'stdin was not an object' };
  }

  const sessionId = pick(input, 'session_id', 'sessionId');
  if (!sessionId) return { ok: false, error: 'no session_id' };
  if (!isSafeFilenameSegment(sessionId)) {
    return { ok: false, error: `session_id is not a safe filename: ${JSON.stringify(sessionId.slice(0, 64))}` };
  }

  const reasonRaw = pick(input, 'reason', 'end_reason');
  const endReason = END_REASONS.has(reasonRaw) ? reasonRaw : 'other';

  // `SubagentStop` and `SessionEnd` share this payload shape; the event name is
  // what says which note to write. An unknown event is not guessed at.
  const hookEventName = pick(input, 'hook_event_name', 'hookEventName');
  const agentId = pick(input, 'agent_id', 'agentId');

  const parentFromEnv = String(env?.[PARENT_SESSION_ENV_VAR] ?? '').trim();
  const parentSession = pick(input, 'parent_session_id', 'parentSessionId', 'parent_session') || parentFromEnv;

  return {
    ok: true,
    value: {
      sessionId,
      endReason,
      hookEventName,
      cwd: toPosix(pick(input, 'cwd')),
      transcriptPath: toPosix(pick(input, 'transcript_path', 'transcriptPath')),
      // The agent id becomes half of a filename, so it is held to the same
      // allow-list as the session id.
      agentId: isSafeFilenameSegment(agentId.replace(/^agent-/, '')) ? agentId : '',
      agentType: pick(input, 'agent_type', 'agentType'),
      agentTranscriptPath: toPosix(pick(input, 'agent_transcript_path', 'agentTranscriptPath')),
      parentSession: isSafeFilenameSegment(parentSession) ? parentSession : '',
      ...Object.fromEntries(['memory_excluded', 'purpose', 'classification', 'data_classification', 'restricted', 'persistence']
        .filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])),
    },
  };
}
