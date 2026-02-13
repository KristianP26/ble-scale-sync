import { describe, it, expect } from 'vitest';
import {
  resolveUserProfile,
  resolveRuntimeConfig,
  resolveExportersForUser,
  resolveForSingleUser,
} from '../../src/config/resolve.js';
import type { AppConfig, UserConfig, ScaleConfig } from '../../src/config/schema.js';

// --- Test data ---

const USER: UserConfig = {
  name: 'Test',
  slug: 'test',
  height: 183,
  birth_date: '1990-06-15',
  gender: 'male',
  is_athlete: true,
  weight_range: { min: 70, max: 100 },
  last_known_weight: null,
};

const SCALE_CM: ScaleConfig = { weight_unit: 'kg', height_unit: 'cm' };
const SCALE_IN: ScaleConfig = { weight_unit: 'lbs', height_unit: 'in' };

const BASE_CONFIG: AppConfig = {
  version: 1,
  scale: SCALE_CM,
  unknown_user: 'nearest',
  users: [USER],
  global_exporters: [{ type: 'garmin' }, { type: 'mqtt', broker_url: 'mqtt://host' }],
  runtime: {
    continuous_mode: true,
    scan_cooldown: 60,
    dry_run: false,
    debug: false,
  },
  ble: {
    scale_mac: 'FF:03:00:13:A1:04',
  },
};

// --- resolveUserProfile ---

describe('resolveUserProfile', () => {
  it('computes age from birth_date', () => {
    const profile = resolveUserProfile(USER, SCALE_CM);
    const today = new Date();
    const expectedAge =
      today.getFullYear() - 1990 - (today < new Date(today.getFullYear(), 5, 15) ? 1 : 0);
    expect(profile.age).toBe(expectedAge);
  });

  it('preserves height in cm when height_unit is cm', () => {
    const profile = resolveUserProfile(USER, SCALE_CM);
    expect(profile.height).toBe(183);
  });

  it('converts height from inches to cm when height_unit is in', () => {
    const userInches = { ...USER, height: 72 };
    const profile = resolveUserProfile(userInches, SCALE_IN);
    expect(profile.height).toBeCloseTo(72 * 2.54, 2);
  });

  it('maps gender correctly', () => {
    const profile = resolveUserProfile(USER, SCALE_CM);
    expect(profile.gender).toBe('male');
  });

  it('maps isAthlete correctly', () => {
    const profile = resolveUserProfile(USER, SCALE_CM);
    expect(profile.isAthlete).toBe(true);
  });

  it('handles female non-athlete', () => {
    const femaleUser = { ...USER, gender: 'female' as const, is_athlete: false };
    const profile = resolveUserProfile(femaleUser, SCALE_CM);
    expect(profile.gender).toBe('female');
    expect(profile.isAthlete).toBe(false);
  });

  it('computes correct age for birthday not yet passed this year', () => {
    const today = new Date();
    // Set birth_date to Dec 31 of last year's age computation
    const futureBirthday = `${today.getFullYear() - 30}-12-31`;
    const user = { ...USER, birth_date: futureBirthday };
    const profile = resolveUserProfile(user, SCALE_CM);
    // If Dec 31 hasn't happened yet this year, age should be 29
    if (today.getMonth() < 11 || (today.getMonth() === 11 && today.getDate() < 31)) {
      expect(profile.age).toBe(29);
    } else {
      expect(profile.age).toBe(30);
    }
  });
});

// --- resolveRuntimeConfig ---

describe('resolveRuntimeConfig', () => {
  it('extracts profile from first user', () => {
    const result = resolveRuntimeConfig(BASE_CONFIG);
    expect(result.profile.height).toBe(183);
    expect(result.profile.gender).toBe('male');
  });

  it('extracts scaleMac from ble config', () => {
    const result = resolveRuntimeConfig(BASE_CONFIG);
    expect(result.scaleMac).toBe('FF:03:00:13:A1:04');
  });

  it('returns undefined scaleMac when not configured', () => {
    const config = { ...BASE_CONFIG, ble: undefined };
    const result = resolveRuntimeConfig(config);
    expect(result.scaleMac).toBeUndefined();
  });

  it('extracts weight unit', () => {
    const result = resolveRuntimeConfig(BASE_CONFIG);
    expect(result.weightUnit).toBe('kg');
  });

  it('extracts runtime flags', () => {
    const result = resolveRuntimeConfig(BASE_CONFIG);
    expect(result.continuousMode).toBe(true);
    expect(result.scanCooldownSec).toBe(60);
    expect(result.dryRun).toBe(false);
  });

  it('defaults runtime flags when runtime is undefined', () => {
    const config = { ...BASE_CONFIG, runtime: undefined };
    const result = resolveRuntimeConfig(config);
    expect(result.continuousMode).toBe(false);
    expect(result.scanCooldownSec).toBe(30);
    expect(result.dryRun).toBe(false);
  });
});

// --- resolveExportersForUser ---

describe('resolveExportersForUser', () => {
  it('returns global exporters when user has none', () => {
    const entries = resolveExportersForUser(BASE_CONFIG, USER);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('garmin');
    expect(entries[1].type).toBe('mqtt');
  });

  it('returns user exporters first, then global', () => {
    const userWithExporters = {
      ...USER,
      exporters: [{ type: 'webhook', url: 'http://test' }],
    };
    const entries = resolveExportersForUser(BASE_CONFIG, userWithExporters);
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe('webhook');
    expect(entries[1].type).toBe('garmin');
    expect(entries[2].type).toBe('mqtt');
  });

  it('deduplicates by type (user overrides global)', () => {
    const userWithGarmin = {
      ...USER,
      exporters: [{ type: 'garmin', email: 'user@example.com' }],
    };
    const entries = resolveExportersForUser(BASE_CONFIG, userWithGarmin);
    expect(entries).toHaveLength(2);
    // User's garmin overrides global garmin
    expect(entries[0].type).toBe('garmin');
    expect((entries[0] as Record<string, unknown>).email).toBe('user@example.com');
    expect(entries[1].type).toBe('mqtt');
  });

  it('returns empty array when no exporters configured', () => {
    const config = { ...BASE_CONFIG, global_exporters: undefined };
    const entries = resolveExportersForUser(config, USER);
    expect(entries).toHaveLength(0);
  });
});

// --- resolveForSingleUser ---

describe('resolveForSingleUser', () => {
  it('combines runtime config with exporter entries', () => {
    const result = resolveForSingleUser(BASE_CONFIG);
    expect(result.profile).toBeDefined();
    expect(result.profile.height).toBe(183);
    expect(result.exporterEntries).toHaveLength(2);
    expect(result.continuousMode).toBe(true);
    expect(result.scaleMac).toBe('FF:03:00:13:A1:04');
  });

  it('uses first user from config', () => {
    const multiUserConfig: AppConfig = {
      ...BASE_CONFIG,
      users: [USER, { ...USER, name: 'Second', slug: 'second', height: 170 }],
    };
    const result = resolveForSingleUser(multiUserConfig);
    expect(result.profile.height).toBe(183); // first user
  });

  it('resolves exporter entries for the first user', () => {
    const userWithExporters = {
      ...USER,
      exporters: [{ type: 'ntfy', topic: 'test' }],
    };
    const config = { ...BASE_CONFIG, users: [userWithExporters] };
    const result = resolveForSingleUser(config);
    expect(result.exporterEntries).toHaveLength(3); // ntfy + garmin + mqtt
    expect(result.exporterEntries[0].type).toBe('ntfy');
  });
});
