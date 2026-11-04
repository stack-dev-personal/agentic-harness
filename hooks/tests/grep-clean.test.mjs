/**
 * Nothing the jobs image runs is bound to Windows (R-86).
 *
 * The image is built on Debian, so a Windows drive path, a PowerShell call or
 * the OneDrive vault in the code it copies is a job that works on the laptop
 * and fails in the container. This reads the real `docker/jobs/Dockerfile` and
 * the real `.dockerignore`, lists the files the image would hold, strips their
 * comments and looks for:
 *
 *   C:/  C:\      a drive path, unless it ends in `...` (help text showing a shape)
 *   .ps1          a PowerShell script
 *   powershell    the program, as a word in lower case (`'PowerShell'` in
 *                 constants.mjs is the name of a Claude Code tool)
 *   Move-Item     a PowerShell cmdlet
 *   OneDrive      the vault's old home
 *
 * Only code is scanned (.mjs, .sh, .py, and the Dockerfile itself). Data and
 * prose in the image (the golden set, the lock file, a README) are not: a
 * query about OneDrive in the eval set is a fact about a note, not a path.
 *
 * It also checks the other half: every module the jobs import is in the image,
 * so an ignore rule added to keep an offender out cannot break a job.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VAULT_SEGMENTS } from '../lib/constants.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCKERFILE = 'docker/jobs/Dockerfile';
const DOCKERIGNORE = '.dockerignore';

/**
 * The scripts the scheduler starts, directly or through the nightly script,
 * and doctor. The two sweeps are not here: in the container the nightly skips
 * them (HARNESS_JOBS_CONTAINER=1). They are still copied, and still scanned.
 */
const JOB_ENTRY_POINTS = Object.freeze([
  'hooks/scheduler.mjs',
  'hooks/doctor.mjs',
  'hooks/sync-realms.mjs',
  'hooks/collect-checkpoints.mjs',
]);
const JOB_SCRIPTS = Object.freeze(['scripts/jobs-entrypoint.sh', 'scripts/nightly-ingest.sh', 'scripts/lib/machine-env.sh']);

const SLASH_COMMENTS = Object.freeze(['.mjs']);
const HASH_COMMENTS = Object.freeze(['.sh', '.py']);

/** A drive letter that is not the tail of a word (`https://` is not drive `s`), then the path. */
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`<>|)\]]*/g;
const PLACEHOLDER_TAIL = /(?:\.\.\.|…)$/;

const PATTERNS = Object.freeze([
  { name: 'drive path', find: (line) => (line.match(DRIVE_PATH) ?? []).filter((hit) => !PLACEHOLDER_TAIL.test(hit)) },
  { name: '.ps1', find: (line) => line.match(/\.ps1\b/gi) ?? [] },
  { name: 'powershell', find: (line) => line.match(/\b(?:powershell|pwsh)(?:\.exe)?\b/g) ?? [] },
  { name: 'Move-Item', find: (line) => line.match(/\bMove-Item\b/g) ?? [] },
  { name: 'OneDrive', find: (line) => line.match(/OneDrive/g) ?? [] },
]);

/**
 * Lines that match and are not OS-bound code, each with the reason. Both are
 * `--help` text that still describes the default vault as it was before
 * DEFAULT_VAULT_SEGMENTS moved; the files belong to another change. When one
 * is reworded, the last test here fails until its entry is removed.
 */
const KNOWN_PROSE = Object.freeze([
  {
    file: 'hooks/collect-checkpoints.mjs',
    line: '--vault <dir>     vault root (default: $${VAULT_ENV_VAR} or the OneDrive vault)',
    why: 'usage text; the default itself is DEFAULT_VAULT_SEGMENTS',
  },
  {
    file: 'hooks/sweep-transcripts.mjs',
    line: '--vault <dir>          vault root (default: $${VAULT_ENV_VAR} or the OneDrive vault)',
    why: 'usage text; the default itself is DEFAULT_VAULT_SEGMENTS',
  },
]);

const read = (relative) => fs.readFileSync(path.join(REPO, relative), 'utf8');

/** The context paths the Dockerfile copies: every COPY that is not from another stage. */
function copySources(dockerfileText) {
  return dockerfileText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^COPY\s/.test(line) && !/\s--from=/.test(line))
    .flatMap((line) => line.split(/\s+/).slice(1).filter((word) => !word.startsWith('--')).slice(0, -1))
    .map((source) => source.replace(/\/$/, ''));
}

/** One .dockerignore pattern as a test over a context path or any folder above it. */
function ignoreRule(pattern) {
  const negated = pattern.startsWith('!');
  const body = (negated ? pattern.slice(1) : pattern).replace(/^\//, '').replace(/\/$/, '');
  const source = body
    .split('**/')
    .map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('(?:.*/)?');
  return Object.freeze({ negated, regex: new RegExp(`^${source}(?:/.*)?$`) });
}

function ignoreRules(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(ignoreRule);
}

/** Docker's rule: the last pattern that matches decides. */
function isIgnored(relative, rules) {
  return rules.reduce((ignored, rule) => (rule.regex.test(relative) ? !rule.negated : ignored), false);
}

/** Every file under a COPY source that the ignore rules leave in the context. */
function filesUnder(source, rules) {
  const absolute = path.join(REPO, source);
  if (isIgnored(source, rules) || !fs.existsSync(absolute)) return [];
  if (!fs.statSync(absolute).isDirectory()) return [source];
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => filesUnder(`${source}/${entry.name}`, rules));
}

/** Blank out `//` and block comments, keeping strings and line numbers. */
function stripSlashComments(text) {
  let out = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const pair = text.slice(i, i + 2);
    if (quote) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === quote || (char === '\n' && quote !== '`')) quote = '';
    } else if (pair === '//') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (pair === '/*') {
      const end = text.indexOf('*/', i + 2);
      const comment = text.slice(i, end === -1 ? text.length : end + 2);
      out += comment.replace(/[^\n]/g, '');
      i += comment.length - 1;
    } else {
      if (char === "'" || char === '"' || char === '`') quote = char;
      out += char;
    }
  }
  return out;
}

