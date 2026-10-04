import { describe, it, expect, vi } from 'vitest';
import { runWizard, runEditMode } from '../../src/wizard/runner.js';
import { BackNavigation } from '../../src/wizard/types.js';
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
    stepHistory: [],
    prompts: createMockPromptProvider([]),
    ...overrides,
  };
}

// ─── runWizard() ──────────────────────────────────────────────────────────

describe('runWizard()', () => {
  it('executes steps in order by the order field', async () => {
    const order: string[] = [];
    const steps = [
      makeStep('c', 30, {
        run: async () => {
          order.push('c');
        },
      }),
      makeStep('a', 10, {
        run: async () => {
          order.push('a');
        },
      }),
      makeStep('b', 20, {
        run: async () => {
          order.push('b');
        },
      }),
    ];

    // Steps b and c are non-first, each needs a 'continue' answer for back-nav prompt
    const ctx = makeCtx({
      prompts: createMockPromptProvider(['continue', 'continue']),
    });

    await runWizard(steps, ctx);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('skips steps where shouldRun returns false', async () => {
    const order: string[] = [];
    const steps = [
      makeStep('a', 10, {
        run: async () => {
          order.push('a');
        },
      }),
      makeStep('b', 20, {
        shouldRun: () => false,
        run: async () => {
          order.push('b');
        },
      }),
      makeStep('c', 30, {
        run: async () => {
          order.push('c');
        },
      }),
    ];

    // 'c' is the second active step (b is skipped), needs 1 'continue'
    const ctx = makeCtx({
      prompts: createMockPromptProvider(['continue']),
    });

    await runWizard(steps, ctx);
    expect(order).toEqual(['a', 'c']);
  });

  it('includes steps where shouldRun returns true', async () => {
    const order: string[] = [];
    const steps = [
      makeStep('a', 10, {
        shouldRun: () => true,
        run: async () => {
          order.push('a');
        },
      }),
    ];

    await runWizard(steps, makeCtx());
    expect(order).toEqual(['a']);
  });

  it('handles BackNavigation by going to the previous step', async () => {
    const calls: string[] = [];
    let bThrown = false;

    const steps = [
      makeStep('a', 10, {
        run: async () => {
          calls.push('a');
        },
      }),
      makeStep('b', 20, {
        run: async () => {
          calls.push('b');
          if (!bThrown) {
            bThrown = true;
            throw new BackNavigation();
          }
        },
      }),
      makeStep('c', 30, {
        run: async () => {
          calls.push('c');
        },
      }),
    ];

    // Flow: a runs, 'continue' for b, b throws back → a runs again,
    // 'continue' for b, b succeeds, 'continue' for c, c runs
    const ctx = makeCtx({
      prompts: createMockPromptProvider(['continue', 'continue', 'continue']),
    });

    await runWizard(steps, ctx);
    // a runs, then b runs and throws back, a runs again, b runs successfully, c runs
    expect(calls).toEqual(['a', 'b', 'a', 'b', 'c']);
  });

  it('stays at first step when BackNavigation thrown from step 0', async () => {
    let throwCount = 0;
    const steps = [
      makeStep('a', 10, {
        run: async () => {
          if (throwCount < 1) {
            throwCount++;
            throw new BackNavigation();
          }
        },
      }),
    ];

    await runWizard(steps, makeCtx());
    // Threw once, stayed, then ran successfully
    expect(throwCount).toBe(1);
  });

  it('records step IDs in stepHistory', async () => {
    // Step b is non-first, needs 'continue'
    const ctx = makeCtx({
      prompts: createMockPromptProvider(['continue']),
    });
    const steps = [makeStep('a', 10), makeStep('b', 20)];

    await runWizard(steps, ctx);
    expect(ctx.stepHistory).toEqual(['a', 'b']);
  });

  it('pops stepHistory on BackNavigation', async () => {
    let thrown = false;

    const steps = [
      makeStep('a', 10),
      makeStep('b', 20, {
        run: async () => {
          if (!thrown) {
            thrown = true;
            throw new BackNavigation();
          }
        },
      }),
    ];

    // Flow: a runs, 'continue' for b, b throws back → a runs again,
    // 'continue' for b, b succeeds
    const ctx = makeCtx({
      prompts: createMockPromptProvider(['continue', 'continue']),
    });

    await runWizard(steps, ctx);
    // After back nav: history had ['a'], popped to [], then 'a' runs again → ['a'], then 'b' → ['a', 'b']
    expect(ctx.stepHistory).toEqual(['a', 'b']);
  });

  it('propagates non-BackNavigation errors', async () => {
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
    const steps = [
      makeStep('a', 10, {
        run: async (c) => {
          c.config.version = 1;
        },
      }),
    ];

    const result = await runWizard(steps, ctx);
    expect(result.version).toBe(1);
  });

  it('handles empty step list', async () => {
    const result = await runWizard([], makeCtx());
    expect(result).toEqual({});
  });

  it('handles all steps filtered out by shouldRun', async () => {
    const steps = [
      makeStep('a', 10, { shouldRun: () => false }),
      makeStep('b', 20, { shouldRun: () => false }),
    ];

    const result = await runWizard(steps, makeCtx());
    expect(result).toEqual({});
  });

  it('goes back when user selects back in the prompt', async () => {
    const calls: string[] = [];

    const steps = [
      makeStep('a', 10, {
        run: async () => {
          calls.push('a');
        },
      }),
      makeStep('b', 20, {
        run: async () => {
          calls.push('b');
        },
      }),
    ];

    // At step b: user selects 'back' → goes to a, then 'continue' for b
    const ctx = makeCtx({
      prompts: createMockPromptProvider(['back', 'continue']),
    });

    await runWizard(steps, ctx);
    // a runs, back prompt → back → a runs again, continue → b runs
    expect(calls).toEqual(['a', 'a', 'b']);
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
        run: async () => {
          calls.push('b');
        },
      }),
    ];

    await runWizard(steps, makeCtx({ prompts: createMockPromptProvider(['continue']) }));

    expect(calls).toEqual(['a', 'b']);
  });

  it('skips a step on the way back when it no longer runs', async () => {
    const calls: string[] = [];
    let cThrown = false;
    const steps = [
      makeStep('a', 10, {
        run: async (c) => {
          calls.push('a');
          if (c.config.unknown_user === undefined) c.config.unknown_user = 'nearest';
        },
      }),
      makeStep('b', 20, {
        shouldRun: (c) => c.config.unknown_user === 'nearest',
        run: async () => {
          calls.push('b');
        },
      }),
      makeStep('c', 30, {
        run: async (c) => {
          calls.push('c');
          if (!cThrown) {
            // An answer here switches b off, then the person goes back.
            cThrown = true;
            c.config.unknown_user = 'ignore';
            throw new BackNavigation();
          }
        },
      }),
    ];

    // continue for b, continue for c, c throws back to a (b is off now),
    // continue for c
    const ctx = makeCtx({
      prompts: createMockPromptProvider(['continue', 'continue', 'continue']),
    });

    await runWizard(steps, ctx);

    expect(calls).toEqual(['a', 'b', 'c', 'a', 'c']);
  });

  it('counts only the steps that run in the step header', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const steps = [
      makeStep('a', 10),
      makeStep('b', 20, { shouldRun: () => false }),
      makeStep('c', 30),
    ];

    await runWizard(steps, makeCtx({ prompts: createMockPromptProvider(['continue']) }));

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
        run: async () => {
          order.push('summary');
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
      makeStep('summary', 80),
    ];

    await runEditMode(steps, makeCtx({ prompts }));

    expect(stravaRuns).toBe(1);
    expect(menus).toEqual([
      ['exporters', '__save__'],
      ['exporters', 'strava-auth', '__save__'],
      ['exporters', 'strava-auth', '__save__'],
      ['exporters', '__save__'],
    ]);
  });
});
