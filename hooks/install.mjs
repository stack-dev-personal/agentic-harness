#!/usr/bin/env node
/**
 * Deploy the hooks to `~/.claude/hooks/`: the capture hook (`session-capture.mjs`),
 * the SessionStart brief (`session-start.mjs`, R-H4) and every module they import.
 *
 * The source of truth is this repository. The deployed copy is a byte-identical
 * copy, never a symlink and never a `settings.json` entry pointing into a
 * worktree — a worktree gets deleted, and a hook that vanishes with it takes
 * every future session's note with it.
 *
 *   node hooks/install.mjs [--dry-run] [--register-mcp] [--target <dir>] [--settings <file>]
 *                          [--node <path to node.exe>] [--skip-settings]
 *
 * The existing deployment is backed up first, and every copied file is read
 * back and compared by SHA-256, because "it looked like it copied" is not the
 * standard for something that runs on every session exit.
 *
 * It then registers the capture hook for `SessionEnd` and `SubagentStop`, and
 * the start hook for `SessionStart` (matcher `startup|resume`), in
 * `~/.claude/settings.json`. That file is the user's — permissions, model,
 * plugins, other tools' hooks — so the write is a read-merge-write that touches
 * only those three events and leaves everything else exactly as it found it. A
 * second run changes nothing.
 *
 * `--config` is a second, separate mode (R-H5): it places a clone of the
 * private `claude-config` repo (CLAUDE.md, rules, skills, skill-vault and a
 * settings template) on this machine.
 *
 *   node hooks/install.mjs --config --dry-run|--apply [--config-repo <dir>] [--target <claudeDir>]
 *                          [--node <path to node.exe>]
 *
 * Defaults: `~/claude-config` into `~/.claude`. It scans the clone with the
 * capture hook's secret rules first and refuses the whole apply on a finding
 * the repo's `.scan-exceptions.json` does not cover, on a denylisted path in
 * the repo, or on a write that would go through a link. Files it overwrites are
 * backed up to `<target>/config-backup-<stamp>/`; nothing in the target is ever
 * deleted. The template's hooks and permissions are merged into
 * `<target>/settings.json` add-only (see `mergeSettingsTemplate`).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCAN_EXCEPTIONS_FILE,
  SETTINGS_TEMPLATE_FILE,
  mergeSettingsTemplate,
  parseScanExceptions,
  partitionFindings,
  planInstall,
  scanForSecrets,
} from './lib/claude-config.mjs';
import { isEntryPoint } from './lib/entry-point.mjs';
import { loadMachineEnv, loadRepoEnv } from './lib/machine-env.mjs';
import { SCOPE, SERVER_NAME, buildRagServerConfig, registerRagServer } from './lib/mcp-registration.mjs';
import { hookCommands, withHookRegistered } from './lib/settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * `--register-mcp` builds the server entry from the environment: the repo's
 * .env (secrets) and the machine file (paths), the shell winning over both.
 * Loaded on a direct run only, so importing this module changes nothing.
 */
function loadEnvironment() {
  const report = (problem) => console.error(problem);
  Object.assign(
    process.env,
    loadMachineEnv(loadRepoEnv(process.env, path.resolve(HERE, '..'), report), os.homedir(), report),
  );
}

/** The scripts settings.json runs. Everything else deployed is what these import. */
const ENTRY_POINTS = Object.freeze(['session-capture.mjs', 'session-start.mjs', 'memory-worker.mjs']);

/** A static `import … from './x.mjs'`, `import './x.mjs'` or `export … from './x.mjs'` at a line start. */
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g;
/** `import('./x.mjs')` with a literal relative path. No hook module uses a computed one. */
const DYNAMIC_IMPORT = /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * Exactly what the hooks need at runtime: the entry points and every module
 * they reach through relative imports, as paths relative to this folder.
 *
 * Walked from the source, not kept as a list: a hand-kept list went stale the
 * first time a module was added (`lib/spawn.mjs`), and the deployed hook then
 * failed on import with nothing but a log line to show for it. Tests and repo
 * tools are never reached from an entry point, so they stay in the repo.
 */
