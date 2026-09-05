import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDir, defaultConfigPath, defaultEnvPath } from '../../src/config/paths.js';

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

/** A temp directory holding `fileName`, entered as the working directory. */
function cwdWith(fileName: string): string {
  // realpathSync: on macOS os.tmpdir() is a symlink and process.cwd() returns
  // the resolved form, so the expectation has to be resolved too.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bss-paths-')));
  writeFileSync(join(dir, fileName), '');
  process.chdir(dir);
  return dir;
}

describe('configDir', () => {
  it('picks the directory that holds config.yaml', () => {
    const found = join('/root', 'config.yaml');
    expect(configDir(['/cwd', '/root'], (p) => p === found)).toBe('/root');
  });

  it('picks the directory that holds only a .env', () => {
    const found = join('/root', '.env');
    expect(configDir(['/cwd', '/root'], (p) => p === found)).toBe('/root');
  });

  it('prefers the working directory when both directories qualify', () => {
    expect(configDir(['/cwd', '/root'], () => true)).toBe('/cwd');
  });

  it('falls back to the working directory when neither file exists', () => {
    // What `setup` writes and what "No configuration found" names, so it has to
    // be the directory the user is standing in.
    expect(configDir(['/cwd', '/root'], () => false)).toBe('/cwd');
  });

  it('never mixes a config.yaml and a .env from two directories', () => {
    // A stray .env in cwd used to feed its secrets into the package root's
    // config.yaml: one deployment's config populated with another's tokens.
    const cwdEnv = join('/cwd', '.env');
    const rootConfig = join('/root', 'config.yaml');
    const dir = configDir(['/cwd', '/root'], (p) => p === cwdEnv || p === rootConfig);
    expect(dir).toBe('/cwd');
  });
});

describe('defaultConfigPath', () => {
  it('finds the config.yaml of the directory the command runs in', () => {
    const dir = cwdWith('config.yaml');
    expect(defaultConfigPath()).toBe(join(dir, 'config.yaml'));
  });
});

describe('defaultEnvPath', () => {
  it('finds the .env of the directory the command runs in', () => {
    const dir = cwdWith('.env');
    expect(defaultEnvPath()).toBe(join(dir, '.env'));
  });
});
