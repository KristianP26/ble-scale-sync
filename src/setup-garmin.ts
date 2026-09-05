/**
 * `ble-scale-sync setup-garmin`: run the Python Garmin authentication helper
 * that ships inside the package (#365).
 *
 * The script path is anchored to the package install directory rather than the
 * working directory, because an npm or npx install runs the CLI from wherever
 * the user happens to stand. Arguments are translated the same way
 * docker-entrypoint.sh translates them, so --all-users and --user <name> mean
 * the same thing in both CLIs (see translateGarminArgs for what goes wrong
 * without it).
 *
 * Interpreter detection is local rather than reused from wizard/platform.ts:
 * detectPlatform() also probes `docker --version` and `getent group bluetooth`,
 * which this command has no use for.
 */
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './config/paths.js';
import { isSupportedPython, parsePythonVersion, translateGarminArgs } from './garmin-cli.js';

/**
 * First interpreter on PATH that is actually Python 3.9+.
 *
 * The version is parsed, not assumed: on hosts where `python3` is absent and
 * `python` is Python 2, an unchecked spawn dies with a raw SyntaxError on the
 * first f-string, naming nothing a user can act on.
 */
function findPython(): string | null {
  for (const cmd of ['python3', 'python']) {
    try {
      // Python 2 writes --version to stderr, Python 3 to stdout: merge both.
      const output = execFileSync(cmd, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 5_000,
      });
      if (isSupportedPython(parsePythonVersion(output))) return cmd;
    } catch (err) {
      // Not on PATH, or it wrote the version to stderr and exited non-zero.
      const stderr = (err as { stderr?: string | Buffer }).stderr;
      if (stderr !== undefined && isSupportedPython(parsePythonVersion(String(stderr)))) {
        return cmd;
      }
    }
  }
  return null;
}

const python = findPython();
if (python === null) {
  console.error('Python 3.9 or newer was not found on PATH. Install it and try again.');
  process.exit(1);
}

const script = join(ROOT, 'garmin-scripts', 'setup_garmin.py');
const args = translateGarminArgs(process.argv.slice(2));
const child = spawn(python, [script, ...args], { stdio: 'inherit' });

child.on('error', (err: Error) => {
  console.error(`Failed to start ${python}: ${err.message}`);
  process.exit(1);
});

child.on('close', (code: number | null) => {
  process.exit(code ?? 1);
});
