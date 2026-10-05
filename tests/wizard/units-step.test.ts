import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unitsStep, convertHeight } from '../../src/wizard/steps/units.js';
import { WIZARD_STEPS } from '../../src/wizard/steps/index.js';
import type { WizardContext } from '../../src/wizard/types.js';
import type { AppConfig, UserConfig } from '../../src/config/schema.js';
import { scriptedPrompts, type ScriptedAnswer } from '../helpers/scripted-prompts.js';

function user(name: string, height: number): UserConfig {
  return {
    name,
    slug: name.toLowerCase(),
    height,
    birth_date: '1990-01-01',
    gender: 'male',
    is_athlete: false,
    weight_range: { min: 60, max: 90 },
    last_known_weight: null,
  };
}

function ctxWith(config: Partial<AppConfig>, answers: Array<[RegExp, ScriptedAnswer]>) {
  const scripted = scriptedPrompts(answers);
  const ctx: WizardContext = {
    config,
    configPath: '/tmp/config.yaml',
    isEditMode: false,
    nonInteractive: false,
    platform: { os: 'linux', arch: 'x64', hasDocker: false, hasPython: false, pythonCommand: null },
    prompts: scripted.prompts,
  };
  return { ctx, ...scripted };
}

describe('unitsStep', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // The wizard never asked for units, so a new config was always kg/cm.
  it('runs between BLE discovery and the user profiles', () => {
    const ids = WIZARD_STEPS.map((s) => s.id);
    expect(ids.indexOf('units')).toBeGreaterThan(ids.indexOf('ble'));
    expect(ids.indexOf('units')).toBeLessThan(ids.indexOf('users'));
  });

  it('writes pounds and inches when chosen', async () => {
    const { ctx } = ctxWith(
      { scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' } },
      [
        [/^Weight unit/, 'lbs'],
        [/^Height unit/, 'in'],
      ],
    );

    await unitsStep.run(ctx);

    expect(ctx.config.scale).toEqual({
      weight_unit: 'lbs',
      height_unit: 'in',
      display_unit: 'weight_unit',
    });
  });

  it('offers the current units first, so Enter keeps them', async () => {
    const { ctx } = ctxWith(
      { scale: { weight_unit: 'lbs', height_unit: 'in', display_unit: 'st' } },
      [],
    );

    await unitsStep.run(ctx);

    expect(ctx.config.scale).toEqual({ weight_unit: 'lbs', height_unit: 'in', display_unit: 'st' });
  });

  // A height is stored in height_unit, so switching units must convert it.
  it('converts existing heights when the height unit changes', async () => {
    const users = [user('Alice', 180), user('Bob', 165.1)];
    const { ctx } = ctxWith(
      { scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' }, users },
      [[/^Height unit/, 'in']],
    );

    await unitsStep.run(ctx);

    expect(users.map((u) => u.height)).toEqual([70.87, 65]);
    // weight_range is kg in every unit setting.
    expect(users[0].weight_range).toEqual({ min: 60, max: 90 });
  });

  it('leaves heights alone when the height unit stays', async () => {
    const users = [user('Alice', 180)];
    const { ctx } = ctxWith(
      { scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' }, users },
      [[/^Weight unit/, 'lbs']],
    );

    await unitsStep.run(ctx);

    expect(users[0].height).toBe(180);
  });

  it('round-trips a height to the typed precision', () => {
    expect(convertHeight(70, 'in', 'cm')).toBe(177.8);
    expect(convertHeight(177.8, 'cm', 'in')).toBe(70);
  });

  // Inches to one decimal drifted on every toggle: 180 -> 70.9 -> 180.1.
  it('comes back to the same height after switching the unit there and back', async () => {
    const users = [user('Alice', 180), user('Bob', 172), user('Carol', 163.5)];
    const config: Partial<AppConfig> = {
      scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' },
      users,
    };

    await unitsStep.run(ctxWith(config, [[/^Height unit/, 'in']]).ctx);
    await unitsStep.run(ctxWith(config, [[/^Height unit/, 'cm']]).ctx);

    expect(users.map((u) => u.height)).toEqual([180, 172, 163.5]);
  });

  // A ${VAR} unit was read as an unknown unit: Enter replaced the reference
  // with a literal and multiplied every height by 2.54.
  it('keeps a ${VAR} unit that resolves to the unit chosen, and its heights', async () => {
    vi.stubEnv('BSS_TEST_WEIGHT_UNIT', 'lbs');
    vi.stubEnv('BSS_TEST_HEIGHT_UNIT', 'in');
    const users = [user('Alice', 70.87)];
    const { ctx, asked } = ctxWith(
      {
        scale: {
          weight_unit: '${BSS_TEST_WEIGHT_UNIT}' as 'lbs',
          height_unit: '${BSS_TEST_HEIGHT_UNIT}' as 'in',
          display_unit: 'weight_unit',
        },
        users,
      },
      [],
    );

    await unitsStep.run(ctx);

    expect(asked).toEqual(['Weight unit:', 'Height unit:']);
    expect(ctx.config.scale).toMatchObject({
      weight_unit: '${BSS_TEST_WEIGHT_UNIT}',
      height_unit: '${BSS_TEST_HEIGHT_UNIT}',
    });
    expect(users[0].height).toBe(70.87);
  });

  it('converts from the unit a ${VAR} resolves to when another unit is chosen', async () => {
    vi.stubEnv('BSS_TEST_HEIGHT_UNIT', 'in');
    const users = [user('Alice', 70)];
    const { ctx } = ctxWith(
      {
        scale: {
          weight_unit: 'kg',
          height_unit: '${BSS_TEST_HEIGHT_UNIT}' as 'in',
          display_unit: 'weight_unit',
        },
        users,
      },
      [[/^Height unit/, 'cm']],
    );

    await unitsStep.run(ctx);

    expect(ctx.config.scale?.height_unit).toBe('cm');
    expect(users[0].height).toBe(177.8);
  });

  it('does not convert heights from a unit it cannot resolve, and says so', async () => {
    const users = [user('Alice', 180)];
    const { ctx } = ctxWith(
      {
        scale: {
          weight_unit: 'kg',
          height_unit: '${BSS_TEST_UNDEFINED_UNIT}' as 'cm',
          display_unit: 'weight_unit',
        },
        users,
      },
      [[/^Height unit/, 'in']],
    );

    await unitsStep.run(ctx);

    expect(users[0].height).toBe(180);
    expect(out.join('\n')).toMatch(/height_unit is '\$\{BSS_TEST_UNDEFINED_UNIT\}'.*not converted/);
  });

  // A ${VAR} height lives in .env, so it kept its old number in the new unit.
  it('warns about a ${VAR} height with the value to set in .env', async () => {
    vi.stubEnv('BSS_TEST_HEIGHT', '180');
    const alice = { ...user('Alice', 0), height: '${BSS_TEST_HEIGHT}' as unknown as number };
    const { ctx } = ctxWith(
      {
        scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' },
        users: [alice],
      },
      [[/^Height unit/, 'in']],
    );

    await unitsStep.run(ctx);

    expect(alice.height).toBe('${BSS_TEST_HEIGHT}');
    const warning = out.find((l) => l.includes('Alice'));
    expect(warning).toContain('${BSS_TEST_HEIGHT}');
    expect(warning).toContain('Set BSS_TEST_HEIGHT to 70.87 in .env');
    // Yellow warn(), not a dim note that is easy to miss.
    expect(warning).toContain('\u26A0');
  });
});
