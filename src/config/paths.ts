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
 * The one directory both config.yaml and .env are read from.
 *
 * The working directory comes first so `npx ble-scale-sync` finds the config of
 * the directory the user is standing in; under npx, ROOT is an ephemeral cache
 * directory that can hold neither their config nor their .env. ROOT stays as the
 * fallback, which keeps a git checkout, the Docker image and the Home Assistant
 * add-on unchanged: in all three, cwd and ROOT are the same directory.
 *
 * The two files are resolved TOGETHER, from whichever directory holds either of
 * them, and never independently. Resolving them apart lets a stray .env in the
 * current directory feed its secrets into a config.yaml from the package root,
 * which is one deployment's config populated with another's tokens.
 *
 * @internal Exported for testing: the probe is injectable so a unit test never
 * depends on what happens to be on the developer's disk.
 */
export function configDir(
  dirs: readonly string[] = [process.cwd(), ROOT],
  exists: (path: string) => boolean = existsSync,
): string {
  for (const dir of dirs) {
    if (exists(join(dir, 'config.yaml')) || exists(join(dir, '.env'))) return dir;
  }
  // Neither file exists anywhere: the working directory is where a fresh
  // `setup` should write, and the path "No configuration found" should name.
  return dirs[0];
}

/** Default config.yaml location: alongside the .env, working directory first. */
export function defaultConfigPath(): string {
  return join(configDir(), 'config.yaml');
}

/** Default .env location: alongside the config.yaml, working directory first. */
export function defaultEnvPath(): string {
  return join(configDir(), '.env');
}
