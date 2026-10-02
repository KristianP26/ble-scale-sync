import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `validate` is a CLI with top-level side effects (parseArgs, process.exit), so
 * it is exercised as a process rather than imported.
 *
 * It used to load the config and COUNT the exporters. The schema only checks
 * that `type` is a non-empty string - every other exporter field is validated
 * by its factory - so counting reported "Config valid" for a config whose first
 * export would die on a missing url or a qos of 99. That is the one thing this
 * command exists to rule out.
 */

const dirs: string[] = [];

function configWith(exporters: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bss-validate-'));
  dirs.push(dir);
  const path = join(dir, 'config.yaml');
  writeFileSync(
    path,
    [
      'version: 1',
      'users:',
      '  - name: Dad',
      '    slug: dad',
      '    height: 183',
      "    birth_date: '1990-06-15'",
      '    gender: male',
      '    is_athlete: false',
      '    weight_range:',
      '      min: 60',
      '      max: 110',
      exporters,
      '',
    ].join('\n'),
  );
  return path;
}

function runValidate(configPath: string): { status: number | null; out: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/config/validate-cli.ts', '--config', configPath],
    { encoding: 'utf8', cwd: process.cwd() },
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('validate builds the exporters it reports on', () => {
  it('accepts a config whose exporters really can be built', () => {
    const path = configWith(
      ['    exporters:', '      - type: file', "        file_path: './out.csv'"].join('\n'),
    );

    const { status, out } = runValidate(path);

    expect(out).toContain('Config valid');
    expect(status).toBe(0);
  });

  it('rejects an exporter missing a required field', () => {
    // `file` with no file_path passes the schema, which only looks at `type`.
    const path = configWith(['    exporters:', '      - type: file'].join('\n'));

    const { status, out } = runValidate(path);

    expect(status).toBe(1);
    expect(out).toContain('Config invalid');
    expect(out).toContain('file_path');
  });

  it('names the user and the exporter type that failed', () => {
    const path = configWith(
      [
        '    exporters:',
        '      - type: mqtt',
        "        broker_url: 'mqtt://localhost:1883'",
        '        qos: 99',
      ].join('\n'),
    );

    const { status, out } = runValidate(path);

    expect(status).toBe(1);
    expect(out).toContain('dad / mqtt');
    expect(out).toContain('qos');
  });
}, 60_000);
