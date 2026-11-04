/** Compatibility names for older hooks and queued work; policy and drain are shared. */
import { queueIngest, drainIngest } from './ingest-queue.mjs';
export { TASK_NAME } from './ingest-queue.mjs';
const LEGACY_QUEUE = 'codex-ingest-queue.jsonl';
export function queueCodexIngest(options) { return queueIngest({ ...options, queueName: LEGACY_QUEUE }); }
export function drainCodexIngest(options = {}) { return drainIngest({ ...options, queueName: LEGACY_QUEUE }); }