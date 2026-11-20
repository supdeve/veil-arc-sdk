/**
 * Verify the package before it is published: the manifest, the files, the
 * entry points, and the absence of secrets.
 *
 * The secret check is deliberately **shape aware**. A 32-byte value on its own
 * is not a secret: a deployed contract's code hash and a transaction hash are
 * public by construction, and Veil publishes both. Only a value that sits in a
 * key-shaped slot, or an unlabelled 32-byte blob, is a failure.
 *
 * Usage:
 *   node scripts/verify-package.mjs           # the check that CI runs
 *   node scripts/verify-package.mjs --strict  # additionally refuse unresolved
 *                                              # placeholders (the publish job)
 */
import {execFileSync} from 'node:child_process';
import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const problems = [];
const warnings = [];
const publicHashes = new Set();

/* ------------------------------------------------------------------ the manifest */

if (!manifest.name || !manifest.version) problems.push('the manifest has no name or version');
if (!manifest.license) problems.push('the manifest has no licence');
if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name ?? '')) {
  problems.push(`the package name ${manifest.name} is not a valid unscoped npm name`);
}
for (const dependency of Object.keys(manifest.dependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.dependencies[dependency])) {
    problems.push(`the dependency ${dependency} is not pinned to an exact version`);
  }
}
for (const entry of ['.', './store', './monitor', './tools']) {
  const target = manifest.exports?.[entry];
  if (!target) problems.push(`the export ${entry} is missing`);
}
for (const file of ['LICENSE', 'NOTICE.md', 'README.md', 'CHANGELOG.md']) {
  if (!existsSync(resolve(root, file))) problems.push(`${file} is missing`);
}
for (const field of ['repository', 'homepage', 'bugs']) {
  const value = JSON.stringify(manifest[field] ?? '');
  if (value.includes('OWNER')) {
    const message = `the ${field} field still contains the OWNER placeholder`;
    if (strict) problems.push(message);
    else warnings.push(`${message} (replace it before publishing)`);
  }
}

/* ------------------------------------------------------------------- the file set */

const SKIP = new Set(['node_modules', 'dist', '.git']);

/** the tracked files, when the tree is a git repository; otherwise every file */
function candidateFiles() {
  try {
    const tracked = execFileSync('git', ['ls-files', '--', '.'], {cwd: root, encoding: 'utf8'})
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (tracked.length) return tracked;
  } catch {
    // not a git repository: fall through to the directory walk
  }
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      if (SKIP.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path).split('\\').join('/'));
    }
  };
  walk(root);
  return files.sort();
}

/* ----------------------------------------------------------------------- the rules */

const RULES = [
  {
    id: 'private-key',
    note: 'a key-shaped value in a key-shaped slot',
    test: text =>
      /(?:privateKey|secretKey|signingKey|private_key|secret_key|mnemonic|seedPhrase)\s*[:=]\s*["']?0x?[0-9a-fA-F]{64}/.test(text),
  },
  {
    id: 'mnemonic',
    note: 'a possible seed phrase',
    // a line that is nothing but twelve to twenty-three short lowercase words
    test: text =>
      text.split('\n').some(line => /^(?:[a-z]{3,8} ){11,22}[a-z]{3,8}$/.test(line.trim())),
  },
  {
    id: 'credential',
    note: 'a credential assignment',
    test: text =>
      /(?:authToken|_authToken|NPM_TOKEN|GH_TOKEN|GITHUB_TOKEN|PRIVATE_KEY|SECRET_KEY|API_KEY)\s*[=:]\s*["'][^"']{8,}/.test(text),
  },
  {
    id: 'bare-secret',
    note: 'an unlabelled 32-byte hex blob',
    test: text => /(?<![0-9a-fA-F0-9x])[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(text),
  },
  {
    id: 'local-path',
    note: 'an absolute local path',
    test: text => /C:\\Users\\|\/home\/[a-z]+\//i.test(text),
  },
  {
    id: 'wallet-file',
    note: 'a wallet or key file reference',
    test: text => /(?:wallet\.json|keystore|\.p12\b|\.pem\b)/i.test(text),
  },
];

/** the 0x-prefixed 32-byte values: public by construction, recorded not flagged */
function collectPublicHashes(text) {
  for (const value of text.match(/0x[0-9a-fA-F]{64}/g) ?? []) publicHashes.add(value);
}

const files = candidateFiles();
// the checker itself carries the rule literals, so it cannot be scanned by them
const SELF = 'scripts/verify-package.mjs';
for (const file of files) {
  if (file === SELF) continue;
  const path = resolve(root, file);
  if (!existsSync(path) || !statSync(path).isFile()) continue;
  const text = readFileSync(path, 'utf8');
  for (const rule of RULES) {
    if (rule.test(text)) problems.push(`${file} contains ${rule.note} (${rule.id})`);
  }
  collectPublicHashes(text);
}

/* ----------------------------------------------------------------- the archive set */

/** the entry names of a gzip tarball, read without an external command */
function tarEntries(archive) {
  const buffer = gunzipSync(readFileSync(archive));
  const names = [];
  for (let offset = 0; offset + 512 <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

const archive = resolve(root, `${manifest.name}-${manifest.version}.tgz`);
if (existsSync(archive)) {
  const entries = tarEntries(archive);
  for (const entry of entries) {
    if (/(?:evidence|wallet|keystore|secret|\.pem$|\.p12$|\.key$)/i.test(entry)) {
      problems.push(`the archive carries ${entry}`);
    }
  }
  warnings.push(`the archive carries ${entries.length} entries`);
} else {
  warnings.push(`the archive ${manifest.name}-${manifest.version}.tgz is not built yet`);
}

/* ------------------------------------------------------------------------- the result */

if (warnings.length) {
  for (const warning of warnings) console.log(`  note   ${warning}`);
}
console.log(`  note   ${publicHashes.size} public 32-byte values are recorded, not flagged`);

if (problems.length) {
  console.error('the package verification failed:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}
console.log('the package is publishable');
