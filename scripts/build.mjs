/**
 * Build the publishable package: compile the public sources.
 *
 * The script is cross-platform: it works in the maintainer's shell and in the
 * CI workflow alike.
 */
import {execFileSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const windows = process.platform === 'win32';

execFileSync(windows ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
  shell: windows,
});
console.log('the package is built');
