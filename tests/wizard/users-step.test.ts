import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usersStep } from '../../src/wizard/steps/users.js';
import type { PromptProvider, PromptChoice, WizardContext } from '../../src/wizard/types.js';
import type { UserConfig } from '../../src/config/schema.js';

/**
 * Answers by prompt text, not by position, so the test reads the same against
 * any prompt order. Like the real provider, an unanswered input returns its
 * default (the user pressing Enter). Unlike createMockPromptProvider it also
 * runs `validate`, and records a rejection instead of looping, so an answer
 * the real wizard would refuse shows up as an assertion.
 */
function scriptedPrompts(answers: Array<[RegExp, string | boolean]>) {
  const rejected: string[] = [];
  const asked: string[] = [];
  const find = (message: string) => {
    asked.push(message);
    return answers.find(([re]) => re.test(message))?.[1];
  };
  const prompts: PromptProvider = {
    async input(message, opts) {
      const value = String(find(message) ?? opts?.default ?? '');
      const verdict = opts?.validate?.(value) ?? true;
      if (verdict !== true) rejected.push(`${message} ${value}: ${verdict}`);
      return value;
    },
    async select<T>(message: string, choices: PromptChoice<T>[]): Promise<T> {
      const answer = find(message);
      const choice = choices.find((c) => c.value === answer) ?? choices[0];
      return choice.value;
    },
    async confirm(message, opts) {
      const answer = find(message);
      return typeof answer === 'boolean' ? answer : (opts?.default ?? false);
    },
    async checkbox() {
      throw new Error('unexpected checkbox');
    },
    async password() {
      throw new Error('unexpected password');
    },
  };
  return { prompts, rejected, asked };
}

const alice: UserConfig = {
  name: 'Alice',
  slug: 'alice',
  height: 168,
  birth_date: '1990-06-15',
  gender: 'female',
  is_athlete: false,
  weight_range: { min: 50, max: 70 },
  last_known_weight: 61.3,
  exporters: [{ type: 'garmin', email: 'a@example.com', token_dir: './garmin-tokens/alice' }],
  beurer_pin: 1234,
  beurer_user_index: 2,
  beurer_provision: true,
};

const bob: UserConfig = {
  name: 'Bob',
  slug: 'bob',
  height: 183,
  birth_date: '1985-01-02',
  gender: 'male',
  is_athlete: true,
  weight_range: { min: 70, max: 100 },
  last_known_weight: 82,
  exporters: [{ type: 'strava', client_id: '1', client_secret: 's', token_dir: './st/bob' }],
};

function editContext(prompts: PromptProvider, users: UserConfig[]): WizardContext {
  return {
    config: {
      scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' },
      users: structuredClone(users),
    },
    configPath: '/tmp/config.yaml',
    isEditMode: true,
    nonInteractive: false,
    platform: { os: 'linux', arch: 'x64', hasDocker: false, hasPython: false, pythonCommand: null },
    stepHistory: [],
    prompts,
  };
}

describe('usersStep in edit mode', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Editing one field of a profile used to rebuild every user from scratch,
  // dropping per-user exporters, last_known_weight and the Beurer keys, and
  // the user's own slug was refused as "already in use".
  it('keeps the keys it does not ask about when a user is edited', async () => {
    const { prompts, rejected } = scriptedPrompts([
      [/Alice/, 'edit'],
      [/^User name/, 'Alice'],
      [/^Slug/, 'alice'],
      [/^Height/, '170'],
      [/^Birth date/, '1990-06-15'],
      [/^Gender/, 'female'],
      [/^Athlete/, false],
      [/minimum/, '50'],
      [/maximum/, '72'],
      [/^Add another user/, false],
    ]);
    const ctx = editContext(prompts, [alice]);

    await usersStep.run(ctx);

    expect(ctx.config.users).toEqual([
      { ...alice, height: 170, weight_range: { min: 50, max: 72 } },
    ]);
    expect(rejected).toEqual([]);
  });

  it('pre-fills every prompt, so pressing Enter changes nothing', async () => {
    const { prompts, rejected } = scriptedPrompts([
      [/Alice/, 'edit'],
      [/^Add another user/, false],
    ]);
    const ctx = editContext(prompts, [alice]);

    await usersStep.run(ctx);

    expect(rejected).toEqual([]);
    expect(ctx.config.users).toEqual([alice]);
  });

  it('keeps an unchanged user without asking anything about it', async () => {
    const { prompts, asked } = scriptedPrompts([
      [/Alice/, 'keep'],
      [/Bob/, 'keep'],
      [/^Add another user/, false],
    ]);
    const ctx = editContext(prompts, [alice, bob]);

    await usersStep.run(ctx);

    expect(ctx.config.users).toEqual([alice, bob]);
    expect(asked.some((m) => /^Height/.test(m))).toBe(false);
  });

  it('removes a user on request and keeps the others intact', async () => {
    const { prompts } = scriptedPrompts([
      [/Alice/, 'remove'],
      [/Bob/, 'keep'],
      [/^Add another user/, false],
    ]);
    const ctx = editContext(prompts, [alice, bob]);

    await usersStep.run(ctx);

    expect(ctx.config.users).toEqual([bob]);
  });

  it('asks for a new user when every existing one was removed', async () => {
    const { prompts, rejected } = scriptedPrompts([
      [/Alice/, 'remove'],
      [/^User name/, 'Carol'],
      [/^Slug/, 'carol'],
      [/^Height/, '160'],
      [/^Birth date/, '1999-09-09'],
      [/^Gender/, 'female'],
      [/^Athlete/, false],
      [/minimum/, '45'],
      [/maximum/, '65'],
      [/^Add another user/, false],
    ]);
    const ctx = editContext(prompts, [alice]);

    await usersStep.run(ctx);

    expect(rejected).toEqual([]);
    expect(ctx.config.users).toEqual([
      {
        name: 'Carol',
        slug: 'carol',
        height: 160,
        birth_date: '1999-09-09',
        gender: 'female',
        is_athlete: false,
        weight_range: { min: 45, max: 65 },
        last_known_weight: null,
      },
    ]);
  });

  it('refuses a slug another kept user already has', async () => {
    const { prompts, rejected } = scriptedPrompts([
      [/Alice/, 'edit'],
      [/Bob/, 'keep'],
      [/^Slug/, 'bob'],
      [/^Add another user/, false],
    ]);
    const ctx = editContext(prompts, [alice, bob]);

    await usersStep.run(ctx);

    expect(rejected.join('\n')).toMatch(/Slug 'bob' is already in use/);
  });

  // Weight ranges are stored in kg but asked in lbs. Re-converting the
  // displayed default would drift the stored value on every edit.
  it('keeps a lbs weight range exact when Enter accepts the default', async () => {
    const { prompts } = scriptedPrompts([
      [/Alice/, 'edit'],
      [/^Add another user/, false],
    ]);
    const ctx = editContext(prompts, [alice]);
    ctx.config.scale = { weight_unit: 'lbs', height_unit: 'cm', display_unit: 'weight_unit' };

    await usersStep.run(ctx);

    expect(ctx.config.users![0].weight_range).toEqual({ min: 50, max: 70 });
  });
});
