import type { WizardContext } from './types.js';
import { formatEnvLine } from '../config/env-file.js';
import { referencedEnvNames } from '../config/env-refs.js';
import { dim, warn } from './ui.js';

/** A whole-value `${VAR}` reference. */
export const WHOLE_ENV_REF = /^\$\{[^}]+\}$/;

/** `GARMIN_PASSWORD_ALICE` from `['garmin', 'password', 'alice']`. */
export function envName(parts: readonly (string | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p)
    .map((p) => p.toUpperCase().replace(/[^A-Z0-9]+/g, '_'))
    .join('_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The first of NAME, NAME_2, NAME_3 ... that this setup may use for `value`:
 * free, or already holding exactly this value. A name already set to anything
 * else is never reused, because some other entry may read it, and a variable
 * from the real environment would win over .env at load anyway.
 *
 * A name the config already reads as `${NAME}` is not free either when the
 * wizard cannot see its value: it may come from systemd or compose only, and
 * reusing it would hand that entry a different secret.
 */
function freeName(ctx: WizardContext, base: string, value: string): string {
  const referenced = referencedEnvNames(ctx.config);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}_${n}`;
    const pending = ctx.pendingEnv?.get(name);
    const current = pending ?? process.env[name];
    if (current === value) return name;
    if (current === undefined && !referenced.has(name)) return name;
  }
}

/**
 * Offer to keep a secret the person just typed out of config.yaml: it goes to
 * the .env beside the config (written when the config is saved) and the config
 * gets a `${NAME}` reference. Returns what to store in the config.
 *
 * config.yaml is the file people back up and paste into issues; the header the
 * wizard writes has always told them to use references, and until now the
 * wizard itself wrote every password in plaintext. Inside a container the .env
 * would be written to the container's own filesystem and lost, so there the
 * offer defaults to no.
 */
export async function offerEnvSecret(
  ctx: WizardContext,
  value: string,
  nameParts: readonly (string | undefined)[],
): Promise<string> {
  if (!value || WHOLE_ENV_REF.test(value)) return value;

  const base = envName(nameParts);
  if (!base) return value;
  const name = freeName(ctx, base, value);
  if (formatEnvLine(name, value) === undefined) {
    console.log(dim('  This value cannot be written to .env as it is; keeping it in config.yaml.'));
    return value;
  }

  const inContainer = ctx.platform.inContainer === true;
  const store = await ctx.prompts.confirm(
    inContainer
      ? `Store it in .env as \${${name}} instead of config.yaml? (only if .env is mounted into the container)`
      : `Store it in .env as \${${name}} instead of config.yaml? (recommended)`,
    { default: !inContainer },
  );
  if (!store) return value;

  ctx.pendingEnv ??= new Map();
  ctx.pendingEnv.set(name, value);
  // The scan and the connectivity test resolve references before saving.
  process.env[name] = value;
  if (inContainer) {
    console.log(`  ${warn('.env is written inside the container; mount it to keep it.')}`);
  }
  return `\${${name}}`;
}

/**
 * Ask for a secret with a masked prompt. An existing value cannot be shown as
 * a default, so Enter keeps it: retyping would turn a `${VAR}` reference into
 * the plain secret. A new value is offered for .env (offerEnvSecret).
 * Returns undefined for an empty answer with nothing to keep.
 *
 * `trim` is for a value that must not carry spaces (a token pasted with a
 * trailing one); it is trimmed before it is offered for .env, so the file
 * holds what the config would. A password is kept as typed.
 */
export async function promptSecret(
  ctx: WizardContext,
  message: string,
  current: string | null | undefined,
  nameParts: readonly (string | undefined)[],
  opts: { required?: string; trim?: boolean } = {},
): Promise<string | undefined> {
  const hasCurrent = typeof current === 'string' && current !== '';
  const hint = hasCurrent ? ' (press Enter to keep the current value)' : '';
  // Whitespace alone is no secret: a required one is refused, and otherwise it
  // counts as Enter rather than being saved as a password of spaces.
  const typed = await ctx.prompts.password(`${message}${hint}:`, {
    validate: (v) => (v.trim() || hasCurrent || !opts.required ? true : opts.required!),
  });
  const value = opts.trim ? typed.trim() : typed;
  if (!value.trim()) return hasCurrent ? current : undefined;
  return offerEnvSecret(ctx, value, nameParts);
}
