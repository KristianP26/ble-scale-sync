import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    stepHistory: [],
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
