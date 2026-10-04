import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { summaryStep } from '../../src/wizard/steps/summary.js';
import type { WizardContext } from '../../src/wizard/types.js';
import type { AppConfig, UserConfig } from '../../src/config/schema.js';
import { scriptedPrompts } from '../helpers/scripted-prompts.js';

function user(name: string, slug: string, min: number, max: number): UserConfig {
  return {
    name,
    slug,
    height: 175,
    birth_date: '1990-01-01',
    gender: 'male',
    is_athlete: false,
    weight_range: { min, max },
    last_known_weight: null,
  };
}

const alice = user('Alice', 'alice', 50, 70);
const bob = user('Bob', 'bob', 70, 100);

describe('summaryStep out_of_range (S-02)', () => {
  let dir: string;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'bss-summary-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  async function save(config: Partial<AppConfig>): Promise<Record<string, unknown>> {
    const configPath = join(dir, 'config.yaml');
    const { prompts } = scriptedPrompts([[/^Save to/, true]]);
    const ctx: WizardContext = {
      config: {
        version: 1,
        scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' },
        unknown_user: 'nearest',
        ble: {},
        global_exporters: [{ type: 'file', file_path: './measurements.csv' }],
        ...config,
      },
      configPath,
      isEditMode: false,
      nonInteractive: false,
      platform: {
        os: 'win32',
        arch: 'x64',
        hasDocker: false,
        hasPython: false,
        pythonCommand: null,
      },
      stepHistory: [],
      prompts,
    };
    await summaryStep.run(ctx);
    return parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  }

  // A multi-user setup matches readings by weight, so a spoofed or misread
  // weight outside every range was exported to the nearest user under the
  // schema default `warn`. The wizard now writes `skip` for such a setup.
  it('writes out_of_range: skip for a multi-user config', async () => {
    const written = await save({ users: [alice, bob] });
    expect(written.out_of_range).toBe('skip');
  });

  it('leaves out_of_range unset for a single user, so the schema default applies', async () => {
    const written = await save({ users: [alice] });
    expect(written.out_of_range).toBeUndefined();
  });

  it('keeps an explicit out_of_range the config already has', async () => {
    const written = await save({ users: [alice, bob], out_of_range: 'warn' });
    expect(written.out_of_range).toBe('warn');
  });
});
