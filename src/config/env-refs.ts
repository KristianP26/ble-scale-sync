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
  if (typeof obj === 'string') {
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
    return obj.map((item) => resolveEnvReferences(item)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvReferences(value);
    }
    return result as T;
  }
  return obj;
}