function runtimePayload(entries = ENTRY_POINTS) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const file = path.join(HERE, relative);
    if (!fs.existsSync(file)) continue; // reported as missing by main()
    const source = fs.readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(STATIC_IMPORT), ...source.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]);
    for (const specifier of specifiers) {
      const resolved = path.relative(HERE, path.resolve(path.dirname(file), specifier)).replace(/\\/g, '/');
      if (resolved.startsWith('../')) throw new Error(`${relative} imports ${specifier}, outside hooks/`);
      queue.push(resolved);
    }
  }
  return Object.freeze([...seen].sort());
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Flags that take a value, and the args key each one sets. */
const VALUE_FLAGS = Object.freeze({
  '--target': 'target',
  '--settings': 'settings',
  '--node': 'node',
  '--config-repo': 'configRepo',
});
/** Flags of the hook install that mean nothing to `--config`, and the reverse. */
const HOOK_ONLY_FLAGS = Object.freeze(['--register-mcp', '--settings', '--skip-settings']);
const CONFIG_ONLY_FLAGS = Object.freeze(['--apply', '--config-repo']);

function parseArgs(argv) {
  const seen = new Set();
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (VALUE_FLAGS[arg]) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      values[VALUE_FLAGS[arg]] = value;
      index += 1;
    } else if (!['--dry-run', '--apply', '--config', ...HOOK_ONLY_FLAGS].includes(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    seen.add(arg);
  }
  return seen.has('--config') ? configArgs(seen, values) : hookArgs(seen, values);
}

function hookArgs(seen, values) {
  const stray = CONFIG_ONLY_FLAGS.find((flag) => seen.has(flag));
  if (stray) throw new Error(`${stray} is for --config`);
  return {
    config: false,
    dryRun: seen.has('--dry-run'),
    skipSettings: seen.has('--skip-settings'),
    registerMcp: seen.has('--register-mcp'),
    target: values.target ?? path.join(os.homedir(), '.claude', 'hooks'),
    settings: values.settings ?? path.join(os.homedir(), '.claude', 'settings.json'),
    node: values.node ?? process.execPath,
  };
}

function configArgs(seen, values) {
  const stray = HOOK_ONLY_FLAGS.find((flag) => seen.has(flag));
  if (stray) throw new Error(`${stray} is for the hook install, not with --config`);
  if (seen.has('--dry-run') && seen.has('--apply')) throw new Error('--config takes either --dry-run or --apply, not both');
  if (!seen.has('--dry-run') && !seen.has('--apply')) throw new Error('--config needs --dry-run or --apply');
  return {
    config: true,
    dryRun: seen.has('--dry-run'),
    configRepo: path.resolve(values.configRepo ?? path.join(os.homedir(), 'claude-config')),
    target: path.resolve(values.target ?? path.join(os.homedir(), '.claude')),
    node: values.node ?? process.execPath,
  };
}

/**
 * Register the hooks for their events, preserving the rest of the file.
 *
 * Written through a temporary file and renamed into place: settings.json is
 * read by every Claude Code session, and a half-written one is worse than an
 * unregistered hook.
 */
function registerHook(args) {
  const commands = hookCommands(args.node, args.target);

  // A settings file next to a hook somewhere else is almost always a mistake —
  // a test installing into a temp directory, say. Registering it would point
  // every future session at a path that is about to be deleted, and leave the
  // entry behind forever. Refuse unless both were redirected together.
  if (!sameDirectory(path.dirname(args.settings), path.dirname(args.target))) {
    console.log(
      `  settings: skipped — ${args.target} is not beside ${args.settings}; ` +
        'pass --settings too, or --skip-settings to silence this',
    );
    return { ok: true, added: [], unchanged: [] };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(args.settings, 'utf8');
  } catch {
    raw = '';
  }

  let current = {};
  if (raw.trim()) {
    try {
      current = JSON.parse(raw);
    } catch (err) {
      console.error(`refusing to touch settings: ${args.settings} is not valid JSON (${err.message})`);
      return { ok: false, added: [], unchanged: [] };
    }
  }

  const { settings, added, unchanged } = withHookRegistered(current, commands);
  for (const event of unchanged) console.log(`  settings ${event}: already registered`);
  for (const event of added) console.log(`  settings ${event}: registering`);
  if (added.length === 0) return { ok: true, added, unchanged };
  if (args.dryRun) return { ok: true, added, unchanged };

  const text = `${JSON.stringify(settings, null, 2)}
`;
  const temporary = `${args.settings}.session-capture-tmp`;
  try {
    if (raw) fs.writeFileSync(`${args.settings}.bak`, raw, 'utf8');
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, args.settings);
  } catch (err) {
    console.error(`settings write failed: ${err?.message || err}`);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* the temporary file is not worth a second error */
    }
    return { ok: false, added, unchanged };
  }
  return { ok: true, added, unchanged };
}

