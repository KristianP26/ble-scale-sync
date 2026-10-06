import { existsSync, readFileSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import { atomicWrite } from './write.js';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What a single-quoted value cannot carry for every reader of the file: a `'`
 * ends it, a newline ends the line for systemd and compose, python-dotenv
 * (setup_garmin.py) expands `${...}` even inside single quotes and reads `\\`
 * as one backslash.
 */
const UNSAFE_VALUE = /['\r\n]|\$\{|\\\\/;

/**
 * One `KEY='value'` line that reads back as exactly `value`, or undefined when
 * there is none; the caller then keeps the value in config.yaml. Single quotes
 * only: the .env is read by Node's dotenv, python-dotenv, systemd
 * EnvironmentFile and compose env_file, and backticks are dotenv's alone. The
 * round trip through dotenv is checked as well.
 */
export function formatEnvLine(key: string, value: string): string | undefined {
  if (!ENV_KEY.test(key)) return undefined;
  if (UNSAFE_VALUE.test(value)) return undefined;
  const line = `${key}='${value}'`;
  return parseDotenv(line)[key] === value ? line : undefined;
}

/**
 * Append variables to a .env file, creating it when missing. Existing lines are
 * never rewritten: a key that is already there with the same value is skipped,
 * and one with a different value is an error, because the config would then
 * read the file's value, not the one the person typed, and some other part of
 * the config may read it too. The file is written 0600 through atomicWrite,
 * like config.yaml, since it holds secrets.
 *
 * Returns the keys that were written. Throws when a value cannot be written as
 * a line dotenv reads back unchanged (callers check with formatEnvLine first)
 * or a key is already set to something else; nothing is written then.
 */
export function appendEnvFile(path: string, entries: ReadonlyMap<string, string>): string[] {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const present = parseDotenv(raw);

  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (Object.hasOwn(present, key)) {
      if (present[key] === value) continue;
      throw new Error(`${key} is already set to a different value in ${path}`);
    }
    const line = formatEnvLine(key, value);
    if (line === undefined) throw new Error(`Cannot write ${key} to ${path} as a .env line`);
    lines.push(line);
  }
  if (lines.length === 0) return [];

  const sep = raw === '' || raw.endsWith('\n') ? '' : '\n';
  const block = `# Added by ble-scale-sync setup\n${lines.join('\n')}\n`;
  atomicWrite(path, `${raw}${sep}${raw === '' ? '' : '\n'}${block}`);
  return lines.map((l) => l.slice(0, l.indexOf('=')));
}
