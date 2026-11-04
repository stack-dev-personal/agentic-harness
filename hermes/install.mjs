#!/usr/bin/env node
/** Preview-first, additive installation. Existing profile files are never overwritten. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from '../hooks/lib/entry-point.mjs';
import { canonicalPath, pathWithin } from '../hooks/lib/memory-policy.mjs';

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'harness-memory');
export function installHermes({ hermesHome, repoRoot = path.resolve(source, '..', '..'), nodePath = process.execPath, apply = false, update = false }) {
  if (!hermesHome || !path.isAbsolute(hermesHome)) throw new Error('an absolute Hermes profile home is required');
  const destination = path.join(hermesHome, 'plugins', 'harness-memory');
  const files = ['__init__.py', 'plugin.yaml'].map(name => ({ path: path.join(destination, name), text: fs.readFileSync(path.join(source, name), 'utf8') }));
  files.push({ path: path.join(hermesHome, 'harness-memory.json'), text: JSON.stringify({ enabled: true, repo: path.resolve(repoRoot), node: nodePath }, null, 2) + '\n' });
  for (const file of files) {
    if (!pathWithin(canonicalPath(hermesHome), canonicalPath(file.path))) throw new Error('Hermes install destination escapes profile');
    if (fs.existsSync(file.path) && fs.readFileSync(file.path, 'utf8') !== file.text && !update) throw new Error('existing Hermes adapter/config differs; review before replacing it');
  }
  const changes = files.filter(file => !fs.existsSync(file.path) || (update && file.path !== path.join(hermesHome, 'harness-memory.json') && fs.readFileSync(file.path, 'utf8') !== file.text));
  if (apply) for (const file of changes) {
    if (fs.existsSync(file.path)) {
      const backup = path.join(hermesHome, 'backups', `harness-adapter-${Date.now()}-${path.basename(file.path)}`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(file.path, backup, fs.constants.COPYFILE_EXCL);
    }
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.text, { flag: update ? 'w' : 'wx' });
  }
  return { applied: apply, files: changes.map(file => file.path),
    activation: 'Select harness-memory through Hermes memory setup for this profile, then start a new session.' };
}

if (isEntryPoint(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const homeAt = args.indexOf('--home');
    process.stdout.write(JSON.stringify(installHermes({ hermesHome: homeAt === -1 ? '' : args[homeAt + 1], apply: args.includes('--apply'), update: args.includes('--update') }), null, 2) + '\n');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
