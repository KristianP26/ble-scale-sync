import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { garminAuthStep } = await import('../../src/wizard/steps/garmin-auth.js');
import type { WizardContext } from '../../src/wizard/types.js';

function ctxWith(users: unknown[]): WizardContext {
  return {
    config: { users } as WizardContext['config'],
    configPath: 'config.yaml',
    isEditMode: false,
    nonInteractive: false,
    platform: { os: 'linux', arch: 'x64', hasDocker: false, hasPython: true, pythonCommand: 'py' },
    stepHistory: [],
    prompts: {
      input: async () => '',
      password: async () => '',
      confirm: async () => true,
      checkbox: async () => [] as never,
      select: async (_m, choices) => choices[0].value,
    },
  };
}

describe('garminAuthStep refuses to auth two accounts into one token directory', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    // A child that exits 0, so an unguarded auth loop runs to completion and
    // the assertion below (not a TypeError) is what fails.
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // The old duplicate check dropped entries without token_dir before
  // comparing, so two users on the default directory passed it, and the
  // second auth overwrote the first user's tokens.
  it('does not start any auth when two users share the default directory', async () => {
    const ctx = ctxWith([
      {
        name: 'Alice',
        slug: 'alice',
        exporters: [{ type: 'garmin', email: 'a@x', password: 'p' }],
      },
      { name: 'Bob', slug: 'bob', exporters: [{ type: 'garmin', email: 'b@x', password: 'p' }] },
    ]);

    await garminAuthStep.run(ctx);

    expect(spawnMock).not.toHaveBeenCalled();
  });
});
