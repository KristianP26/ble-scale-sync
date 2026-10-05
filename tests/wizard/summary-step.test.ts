import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseDotenv } from 'dotenv';
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

describe('summaryStep in edit mode keeps the comments of config.yaml', () => {
  let dir: string;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'bss-summary-edit-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const ORIGINAL = `# my notes about this install
version: 1
scale:
  weight_unit: kg # metric household
  height_unit: cm
unknown_user: nearest
users:
  # first user
  - name: Alice
    slug: alice
    height: 175
    birth_date: '1990-01-01'
    gender: male
    is_athlete: false
    weight_range: { min: 50, max: 70 }
    last_known_weight: null
  # second user
  - name: Bob
    slug: bob # do not rename
    height: 180
    birth_date: '1985-05-05'
    gender: male
    is_athlete: false
    weight_range: { min: 70, max: 100 }
    last_known_weight: null
global_exporters:
  - type: webhook
    url: '\${HOOK_URL}' # kept in .env
`;

  async function edit(change: (config: Partial<AppConfig>) => void): Promise<string> {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, ORIGINAL);
    const config = parseYaml(ORIGINAL) as Partial<AppConfig>;
    change(config);
    const { prompts } = scriptedPrompts([[/^Save to/, true]]);
    const ctx: WizardContext = {
      config,
      configPath,
      isEditMode: true,
      nonInteractive: false,
      platform: {
        os: 'win32',
        arch: 'x64',
        hasDocker: false,
        hasPython: false,
        pythonCommand: null,
      },
      prompts,
    };
    await summaryStep.run(ctx);
    return readFileSync(configPath, 'utf8');
  }

  // The whole object used to be stringified, so every comment was lost.
  it('keeps comments on keys it did not change and on the ones it did', async () => {
    const out = await edit((c) => {
      c.scale!.weight_unit = 'lbs';
    });

    expect(out).toContain('# my notes about this install');
    expect(out).toContain('weight_unit: lbs # metric household');
    expect(out).toContain("url: '${HOOK_URL}' # kept in .env");
    expect((parseYaml(out) as AppConfig).scale.weight_unit).toBe('lbs');
  });

  it('keeps a user comment with its user when an earlier user is removed', async () => {
    const out = await edit((c) => {
      c.users = c.users!.filter((u) => u.slug !== 'alice');
    });

    expect(out).not.toContain('Alice');
    expect(out).toContain('slug: bob # do not rename');
    expect((parseYaml(out) as AppConfig).users.map((u) => u.slug)).toEqual(['bob']);
  });

  it('writes what the wizard produced, values and all', async () => {
    let expected: Partial<AppConfig> = {};
    const out = await edit((c) => {
      c.users![1].height = 181;
      c.global_exporters!.push({ type: 'file', file_path: './m.csv' });
      c.runtime = { continuous_mode: true } as AppConfig['runtime'];
      expected = structuredClone(c);
    });

    // Two users: the save adds out_of_range: skip (S-02).
    expect(parseYaml(out)).toEqual({ ...expected, out_of_range: 'skip' });
  });

  // Validated as written, a ${VAR} unit failed the enum, and "Save anyway?"
  // defaults to no, so Enter left the file unsaved. The app resolves it first.
  it('validates a ${VAR} value the way the app loads it', async () => {
    vi.stubEnv('BSS_TEST_WEIGHT_UNIT', 'lbs');
    try {
      const out = await edit((c) => {
        c.scale!.weight_unit = '${BSS_TEST_WEIGHT_UNIT}' as 'lbs';
      });

      expect(out).toContain('weight_unit: ${BSS_TEST_WEIGHT_UNIT} # metric household');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('summaryStep writes the secrets kept for .env', () => {
  let dir: string;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'bss-summary-env-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function ctxFor(save: boolean): WizardContext {
    vi.stubEnv('BSS_TEST_HOOK', 'https://hooks.example/x');
    return {
      config: {
        version: 1,
        scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' },
        unknown_user: 'nearest',
        users: [alice],
        global_exporters: [{ type: 'webhook', url: '${BSS_TEST_HOOK}' }],
      },
      configPath: join(dir, 'config.yaml'),
      isEditMode: false,
      nonInteractive: false,
      platform: {
        os: 'win32',
        arch: 'x64',
        hasDocker: false,
        hasPython: false,
        pythonCommand: null,
      },
      prompts: scriptedPrompts([[/^Save to/, save]]).prompts,
      pendingEnv: new Map([['BSS_TEST_HOOK', 'https://hooks.example/x']]),
    };
  }

  it('appends them to the .env beside the config when saving', async () => {
    await summaryStep.run(ctxFor(true));

    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain(
      "BSS_TEST_HOOK='https://hooks.example/x'",
    );
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toContain('${BSS_TEST_HOOK}');
  });

  it('writes nothing when the save is declined, and records that nothing was saved', async () => {
    const ctx = ctxFor(false);
    await summaryStep.run(ctx);

    expect(existsSync(join(dir, '.env'))).toBe(false);
    expect(existsSync(join(dir, 'config.yaml'))).toBe(false);
    expect(ctx.saved).toBe(false);
  });

  it('records the save', async () => {
    const ctx = ctxFor(true);
    await summaryStep.run(ctx);

    expect(ctx.saved).toBe(true);
  });

  // A secret typed again is stored under a new name, and an exporter can be
  // removed after its secret was stored; both used to end up in .env anyway.
  it('writes only the secrets the saved config still refers to', async () => {
    const ctx = ctxFor(true);
    ctx.pendingEnv!.set('BSS_TEST_REPLACED', 'old-secret');
    ctx.pendingEnv!.set('BSS_TEST_REMOVED', 'gone');

    await summaryStep.run(ctx);

    const env = parseDotenv(readFileSync(join(dir, '.env')));
    expect(env).toEqual({ BSS_TEST_HOOK: 'https://hooks.example/x' });
  });

  // The menu then shows again, so the person can pick another name.
  it('does not save when .env already has the name with another value', async () => {
    writeFileSync(join(dir, '.env'), 'BSS_TEST_HOOK=https://other.example\n');
    const ctx = ctxFor(true);

    await summaryStep.run(ctx);

    expect(existsSync(join(dir, 'config.yaml'))).toBe(false);
    expect(ctx.saved).toBe(false);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('BSS_TEST_HOOK=https://other.example\n');
  });
});

describe('summaryStep shows what the save changes', () => {
  let dir: string;
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    dir = mkdtempSync(join(tmpdir(), 'bss-summary-diff-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const FILE = `version: 1
scale:
  weight_unit: kg
  height_unit: cm
unknown_user: nearest
users:
  - name: Alice
    slug: alice
    height: 175
    birth_date: '1990-01-01'
    gender: male
    is_athlete: false
    weight_range: { min: 50, max: 70 }
    last_known_weight: null
global_exporters:
  - type: ntfy
    url: https://ntfy.sh
    topic: scale
    token: old-plain-token
`;

  async function save(isEditMode: boolean, change: (c: Partial<AppConfig>) => void) {
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, FILE);
    const config = parseYaml(FILE) as Partial<AppConfig>;
    change(config);
    const scripted = scriptedPrompts([[/^Save to/, false]]);
    await summaryStep.run({
      config,
      configPath,
      isEditMode,
      nonInteractive: false,
      platform: {
        os: 'win32',
        arch: 'x64',
        hasDocker: false,
        hasPython: false,
        pythonCommand: null,
      },
      prompts: scripted.prompts,
    });
    return { text: out.join('\n'), asked: scripted.asked };
  }

  it('prints the changed settings before asking to save, secrets masked', async () => {
    const { text, asked } = await save(true, (c) => {
      c.scale!.weight_unit = 'lbs';
      (c.global_exporters![0] as { token: string }).token = 'new-plain-token';
      (c.global_exporters![0] as { password?: string }).password = 'added-plain-password';
    });

    expect(text).toContain('Changes (secrets hidden)');
    expect(text).toContain('~ scale.weight_unit: kg -> lbs');
    expect(text).toContain('~ global_exporters[0:ntfy].token: (changed)');
    expect(text).toContain('+ global_exporters[0:ntfy].password: ********');
    expect(text).not.toMatch(/plain-token|plain-password/);
    expect(asked).toContain(`Save to ${join(dir, 'config.yaml')}?`);
  });

  it('says so when nothing changed', async () => {
    const { text } = await save(true, () => {});

    expect(text).toMatch(/No changes to config\.yaml/);
  });

  it('notes that a fresh setup replaces the file instead of diffing it', async () => {
    const { text } = await save(false, () => {});

    expect(text).toMatch(/This replaces the existing/);
    expect(text).not.toMatch(/No changes/);
  });
});
