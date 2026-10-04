import { existsSync, readFileSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';

// --- .env loading ---

/** Per .env path: the keys this module put into process.env, and the value it put there. */
const ownedEnvKeys = new Map<string, Map<string, string>>();

/**
 * Load a .env file into process.env, and on a later call bring process.env up
 * to date with the file again.
 *
 * `dotenv.config()` never overwrites a key that is already set, so on a config
 * reload a token rotated in .env kept its old value and a deleted line kept
 * resolving (G-20). This tracks the keys it set itself and updates or removes
 * only those. A variable from the real environment (Docker `-e`, systemd
 * `Environment=`) still wins over .env, as it does on the first load, and a
 * key something else has rewritten since is left alone. Quiet, unlike
 * dotenv 17's `config()`, which prints a banner on every call.
 */
export function loadEnvFile(path: string): void {
  // A missing .env is not an error, it is optional; it also means every key
  // it set before is gone. An unreadable one changes nothing.
  let parsed: Record<string, string> = {};
  if (existsSync(path)) {
    try {
      parsed = parseDotenv(readFileSync(path));
    } catch {
      return;
    }
  }

  let owned = ownedEnvKeys.get(path);
  if (!owned) {
    owned = new Map();
    ownedEnvKeys.set(path, owned);
  }

  for (const [key, value] of [...owned]) {
    if (key in parsed) continue;
    if (process.env[key] === value) delete process.env[key];
    owned.delete(key);
  }

  for (const [key, value] of Object.entries(parsed)) {
    const current = process.env[key];
    const ours = owned.has(key) && current === owned.get(key);
    if (current !== undefined && !ours) continue;
    process.env[key] = value;
    owned.set(key, value);
  }
}

/**
 * Whether `process.env[name]` currently holds a value that {@link loadEnvFile}
 * put there from a .env file, as opposed to one from the real environment
 * (Docker `-e`, compose `environment:`, systemd `Environment=`).
 *
 * A key the loader set but something else has rewritten since counts as the
 * real environment, the same rule loadEnvFile applies on a reload. On Windows
 * process.env is case-insensitive, so a .env line `scale_mac=...` lands on
 * SCALE_MAC there and is matched the same way.
 */
export function isFromEnvFile(name: string): boolean {
  const current = process.env[name];
  if (current === undefined) return false;
  const fold = process.platform === 'win32';
  for (const owned of ownedEnvKeys.values()) {
    for (const [key, value] of owned) {
      const sameKey = key === name || (fold && key.toUpperCase() === name.toUpperCase());
      if (sameKey && value === current) return true;
    }
  }
  return false;
}

// --- Env reference resolution ---

const ENV_REF_REGEX = /\$(\$?)\{([^}]+)}/g;

/**
 * Deep-walk a parsed YAML object and replace `${VAR}` references with
 * `process.env[VAR]`. Throws if a referenced variable is not defined.
 *
 * `$${...}` is the escape for a literal `${...}`, so a password or a URL
 * template containing `${` can be written at all (G-24).
 */
export function resolveEnvReferences<T>(obj: T): T {
  return resolveAt(obj, [], null);
}

/** A config path, as zod reports it in `issue.path`. */
export type ConfigPath = ReadonlyArray<PropertyKey>;

/** Key for a {@link ConfigPath}, stable between the walk here and a zod issue. */
export function configPathKey(path: ConfigPath): string {
  return JSON.stringify(path.map((p) => (typeof p === 'number' ? p : String(p))));
}

/**
 * {@link resolveEnvReferences}, plus the paths whose WHOLE value was a single
 * `${VAR}` reference, mapped to the variable name.
 *
 * Only those values may be converted to a number or a boolean afterwards
 * (`safeParseWithEnvRefs`): `port: ${PORT}` is the user asking for the
 * variable's value as the port, while `name: "v${N}"` or a quoted literal
 * `"6053"` is a string the user typed.
 */
export function resolveEnvReferencesTracked<T>(obj: T): {
  value: T;
  wholeRefs: Map<string, string>;
} {
  const wholeRefs = new Map<string, string>();
  return { value: resolveAt(obj, [], wholeRefs), wholeRefs };
}

const WHOLE_REF_REGEX = /^\$\{([^}]+)}$/;

function resolveAt<T>(obj: T, path: PropertyKey[], wholeRefs: Map<string, string> | null): T {
  if (typeof obj === 'string') {
    const whole = WHOLE_REF_REGEX.exec(obj);
    if (whole && wholeRefs) wholeRefs.set(configPathKey(path), whole[1]);
    return obj.replace(ENV_REF_REGEX, (match, escaped: string, varName: string) => {
      if (escaped) return match.slice(1);
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(
          `Environment variable '${varName}' referenced in config.yaml is not defined`,
        );
      }
      return value;
    }) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item, i) => resolveAt(item, [...path, i], wholeRefs)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveAt(value, [...path, key], wholeRefs);
    }
    return result as T;
  }
  return obj;
}

// --- Boolean and number words ---

/**
 * The boolean spellings every environment-sourced value accepts: the env
 * overrides (DRY_RUN, CONTINUOUS_MODE, ...) and a `${VAR}` reference in a
 * boolean config field.
 */
export const BOOL_TRUE_WORDS: ReadonlySet<string> = new Set(['true', 'yes', 'on', '1']);
export const BOOL_FALSE_WORDS: ReadonlySet<string> = new Set(['false', 'no', 'off', '0']);
export const BOOL_WORDS_HINT = 'true/false, yes/no, on/off, 1/0';

/** `true`/`false` for a recognised boolean word (any case, trimmed), else undefined. */
export function parseBoolWord(raw: string): boolean | undefined {
  const word = raw.trim().toLowerCase();
  if (BOOL_TRUE_WORDS.has(word)) return true;
  if (BOOL_FALSE_WORDS.has(word)) return false;
  return undefined;
}

const DECIMAL_REGEX = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * A plain decimal number (trimmed), else undefined. Stricter than `Number()`,
 * which reads an empty string as 0 and accepts hex and `Infinity`.
 */
export function parseDecimal(raw: string): number | undefined {
  const text = raw.trim();
  if (!DECIMAL_REGEX.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}
