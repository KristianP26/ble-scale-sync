import type { WizardStep, WizardContext } from '../types.js';
import { EXPORTER_SCHEMAS, createExporterFromEntry } from '../../exporters/registry.js';
import type { ExporterEntry, UserConfig } from '../../config/schema.js';
import { resolveEnvReferences } from '../../config/env-refs.js';
import { success, error, info, dim } from '../ui.js';

function getAllExporterEntries(ctx: WizardContext): ExporterEntry[] {
  const entries: ExporterEntry[] = [];
  const seenTypes = new Set<string>();

  for (const e of ctx.config.global_exporters ?? []) {
    if (!seenTypes.has(e.type)) {
      entries.push(e);
      seenTypes.add(e.type);
    }
  }
  for (const u of ctx.config.users ?? []) {
    for (const e of (u as UserConfig).exporters ?? []) {
      const entry = e as ExporterEntry;
      if (!seenTypes.has(entry.type)) {
        entries.push(entry);
        seenTypes.add(entry.type);
      }
    }
  }
  return entries;
}

export const validateStep: WizardStep = {
  id: 'validate',
  title: 'Test Connectivity',
  order: 70,

  async run(ctx: WizardContext): Promise<void> {
    const allEntries = getAllExporterEntries(ctx);

    // Filter out Garmin — it requires Python subprocess, not testable here
    const entries = allEntries.filter((e) => e.type !== 'garmin');

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

    for (const entry of entries) {
      const schema = EXPORTER_SCHEMAS.find((s) => s.name === entry.type);
      const displayName = schema?.displayName ?? entry.type;

      process.stdout.write(`  Testing ${displayName}... `);

      try {
        // The wizard holds the raw YAML so that saving keeps ${VAR} references;
        // testing it as-is sent the literal reference as URL or token.
        const exporter = createExporterFromEntry(resolveEnvReferences(entry));
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
