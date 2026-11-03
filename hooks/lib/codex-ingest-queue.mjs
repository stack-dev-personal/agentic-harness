/** Hand Codex captures to Task Scheduler; Codex terminates detached hook children. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DISABLE_VALUES } from './constants.mjs';
import { ENV_ENABLED, ingestEntry, inBatches, resolveProjectDir, resolveUv } from './enqueue-ingest.mjs';
import { loadMachineEnv } from './machine-env.mjs';

export const TASK_NAME = 'AgenticHarness-CodexIngest';
const QUEUE_NAME = 'codex-ingest-queue.jsonl';
const PROCESSING_PREFIX = `${QUEUE_NAME}.processing-`;
const BATCH_SIZE = 20;
const INGEST_TIMEOUT_MS = 30 * 60 * 1000;
/** Ingest prints a line per document; the 1 MB default would end a big batch with ENOBUFS. */
const INGEST_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_DRAIN_PASSES = 10;

function queuePath(env) {
  return path.join(env.USERPROFILE || os.homedir(), '.harness', QUEUE_NAME);
}

function isVaultNote(file, vaultRoot) {
  const relative = path.relative(path.resolve(vaultRoot), path.resolve(file));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && path.extname(file).toLowerCase() === '.md' && fs.existsSync(file);
}

/**
 * Append the notes to the queue and start the scheduled task. Never throws:
 * it runs inside SessionEnd, so every failure comes back as `{ queued: false, reason }`
 * and is logged; the daily task's sweep and drain are the retry.
 */
export function queueCodexIngest({ notePaths, vaultRoot, env = process.env, log = () => {}, run = spawnSync, startTask = true }) {
  try {
    if (DISABLE_VALUES.has(String(env[ENV_ENABLED] ?? '').toLowerCase())) {
      return { queued: false, reason: `disabled by ${ENV_ENABLED}` };
    }
    const notes = [...new Set(notePaths.filter((file) => isVaultNote(file, vaultRoot)))];
    if (!notes.length) return { queued: false, reason: 'no vault notes' };
    const file = queuePath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, notes.map((note) => JSON.stringify(path.resolve(note))).join('\n') + '\n');
    if (!startTask) return { queued: true, taskStarted: false, notes: notes.length };
    const executable = path.join(env.SystemRoot || path.join(path.parse(os.homedir()).root, 'Windows'), 'System32', 'schtasks.exe');
    const result = run(executable, ['/Run', '/TN', TASK_NAME], { timeout: 1000, windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) log(`ingest queued; scheduled task did not start (${result.error?.code || result.status}); daily trigger will retry`);
    return { queued: true, taskStarted: result.status === 0, notes: notes.length };
  } catch (error) {
    const reason = `queue write failed (${error?.code || error?.name || 'error'})`;
    log(`ingest not queued: ${reason}`);
    return { queued: false, reason };
  }
}

function readQueuedNotes(file, vaultRoot) {
  return [...new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter((note) => typeof note === 'string' && isVaultNote(note, vaultRoot)))];
}

/**
 * Task Scheduler runs this in its own process, outside Codex's hook job.
 * A file whose ingest fails stays on disk for the next run, and the drain
 * moves on to the other files, so one bad note never blocks the queue.
 * Returns `{ ingested, failed }`, `failed` being the file names left behind.
 */
export function drainCodexIngest({ env = process.env, run = spawnSync, log = () => {} } = {}) {
  const loaded = loadMachineEnv(env);
  const vaultRoot = loaded.HARNESS_VAULT || path.join(loaded.USERPROFILE || os.homedir(), 'vault');
  const projectDir = resolveProjectDir(loaded);
  const uv = resolveUv(loaded);
  if (!uv || !fs.existsSync(projectDir)) throw new Error('ingest project or uv is unavailable');
  const pending = queuePath(loaded);
  const directory = path.dirname(pending);
  fs.mkdirSync(directory, { recursive: true });
  let ingested = 0;
  const failed = new Set();
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
    const work = fs.readdirSync(directory)
      .filter((name) => name.startsWith(PROCESSING_PREFIX) && !failed.has(name));
    if (fs.existsSync(pending)) {
      const processing = `${pending}.processing-${process.pid}-${pass}`;
      fs.renameSync(pending, processing);
      work.push(path.basename(processing));
    }
    if (!work.length) break;
    for (const name of work) {
      const file = path.join(directory, name);
      try {
        for (const batch of inBatches(readQueuedNotes(file, vaultRoot), BATCH_SIZE)) {
          const args = ['--directory', projectDir, 'run', ...ingestEntry(process.platform),
            '--source', 'obsidian', '--path', vaultRoot, ...batch.flatMap((note) => ['--only', note])];
          const result = run(uv, args, { env: loaded, windowsHide: true, encoding: 'utf8',
            timeout: INGEST_TIMEOUT_MS, maxBuffer: INGEST_MAX_BUFFER });
          if (result.status !== 0) throw new Error(`ingest failed (${result.error?.code || result.status}): ${(result.stderr || '').slice(-400)}`);
          ingested += batch.length;
          log(`ingested ${batch.length} Codex note(s)`);
        }
        fs.unlinkSync(file);
      } catch (error) {
        failed.add(name);
        log(`${name} kept for the next run: ${error?.message || error}`);
      }
    }
  }
  return { ingested, failed: [...failed] };
}
