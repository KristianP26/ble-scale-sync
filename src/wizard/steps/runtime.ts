import type { WizardStep, WizardContext } from '../types.js';
import { dim } from '../ui.js';

export const runtimeStep: WizardStep = {
  id: 'runtime',
  title: 'Runtime Settings',
  order: 60,

  async run(ctx: WizardContext): Promise<void> {
    const continuous_mode = await ctx.prompts.confirm(
      'Enable continuous mode? (keep running and auto-reconnect after each reading)',
      { default: false },
    );

    let scan_cooldown = 30;
    if (continuous_mode) {
      const cooldownStr = await ctx.prompts.input(
        'Scan cooldown between readings (seconds, 5-3600):',
        {
          default: '30',
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
      default: false,
    });

    const debug = await ctx.prompts.confirm('Enable debug logging? (verbose BLE output)', {
      default: false,
    });

    ctx.config.runtime = {
      continuous_mode,
      scan_cooldown,
      dry_run,
      debug,
      watchdog_max_consecutive_failures: 10,
    };

    console.log(
      dim(
        `\n  Continuous: ${continuous_mode}, Cooldown: ${scan_cooldown}s, Dry run: ${dry_run}, Debug: ${debug}`,
      ),
    );
  },
};
