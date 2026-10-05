import { describe, it, expect, vi } from 'vitest';
import { runWizard, runEditMode, runSectionMenu } from '../../src/wizard/runner.js';
import type { WizardStep, WizardContext } from '../../src/wizard/types.js';
import { createMockPromptProvider } from '../../src/wizard/prompt-provider.js';

function makeStep(
  id: string,
  order: number,
  opts?: {
    shouldRun?: (ctx: WizardContext) => boolean;
    run?: (ctx: WizardContext) => Promise<void>;
  },
): WizardStep {
  return {
    id,
    title: `Step ${id}`,
    order,
    shouldRun: opts?.shouldRun,
    run: opts?.run ?? vi.fn(async () => {}),
  };
}

function makeCtx(overrides?: Partial<WizardContext>): WizardContext {
  return {
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
    prompts: createMockPromptProvider([]),
    ...overrides,
  };
}

// ─── runWizard() ──────────────────────────────────────────────────────────

describe('runWizard()', () => {
  it('executes steps in order by the order field, without a prompt between them', async () => {
    const order: string[] = [];
    const push = (id: string) => async () => void order.push(id);
    const steps = [
      makeStep('c', 30, { run: push('c') }),
      makeStep('a', 10, { run: push('a') }),
      makeStep('b', 20, { run: push('b') }),
    ];

    // The old Back prompt before every step would exhaust this provider.
    await runWizard(steps, makeCtx({ prompts: createMockPromptProvider([]) }));
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('skips steps where shouldRun returns false', async () => {
    const order: string[] = [];
    const steps = [
      makeStep('a', 10, { run: async () => void order.push('a') }),
      makeStep('b', 20, { shouldRun: () => false, run: async () => void order.push('b') }),
      makeStep('c', 30, { run: async () => void order.push('c') }),
    ];

    await runWizard(steps, makeCtx());
    expect(order).toEqual(['a', 'c']);
  });

  it('propagates errors', async () => {
    const steps = [
      makeStep('a', 10, {
        run: async () => {
          throw new Error('boom');
        },
      }),
    ];

    await expect(runWizard(steps, makeCtx())).rejects.toThrow('boom');
  });

  it('returns the config from context', async () => {
    const ctx = makeCtx();
    const steps = [makeStep('a', 10, { run: async (c) => void (c.config.version = 1) })];

    const result = await runWizard(steps, ctx);
    expect(result.version).toBe(1);
  });

  it('handles empty step list', async () => {
    const result = await runWizard([], makeCtx());
    expect(result).toEqual({});
  });

  // shouldRun used to be asked once, before the first step, so a step that
  // depends on an earlier answer (Garmin or Strava auth on a fresh setup,
  // where no exporter exists yet) never ran.
  it('asks shouldRun when the step comes up, after the earlier steps ran', async () => {
    const calls: string[] = [];
    const steps = [
      makeStep('a', 10, {
        run: async (c) => {
          calls.push('a');
          c.config.version = 1;
        },
      }),
      makeStep('b', 20, {
        shouldRun: (c) => c.config.version === 1,
        run: async () => void calls.push('b'),
      }),
    ];

    await runWizard(steps, makeCtx());

    expect(calls).toEqual(['a', 'b']);
  });

  it('counts only the steps that run in the step header', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const steps = [
      makeStep('a', 10),
      makeStep('b', 20, { shouldRun: () => false }),
      makeStep('c', 30),
    ];

    await runWizard(steps, makeCtx());

    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(out).toMatch(/Step 2\/2/);
    expect(out).not.toMatch(/\/3/);
  });
});

// ─── runEditMode() ────────────────────────────────────────────────────────

describe('runEditMode()', () => {
  it('skips the welcome step in edit mode', async () => {
    const order: string[] = [];
    const steps = [
      makeStep('welcome', 10, {
        run: async () => {
          order.push('welcome');
        },
      }),
      makeStep('users', 20, {
        run: async () => {
          order.push('users');
        },
      }),
      makeStep('summary', 100, {
        run: async (c) => {
          order.push('summary');
          c.saved = true;
        },
      }),
    ];

    // First select 'users', then select '__save__'
    const ctx = makeCtx({
      prompts: createMockPromptProvider(['users', '__save__']),
    });

    await runEditMode(steps, ctx);
    expect(order).toEqual(['users', 'summary']);
    expect(order).not.toContain('welcome');
  });

  it('allows running the same step multiple times', async () => {
    let count = 0;
    const steps = [
      makeStep('users', 20, {
        run: async () => {
          count++;
        },
      }),
    ];

    const ctx = makeCtx({
      prompts: createMockPromptProvider(['users', 'users', '__save__']),
    });

    await runEditMode(steps, ctx);
    expect(count).toBe(2);
  });

  it('exits when user selects Review & Save', async () => {
    const steps = [makeStep('users', 20)];

    const ctx = makeCtx({
      prompts: createMockPromptProvider(['__save__']),
    });

    const result = await runEditMode(steps, ctx);
    expect(result).toBeDefined();
  });

  // The menu was built once, so a Strava exporter added in the same session
  // could not be authorized until the wizard was started again.
  it('rebuilds the menu after each section, as shouldRun changes', async () => {
    const menus: string[][] = [];
    const answers = ['exporters', 'strava-auth', 'exporters', '__save__'];
    const prompts = createMockPromptProvider([]);
    prompts.select = (async (_message: string, choices: { value: string }[]) => {
      menus.push(choices.map((c) => c.value));
      return answers.shift();
    }) as typeof prompts.select;
    let stravaRuns = 0;
    const steps = [
      makeStep('exporters', 40, {
        run: async (c) => {
          // First visit adds the exporter, the second removes it.
          c.config.version = c.config.version === 1 ? undefined : 1;
        },
      }),
      makeStep('strava-auth', 55, {
        shouldRun: (c) => c.config.version === 1,
        run: async () => {
          stravaRuns++;
        },
      }),
      makeStep('summary', 80, { run: async (c) => void (c.saved = true) }),
    ];

    await runEditMode(steps, makeCtx({ prompts }));

    expect(stravaRuns).toBe(1);
    expect(menus).toEqual([
      ['__save__', 'exporters', '__quit__'],
      ['__save__', 'exporters', 'strava-auth', '__quit__'],
      ['__save__', 'exporters', 'strava-auth', '__quit__'],
      ['__save__', 'exporters', '__quit__'],
    ]);
  });
});

describe('runSectionMenu()', () => {
  // Review & Save is first, so Enter on the menu finishes.
  it('offers Review & Save first', async () => {
    let first: unknown;
    const prompts = createMockPromptProvider([]);
    prompts.select = (async (_m: string, choices: { value: string }[]) => {
      first = choices[0].value;
      return '__save__';
    }) as typeof prompts.select;

    await runSectionMenu(
      [makeStep('users', 20), makeStep('summary', 80, { run: async (c) => void (c.saved = true) })],
      makeCtx({ prompts }),
    );

    expect(first).toBe('__save__');
  });

  // The menu ended after the summary whatever it did, so a "No" at "Save
  // anyway?" (or a failed .env write) dropped every answer.
  it('comes back to the menu when the summary did not save', async () => {
    const order: string[] = [];
    let summaryRuns = 0;
    const steps = [
      makeStep('users', 20, { run: async () => void order.push('users') }),
      makeStep('summary', 80, {
        run: async (c) => {
          summaryRuns++;
          order.push('summary');
          c.saved = summaryRuns === 2;
        },
      }),
    ];
    const ctx = makeCtx({ prompts: createMockPromptProvider(['__save__', 'users', '__save__']) });

    await runSectionMenu(steps, ctx);

    expect(order).toEqual(['summary', 'users', 'summary']);
    expect(ctx.saved).toBe(true);
  });

  it('offers Quit without saving last, and it ends the menu without the summary', async () => {
    let last: unknown;
    // Review & Save after Quit only so a menu that ignores Quit still ends.
    const answers = ['__quit__', '__save__'];
    const prompts = createMockPromptProvider([]);
    prompts.select = (async (_m: string, choices: { value: string; name: string }[]) => {
      last ??= choices[choices.length - 1];
      return answers.shift();
    }) as typeof prompts.select;
    const summary = makeStep('summary', 80);
    const ctx = makeCtx({ prompts });

    await runSectionMenu([makeStep('users', 20), summary], ctx);

    expect(last).toEqual({ name: 'Quit without saving', value: '__quit__' });
    expect(summary.run).not.toHaveBeenCalled();
    expect(ctx.saved).toBeFalsy();
  });
});
