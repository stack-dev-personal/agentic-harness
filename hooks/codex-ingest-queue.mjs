#!/usr/bin/env node
/** Compatibility entry point: all runtimes now use one worker and queue. */
import path from 'node:path';
import { runMemoryWorker } from './memory-worker.mjs';
import { createLogger } from './lib/logger.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { harnessDir } from './lib/machine-env.mjs';
if (isEntryPoint(import.meta.url)) {
  const log = createLogger(path.join(harnessDir(), 'memory-worker.log'));
  try { const result = await runMemoryWorker({ log }); if (result.failed) process.exitCode = 1; }
  catch { log('memory worker failed; pending work retained'); process.exitCode = 1; }
}