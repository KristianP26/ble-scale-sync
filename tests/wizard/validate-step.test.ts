import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExporterEntry } from '../../src/config/schema.js';

const created: ExporterEntry[] = [];
vi.mock('../../src/exporters/registry.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/exporters/registry.js')>();
  return {
    ...actual,
    createExporterFromEntry: (entry: ExporterEntry) => {
      created.push(entry);
      return { name: entry.type, export: async () => ({ success: true }) };
    },
  };
});

const { validateStep } = await import('../../src/wizard/steps/validate.js');
import type { WizardContext } from '../../src/wizard/types.js';
import { scriptedPrompts } from '../helpers/scripted-prompts.js';

function ctxWith(global: ExporterEntry[]): WizardContext {
  return {
    config: { global_exporters: global, users: [] },
    configPath: '/tmp/config.yaml',
    isEditMode: true,
    nonInteractive: false,
    platform: { os: 'linux', arch: 'x64', hasDocker: false, hasPython: false, pythonCommand: null },
    prompts: scriptedPrompts([]).prompts,
  };
}

describe('validateStep resolves ${VAR} references before testing', () => {
  let out: string[];
  beforeEach(() => {
    created.length = 0;
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubEnv('BSS_TEST_HOOK_URL', 'https://hooks.example/real');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // Edit mode works on the raw YAML, so the exporter used to be built with the
  // literal '${VAR}' and every exporter with a reference reported FAILED.
  it('builds the exporter from the referenced value', async () => {
    const entry = { type: 'webhook', url: '${BSS_TEST_HOOK_URL}' } as ExporterEntry;
    const ctx = ctxWith([entry]);

    await validateStep.run(ctx);

    expect(created).toEqual([{ type: 'webhook', url: 'https://hooks.example/real' }]);
    // The config keeps the reference; only the tested copy is resolved.
    expect(ctx.config.global_exporters).toEqual([{ type: 'webhook', url: '${BSS_TEST_HOOK_URL}' }]);
  });

  it('reports an undefined variable instead of testing the literal', async () => {
    const ctx = ctxWith([{ type: 'webhook', url: '${BSS_TEST_NOT_DEFINED}' } as ExporterEntry]);

    await validateStep.run(ctx);

    expect(created).toEqual([]);
    expect(out.join('\n')).toMatch(/BSS_TEST_NOT_DEFINED/);
  });
});

describe('validateStep tests every exporter entry', () => {
  let written: string[];
  beforeEach(() => {
    created.length = 0;
    written = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      written.push(String(s));
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  // Since D029 every entry of a type runs, but this step kept only the first
  // one per type, so a second webhook with a wrong URL was never tested.
  it('tests a second global entry of the same type', async () => {
    const ctx = ctxWith([
      { type: 'webhook', url: 'https://a.example/hook' } as ExporterEntry,
      { type: 'webhook', url: 'https://b.example/hook' } as ExporterEntry,
    ]);

    await validateStep.run(ctx);

    expect(created.map((e) => (e as { url?: string }).url)).toEqual([
      'https://a.example/hook',
      'https://b.example/hook',
    ]);
    expect(written.join('')).toMatch(/Webhook \(global #1\).*Webhook \(global #2\)/s);
  });

  it('tests the same per-user type for every user, named by user', async () => {
    const ctx = ctxWith([]);
    ctx.config.users = [
      { name: 'Alice', exporters: [{ type: 'intervals', athlete_id: 'a' }] },
      { name: 'Bob', exporters: [{ type: 'intervals', athlete_id: 'b' }] },
    ] as unknown as NonNullable<WizardContext['config']['users']>;

    await validateStep.run(ctx);

    expect(created).toHaveLength(2);
    expect(written.join('')).toMatch(/Intervals\.icu \(Alice\).*Intervals\.icu \(Bob\)/s);
  });
});

describe('validateStep tests token exporters against the config being written', () => {
  beforeEach(() => {
    created.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  // Built from the raw entry, Strava looked for its tokens next to the working
  // directory or the package, not next to --config where the wizard put them.
  it('resolves token_dir next to the config file, as config loading does', async () => {
    const configDir = join(tmpdir(), 'bss-validate-cfg');
    const ctx = ctxWith([]);
    ctx.configPath = join(configDir, 'config.yaml');
    ctx.config.users = [
      {
        name: 'Alice',
        exporters: [
          { type: 'strava', client_id: '1', client_secret: 's' },
          { type: 'strava', client_id: '2', client_secret: 's', token_dir: './st/alice' },
        ],
      },
    ] as unknown as NonNullable<WizardContext['config']['users']>;

    await validateStep.run(ctx);

    expect(created.map((e) => (e as { token_dir?: string }).token_dir)).toEqual([
      resolve(configDir, 'strava-tokens'),
      resolve(configDir, 'st', 'alice'),
    ]);
    // Only the tested copy changes.
    expect(ctx.config.users![0].exporters![1]).toMatchObject({ token_dir: './st/alice' });
  });
});
