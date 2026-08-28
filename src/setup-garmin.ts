/**
 * `ble-scale-sync setup-garmin`: run the Python Garmin authentication helper
 * that ships inside the package (#365).
 *
 * The script path is anchored to the package install directory rather than the
 * working directory, because an npm or npx install runs the CLI from wherever
 * the user happens to stand. Extra arguments are forwarded unchanged, so
 * --from-config, --user <name> and --token-dir <dir> keep behaving exactly as
 * they do from a checkout.
 *
 * Interpreter detection is local rather than reused from wizard/platform.ts:
 * detectPlatform() also probes `docker --version` and `getent group bluetooth`,
 * which this command has no use for.
 */
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './config/paths.js';

function findPython(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5_000 });
      return cmd;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const python = findPython();
if (python === null) {
  console.error('Python 3 was not found on PATH. Install Python 3.9 or newer and try again.');
  process.exit(1);
}

const script = join(ROOT, 'garmin-scripts', 'setup_garmin.py');
const child = spawn(python, [script, ...process.argv.slice(2)], { stdio: 'inherit' });

child.on('error', (err: Error) => {
  console.error(`Failed to start ${python}: ${err.message}`);
  process.exit(1);
});

child.on('close', (code: number | null) => {
  process.exit(code ?? 1);
});
