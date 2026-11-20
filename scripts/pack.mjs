/**
 * Pack the release archive and print its digest.
 *
 * The script is cross-platform: it works in the maintainer's shell and in the
 * CI workflow alike.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';

execFileSync(windows ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', '.'], {
  cwd: root,
  stdio: 'inherit',
  shell: windows,
});

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const archive = resolve(root, `${manifest.name}-${manifest.version}.tgz`);
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
console.log(JSON.stringify({archive: `${manifest.name}-${manifest.version}.tgz`, sha256: digest}, null, 2));
