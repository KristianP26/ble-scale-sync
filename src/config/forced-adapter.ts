import type { AppConfig } from './schema.js';
import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { applyForcedAdapter, UnknownAdapterError } from '../scales/force.js';

/**
 * Why `ble.force_scale_adapter` cannot run with this config, or null when it
 * can (or is not set). `config` must be the loaded config, env overrides
 * applied: SCALE_MAC is the documented Docker way to supply the MAC, which is
 * why the schema cannot check this pairing (see the note above ScaleSchema).
 *
 * `start` enforces both conditions and exits 1; `validate` used to skip them
 * and report "Config valid" for a config that `start` then refused.
 */
export function forcedAdapterProblem(
  config: AppConfig,
  registry: readonly ScaleAdapter[],
): string | null {
  const forcedName = config.ble?.force_scale_adapter ?? undefined;
  if (!forcedName) return null;
  if (!config.ble?.scale_mac) {
    return (
      'ble.force_scale_adapter requires a scale MAC (ble.scale_mac or the SCALE_MAC ' +
      'environment variable): the forced adapter matches every device it is shown, ' +
      'so the MAC is what keeps it pointed at your scale.'
    );
  }
  try {
    applyForcedAdapter(registry, forcedName);
  } catch (err) {
    if (err instanceof UnknownAdapterError) return err.message;
    throw err;
  }
  return null;
}
