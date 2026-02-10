import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';
import type { Gender, UserProfile } from './interfaces/scale-adapter.js';

const __dirname: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(__dirname, '..');

export type WeightUnit = 'kg' | 'lbs';

export interface Config {
  profile: UserProfile;
  scaleMac?: string;
  weightUnit: WeightUnit;
  dryRun: boolean;
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
/** CoreBluetooth UUID format used on macOS (e.g. 12345678-1234-1234-1234-123456789ABC). */
const CB_UUID_REGEX =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export function loadConfig(): Config {
  config({ path: join(ROOT, '.env') });

  const weightUnit = parseWeightUnit(process.env.WEIGHT_UNIT);
  const heightUnit = parseHeightUnit(process.env.HEIGHT_UNIT);

  const heightRange = heightUnit === 'in' ? { min: 20, max: 100 } : { min: 50, max: 250 };
  let height = parseNumber(
    'USER_HEIGHT',
    requireEnv('USER_HEIGHT'),
    heightRange.min,
    heightRange.max,
  );
  if (heightUnit === 'in') {
    height = height * 2.54;
  }

  const birthDate = parseBirthDate(requireEnv('USER_BIRTH_DATE'));
  const age = computeAge(birthDate);
  if (age < 5) {
    fail(`USER_BIRTH_DATE results in age ${age}, minimum age is 5`);
  }

  const gender = parseGender(requireEnv('USER_GENDER'));
  const isAthlete = parseBoolean('USER_IS_ATHLETE', requireEnv('USER_IS_ATHLETE'));

  let scaleMac: string | undefined;
  const rawMac = process.env.SCALE_MAC;
  if (rawMac) {
    if (!MAC_REGEX.test(rawMac) && !CB_UUID_REGEX.test(rawMac)) {
      fail(
        `SCALE_MAC must be a MAC address (XX:XX:XX:XX:XX:XX) ` +
          `or CoreBluetooth UUID (macOS), got '${rawMac}'`,
      );
    }
    scaleMac = rawMac;
  }

  const dryRun = process.env.DRY_RUN ? parseBoolean('DRY_RUN', process.env.DRY_RUN) : false;

  return {
    profile: { height, age, gender, isAthlete },
    scaleMac,
    weightUnit,
    dryRun,
  };
}

function parseBirthDate(raw: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) {
    fail(`USER_BIRTH_DATE must be in YYYY-MM-DD format, got '${raw}'`);
  }
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    fail(`USER_BIRTH_DATE is not a valid date: '${raw}'`);
  }
  if (date > new Date()) {
    fail('USER_BIRTH_DATE cannot be in the future');
  }
  return date;
}

function computeAge(birth: Date): number {
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

function parseWeightUnit(raw: string | undefined): WeightUnit {
  if (!raw || raw === '') return 'kg';
  const lower = raw.toLowerCase();
  if (lower === 'kg' || lower === 'lbs') return lower;
  fail(`WEIGHT_UNIT must be 'kg' or 'lbs', got '${raw}'`);
}

function parseHeightUnit(raw: string | undefined): 'cm' | 'in' {
  if (!raw || raw === '') return 'cm';
  const lower = raw.toLowerCase();
  if (lower === 'cm' || lower === 'in') return lower;
  fail(`HEIGHT_UNIT must be 'cm' or 'in', got '${raw}'`);
}
