import type { ScaleAdapter } from '../interfaces/scale-adapter.js';

/**
 * Manual adapter override (`ble.force_scale_adapter`).
 *
 * Auto-detection reads an advertisement and, for a fleet of rebadged OEM
 * hardware sharing one vendor service, it can pick the wrong protocol adapter.
 * Every such report (#235, #318, #319) ends the same way: the user waits for a
 * release to fix a matcher, with no way to say "I know what this scale is".
 * This is that escape hatch.
 *
 * Scope is deliberately narrow. The override replaces the whole registry with
 * one adapter that claims every device it is shown, so it is only sound when
 * the transport already knows which device it is talking to. `ble.scale_mac` is
 * therefore required alongside it (enforced by the config schema): without a
 * target MAC, "matches everything" would mean connecting to the first phone or
 * television in range. `npm run scan` keeps the untouched registry, so device
 * discovery still reports what auto-detection would have chosen.
 */

/** Thrown when the configured name is not in the registry. */
export class UnknownAdapterError extends Error {
  constructor(requested: string, available: string[]) {
    super(
      `ble.force_scale_adapter: no adapter named "${requested}". Available adapters: ` +
        available.join(', '),
    );
    this.name = 'UnknownAdapterError';
  }
}

/**
 * Return the registry to use, given an optional forced adapter name.
 *
 * The forced adapter is wrapped rather than mutated: the registry holds shared
 * singletons, so flipping `matches()` on the instance itself would leak into
 * every other consumer, tests included. The wrapper forwards every other
 * property to the real adapter with `this` still bound to it, so per-session
 * state keeps working.
 */
export function applyForcedAdapter(
  registry: readonly ScaleAdapter[],
  forcedName: string | undefined | null,
): ScaleAdapter[] {
  if (!forcedName) return [...registry];
  const wanted = forcedName.trim().toLowerCase();
  const found = registry.find((a) => a.name.toLowerCase() === wanted);
  if (!found) {
    throw new UnknownAdapterError(
      forcedName,
      registry.map((a) => a.name),
    );
  }
  return [forceAdapter(found)];
}

/** Wrap an adapter so it claims every device it is offered. */
function forceAdapter(adapter: ScaleAdapter): ScaleAdapter {
  return new Proxy(adapter, {
    get(target, prop, _receiver) {
      if (prop === 'matches') return () => true;
      // Marks this adapter as one that did NOT earn its device by matching it.
      // `hasParseableBroadcastSource` uses it to require a real parse before
      // gating a dual-mode adapter into "wait for a broadcast", which would
      // otherwise starve the GATT path forever.
      if (prop === 'isForcedOverride') return true;
      // Bind to the real adapter, never to the proxy: adapters keep per-session
      // state in private fields and `this` must resolve to the instance holding
      // them.
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
