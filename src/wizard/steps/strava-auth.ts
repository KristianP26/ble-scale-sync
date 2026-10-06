import { dirname, resolve } from 'node:path';
import type { WizardStep, WizardContext } from '../types.js';
import type { ExporterEntry, UserConfig } from '../../config/schema.js';
import { success, error, warn, dim } from '../ui.js';
import { cliCommand } from '../../cli-invocation.js';
import { findTokenDirCollisions } from '../../config/token-dirs.js';
import { resolveEnvReferences } from '../../config/env-refs.js';
import { stravaTokenDir, type StravaExporterEntry } from '../../exporters/strava-select.js';
import { exchangeStravaCode, stravaAuthorizeInstructions } from '../../exporters/strava-auth.js';
import { errMsg } from '../../utils/error.js';

interface StravaOwner {
  /** User name, or 'global' for an entry in global_exporters. */
  owner: string;
  /** The --user argument that names this entry for setup-strava, if any. */
  slug?: string;
  entry: ExporterEntry;
}

function getStravaEntries(ctx: WizardContext): StravaOwner[] {
  const found: StravaOwner[] = [];
  for (const e of ctx.config.global_exporters ?? []) {
    if (e.type === 'strava') found.push({ owner: 'global', entry: e });
  }
  for (const u of (ctx.config.users ?? []) as UserConfig[]) {
    for (const e of u.exporters ?? []) {
      if (e.type === 'strava') found.push({ owner: u.name, slug: u.slug, entry: e });
    }
  }
  return found;
}

/**
 * Strava authorization inside the wizard. It used to collect the client ID and
 * secret and stop there, so the connectivity test that followed reported a
 * missing token file and the first weigh-in failed until the person found
 * `setup-strava` on their own. Garmin has always been authorized here.
 */
export const stravaAuthStep: WizardStep = {
  id: 'strava-auth',
  title: 'Strava Authorization',
  order: 55,

  shouldRun(ctx: WizardContext): boolean {
    return getStravaEntries(ctx).length > 0;
  },

  async run(ctx: WizardContext): Promise<void> {
    const entries = getStravaEntries(ctx);
    const configDir = dirname(resolve(ctx.configPath));
    // setup-strava needs --user once there are several entries, and a global
    // entry has no user to name, so it can only be authorized there alone.
    const laterHint = (slug?: string): string => {
      if (entries.length === 1) return `Run later with: ${cliCommand('setup-strava')}`;
      if (slug) return `Run later with: ${cliCommand('setup-strava', ['--user', slug])}`;
      return (
        `${cliCommand('setup-strava')} can authorize a global Strava exporter only while it ` +
        'is the only Strava exporter in config.yaml.'
      );
    };

    // Two accounts in one token directory: the second authorization would
    // replace the first account's tokens. Same refusal as the Garmin step.
    const collisions = findTokenDirCollisions(
      {
        users: (ctx.config.users ?? []) as Parameters<typeof findTokenDirCollisions>[0]['users'],
        global_exporters: ctx.config.global_exporters,
      },
      configDir,
    ).filter((c) => c.type === 'strava');
    if (collisions.length > 0) {
      for (const c of collisions) console.log(`\n  ${warn(c.message)}`);
      console.log(
        dim(
          `\n  Strava authorization skipped. Fix token_dir, then run ${cliCommand('setup-strava', ['--user', '<name or slug>'])} for each user.\n`,
        ),
      );
      return;
    }

    for (const { owner, slug, entry } of entries) {
      const forWhom = owner === 'global' ? '' : ` for ${owner}`;
      const go = await ctx.prompts.confirm(
        `Authorize Strava${forWhom} now? (needs a browser to approve the app)`,
        { default: true },
      );
      if (!go) {
        console.log(dim(`  Skipped. ${laterHint(slug)}`));
        continue;
      }

      // The config holds the raw YAML so saving keeps ${VAR} references; the
      // exchange needs the values.
      let strava: StravaExporterEntry;
      try {
        strava = resolveEnvReferences(entry) as unknown as StravaExporterEntry;
      } catch (err) {
        console.log(`\n  ${warn(`${errMsg(err)}. Skipping Strava authorization${forWhom}.`)}`);
        console.log(dim(`  Define it in .env. ${laterHint(slug)}`));
        continue;
      }
      if (!strava.client_id || !strava.client_secret) {
        console.log(`\n  ${warn(`Strava client ID or secret missing${forWhom}; skipped.`)}`);
        continue;
      }
      const tokenDir = stravaTokenDir(strava, configDir);

      let done = false;
      while (!done) {
        console.log('');
        for (const line of stravaAuthorizeInstructions(String(strava.client_id))) {
          console.log(`  ${line}`);
        }
        console.log('');
        const code = (
          await ctx.prompts.input('Paste the authorization code (empty to skip):', {
            default: '',
          })
        ).trim();
        if (!code) {
          console.log(dim(`  Skipped. ${laterHint(slug)}`));
          break;
        }
        try {
          const tokenPath = await exchangeStravaCode({
            clientId: String(strava.client_id),
            clientSecret: String(strava.client_secret),
            code,
            tokenDir,
          });
          console.log(
            `\n  ${success(`Strava authorized${forWhom}. Tokens saved to ${tokenPath}`)}`,
          );
          done = true;
        } catch (err) {
          console.log(`\n  ${error(errMsg(err))}`);
          // A code works once, so a retry needs a new one from the same URL.
          const retry = await ctx.prompts.confirm('Try again with a new code?', { default: true });
          if (!retry) {
            console.log(dim(`  ${laterHint(slug)}`));
            break;
          }
        }
      }
    }
  },
};

// Exported for testing
export { getStravaEntries };
