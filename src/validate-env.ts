import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import type { Gender, UserProfile } from './interfaces/scale-adapter.js';

const __dirname: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(__dirname, '..');

export interface Config {
  profile: UserProfile;
  scaleMac?: string;
}

function fail(msg: string): never {
  console.error(`[Config] ${msg}`);
  process.exit(1);
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    fail(`Missing required env var: ${key}. Check your .env file.`);
  }
  return val;
}

function parseNumber(key: string, raw: string, min: number, max: number): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    fail(`${key} must be a number, got '${raw}'`);
  }
  if (num < min || num > max) {
    fail(`${key} must be between ${min} and ${max}, got ${num}`);
  }
  return num;
}

function parseGender(raw: string): Gender {
  const lower = raw.toLowerCase();
  if (lower === 'male' || lower === 'female') return lower;
  fail(`USER_GENDER must be 'male' or 'female', got '${raw}'`);
}

function parseBoolean(key: string, raw: string): boolean {
  const lower = raw.toLowerCase();
  if (['true', 'yes', '1'].includes(lower)) return true;
  if (['false', 'no', '0'].includes(lower)) return false;
  fail(`${key} must be true/false/yes/no/1/0, got '${raw}'`);
}

const MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

export function loadConfig(): Config {
  config({ path: join(ROOT, '.env') });

  const height = parseNumber('USER_HEIGHT', requireEnv('USER_HEIGHT'), 50, 250);

  const currentYear = new Date().getFullYear();
  const birthYear = parseNumber(
    'USER_BIRTH_YEAR',
    requireEnv('USER_BIRTH_YEAR'),
    1900,
    currentYear,
  );
  const age = currentYear - birthYear;
  if (age < 5) {
    fail(`USER_BIRTH_YEAR ${birthYear} results in age ${age}, minimum age is 5`);
  }

  const gender = parseGender(requireEnv('USER_GENDER'));
  const isAthlete = parseBoolean('USER_IS_ATHLETE', requireEnv('USER_IS_ATHLETE'));

  let scaleMac: string | undefined;
  const rawMac = process.env.SCALE_MAC;
  if (rawMac) {
    if (!MAC_REGEX.test(rawMac)) {
      fail(`SCALE_MAC must be in format XX:XX:XX:XX:XX:XX, got '${rawMac}'`);
    }
    scaleMac = rawMac;
  }

  return {
    profile: { height, age, gender, isAthlete },
    scaleMac,
  };
}
