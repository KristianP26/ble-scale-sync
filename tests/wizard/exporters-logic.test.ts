import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EXPORTER_SCHEMAS } from '../../src/exporters/registry.js';
import type { ConfigFieldDef } from '../../src/interfaces/exporter-schema.js';
import { promptField, exportersStep } from '../../src/wizard/steps/exporters.js';
import type { WizardContext } from '../../src/wizard/types.js';
import { scriptedPrompts, type ScriptedAnswer } from '../helpers/scripted-prompts.js';
import { snapshotEnv } from '../helpers/env-snapshot.js';

const EXPORTERS = /^Exporters:/;
const STORE_ENV = /Store it in \.env/;

const scripts: ReturnType<typeof scriptedPrompts>[] = [];

// A secret accepted for .env is also set in process.env (GARMIN_PASSWORD*,
// STRAVA_CLIENT_SECRET* from the Enter-only runs below).
let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = snapshotEnv();
});
// Every scripted answer must have been asked for and accepted. A regex that
// matches no prompt would otherwise leave that prompt on its default, and the
// test would pass on a path it never meant to take.
afterEach(() => {
  restoreEnv();
  for (const s of scripts.splice(0)) {
    expect(s.pending.map(([re]) => String(re))).toEqual([]);
    expect(s.rejected).toEqual([]);
  }
});

function makeCtx(answers: Array<[RegExp, ScriptedAnswer]> = []) {
  const scripted = scriptedPrompts(answers);
  scripts.push(scripted);
  const ctx: WizardContext = {
    config: {},
    configPath: 'config.yaml',
    isEditMode: false,
    nonInteractive: false,
    platform: {
      os: 'linux',
      arch: 'x64',
      hasDocker: false,
      hasPython: true,
      pythonCommand: 'python3',
    },
    prompts: scripted.prompts,
  };
  return { ctx, asked: scripted.asked };
}

// ─── Schema-driven field types ───────────────────────────────────────────

describe('promptField()', () => {
  it('handles string field', async () => {
    const field: ConfigFieldDef = { key: 'url', label: 'URL', type: 'string', required: true };
    const { ctx } = makeCtx([[/^URL:/, 'https://example.com']]);
    const result = await promptField(ctx, field);
    expect(result).toBe('https://example.com');
  });

  it('handles string field with default', async () => {
    const field: ConfigFieldDef = {
      key: 'topic',
      label: 'Topic',
      type: 'string',
      required: false,
      default: 'my-topic',
    };
    // Enter: the offered default is the answer.
    const { ctx } = makeCtx();
    const result = await promptField(ctx, field);
    expect(result).toBe('my-topic');
  });

  it('handles password field', async () => {
    const field: ConfigFieldDef = {
      key: 'password',
      label: 'Password',
      type: 'password',
      required: true,
    };
    const { ctx } = makeCtx([
      [/^Password:/, 'secret123'],
      [STORE_ENV, false], // keep it in config.yaml
    ]);
    const result = await promptField(ctx, field);
    expect(result).toBe('secret123');
  });

  it('password field calls prompts.password() not prompts.input()', async () => {
    const field: ConfigFieldDef = {
      key: 'password',
      label: 'Password',
      type: 'password',
      required: true,
    };
    const { ctx } = makeCtx([
      [/^Password:/, 'secret123'],
      [STORE_ENV, false],
    ]);
    const passwordSpy = vi.spyOn(ctx.prompts, 'password');
    const inputSpy = vi.spyOn(ctx.prompts, 'input');

    await promptField(ctx, field);
    expect(passwordSpy).toHaveBeenCalledOnce();
    expect(inputSpy).not.toHaveBeenCalled();
  });

  it('handles number field', async () => {
    const field: ConfigFieldDef = {
      key: 'timeout',
      label: 'Timeout',
      type: 'number',
      required: false,
      default: 10000,
    };
    const { ctx } = makeCtx([[/^Timeout:/, '5000']]);
    const result = await promptField(ctx, field);
    expect(result).toBe(5000);
  });

  it('handles boolean field', async () => {
    const field: ConfigFieldDef = {
      key: 'retain',
      label: 'Retain',
      type: 'boolean',
      required: false,
      default: true,
    };
    const { ctx } = makeCtx([[/^Retain\?/, true]]);
    const result = await promptField(ctx, field);
    expect(result).toBe(true);
  });

  it('returns the answer, not the default, for a boolean field', async () => {
    const field: ConfigFieldDef = {
      key: 'retain',
      label: 'Retain',
      type: 'boolean',
      required: false,
      default: true,
    };
    const { ctx } = makeCtx([[/^Retain\?/, false]]);
    const result = await promptField(ctx, field);
    expect(result).toBe(false);
  });

  it('handles select field', async () => {
    const field: ConfigFieldDef = {
      key: 'method',
      label: 'Method',
      type: 'select',
      required: false,
      default: 'POST',
      choices: [
        { label: 'POST', value: 'POST' },
        { label: 'PUT', value: 'PUT' },
      ],
    };
    const { ctx } = makeCtx([[/^Method:/, 'PUT']]);
    const result = await promptField(ctx, field);
    expect(result).toBe('PUT');
  });

  it('returns undefined for empty optional string', async () => {
    const field: ConfigFieldDef = {
      key: 'headers',
      label: 'Headers',
      type: 'string',
      required: false,
    };
    const { ctx } = makeCtx([[/^Headers:/, '']]);
    const result = await promptField(ctx, field);
    expect(result).toBeUndefined();
  });

  it('returns default for empty optional number', async () => {
    const field: ConfigFieldDef = {
      key: 'qos',
      label: 'QoS',
      type: 'number',
      required: false,
      default: 1,
    };
    const { ctx } = makeCtx([[/^QoS:/, '']]);
    const result = await promptField(ctx, field);
    expect(result).toBe(1);
  });
});

