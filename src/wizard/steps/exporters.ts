import type { WizardStep, WizardContext, PromptChoice } from '../types.js';
import { EXPORTER_SCHEMAS } from '../../exporters/registry.js';
import type { ExporterSchema, ConfigFieldDef } from '../../interfaces/exporter-schema.js';
import type { ExporterEntry, UserConfig } from '../../config/schema.js';
import { success, dim } from '../ui.js';

async function promptField(
  ctx: WizardContext,
  field: ConfigFieldDef,
): Promise<string | number | boolean | undefined> {
  const { prompts } = ctx;

  switch (field.type) {
    case 'string': {
      const value = await prompts.input(`${field.label}:`, {
        default: field.default !== undefined ? String(field.default) : undefined,
        validate: (v) => {
          if (field.required && !v.trim()) return `${field.label} is required`;
          if (field.validate) {
            const err = field.validate(v);
            if (err) return err;
          }
          return true;
        },
      });
      return value || undefined;
    }

    case 'password': {
      const hint = field.description?.includes('${ENV_VAR}')
        ? ` (tip: use \${ENV_VAR} syntax to reference .env secrets)`
        : '';
      const value = await prompts.password(`${field.label}${hint}:`, {
        validate: (v) => {
          if (field.required && !v.trim()) return `${field.label} is required`;
          return true;
        },
      });
      return value || undefined;
    }

    case 'number': {
      const value = await prompts.input(`${field.label}:`, {
        default: field.default !== undefined ? String(field.default) : undefined,
        validate: (v) => {
          if (!v.trim() && !field.required) return true;
          const n = Number(v);
          if (!Number.isFinite(n)) return 'Must be a valid number';
          if (field.validate) {
            const err = field.validate(v);
            if (err) return err;
          }
          return true;
        },
      });
      return value ? Number(value) : (field.default as number | undefined);
    }

    case 'boolean': {
      return prompts.confirm(`${field.label}?`, {
        default: (field.default as boolean) ?? false,
      });
    }

    case 'select': {
      if (!field.choices || field.choices.length === 0) return field.default;
      const choices: PromptChoice<string | number>[] = field.choices.map((c) => ({
        name: c.label,
        value: c.value,
      }));
      return prompts.select(`${field.label}:`, choices);
    }

    default:
      return undefined;
  }
}

async function promptExporterFields(
  ctx: WizardContext,
  schema: ExporterSchema,
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};

  console.log(`\n  ${schema.displayName}: ${schema.description}\n`);

  for (const field of schema.fields) {
    const value = await promptField(ctx, field);
    if (value !== undefined) {
      config[field.key] = value;
    }
  }

  return config;
}

export const exportersStep: WizardStep = {
  id: 'exporters',
  title: 'Export Targets',
  order: 40,

  async run(ctx: WizardContext): Promise<void> {
    // Unified checkbox with all exporters
    const choices = EXPORTER_SCHEMAS.map((s) => {
      const scope = s.supportsGlobal ? '(shared)' : '(per-user)';
      return {
        name: `${s.displayName} ${scope} — ${s.description}`,
        value: s.name,
      };
    });

    console.log('\nSelect export targets:\n');
    let selected = await ctx.prompts.checkbox('Exporters:', choices);

    while (selected.length === 0) {
      const proceedEmpty = await ctx.prompts.confirm(
        'No exporters selected. Measurements will not be sent anywhere. Continue without exporters?',
        { default: false },
      );
      if (proceedEmpty) {
        console.log(dim('\n  No exporters selected — measurements will not be exported.'));
        return;
      }
      console.log(dim('\n  Pick at least one export target (space to toggle, enter to confirm):'));
      selected = await ctx.prompts.checkbox('Exporters:', choices);
    }

    const selectedSchemas = selected.map((n) => EXPORTER_SCHEMAS.find((s) => s.name === n)!);
    const names = selectedSchemas.map((s) => s.displayName);
    console.log(dim(`\n  Selected: ${names.join(', ')}`));

    // Global exporters (supportsGlobal)
    const globalSchemas = selectedSchemas.filter((s) => s.supportsGlobal);
    if (globalSchemas.length > 0) {
      const globalEntries: ExporterEntry[] = [];
      for (const schema of globalSchemas) {
        const configure = await ctx.prompts.confirm(`Configure ${schema.displayName}?`, {
          default: true,
        });
        if (!configure) {
          console.log(dim('  \u2192 Skipped.'));
          continue;
        }
        const fields = await promptExporterFields(ctx, schema);
        globalEntries.push({ type: schema.name, ...fields } as ExporterEntry);
      }
      ctx.config.global_exporters = globalEntries.length > 0 ? globalEntries : undefined;
    }

    // Per-user exporters (supportsPerUser && !supportsGlobal)
    const perUserSchemas = selectedSchemas.filter((s) => s.supportsPerUser && !s.supportsGlobal);
    const users = ctx.config.users;
    if (users && users.length > 0 && perUserSchemas.length > 0) {
      for (const user of users) {
        const userEntries: ExporterEntry[] = [];
        for (const schema of perUserSchemas) {
          const configure = await ctx.prompts.confirm(
            `Configure ${schema.displayName} for ${user.name}?`,
            { default: true },
          );
          if (!configure) {
            console.log(dim('  \u2192 Skipped.'));
            continue;
          }
          const fields = await promptExporterFields(ctx, schema);
          userEntries.push({ type: schema.name, ...fields } as ExporterEntry);
        }
        (user as UserConfig).exporters = userEntries.length > 0 ? userEntries : undefined;
      }
    }

    // Summary
    const globalCount = ctx.config.global_exporters?.length ?? 0;
    const perUserCount = (ctx.config.users ?? []).reduce(
      (sum, u) => sum + ((u as UserConfig).exporters?.length ?? 0),
      0,
    );
    console.log(
      `\n  ${success(`Exporters configured: ${globalCount} global, ${perUserCount} per-user`)}`,
    );
  },
};

// Exported for testing
export { promptField, promptExporterFields };
