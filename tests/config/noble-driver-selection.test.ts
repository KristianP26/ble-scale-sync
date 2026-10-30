import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandlerKey } from '../../src/ble/transport-availability.js';

/**
 * Which BLE transport each way of setting `ble.noble_driver` ends up loading,
 * on each desktop platform (architecture audit 2026-10-21, C-06).
 *
 * Today the value reaches src/ble/index.ts through process.env.NOBLE_DRIVER:
 * yaml-load publishes the configured driver there, scan and diagnose set it
 * from loadBleConfig, and a value that only came from the .env next to
 * config.yaml is removed again (G-03). Moving the driver to a parameter must
 * leave every cell of this table as it is, on Windows and macOS above all
 * (D007), where noble is the only transport.
 */

let caseDir = '';
vi.mock(import('../../src/config/paths.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  // The legacy .env mode reads these; the other cases pass --config.
  defaultConfigPath: () => join(caseDir, 'config.yaml'),
  defaultEnvPath: () => join(caseDir, '.env'),
}));

const PLATFORMS = ['linux', 'win32', 'darwin'] as const;
type Platform = (typeof PLATFORMS)[number];
const OS_DEFAULT: Record<Platform, HandlerKey> = {
  linux: 'node-ble',
  win32: 'noble-legacy',
  darwin: 'noble',
};

const USER = `
users:
  - name: Dad
    slug: dad
    height: 183
    birth_date: '1990-06-15'
    gender: male
    is_athlete: false
    weight_range: { min: 75, max: 95 }
`;

interface Source {
  id: string;
  /** config.yaml text; absent = legacy .env mode. */
  yaml?: string;
  /** The .env next to config.yaml, or the legacy .env. */
  envFile?: string;
  /** NOBLE_DRIVER in the real environment. */
  env?: string;
  expected: (platform: Platform) => HandlerKey;
}

const SOURCES: Source[] = [
  { id: 'unset', yaml: `version: 1\n${USER}`, expected: (p) => OS_DEFAULT[p] },
  {
    id: 'config',
    yaml: `version: 1\nble:\n  noble_driver: stoprocent\n${USER}`,
    expected: () => 'noble',
  },
  { id: 'env', yaml: `version: 1\n${USER}`, env: 'abandonware', expected: () => 'noble-legacy' },
  {
    id: 'env over config',
    yaml: `version: 1\nble:\n  noble_driver: stoprocent\n${USER}`,
    env: 'abandonware',
    expected: () => 'noble-legacy',
  },
  {
    // Only the real environment overrides config.yaml (G-03).
    id: '.env next to config.yaml',
    yaml: `version: 1\n${USER}`,
    envFile: 'NOBLE_DRIVER=stoprocent\n',
    expected: (p) => OS_DEFAULT[p],
  },
  {
    id: 'legacy .env',
    envFile:
      'USER_HEIGHT=183\nUSER_BIRTH_DATE=1990-06-15\nUSER_GENDER=male\nUSER_IS_ATHLETE=false\n' +
      'NOBLE_DRIVER=abandonware\n',
    expected: () => 'noble-legacy',
  },
];

const CASES = SOURCES.flatMap((source) =>
  PLATFORMS.map((platform) => [source.id, platform, source] as const),
);

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function writeCase(source: Source): string | undefined {
  if (source.envFile !== undefined) writeFileSync(join(caseDir, '.env'), source.envFile);
  if (source.yaml === undefined) return undefined;
  const path = join(caseDir, 'config.yaml');
  writeFileSync(path, source.yaml);
  return path;
}

describe('noble driver selection: {unset, config, env, .env} x {linux, win32, darwin}', () => {
  beforeEach(() => {
    caseDir = mkdtempSync(join(tmpdir(), 'bss-noble-driver-'));
    // Fresh loaders: yaml-load remembers what it published, env-refs what came from .env.
    vi.resetModules();
    for (const name of ['NOBLE_DRIVER', 'BLE_HANDLER', 'USER_IS_ATHLETE']) {
      vi.stubEnv(name, undefined);
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(caseDir, { recursive: true, force: true });
  });

  function onPlatform(platform: Platform, source: Source): string | undefined {
    Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
    if (source.env !== undefined) vi.stubEnv('NOBLE_DRIVER', source.env);
    return writeCase(source);
  }

  it.each(CASES)('start: %s on %s', async (_id, platform, source) => {
    const path = onPlatform(platform, source);
    const { loadAppConfig } = await import('../../src/config/load.js');
    const { resolveHandlerKey } = await import('../../src/ble/index.js');
    const { config } = loadAppConfig(path);
    expect(resolveHandlerKey(config.ble?.handler)).toBe(source.expected(platform));
  });

  it.each(CASES)('scan: %s on %s', async (_id, platform, source) => {
    const path = onPlatform(platform, source);
    const { loadBleConfig } = await import('../../src/config/load.js');
    const { resolveHandlerKey } = await import('../../src/ble/index.js');
    const ble = loadBleConfig(path);
    // What scan.ts (and diagnose.ts) do before the handler import.
    if (ble.nobleDriver) process.env.NOBLE_DRIVER = ble.nobleDriver;
    expect(resolveHandlerKey(ble.bleHandler)).toBe(source.expected(platform));
  });
});
