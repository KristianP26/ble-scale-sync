import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AppConfig, UserConfig } from '../../src/config/schema.js';
import { createAppContext } from '../../src/runtime/context.js';
import { resolveRuntimeConfig } from '../../src/config/resolve.js';

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

function user(slug: string, last: number | null): UserConfig {
  return {
    name: slug,
    slug,
    height: 180,
    birth_date: '1990-01-01',
    gender: 'male',
    is_athlete: false,
    weight_range: { min: 40, max: 120 },
    last_known_weight: last,
  } as UserConfig;
}

function config(users: UserConfig[]): AppConfig {
  return {
    version: 1,
    scale: { weight_unit: 'kg', height_unit: 'cm' },
    unknown_user: 'nearest',
    out_of_range: 'warn',
    users,
    update_check: false,
  } as AppConfig;
}

function build(c: AppConfig) {
  return createAppContext({
    config: c,
    resolved: { ...resolveRuntimeConfig(c), retryFailedExports: false },
    configSource: 'yaml',
    configPath: undefined,
    signal: new AbortController().signal,
    abortApp: () => {},
  });
}

const warnings = (): string => warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

afterEach(() => warnSpy.mockClear());

describe('a saved last_known_weight that is not a body weight', () => {
  it('createAppContext forgets it and says so', () => {
    const ctx = build(config([user('dad', 1.68e134), user('mom', 60)]));
    expect(ctx.config.users[0].last_known_weight).toBeNull();
    expect(ctx.config.users[1].last_known_weight).toBe(60);
    expect(warnings()).toMatch(/Ignoring last_known_weight 1\.68e\+134 of dad: not a plausible/);
  });

  it('setConfig forgets it as well', () => {
    const ctx = build(config([user('dad', 82)]));
    const next = config([user('dad', 0.1)]);
    ctx.setConfig(next, resolveRuntimeConfig(next));
    expect(ctx.config.users[0].last_known_weight).toBeNull();
    expect(warnings()).toMatch(/Ignoring last_known_weight 0\.1 of dad/);
  });

  it('keeps a plausible value and logs nothing', () => {
    const ctx = build(config([user('dad', 82), user('mom', null)]));
    expect(ctx.config.users[0].last_known_weight).toBe(82);
    expect(warnings()).toBe('');
  });
});
