import type { WizardStep, WizardContext, PromptChoice } from '../types.js';
import { EXPORTER_SCHEMAS } from '../../exporters/registry.js';
import type { ExporterSchema, ConfigFieldDef } from '../../interfaces/exporter-schema.js';
import type { ExporterEntry, UserConfig } from '../../config/schema.js';
import { success, dim } from '../ui.js';
import { promptSecret } from '../secrets.js';

/** A whole-value `${VAR}` reference, kept verbatim rather than parsed as a number. */
const ENV_REF = /^\$\{[^}]+\}$/;

/**
 * Ask for one exporter field.
 *
 * `current` is the value already in the config (edit mode, or a step revisited
 * with Back). It becomes the default, and for a password an empty answer keeps
 * it, because a password prompt cannot show a default and the stored value is
 * often a `${VAR}` reference that retyping would replace with the plain secret.
 */
async function promptField(
  ctx: WizardContext,
  field: ConfigFieldDef,
  current?: unknown,
  secretName?: readonly (string | undefined)[],
): Promise<string | number | boolean | undefined> {
  const { prompts } = ctx;
  const hasCurrent = current !== undefined && current !== null && current !== '';

  switch (field.type) {
    case 'string': {
      const offered = hasCurrent ? String(current) : field.default;
      const value = await prompts.input(`${field.label}:`, {
        default: offered !== undefined ? String(offered) : undefined,
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
      const tip =
        !hasCurrent && field.description?.includes('${ENV_VAR}')
          ? ` (tip: use \${ENV_VAR} syntax to reference .env secrets)`
          : '';
      return promptSecret(
        ctx,
        `${field.label}${tip}`,
        hasCurrent ? String(current) : undefined,
        secretName ?? [field.key],
        { required: field.required ? `${field.label} is required` : undefined },
      );
    }

    case 'number': {
      const offered = hasCurrent ? String(current) : field.default;
      const value = await prompts.input(`${field.label}:`, {
        default: offered !== undefined ? String(offered) : undefined,
        validate: (v) => {
          if (!v.trim() && !field.required) return true;
          if (ENV_REF.test(v.trim())) return true;
          const n = Number(v);
          if (!Number.isFinite(n)) return 'Must be a valid number';
          if (field.validate) {
            const err = field.validate(v);
            if (err) return err;
          }
          return true;
        },
      });
      if (ENV_REF.test(value.trim())) return value.trim();
      return value ? Number(value) : field.default;
    }

    case 'boolean': {
      // A ${VAR} cannot be shown as yes/no; asking would replace it.
      if (typeof current === 'string' && ENV_REF.test(current)) {
        console.log(dim(`  ${field.label}: keeping ${current}`));
        return current;
      }
      const currentBool =
        typeof current === 'boolean' ? current : current === 'true' ? true : undefined;
      return prompts.confirm(`${field.label}?`, {
        default: currentBool ?? field.default ?? false,
      });
    }

    case 'select': {
      if (field.choices.length === 0) {
        // Unreachable through the type: `choices` is a non-empty tuple. Kept
        // because this used to return `field.default` - i.e. `undefined` for a
        // REQUIRED field - so a select with nothing to select silently produced
        // no value at all and `required` enforced nothing. If it ever happens
        // again it must be loud.
        throw new Error(
          `Exporter field "${field.key}" is a select with no choices; it cannot be answered.`,
        );
      }
      const choices: PromptChoice<string | number>[] = field.choices.map((c) => ({
        name: c.label,
        value: c.value,
      }));
      // The provider has no select default; Enter picks the first choice, so
      // the current value goes first.
      const at = hasCurrent ? choices.findIndex((c) => String(c.value) === String(current)) : -1;
      if (at > 0) choices.unshift(...choices.splice(at, 1));
      return prompts.select(`${field.label}:`, choices);
    }

    default:
      return undefined;
  }
}

/**
 * Ask for every field of one exporter. With `existing`, each prompt starts from
 * that entry's value and the answers are merged into a copy of it, so keys the
 * schema does not ask about survive.
 */
async function promptExporterFields(
  ctx: WizardContext,
  schema: ExporterSchema,
  defaults: Record<string, string> = {},
  existing?: ExporterEntry,
  owner?: string,
): Promise<Record<string, unknown>> {
  const current = (existing ?? {}) as Record<string, unknown>;
  const config: Record<string, unknown> = { ...current };
  delete config.type;

  console.log(`\n  ${schema.displayName}: ${schema.description}\n`);

  for (const field of schema.fields) {
    const offered = defaults[field.key];
    const value = await promptField(
      ctx,
      offered !== undefined ? ({ ...field, default: offered } as ConfigFieldDef) : field,
      current[field.key],
      [schema.name, field.key, owner],
    );
    if (value !== undefined) {
      config[field.key] = value;
    }
  }

  return config;
}

/**
 * Rebuild one exporter list (`global_exporters` or a user's `exporters`).
 *
 * `managed` are the types this list is edited through here; entries of any
 * other type are left exactly as they are. A managed type that is no longer
 * ticked is removed, a ticked one that exists is kept unless the user asks to
 * change it, and a ticked one that does not exist yet is asked for. This step
 * used to rebuild the list from blank prompts, so an untick removed nothing
 * and every edit meant retyping each secret.
 */
async function editExporterList(
  ctx: WizardContext,
  current: readonly ExporterEntry[] | undefined,
  managed: readonly ExporterSchema[],
  selected: ReadonlySet<string>,
  forWhom: string,
  defaultsFor: (schema: ExporterSchema) => Record<string, string>,
  owner?: string,
): Promise<ExporterEntry[]> {
  const result: ExporterEntry[] = [];
  const handled = new Set<string>();

  for (const entry of current ?? []) {
    const schema = managed.find((s) => s.name === entry.type);
    if (!schema) {
      result.push(entry);
      continue;
    }
    if (!selected.has(entry.type)) continue;
    // A second entry of the same type is not something this step can show;
    // keep it rather than drop configuration the user wrote by hand.
    if (handled.has(entry.type)) {
      result.push(entry);
      continue;
    }
    handled.add(entry.type);
    const change = await ctx.prompts.confirm(
      `Change the ${schema.displayName} settings${forWhom}?`,
      { default: false },
    );
    if (!change) {
      result.push(entry);
      continue;
    }
    const fields = await promptExporterFields(ctx, schema, {}, entry, owner);
    result.push({ type: schema.name, ...fields } as ExporterEntry);
  }

  for (const schema of managed) {
    if (!selected.has(schema.name) || handled.has(schema.name)) continue;
    const configure = await ctx.prompts.confirm(`Configure ${schema.displayName}${forWhom}?`, {
      default: true,
    });
    if (!configure) {
      console.log(dim('  → Skipped.'));
      continue;
    }
    const fields = await promptExporterFields(ctx, schema, defaultsFor(schema), undefined, owner);
    result.push({ type: schema.name, ...fields } as ExporterEntry);
  }

  return result;
}

/**
 * With several users, each one's token directory gets its own default. The
 * schema default is one path, and two accounts in one token directory means
 * the second auth overwrites the first, so both people's readings go to the
 * second account (findTokenDirCollisions rejects that config at load).
 */
function perUserDefaults(
  schema: ExporterSchema,
  user: UserConfig,
  userCount: number,
): Record<string, string> {
  if (userCount < 2) return {};
  const field = schema.fields.find((f) => f.key === 'token_dir');
  if (!field || typeof field.default !== 'string' || !user.slug) return {};
  return { token_dir: `${field.default.replace(/\/+$/, '')}/${user.slug}` };
}

export const exportersStep: WizardStep = {
  id: 'exporters',
  title: 'Export Targets',
  order: 40,

  async run(ctx: WizardContext): Promise<void> {
    // Shared types live in global_exporters, per-user-only types in each
    // user's own list; that is where this step reads and writes them.
    const globalSchemas = EXPORTER_SCHEMAS.filter((s) => s.supportsGlobal);
    const perUserSchemas = EXPORTER_SCHEMAS.filter((s) => s.supportsPerUser && !s.supportsGlobal);
    const users = (ctx.config.users ?? []) as UserConfig[];
    const configured = new Set<string>([
      ...(ctx.config.global_exporters ?? [])
        .filter((e) => globalSchemas.some((s) => s.name === e.type))
        .map((e) => e.type),
      ...users.flatMap((u) =>
        (u.exporters ?? [])
          .filter((e) => perUserSchemas.some((s) => s.name === e.type))
          .map((e) => e.type),
      ),
    ]);

    // Unified checkbox with all exporters. What is configured starts ticked,
    // so Enter keeps it and an untick is how an exporter gets removed.
    const choices = EXPORTER_SCHEMAS.map((s) => {
      const scope = s.supportsGlobal ? '(shared)' : '(per-user)';
      return {
        name: `${s.displayName} ${scope} — ${s.description}`,
        value: s.name as string,
        checked: configured.has(s.name),
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
        break;
      }
      console.log(dim('\n  Pick at least one export target (space to toggle, enter to confirm):'));
      selected = await ctx.prompts.checkbox('Exporters:', choices);
    }

    const selectedSet = new Set<string>(selected);
    if (selected.length > 0) {
      const names = EXPORTER_SCHEMAS.filter((s) => selectedSet.has(s.name)).map(
        (s) => s.displayName,
      );
      console.log(dim(`\n  Selected: ${names.join(', ')}`));
    }

    const globalEntries = await editExporterList(
      ctx,
      ctx.config.global_exporters,
      globalSchemas,
      selectedSet,
      '',
      () => ({}),
    );
    ctx.config.global_exporters = globalEntries.length > 0 ? globalEntries : undefined;

    for (const user of users) {
      const userEntries = await editExporterList(
        ctx,
        user.exporters,
        perUserSchemas,
        selectedSet,
        ` for ${user.name}`,
        (schema) => perUserDefaults(schema, user, users.length),
        // GARMIN_PASSWORD_ALICE in .env once there is more than one person.
        users.length > 1 ? user.slug : undefined,
      );
      user.exporters = userEntries.length > 0 ? userEntries : undefined;
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
