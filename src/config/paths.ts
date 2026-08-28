import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname: string = dirname(fileURLToPath(import.meta.url));

/**
 * Package install root: two levels up from src/config, and from dist/config in
 * a build. In a git checkout this is the repository root; in an npm install it
 * is node_modules/ble-scale-sync.
 */
export const ROOT: string = join(__dirname, '..', '..');

/**
 * First existing candidate, else the first candidate.
 *
 * @internal Exported for testing: the probe is injectable so a unit test never
 * depends on what happens to be on the developer's disk.
 */
export function pickExisting(
  fileName: string,
  dirs: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string {
  for (const dir of dirs) {
    const candidate = join(dir, fileName);
    if (exists(candidate)) return candidate;
  }
  return join(dirs[0], fileName);
}

/**
 * The working directory comes first so `npx ble-scale-sync` finds the
 * config.yaml of the directory the user is standing in; under npx, ROOT is an
 * ephemeral cache directory that can hold neither their config nor their .env.
 * ROOT stays as the fallback, which keeps a git checkout, the Docker image and
 * the Home Assistant add-on unchanged: in all three, cwd and ROOT are the same
 * directory. When neither file exists the cwd candidate is returned, so a fresh
 * `setup` writes where the user expects and the "No configuration found" error
 * names a path they can act on.
 */
function preferCwd(fileName: string): string {
  return pickExisting(fileName, [process.cwd(), ROOT]);
}

/** Default config.yaml location: ./config.yaml, else the package root copy. */
export function defaultConfigPath(): string {
  return preferCwd('config.yaml');
}

/** Default .env location: ./.env, else the package root copy. */
export function defaultEnvPath(): string {
  return preferCwd('.env');
}