/** A docstring: a triple-quoted string that is a statement of its own. */
const PYTHON_DOCSTRING = /^([ \t]*)[rRbBuU]?("""|''')[\s\S]*?\2/gm;

/** Blank out `#` comments (outside a one-line string), and Python docstrings. */
function stripHashComments(text, { docstrings }) {
  const body = docstrings ? text.replace(PYTHON_DOCSTRING, (whole) => whole.replace(/[^\n]/g, '')) : text;
  return body
    .split('\n')
    .map((line) => {
      let quote = '';
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (quote) {
          if (char === '\\') i += 1;
          else if (char === quote) quote = '';
        } else if (char === "'" || char === '"') quote = char;
        else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** The file's code with comments blanked, or null for a file that is not scanned. */
function codeOf(relative, text) {
  const extension = path.extname(relative);
  if (SLASH_COMMENTS.includes(extension)) return stripSlashComments(text);
  if (HASH_COMMENTS.includes(extension)) return stripHashComments(text, { docstrings: extension === '.py' });
  if (relative === DOCKERFILE) return stripHashComments(text, { docstrings: false });
  return null;
}

const isKnownProse = (file, line) => KNOWN_PROSE.some((known) => known.file === file && known.line === line.trim());

/** `file:line: pattern: hit` for every match in the file's code. */
function offendersIn(relative, text) {
  const code = codeOf(relative, text);
  if (code === null) return [];
  return code.split('\n').flatMap((line, index) => {
    if (isKnownProse(relative, line)) return [];
    return PATTERNS.flatMap(({ name, find }) => find(line).map((hit) => `${relative}:${index + 1}: ${name}: ${hit}`));
  });
}

/** Every relative module reachable from `entries` by a static import. */
function importClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = path.posix.normalize(queue.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of read(file).matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(path.posix.join(path.posix.dirname(file), match[1]));
    }
  }
  return [...seen].sort();
}

const rules = ignoreRules(read(DOCKERIGNORE));
const sources = copySources(read(DOCKERFILE));
const copied = sources.flatMap((source) => filesUnder(source, rules));

test('the comment stripper removes comments and keeps strings', () => {
  const js = stripSlashComments("const u = 'https://x'; // C:/gone\n/* OneDrive\n */ const p = \"C:/kept\";\n");
  assert.equal(js, "const u = 'https://x'; \n\n const p = \"C:/kept\";\n");

  const shell = stripHashComments('# C:/gone\nrun "a # b" # OneDrive\nurl=x#y\n', { docstrings: false });
  assert.equal(shell, '\nrun "a # b" \nurl=x#y\n');

  const python = stripHashComments('"""Doc: C:/Users/you/vault\nmore."""\nx = "C:/kept"  # OneDrive\n', { docstrings: true });
  assert.equal(python, '\n\nx = "C:/kept"  \n');
});

test('the patterns find a Windows binding and pass a placeholder', () => {
  const hits = (line) => PATTERNS.flatMap(({ name, find }) => find(line).map(() => name));
  assert.deepEqual(hits("const home = 'C:/Users/stack';"), ['drive path']);
  assert.deepEqual(hits('const home = "C:\\\\Users\\\\stack";'), ['drive path']);
  assert.deepEqual(hits("spawn('powershell.exe', ['-File', 'x.ps1'])"), ['.ps1', 'powershell']);
  assert.deepEqual(hits('Move-Item a b'), ['Move-Item']);
  assert.deepEqual(hits("['OneDrive - Syracuse University', 'vault']"), ['OneDrive']);
  assert.deepEqual(hits("help='vault directory (C:/Users/... on Windows)'"), []);
  assert.deepEqual(hits("const remote = 'https://github.com/x/y.git';"), []);
  assert.deepEqual(hits("new Set(['Bash', 'PowerShell'])"), []);
});

test('the ignore rules read as Docker reads them', () => {
  const sample = ignoreRules(['.env', '.env.*', 'hooks/tests/', '**/*.ps1', '**/__pycache__/', 'docs/', '!docs/keep.md'].join('\n'));
  const ignored = (file) => isIgnored(file, sample);
  assert.equal(ignored('.env'), true);
  assert.equal(ignored('.env.secrets/harness_database_url'), true);
  assert.equal(ignored('hooks/tests/doctor.test.mjs'), true);
  assert.equal(ignored('hooks/doctor.mjs'), false);
  assert.equal(ignored('scripts/nightly-ingest.ps1'), true);
  assert.equal(ignored('scripts/lib/machine-env.ps1'), true);
  assert.equal(ignored('scripts/nightly-ingest.sh'), false);
  assert.equal(ignored('ingest/src/ingest/__pycache__/cli.cpython-312.pyc'), true);
  assert.equal(ignored('docs/portable.md'), true);
  assert.equal(ignored('docs/keep.md'), false);
});

test('every COPY source of the jobs Dockerfile puts at least one file in the image', () => {
  assert.ok(sources.length >= 4, `expected the certificate, hooks, scripts and ingest; got ${sources.join(', ')}`);
  for (const source of sources) {
    assert.ok(filesUnder(source, rules).length >= 1, `${source} copies nothing`);
  }
  const scanned = copied.filter((file) => codeOf(file, '') !== null);
  assert.ok(scanned.length >= JOB_ENTRY_POINTS.length, `only ${scanned.length} code files scanned`);
});

test('coverage databases stay outside the jobs build context', () => {
  assert.equal(isIgnored('ingest/.coverage', rules), true);
  assert.equal(isIgnored('ingest/.coverage.worker-123', rules), true);
});

test('nothing the jobs image copies is bound to Windows', () => {
  const scanned = [DOCKERFILE, ...copied].filter((file) => codeOf(file, '') !== null);
  const offenders = scanned.flatMap((file) => offendersIn(file, read(file)));
  assert.deepEqual(offenders, [], `OS-bound code in the image:\n${offenders.join('\n')}`);
});

test('the default vault is ~/vault, not the OneDrive folder', () => {
  assert.deepEqual([...DEFAULT_VAULT_SEGMENTS], ['vault']);
});

/**
 * The Windows twins never enter the image, but their default vault has to
 * agree with the hooks' (DEFAULT_VAULT_SEGMENTS, `~/vault`): a host whose
 * machine file names no vault would otherwise capture into one folder and
 * reconcile another. Only the HARNESS_VAULT default line of each is read.
 */
const WINDOWS_VAULT_DEFAULTS = Object.freeze([
  'scripts/nightly-ingest.ps1',
  'scripts/register-checkpoint-collect.ps1',
  'scripts/register-nightly-ingest.ps1',
  'scripts/register-weekly-curate.ps1',
]);

test('the Windows scripts default to the same vault as the hooks, ~/vault, not the OneDrive folder', () => {
  for (const file of WINDOWS_VAULT_DEFAULTS) {
    const lines = read(file).split('\n').filter((line) => line.includes("Get-MachineSetting $machine 'HARNESS_VAULT'"));
    assert.equal(lines.length, 1, `${file}: expected one HARNESS_VAULT default line`);
    const [line] = lines;
    assert.ok(!/OneDrive/.test(line), `${file}: ${line.trim()}`);
    assert.match(line, /\$env:USERPROFILE\b.*\/vault"\s*\}\s*$/, `${file}: the default is not the profile's vault folder: ${line.trim()}`);
  }
  assert.deepEqual([...DEFAULT_VAULT_SEGMENTS], ['vault'], 'and the hooks still say ~/vault');
});

test('every module and script the jobs run is in the image', () => {
  const needed = [...importClosure(JOB_ENTRY_POINTS), ...JOB_SCRIPTS];
  const missing = needed.filter((file) => !copied.includes(file));
  assert.deepEqual(missing, [], `ignored or not copied, but a job needs it:\n${missing.join('\n')}`);
});

test('no secret, test or Windows script is copied', () => {
  const unwanted = copied.filter((file) => /(^|\/)\.env(\.|$)|(^|\/)secrets\/|\/tests\/|\.ps1$|\/\.venv\/|\/node_modules\//.test(file));
  assert.deepEqual(unwanted, []);
});

test('each known-prose entry still matches a line, so a fixed one is removed from the list', () => {
  for (const known of KNOWN_PROSE) {
    const lines = read(known.file).split('\n').map((line) => line.trim());
    assert.ok(lines.includes(known.line), `${known.file} no longer has this line; delete its KNOWN_PROSE entry:\n${known.line}`);
  }
});
