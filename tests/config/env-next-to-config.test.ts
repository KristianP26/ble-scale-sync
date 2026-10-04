import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadYamlConfig } from '../../src/config/yaml-load.js';

const VAR = 'BSS_TEST_ENV_NEXT_TO_CONFIG';
const dirs: string[] = [];

afterEach(() => {
  // dotenv writes process.env directly, so vi.unstubAllEnvs would not undo it.
  delete process.env[VAR];
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The docs promise config.yaml and .env are always read from the same
 * directory. With `--config /etc/scale/config.yaml` the .env used to come from
 * the working directory (or the package root) instead, so a ${VAR} defined in
 * /etc/scale/.env was reported as not defined.
 */
describe('loadYamlConfig with an explicit config path', () => {
  it('reads the .env that sits next to that config file', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'bss-env-next-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env'), `${VAR}=https://hooks.example/from-dotenv\n`);
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
    delete process.env[VAR];

    const config = loadYamlConfig(configPath);

    expect(config.global_exporters).toEqual([
      expect.objectContaining({ type: 'webhook', url: 'https://hooks.example/from-dotenv' }),
    ]);
  });
});
