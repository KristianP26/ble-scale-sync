import type { WizardStep, WizardContext } from '../types.js';
import { RuntimeSchema, type RuntimeConfig } from '../../config/schema.js';
import { dim } from '../ui.js';

const DEFAULTS = RuntimeSchema.parse({});

/**
 * The schema defaults of the runtime keys this step never asks about. Written
 * on a fresh setup so the file shows them; an existing config keeps its own
 * values. Not prompted because the default is right for nearly every install
 * (#398, #412, #475).
 */
const {
  continuous_mode: _continuous,
  scan_cooldown: _cooldown,
  dry_run: _dryRun,
  debug: _debug,
  ...UNASKED_DEFAULTS
} = DEFAULTS;

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
      { default: current.continuous_mode ?? DEFAULTS.continuous_mode },
    );

    let scan_cooldown = current.scan_cooldown ?? DEFAULTS.scan_cooldown;
    if (continuous_mode) {
      const cooldownStr = await ctx.prompts.input(
        'Scan cooldown after a reading (seconds, 5-3600). Built-in Bluetooth only: mqtt-proxy, esphome-proxy and ha-bluetooth listen all the time and ignore it. On Linux the app waits at least 25 s after a reading regardless:',
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
      default: current.dry_run ?? DEFAULTS.dry_run,
    });

    const debug = await ctx.prompts.confirm('Enable debug logging? (verbose BLE output)', {
      default: current.debug ?? DEFAULTS.debug,
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
