/** Durable, path-only queue shared by every runtime and platform. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DISABLE_VALUES } from './constants.mjs';
import { ENV_ENABLED, ingestEntry, inBatches, resolveProjectDir, resolveUv } from './enqueue-ingest.mjs';
import { loadMachineEnv } from './machine-env.mjs';
import { PERSISTENCE_DISABLED, memoryEligibility } from './memory-policy.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { persist } from './notes-io.mjs';

export const TASK_NAME = 'AgenticHarness-Memory';
export const QUEUE_NAME = 'memory-ingest-queue.jsonl';
const BATCH_SIZE = 20;
const INGEST_TIMEOUT_MS = 30 * 60 * 1000;
/** Ingest prints a line per document; the 1 MB default would end a big batch with ENOBUFS. */
const INGEST_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_DRAIN_PASSES = 10;

function queuePath(env, queueName = QUEUE_NAME) {
  return path.join(env.USERPROFILE || os.homedir(), '.harness', queueName);
}

function isVaultNote(file, vaultRoot) {
  if (typeof file !== 'string') return false;
  const relative = path.relative(path.resolve(vaultRoot), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(file).toLowerCase() !== '.md' || !fs.existsSync(file)) return false;
  const realRelative = path.relative(fs.realpathSync(vaultRoot), fs.realpathSync(file));
  return realRelative && !realRelative.startsWith('..') && !path.isAbsolute(realRelative);
}

/**
 * Append the notes to the queue and start the scheduled task. Never throws:
 * it runs inside SessionEnd, so every failure comes back as `{ queued: false, reason }`
 * and is logged; the periodic task's checkpoint and drain are the retry.
 */
export function queueIngest({ notePaths, vaultRoot, env = process.env, log = () => {}, run = spawnSync, startTask = true, queueName = QUEUE_NAME, taskName = TASK_NAME }) {
  try {
    const gate = memoryEligibility({ env });
    if (!gate.allowed) {
      if (gate.reason === PERSISTENCE_DISABLED) return { queued: false, reason: 'memory persistence disabled by policy' };
      // A broken setting, not a choice: it must show in the log, not pass as "off".
      log(`ingest not queued: ${gate.reason}`);
      return { queued: false, reason: gate.reason };
    }
    if (DISABLE_VALUES.has(String(env[ENV_ENABLED] ?? '').toLowerCase())) {
      return { queued: false, reason: `disabled by ${ENV_ENABLED}` };
    }
    const notes = [...new Set(notePaths.filter((file) => isVaultNote(file, vaultRoot)))];
    for (const note of notes) assertNoteEligible(note, env);
    if (!notes.length) return { queued: false, reason: 'no vault notes' };
    const file = queuePath(env, queueName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, notes.map((note) => JSON.stringify(path.resolve(note))).join('\n') + '\n');
    if (!startTask || DISABLE_VALUES.has(String(env.HARNESS_MEMORY_START_WORKER ?? '').toLowerCase())) return { queued: true, taskStarted: false, notes: notes.length };
    if (process.platform !== 'win32') {
      const worker = fileURLToPath(new URL('../memory-worker.mjs', import.meta.url));
      const child = spawn(process.execPath, [worker], { env, detached: true, stdio: 'ignore' });
      child.on('error', () => log('memory worker start failed; scheduled retry required'));
      child.unref();
      return { queued: true, taskStarted: true, notes: notes.length };
    }
    const executable = path.join(env.SystemRoot || path.join(path.parse(os.homedir()).root, 'Windows'), 'System32', 'schtasks.exe');
    const result = run(executable, ['/Run', '/TN', taskName], { timeout: 1000, windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) log(`ingest queued; scheduled task did not start (${result.error?.code || result.status}); periodic trigger will retry`);
    return { queued: true, taskStarted: result.status === 0, notes: notes.length };
  } catch (error) {
    const reason = `queue write failed (${error?.code || error?.name || 'error'})`;
    log(`ingest not queued: ${reason}`);
    return { queued: false, reason };
  }
}

function assertNoteEligible(note, env) {
  const parsed = parseFrontmatter(fs.readFileSync(note, 'utf8'));
  if (!parsed.ok) throw new Error('queued note has unreadable frontmatter');
  const policy = memoryEligibility({ input: parsed.fields, env, paths: [note] });
  if (!policy.allowed) throw new Error('queued note excluded by memory policy');
}

function readQueuedNotes(file, vaultRoot, env) {
  const notes = new Set();
  const rejected = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      const note = JSON.parse(line);
      if (!isVaultNote(note, vaultRoot)) throw new Error('queued note unavailable');
      assertNoteEligible(note, env);
      notes.add(note);
    } catch { rejected.push(line); }
  }
  return { notes: [...notes], rejected };
}

