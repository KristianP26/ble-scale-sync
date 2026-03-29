import { existsSync } from 'node:fs';
import type { WizardStep, WizardContext } from '../types.js';
import { banner, dim, warn } from '../ui.js';
import { checkForUpdate } from '../../update-check.js';

export const welcomeStep: WizardStep = {
  id: 'welcome',
  title: 'Welcome',
  order: 10,

  async run(ctx: WizardContext): Promise<void> {
    banner();

    // Show update notice if a newer version is available
    const update = await checkForUpdate();
    if (update) {
      console.log(
        warn(`Update available: v${update.latest} (current: v${update.current})`) +
          '\n    https://blescalesync.dev/changelog\n',
      );
    }

    console.log(dim('  Before you start, make sure you have:'));
    console.log(dim('    - Your scale nearby (powered on)'));
    console.log(dim('    - Garmin credentials (if using Garmin export)'));
    console.log(dim('    - Strava API app created (if using Strava export)'));
    console.log(dim('    - MQTT/InfluxDB/Webhook/Ntfy details (if using those exporters)'));
    console.log(dim('    - File path for CSV/JSONL output (if using File export)\n'));

    // Check for existing config
    if (existsSync(ctx.configPath)) {
      const action = await ctx.prompts.select(
        'An existing config.yaml was found. What would you like to do?',
        [
          { name: 'Edit existing configuration', value: 'edit' },
          { name: 'Start fresh (overwrite)', value: 'fresh' },
        ],
      );

      if (action === 'edit') {
        ctx.isEditMode = true;
        return;
      }
    }
  },
};
