import { dirname, resolve } from 'node:path';
import type { WizardStep, WizardContext } from '../types.js';
import { EXPORTER_SCHEMAS, createExporterFromEntry } from '../../exporters/registry.js';
import type { ExporterEntry, UserConfig } from '../../config/schema.js';
import { resolveEnvReferences } from '../../config/env-refs.js';
import { resolveConfigTokenDirs } from '../../config/token-dirs.js';
import { success, error, info, dim } from '../ui.js';

interface LabelledEntry {
  entry: ExporterEntry;
  /** Who the entry belongs to, shown when more than one entry has its type. */
  owner: string;
}

/**
 * Every exporter entry in the config, global first.
 *
 * This used to keep only the first entry of each type. Since D029 every entry
 * of a type runs (two global webhooks both receive the reading), so a second
 * webhook with a wrong URL went untested here and failed at the first weigh-in.
 */
function getAllExporterEntries(ctx: WizardContext): LabelledEntry[] {
  const entries: LabelledEntry[] = [];
  for (const e of ctx.config.global_exporters ?? []) {
    entries.push({ entry: e, owner: 'global' });
  }
  for (const u of ctx.config.users ?? []) {
    const user = u as UserConfig;
    for (const e of user.exporters ?? []) {
      entries.push({ entry: e as ExporterEntry, owner: user.name });
    }
  }
  return entries;
}

/** "Webhook", or "Webhook (global #2)" / "Strava (Alice)" when the type repeats. */
function labelFor(item: LabelledEntry, all: readonly LabelledEntry[]): string {
  const schema = EXPORTER_SCHEMAS.find((s) => s.name === item.entry.type);
  const displayName = schema?.displayName ?? item.entry.type;
  const sameType = all.filter((x) => x.entry.type === item.entry.type);
  if (sameType.length < 2) return displayName;
  const sameOwner = sameType.filter((x) => x.owner === item.owner);
  const nth = sameOwner.length > 1 ? ` #${sameOwner.indexOf(item) + 1}` : '';
  return `${displayName} (${item.owner}${nth})`;
}

/**
 * The entry as config loading hands it to the exporter: a relative or absent
 * token_dir made absolute next to the config being written. Built from the raw
 * entry, Strava resolved it against the working directory or the package root
 * and reported no token file, while the wizard had written it next to --config.
 */
function forTest(entry: ExporterEntry, ctx: WizardContext): ExporterEntry {
  const configDir = dirname(resolve(ctx.configPath));
  return resolveConfigTokenDirs({ users: [], global_exporters: [entry] }, configDir)
    .global_exporters![0];
}

export const validateStep: WizardStep = {
  id: 'validate',
  title: 'Test Connectivity',
  order: 70,

  async run(ctx: WizardContext): Promise<void> {
    const allEntries = getAllExporterEntries(ctx);

    // Filter out Garmin — it requires Python subprocess, not testable here
    const entries = allEntries.filter((e) => e.entry.type !== 'garmin');

    if (entries.length === 0) {
      console.log('\n  No testable exporters configured — skipping connectivity tests.');
      if (allEntries.length > 0) {
        console.log(
          `  ${info('Garmin connectivity is tested at runtime (requires Python + garminconnect).')}`,
        );
      }
      return;
    }

    const runTests = await ctx.prompts.confirm('Test exporter connectivity?', { default: true });
    if (!runTests) {
      console.log(dim('  Skipped.'));
      return;
    }

    console.log('');

    for (const item of entries) {
      const { entry } = item;
      process.stdout.write(`  Testing ${labelFor(item, entries)}... `);

      try {
        // The wizard holds the raw YAML so that saving keeps ${VAR} references;
        // testing it as-is sent the literal reference as URL or token.
        const exporter = createExporterFromEntry(forTest(resolveEnvReferences(entry), ctx));
        if (exporter.healthcheck) {
          const result = await exporter.healthcheck();
          if (result.success) {
            console.log(success('OK'));
          } else {
            console.log(error(`FAILED: ${result.error ?? 'unknown error'}`));
          }
        } else {
          console.log(dim('SKIPPED (no healthcheck)'));
        }
      } catch (err) {
        console.log(error(`FAILED: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  },
};
