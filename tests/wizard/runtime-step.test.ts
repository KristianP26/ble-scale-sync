import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runtimeStep } from '../../src/wizard/steps/runtime.js';
import type { WizardContext } from '../../src/wizard/types.js';
import type { RuntimeConfig } from '../../src/config/schema.js';
import { scriptedPrompts } from '../helpers/scripted-prompts.js';

function ctxWith(
  prompts: WizardContext['prompts'],
  runtime?: RuntimeConfig,
  isEditMode = true,
): WizardContext {
  return {
    config: runtime ? { runtime: structuredClone(runtime) } : {},
    configPath: '/tmp/config.yaml',
    isEditMode,
    nonInteractive: false,
    platform: { os: 'linux', arch: 'x64', hasDocker: false, hasPython: false, pythonCommand: null },
    prompts,
  };
}

const tuned: RuntimeConfig = {
  continuous_mode: true,
  scan_cooldown: 120,
  dry_run: false,
  debug: true,
  watchdog_max_consecutive_failures: 0,
  watch_config: false,
  idle_rescan_delay: 30,
  // Off on purpose (ADR D014: the queue persists body composition to disk).
  retry_failed_exports: false,
};

describe('runtimeStep', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The step used to replace the whole runtime object and hard-code the keys it
  // never asks about, so changing only dry_run silently re-enabled the retry
  // queue and reset the watchdog, watch_config and idle_rescan_delay.
  it('keeps the runtime keys it does not ask about', async () => {
    const { prompts } = scriptedPrompts([[/dry run/, true]]);
    const ctx = ctxWith(prompts, tuned);

    await runtimeStep.run(ctx);

    expect(ctx.config.runtime).toEqual({ ...tuned, dry_run: true });
  });

  it('pre-fills every prompt from the current config, so Enter changes nothing', async () => {
    const { prompts, rejected } = scriptedPrompts([]);
    const ctx = ctxWith(prompts, tuned);

    await runtimeStep.run(ctx);

    expect(rejected).toEqual([]);
    expect(ctx.config.runtime).toEqual(tuned);
  });

  it('writes the schema defaults on a fresh setup', async () => {
    const { prompts } = scriptedPrompts([]);
    const ctx = ctxWith(prompts, undefined, false);

    await runtimeStep.run(ctx);

    expect(ctx.config.runtime).toEqual({
      continuous_mode: false,
      scan_cooldown: 30,
      dry_run: false,
      debug: false,
      watchdog_max_consecutive_failures: 10,
      watch_config: true,
      idle_rescan_delay: 5,
      retry_failed_exports: true,
    });
  });
});
