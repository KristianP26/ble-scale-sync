import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigPath, defaultEnvPath, pickExisting } from '../../src/config/paths.js';

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

describe('pickExisting', () => {
  it('returns the first candidate that exists', () => {
    const found = join('/root', 'config.yaml');
    expect(pickExisting('config.yaml', ['/cwd', '/root'], (p) => p === found)).toBe(found);
  });

  it('prefers the working directory when both exist', () => {
    expect(pickExisting('config.yaml', ['/cwd', '/root'], () => true)).toBe(
      join('/cwd', 'config.yaml'),
    );
  });

  it('falls back to the working directory candidate when neither exists', () => {
    // What `setup` writes and what "No configuration found" names, so it has to
    // be the directory the user is standing in.
    expect(pickExisting('config.yaml', ['/cwd', '/root'], () => false)).toBe(
      join('/cwd', 'config.yaml'),
    );
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
