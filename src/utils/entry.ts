import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the script node was started with
 * (`argv1` = process.argv[1]). Both sides go through realpath: node gives the
 * main module's import.meta.url with symlinks resolved, but argv[1] keeps the
 * path as typed, so `node <symlink>/dist/run.js` would otherwise not match.
 */
export function isMainModule(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  return realOrResolved(fileURLToPath(moduleUrl)) === realOrResolved(argv1);
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