// ─── Confirm-before-configure skip (unified checkbox flow) ──────────────

describe('exportersStep — confirm skip', () => {
  it('skips exporter config when user declines confirm', async () => {
    const { ctx } = makeCtx([
      [EXPORTERS, ['webhook']], // webhook supports global
      [/^Configure Webhook\?/, false],
    ]);
    ctx.config.users = [{ name: 'Test', slug: 'test' }];

    await exportersStep.run(ctx);

    // Webhook was skipped, so global_exporters should be undefined (empty after skip)
    expect(ctx.config.global_exporters).toBeUndefined();
  });

  it('configures exporter when user accepts confirm', async () => {
    // Only the required URL is typed; every other webhook field is Enter.
    const { ctx } = makeCtx([
      [EXPORTERS, ['webhook']],
      [/^Configure Webhook\?/, true],
      [/^Webhook URL:/, 'https://example.com'],
    ]);
    ctx.config.users = [{ name: 'Test', slug: 'test' }];

    await exportersStep.run(ctx);

    expect(ctx.config.global_exporters).toBeDefined();
    expect(ctx.config.global_exporters!.length).toBe(1);
    expect(ctx.config.global_exporters![0].type).toBe('webhook');
    expect(ctx.config.global_exporters![0]).toMatchObject({ url: 'https://example.com' });
  });

  it('returns early when user confirms proceeding with no exporters', async () => {
    const { ctx } = makeCtx([
      [EXPORTERS, []],
      [/Continue without exporters\?/, true],
    ]);
    ctx.config.users = [{ name: 'Test', slug: 'test' }];

    await exportersStep.run(ctx);

    expect(ctx.config.global_exporters).toBeUndefined();
  });

  it('re-prompts when user declines empty selection, accepts on second try', async () => {
    const { ctx, asked } = makeCtx([
      [EXPORTERS, []], // first checkbox: empty
      [/Continue without exporters\?/, false],
      [EXPORTERS, ['webhook']], // second checkbox
      [/^Configure Webhook\?/, true],
      [/^Webhook URL:/, 'https://example.com'],
    ]);
    ctx.config.users = [{ name: 'Test', slug: 'test' }];

    await exportersStep.run(ctx);

    expect(asked.filter((m) => EXPORTERS.test(m) || /Continue without/.test(m))).toEqual([
      expect.stringMatching(EXPORTERS),
      expect.stringMatching(/Continue without exporters\?/),
      expect.stringMatching(EXPORTERS),
    ]);
    expect(ctx.config.global_exporters).toBeDefined();
    expect(ctx.config.global_exporters!.length).toBe(1);
    expect(ctx.config.global_exporters![0].type).toBe('webhook');
  });
});