/** Are these the same directory, separators and case aside? */
/**
 * `--register-mcp`: the rag server's user-scope entry, from this machine's
 * environment (the machine file is loaded at the top of this script). Needs
 * DATABASE_URL and a built `mcp-server/dist/index.js`; refuses otherwise.
 */
function registerMcp(args) {
  const distIndex = path.resolve(HERE, '..', 'mcp-server', 'dist', 'index.js');
  if (!fs.existsSync(distIndex)) {
    console.error(`  mcp: refused — ${distIndex} is not built; run \`npm run build\` in mcp-server/ first`);
    return false;
  }
  let config;
  try {
    const envFile = path.resolve(HERE, '..', '.env');
    config = buildRagServerConfig({ node: args.node, distIndex, envFile, env: process.env });
  } catch (err) {
    console.error(`  mcp: refused — ${err.message}`);
    return false;
  }
  if (args.dryRun) {
    console.log(`  mcp: would register ${SERVER_NAME} (${SCOPE} scope) with ${Object.keys(config.env).join(', ')}`);
    return true;
  }
  const result = registerRagServer({ config });
  if (!result.ok) {
    console.error(`  mcp: ${result.error}`);
    return false;
  }
  console.log(`  mcp: registered ${SERVER_NAME} (${SCOPE} scope) with ${Object.keys(config.env).join(', ')}`);
  return true;
}

function sameDirectory(a, b) {
  const normalise = (value) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalise(a) === normalise(b);
}

