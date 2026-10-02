import { describe, it, expect } from 'vitest';

import { resolveQueuedExporter, collectConfiguredExporters } from '../../src/runtime/exporters.js';
import type { AppConfig, UserConfig } from '../../src/config/schema.js';
import type { AppContext } from '../../src/runtime/context.js';

/**
 * A queued export must be redelivered through the exporter belonging to the
 * user it was queued FOR.
 *
 * `Exporter.name` is the exporter TYPE ('garmin'), a class constant, so two
 * users who each configure their own Garmin account produce two instances that
 * answer to the same name. Resolving a queued entry by name over a union
 * deduped by name therefore handed user B's weigh-in to user A's instance,
 * which uploads with A's credentials - into A's Garmin account.
 *
 * The assertions below read the resolved exporter's OWN config rather than its
 * name, because the name is exactly the thing that cannot tell them apart.
 */

function user(slug: string, tokenDir: string): UserConfig {
  return {
    name: slug.toUpperCase(),
    slug,
    height: 180,
    birth_date: '1990-01-01',
    gender: 'male',
    is_athlete: false,
    weight_range: { min: 40, max: 150 },
    last_known_weight: null,
    exporters: [{ type: 'garmin', email: `${slug}@example.test`, token_dir: tokenDir }],
  } as unknown as UserConfig;
}

function ctxWith(users: UserConfig[]): AppContext {
  return {
    config: { users } as unknown as AppConfig,
    exporterCache: new Map(),
  } as unknown as AppContext;
}

/** The token_dir the resolved instance would actually upload with. */
function accountOf(exporter: unknown): string | undefined {
  return (exporter as { entryConfig?: { token_dir?: string } }).entryConfig?.token_dir;
}

describe('resolveQueuedExporter: a retry must not reach another user account', () => {
  const anna = user('anna', '/tokens/anna');
  const petr = user('petr', '/tokens/petr');

  it('resolves through the entry userSlug, not the first exporter of that name', () => {
    const ctx = ctxWith([anna, petr]);

    const resolved = resolveQueuedExporter(ctx, { exporter: 'garmin', userSlug: 'petr' });

    expect(resolved).toBeDefined();
    expect(accountOf(resolved)).toBe('/tokens/petr');
  });

  it('resolves the other user the same way, so the result is not a fixed order', () => {
    // Guards against a "fix" that merely reversed which instance wins.
    const ctx = ctxWith([anna, petr]);

    expect(accountOf(resolveQueuedExporter(ctx, { exporter: 'garmin', userSlug: 'anna' }))).toBe(
      '/tokens/anna',
    );
  });

  it('the deduped union it used to resolve against carries only ONE of the two', () => {
    // Pins the reason the old lookup was unsafe: this is what it searched.
    const union = collectConfiguredExporters(ctxWith([anna, petr]));

    expect(union.filter((e) => e.name === 'garmin')).toHaveLength(1);
    expect(accountOf(union.find((e) => e.name === 'garmin'))).toBe('/tokens/anna');
  });

  it('returns nothing for a user that is gone instead of falling back', () => {
    const ctx = ctxWith([anna]);

    expect(resolveQueuedExporter(ctx, { exporter: 'garmin', userSlug: 'deleted' })).toBeUndefined();
  });

  it('still falls back to the union for a legacy entry with no slug', () => {
    // Entries written before userSlug existed. The union is what they were
    // queued against, so it is the only honest answer available.
    const ctx = ctxWith([anna, petr]);

    expect(accountOf(resolveQueuedExporter(ctx, { exporter: 'garmin' }))).toBe('/tokens/anna');
  });
});