/**
 * Task Scheduler runs this in its own process, outside Codex's hook job.
 * A file whose ingest fails stays on disk for the next run, and the drain
 * moves on to the other files, so one bad note never blocks the queue.
 * Returns `{ ingested, failed }`, `failed` being the file names left behind.
 */
export function drainIngest({ env = process.env, run = spawnSync, log = () => {}, queueName = QUEUE_NAME } = {}) {
  const loaded = loadMachineEnv(env);
  const gate = memoryEligibility({ env: loaded });
  if (!gate.allowed) {
    if (gate.reason === PERSISTENCE_DISABLED) return { ingested: 0, failed: [], disabled: true };
    // A broken setting is a failure, not "off": a caller that only counts
    // `failed` must see it.
    log(`ingest queue not drained: ${gate.reason}`);
    return { ingested: 0, failed: [`blocked: ${gate.reason}`], disabled: true };
  }
  const vaultRoot = loaded.HARNESS_VAULT || path.join(loaded.USERPROFILE || os.homedir(), 'vault');
  const projectDir = resolveProjectDir(loaded);
  const uv = resolveUv(loaded);
  if (!uv || !fs.existsSync(projectDir)) throw new Error('ingest project or uv is unavailable');
  const pending = queuePath(loaded, queueName);
  const directory = path.dirname(pending);
  fs.mkdirSync(directory, { recursive: true });
  let ingested = 0;
  const failed = new Set();
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
    const work = fs.readdirSync(directory)
      .filter((name) => name.startsWith(`${queueName}.processing-`) && !failed.has(name));
    if (fs.existsSync(pending)) {
      const processing = `${pending}.processing-${process.pid}-${pass}`;
      fs.renameSync(pending, processing);
      work.push(path.basename(processing));
    }
    if (!work.length) break;
    for (const name of work) {
      const file = path.join(directory, name);
      try {
        const queued = readQueuedNotes(file, vaultRoot, loaded);
        for (const batch of inBatches(queued.notes, BATCH_SIZE)) {
          const args = ['--directory', projectDir, 'run', ...ingestEntry(process.platform),
            '--source', 'obsidian', '--path', vaultRoot, ...batch.flatMap((note) => ['--only', note])];
          const result = run(uv, args, { env: loaded, windowsHide: true, encoding: 'utf8',
            timeout: INGEST_TIMEOUT_MS, maxBuffer: INGEST_MAX_BUFFER });
          if (result.status !== 0) throw new Error(`ingest failed (${result.error?.code || result.status})`);
          ingested += batch.length;
          log(`ingested ${batch.length} memory note(s)`);
        }
        if (queued.rejected.length) {
          const saved = persist(file, queued.rejected.join('\n') + '\n');
          if (!saved.ok) throw new Error('rejected queue entries could not be retained');
          failed.add(name);
          log(`${queued.rejected.length} queue entries retained for review`);
        } else fs.unlinkSync(file);
      } catch (error) {
        failed.add(name);
        log(`${name} kept for the next run: ${error?.message || error}`);
      }
    }
  }
  return { ingested, failed: [...failed] };
}
