import type { WizardStep, WizardContext } from '../types.js';
import type { RuntimeConfig } from '../../config/schema.js';
import { dim } from '../ui.js';

/**
 * Values for the runtime keys this step never asks about. Written on a fresh
 * setup so the file shows them; an existing config keeps its own values.
 */
const UNASKED_DEFAULTS = {
  watchdog_max_consecutive_failures: 10,
  watch_config: true,
  // Not prompted: it only matters in continuous mode, the default is right
  // for every install, and one more question here buys nothing (#398).
  idle_rescan_delay: 5,
  // Not prompted: the default is right for every install and one more
  // question buys nothing (#412).
  retry_failed_exports: true,
} satisfies Partial<RuntimeConfig>;

export const runtimeStep: WizardStep = {
  id: 'runtime',
  title: 'Runtime Settings',
  order: 60,

  async run(ctx: WizardContext): Promise<void> {
    // Prompts start from the current values and the result is merged into
    // them. The step used to replace the whole object with hard-coded values,
    // so an edit of dry_run alone silently turned retry_failed_exports back on
    // after the user had switched it off (ADR D014) and reset the watchdog.
    const current: Partial<RuntimeConfig> = ctx.config.runtime ?? {};

    const continuous_mode = await ctx.prompts.confirm(
      'Enable continuous mode? (keep running and auto-reconnect after each reading)',
      { default: current.continuous_mode ?? false },
    );

    let scan_cooldown = current.scan_cooldown ?? 30;
    if (continuous_mode) {
      const cooldownStr = await ctx.prompts.input(
        'Scan cooldown between readings (seconds, 5-3600). Note: after a successful read the app waits at least 25 s on the native BLE handler to avoid reconnecting while the scale is still advertising:',
        {
          default: String(scan_cooldown),
          validate: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Must be a whole number';
            if (n < 5 || n > 3600) return 'Must be between 5 and 3600';
            return true;
          },
        },
      );
      scan_cooldown = Number(cooldownStr);
    }

    const dry_run = await ctx.prompts.confirm('Enable dry run? (read scale but skip all exports)', {
      default: current.dry_run ?? false,
    });

    const debug = await ctx.prompts.confirm('Enable debug logging? (verbose BLE output)', {
      default: current.debug ?? false,
    });

    ctx.config.runtime = {
      ...UNASKED_DEFAULTS,
      ...current,
      continuous_mode,
      scan_cooldown,
      dry_run,
      debug,
    };

    console.log(
      dim(
        `\n  Continuous: ${continuous_mode}, Cooldown: ${scan_cooldown}s, Dry run: ${dry_run}, Debug: ${debug}`,
      ),
    );
  },
};
