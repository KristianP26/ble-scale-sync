import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { WizardStep, WizardContext } from '../types.js';
import { banner, dim, warn } from '../ui.js';
import { checkForUpdate } from '../../update-check.js';
import { configureUpdateState } from '../../update-state.js';

export const welcomeStep: WizardStep = {
  id: 'welcome',
  title: 'Welcome',
  order: 10,

  async run(ctx: WizardContext): Promise<void> {
    banner();

    // Respect update_check: false from existing config
    let updateCheckEnabled = true;
    const exists = existsSync(ctx.configPath);
    // Why an existing file cannot be edited, or undefined when it can.
    let unreadable: string | undefined;
    if (exists) {
      try {
        const raw = readFileSync(ctx.configPath, 'utf8');
        const parsed: unknown = parseYaml(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          unreadable = 'it does not contain a YAML mapping';
        } else if ((parsed as { update_check?: unknown }).update_check === false) {
          updateCheckEnabled = false;
        }
      } catch (err) {
        unreadable = err instanceof Error ? err.message.split('\n')[0] : String(err);
      }
    }

    // Share the app's persisted cooldown: running the wizard repeatedly must
    // not send an extra check per run.
    configureUpdateState(ctx.configPath);

    // Show update notice if a newer version is available
    const update = await checkForUpdate(updateCheckEnabled);
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

    // An unparseable file used to be offered for editing as if it were empty,
    // so "Edit existing configuration" quietly started from nothing (G-23).
    if (exists && unreadable !== undefined) {
      console.log(
        warn(`The existing config.yaml cannot be edited: ${unreadable}.`) +
          '\n    Setting up a new one; the old file is kept as config.yaml.bak when you save.\n',
      );
      return;
    }

    // Check for existing config
    if (exists) {
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
