import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadYamlConfig } from '../../src/config/yaml-load.js';
import { loadEnvFile } from '../../src/config/env-refs.js';

const VAR = 'BSS_TEST_ENV_FILE_RELOAD';
const REAL = 'BSS_TEST_ENV_FILE_REAL';
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bss-env-reload-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  // The loader writes process.env directly, so vi.unstubAllEnvs would not undo it.
  delete process.env[VAR];
  delete process.env[REAL];
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeConfig(dir: string): string {
  const configPath = join(dir, 'config.yaml');
  writeFileSync(
    configPath,
    [
      'version: 1',
      'users:',
      '  - name: Dad',
      '    slug: dad',
      '    height: 183',
      "    birth_date: '1990-06-15'",
      '    gender: male',
      '    is_athlete: false',
      '    weight_range: { min: 60, max: 110 }',
      'global_exporters:',
      '  - type: webhook',
      `    url: \${${VAR}}`,
      '',
    ].join('\n'),
  );
  return configPath;
}

// G-20: dotenv never overwrites a key that is already set, so a value rotated
// in .env was ignored by every reload until the process restarted.
describe('loadYamlConfig on reload', () => {
  it('picks up a value changed in .env since the last load', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir();
    const configPath = writeConfig(dir);
    writeFileSync(join(dir, '.env'), `${VAR}=https://hooks.example/old\n`);

    expect(loadYamlConfig(configPath).global_exporters).toEqual([
      expect.objectContaining({ url: 'https://hooks.example/old' }),
    ]);

    writeFileSync(join(dir, '.env'), `${VAR}=https://hooks.example/new\n`);

    expect(loadYamlConfig(configPath).global_exporters).toEqual([
      expect.objectContaining({ url: 'https://hooks.example/new' }),
    ]);
  });
});

describe('loadEnvFile', () => {
  it('removes a key it set once the line is gone from .env', () => {
    const file = join(tempDir(), '.env');
    writeFileSync(file, `${VAR}=one\n`);
    loadEnvFile(file);
    expect(process.env[VAR]).toBe('one');

    writeFileSync(file, '# nothing here\n');
    loadEnvFile(file);
    expect(process.env[VAR]).toBeUndefined();
  });

  it('never overrides a variable from the real environment', () => {
    const file = join(tempDir(), '.env');
    process.env[REAL] = 'from-the-environment';
    writeFileSync(file, `${REAL}=from-dotenv\n`);
    loadEnvFile(file);
    loadEnvFile(file);
    expect(process.env[REAL]).toBe('from-the-environment');
  });

  it('prints nothing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = join(tempDir(), '.env');
    writeFileSync(file, `${VAR}=x\n`);
    loadEnvFile(file);
    expect(log).not.toHaveBeenCalled();
  });
});
