#!/usr/bin/env node
/**
 * codex-session-start.mjs — Codex `SessionStart` hook.
 *
 * Gives a Codex chat the same start brief Claude Code gets (session-start.mjs).
 * Codex's `session-start.command.input` carries `session_id` and `cwd`, and its
 * `session-start.command.output` schema accepts exactly
 * `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`.
 * The record it writes is what codex-session-capture.mjs reads at SessionEnd.
 *
 * Only the default log differs: `~/.codex/hooks/session-start.log`.
 * Disable: HARNESS_SESSION_START=0.
 */

import os from 'node:os';
import path from 'node:path';

import { isEntryPoint } from './lib/entry-point.mjs';
import { startHookProcess } from './session-start.mjs';

export const CODEX_LOG_PATH = path.join(os.homedir(), '.codex', 'hooks', 'session-start.log');

if (isEntryPoint(import.meta.url)) startHookProcess({ logPath: CODEX_LOG_PATH, runtime: 'codex' });
