import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('garminAuthStep resolves ${VAR} references before using them', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('BSS_TEST_GARMIN_EMAIL', 'alice@example.com');
    vi.stubEnv('BSS_TEST_GARMIN_PASSWORD', 'real-secret');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The edit-mode config is the raw YAML, so the entry holds the literal
  // reference. It used to be handed to setup_garmin.py as the password,
  // overwriting the real GARMIN_PASSWORD from .env in the child's env.
  it('passes the referenced value, not the literal, to setup_garmin.py', async () => {
    const entry = {
      type: 'garmin',
      email: '${BSS_TEST_GARMIN_EMAIL}',
      password: '${BSS_TEST_GARMIN_PASSWORD}',
      token_dir: './garmin-tokens/alice',
    };
    const ctx = ctxWith([{ name: 'Alice', slug: 'alice', exporters: [entry] }]);

    await garminAuthStep.run(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env.GARMIN_EMAIL).toBe('alice@example.com');
    expect(env.GARMIN_PASSWORD).toBe('real-secret');
    // The config itself keeps the reference.
    expect(entry.password).toBe('${BSS_TEST_GARMIN_PASSWORD}');
  });

  // G-23: a 120 s spawn timeout killed the script while it waited for the MFA code.
  it('gives the interactive script no timeout', async () => {
    const entry = {
      type: 'garmin',
      email: '${BSS_TEST_GARMIN_EMAIL}',
      password: '${BSS_TEST_GARMIN_PASSWORD}',
      token_dir: './garmin-tokens/alice',
    };
    await garminAuthStep.run(ctxWith([{ name: 'Alice', slug: 'alice', exporters: [entry] }]));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2].timeout).toBeUndefined();
  });

  // A relative TOKEN_DIR (or .env) has to be resolved next to the config the
  // wizard is writing, so setup_garmin.py needs that path even in its legacy
  // env-credential mode.
  it('passes the config path to setup_garmin.py', async () => {
    const entry = {
      type: 'garmin',
      email: '${BSS_TEST_GARMIN_EMAIL}',
      password: '${BSS_TEST_GARMIN_PASSWORD}',
    };
    await garminAuthStep.run(ctxWith([{ name: 'Alice', slug: 'alice', exporters: [entry] }]));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    const i = args.indexOf('--config-path');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toMatch(/config\.yaml$/);
  });

  it('skips the auth when a referenced variable is not defined', async () => {
    const ctx = ctxWith([
      {
        name: 'Alice',
        slug: 'alice',
        exporters: [{ type: 'garmin', email: 'a@x', password: '${BSS_TEST_UNDEFINED_GARMIN_PW}' }],
      },
    ]);

    await garminAuthStep.run(ctx);

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('garminAuthStep token directory (F-11)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // setup_garmin.py ran without a cwd and got the relative path as written, so
  // the token landed next to wherever the wizard was started, while the
  // uploader (cwd = package directory) looked somewhere else.
  it('hands setup_garmin.py a relative token_dir resolved next to the config file', async () => {
    const configPath = join(tmpdir(), 'bss-wizard', 'config.yaml');
    const ctx = ctxWith([
      {
        name: 'Alice',
        slug: 'alice',
        exporters: [
          { type: 'garmin', email: 'a@x', password: 'p', token_dir: './garmin-tokens/alice' },
        ],
      },
    ]);
    ctx.configPath = configPath;

    await garminAuthStep.run(ctx);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--token-dir') + 1]).toBe(
      join(tmpdir(), 'bss-wizard', 'garmin-tokens', 'alice'),
    );
  });
});