function backup(target, relativePaths, prefix = 'backup') {
  const existing = relativePaths.filter((relative) => fs.existsSync(path.join(target, relative)));
  if (existing.length === 0) return '';

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(target, `${prefix}-${stamp}`);
  for (const relative of existing) {
    const destination = path.join(dir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(target, relative), destination);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// --config: place a claude-config clone on this machine (R-H5)
// ---------------------------------------------------------------------------

const CONFIG_BACKUP_PREFIX = 'config-backup';

/** The repo's exceptions list; absent is empty, malformed throws (and so refuses). */
function readExceptions(configRepo) {
  const file = path.join(configRepo, SCAN_EXCEPTIONS_FILE);
  return fs.existsSync(file) ? parseScanExceptions(fs.readFileSync(file, 'utf8')) : [];
}

/** Every installable file and the template, scanned; findings split by the reviewed exceptions. */
function scanConfigRepo(configRepo, plan) {
  const hashes = new Map(plan.files.map((file) => [file.path, file.sha256]));
  const templateFile = path.join(configRepo, SETTINGS_TEMPLATE_FILE);
  const scanned = [...plan.files];
  if (fs.existsSync(templateFile)) {
    scanned.push({ path: SETTINGS_TEMPLATE_FILE, source: templateFile });
    hashes.set(SETTINGS_TEMPLATE_FILE, sha256(templateFile));
  }
  const { findings } = scanForSecrets(scanned);
  return { findings, ...partitionFindings(findings, readExceptions(configRepo), (p) => hashes.get(p)), scanned };
}

/** `{raw, current}` for settings.json; raw is null when there is none. Never echoes the text. */
function readSettingsForMerge(file) {
  if (!fs.existsSync(file)) return { raw: null, current: {} };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { raw, current: {} };
  try {
    return { raw, current: JSON.parse(raw) };
  } catch {
    throw new Error(`${file}: settings.json is not valid JSON; fix it by hand, nothing was written`);
  }
}

function printConfigPlan(args, plan, scan) {
  const count = (status) => plan.files.filter((file) => file.status === status).length;
  console.log(`config repo: ${args.configRepo}`);
  console.log(`target: ${args.target}`);
  for (const file of plan.files.filter((f) => f.status !== 'unchanged')) {
    console.log(`  ${file.status.padEnd(8)} ${file.path}${file.reason ? ` (${file.reason})` : ''}`);
  }
  for (const { path: p, rule } of plan.refused) console.log(`  refused  ${p} (denylist ${rule})`);
  for (const { path: p, reason } of plan.skipped) console.log(`  skipped  ${p} (${reason})`);
  for (const entry of plan.missing) console.log(`  missing  ${entry}`);
  for (const name of plan.ignored) console.log(`  ignored  ${name}`);
  console.log(
    `files: ${count('new')} new, ${count('changed')} changed, ${count('unchanged')} unchanged, ` +
      `${count('blocked')} blocked, ${plan.ignored.length} ignored, ${plan.refused.length} refused, ` +
      `${plan.skipped.length} skipped`,
  );
  if (scan.findings.length === 0) console.log(`scan: clean (${scan.scanned.length} file(s))`);
  else console.log(`scan: ${scan.findings.length} finding(s), ${scan.excepted.length} excepted`);
  for (const f of scan.unexcepted) console.log(`  finding  ${f.path}:${f.line} ${f.rule}`);
}

function describeMerge(merge) {
  if (!merge) return `settings: no ${SETTINGS_TEMPLATE_FILE} in the repo; settings.json left alone`;
  const kept = merge.permissionsKept.map((k) => k.key);
  const keptNote = kept.length ? `; kept this machine's permissions ${kept.join(', ')}` : '';
  if (!merge.changed) return `settings: no change${keptNote}`;
  const hooks = merge.hooksAdded.map((h) => `${h.event} ${path.posix.basename(h.script) || '(no script)'}`);
  const permissionKeys = [...new Set(merge.permissionsAdded.map((p) => p.key))];
  const lines = [
    `settings: +${merge.hooksAdded.length} hook(s)${hooks.length ? ` (${hooks.join(', ')})` : ''}, ` +
      `+${merge.permissionsAdded.length} permission(s)${permissionKeys.length ? ` (${permissionKeys.join(', ')})` : ''}${keptNote}`,
  ];
  if (merge.nodeRewritten.length) {
    lines.push(`  node rewritten on ${merge.nodeRewritten.length} command(s): ${merge.nodeRewritten[0].to}`);
  }
  return lines.join('\n');
}

function configRefusals(plan, scan) {
  const blocked = plan.files.filter((file) => file.status === 'blocked');
  return [
    ...(scan.unexcepted.length ? [`${scan.unexcepted.length} secret finding(s) not in ${SCAN_EXCEPTIONS_FILE}`] : []),
    ...(plan.refused.length ? [`${plan.refused.length} denylisted path(s) in the repo`] : []),
    ...(blocked.length ? [`${blocked.length} write(s) would go through a link or onto a folder`] : []),
  ];
}

/** Write through a temporary file and rename: settings.json is read by every session. */
function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.config-install-tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, file);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
  if (fs.readFileSync(file, 'utf8') !== text) throw new Error(`${file} does not read back as written`);
}

function applyConfig(args, plan, settingsFile, settingsRead, merge) {
  const toWrite = plan.files.filter((file) => file.status === 'new' || file.status === 'changed');
  const overwritten = toWrite.filter((file) => file.status === 'changed').map((file) => file.path);
  const writesSettings = Boolean(merge?.changed);
  if (writesSettings && settingsRead.raw !== null) overwritten.push('settings.json');

  const backupDir = backup(args.target, overwritten, CONFIG_BACKUP_PREFIX);
  if (backupDir) console.log(`backed up ${overwritten.length} file(s) to ${backupDir}`);

  for (const file of toWrite) {
    fs.mkdirSync(path.dirname(file.target), { recursive: true });
    fs.copyFileSync(file.source, file.target);
  }
  const mismatched = toWrite.filter((file) => sha256(file.target) !== file.sha256);
  if (mismatched.length) {
    console.error(`CONFIG INSTALL FAILED: ${mismatched.length} file(s) differ after copying; settings.json not touched`);
    for (const file of mismatched) console.error(`  ${file.path}`);
    return false;
  }
  console.log(`installed ${toWrite.length} file(s); all verified by SHA-256`);
  if (writesSettings) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeJsonAtomic(settingsFile, merge.settings);
    console.log(`settings: wrote ${settingsFile}`);
  }
  return true;
}