// ─── EXPORTER_SCHEMAS filtering ──────────────────────────────────────────

describe('EXPORTER_SCHEMAS filtering', () => {
  it('has schemas for all known exporters', () => {
    const names = EXPORTER_SCHEMAS.map((s) => s.name);
    expect(names).toContain('garmin');
    expect(names).toContain('mqtt');
    expect(names).toContain('webhook');
    expect(names).toContain('influxdb');
    expect(names).toContain('ntfy');
  });

  it('filters global-supported schemas', () => {
    const global = EXPORTER_SCHEMAS.filter((s) => s.supportsGlobal);
    const names = global.map((s) => s.name);
    // Garmin is per-user only (supportsGlobal: false)
    expect(names).not.toContain('garmin');
    expect(names).toContain('mqtt');
  });

  it('filters per-user-supported schemas', () => {
    const perUser = EXPORTER_SCHEMAS.filter((s) => s.supportsPerUser);
    const names = perUser.map((s) => s.name);
    expect(names).toContain('garmin');
  });

  it('each schema has a displayName and description', () => {
    for (const schema of EXPORTER_SCHEMAS) {
      expect(schema.displayName).toBeTruthy();
      expect(schema.description).toBeTruthy();
    }
  });

  it('each schema field has a key, label, and type', () => {
    for (const schema of EXPORTER_SCHEMAS) {
      for (const field of schema.fields) {
        expect(field.key).toBeTruthy();
        expect(field.label).toBeTruthy();
        expect(['string', 'password', 'number', 'boolean', 'select']).toContain(field.type);
      }
    }
  });

  it('select fields have choices', () => {
    for (const schema of EXPORTER_SCHEMAS) {
      for (const field of schema.fields) {
        if (field.type === 'select') {
          expect(field.choices).toBeDefined();
          expect(field.choices!.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

// ─── Per-user token directories ─────────────────────────────────────────

describe('exportersStep — token_dir default per user', () => {
  // Every user used to be offered the same './garmin-tokens'. Pressing Enter
  // twice put two Garmin accounts in one token directory, and the second auth
  // overwrote the first: both people's weigh-ins went to the second account.
  // Only the required fields are typed, once per user; everything else,
  // the token directory included, is the user pressing Enter.
  const REQUIRED: Record<string, Array<[RegExp, ScriptedAnswer]>> = {
    garmin: [
      [/^Garmin Email:/, 'someone@example.com'],
      [/^Garmin Password/, 'pw'],
    ],
    strava: [
      [/^Client ID:/, '12345'],
      [/^Client Secret/, 'pw'],
    ],
  };
  function enterOnlyCtx(type: string, userCount: number): WizardContext {
    const perUser = Array.from({ length: userCount }, () => REQUIRED[type]).flat();
    return makeCtx([[EXPORTERS, [type]], ...perUser]).ctx;
  }

  it.each(['garmin', 'strava'])('offers each %s user a separate token_dir', async (type) => {
    const ctx = enterOnlyCtx(type, 2);
    ctx.config.users = [
      { name: 'Alice', slug: 'alice' },
      { name: 'Bob', slug: 'bob' },
    ];

    await exportersStep.run(ctx);

    const dirs = (ctx.config.users ?? []).map(
      (u) => (u as { exporters?: { token_dir?: string }[] }).exporters?.[0]?.token_dir,
    );
    expect(dirs).toEqual([`./${type}-tokens/alice`, `./${type}-tokens/bob`]);
  });

  it('keeps the plain default for a single user', async () => {
    const ctx = enterOnlyCtx('garmin', 1);
    ctx.config.users = [{ name: 'Alice', slug: 'alice' }];

    await exportersStep.run(ctx);

    const user = ctx.config.users[0] as { exporters?: { token_dir?: string }[] };
    expect(user.exporters?.[0]?.token_dir).toBe('./garmin-tokens');
  });
});