function installConfig(args) {
  const plan = planInstall(args.configRepo, args.target);
  if (plan.files.length === 0) {
    throw new Error(`${args.configRepo} has no allowlisted files (CLAUDE.md, rules/, skills/, skill-vault/); is it the claude-config clone?`);
  }
  const scan = scanConfigRepo(args.configRepo, plan);
  const settingsFile = path.join(args.target, 'settings.json');
  const settingsRead = readSettingsForMerge(settingsFile);
  const merge = plan.settingsTemplate
    ? mergeSettingsTemplate(settingsRead.current, plan.settingsTemplate, { nodePath: args.node })
    : null;

  printConfigPlan(args, plan, scan);
  console.log(describeMerge(merge));

  const refusals = configRefusals(plan, scan);
  if (refusals.length) {
    console.error(`${args.dryRun ? 'dry run: the apply would refuse' : 'refusing: nothing written'}:`);
    for (const reason of refusals) console.error(`  ${reason}`);
    return false;
  }
  if (args.dryRun) {
    console.log('dry run: nothing written');
    return true;
  }
  return applyConfig(args, plan, settingsFile, settingsRead, merge);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.config) {
    if (!installConfig(args)) process.exitCode = 1;
    return;
  }
  const payload = runtimePayload();

  const missing = payload.filter((relative) => !fs.existsSync(path.join(HERE, relative)));
  if (missing.length) {
    console.error(`refusing to install: missing source files\n  ${missing.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }

  const changes = payload.map((relative) => {
    const source = path.join(HERE, relative);
    const destination = path.join(args.target, relative);
    const sourceHash = sha256(source);
    const targetHash = fs.existsSync(destination) ? sha256(destination) : '';
    return { relative, source, destination, sourceHash, same: sourceHash === targetHash, isNew: !targetHash };
  });

  const toWrite = changes.filter((change) => !change.same);
  if (toWrite.length === 0) {
    console.log(`already current: ${args.target} matches ${payload.length} source files`);
    if (!args.skipSettings && !registerHook(args).ok) process.exitCode = 1;
    if (args.registerMcp && !registerMcp(args)) process.exitCode = 1;
    return;
  }

  console.log(`target: ${args.target}`);
  for (const change of toWrite) console.log(`  ${change.isNew ? 'add   ' : 'update'} ${change.relative}`);
  if (args.dryRun) {
    console.log(`dry run: ${toWrite.length} file(s) would change, nothing written`);
    if (!args.skipSettings) registerHook(args);
    if (args.registerMcp) registerMcp(args);
    return;
  }

  const backupDir = backup(args.target, toWrite.filter((change) => !change.isNew).map((change) => change.relative));
  if (backupDir) console.log(`backed up the previous copy to ${backupDir}`);

  for (const change of toWrite) {
    fs.mkdirSync(path.dirname(change.destination), { recursive: true });
    fs.copyFileSync(change.source, change.destination);
  }

  const mismatched = changes.filter((change) => sha256(change.destination) !== change.sourceHash);
  if (mismatched.length) {
    console.error(`INSTALL FAILED: ${mismatched.length} file(s) differ after copying`);
    for (const change of mismatched) console.error(`  ${change.relative}`);
    process.exitCode = 1;
    return;
  }

  console.log(`installed ${toWrite.length} file(s); all ${payload.length} verified byte-identical`);
  if (!args.skipSettings && !registerHook(args).ok) process.exitCode = 1;
  if (args.registerMcp && !registerMcp(args)) process.exitCode = 1;
}

// Importable without acting: only a direct run loads the environment and installs.
// A missing guard here once ran a real install against ~/.claude on `import`.
if (isEntryPoint(import.meta.url)) {
  try {
    loadEnvironment();
    main();
  } catch (err) {
    console.error(`install failed: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
