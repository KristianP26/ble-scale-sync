import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/validate-env.js';

// Mock dotenv to prevent it from loading a real .env file
vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

function setEnv(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    USER_HEIGHT: '183',
    USER_BIRTH_DATE: '2000-06-15',
    USER_GENDER: 'male',
    USER_IS_ATHLETE: 'true',
  };
  const env = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
}

function clearEnvKeys(...keys: string[]) {
  for (const key of keys) {
    delete process.env[key];
  }
}

describe('loadConfig()', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    vi.unstubAllEnvs();
    exitSpy.mockClear();
    errorSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns valid config with correct defaults', () => {
    setEnv();
    const cfg = loadConfig();
    expect(cfg.profile.height).toBe(183);
    // Birth date 2000-06-15 → precise age depends on today's month/day
    const today = new Date();
    let expectedAge = today.getFullYear() - 2000;
    const md = today.getMonth() - 5; // June = month index 5
    if (md < 0 || (md === 0 && today.getDate() < 15)) expectedAge--;
    expect(cfg.profile.age).toBe(expectedAge);
    expect(cfg.profile.gender).toBe('male');
    expect(cfg.profile.isAthlete).toBe(true);
    expect(cfg.scaleMac).toBeUndefined();
    expect(cfg.weightUnit).toBe('kg');
  });

  it('accepts SCALE_MAC when valid', () => {
    setEnv({ SCALE_MAC: 'AA:BB:CC:DD:EE:FF' });
    const cfg = loadConfig();
    expect(cfg.scaleMac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('accepts case-insensitive USER_GENDER', () => {
    setEnv({ USER_GENDER: 'Female' });
    const cfg = loadConfig();
    expect(cfg.profile.gender).toBe('female');
  });

  it('accepts various boolean formats for USER_IS_ATHLETE', () => {
    for (const val of ['true', 'yes', '1', 'True', 'YES']) {
      vi.unstubAllEnvs();
      setEnv({ USER_IS_ATHLETE: val });
      expect(loadConfig().profile.isAthlete).toBe(true);
    }
    for (const val of ['false', 'no', '0', 'False', 'NO']) {
      vi.unstubAllEnvs();
      setEnv({ USER_IS_ATHLETE: val });
      expect(loadConfig().profile.isAthlete).toBe(false);
    }
  });

  describe('WEIGHT_UNIT', () => {
    it('defaults to kg when not set', () => {
      setEnv();
      const cfg = loadConfig();
      expect(cfg.weightUnit).toBe('kg');
    });

    it('accepts WEIGHT_UNIT=lbs', () => {
      setEnv({ WEIGHT_UNIT: 'lbs' });
      const cfg = loadConfig();
      expect(cfg.weightUnit).toBe('lbs');
    });

    it('rejects invalid WEIGHT_UNIT=stones', () => {
      setEnv({ WEIGHT_UNIT: 'stones' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("must be 'kg' or 'lbs'"));
    });
  });

  describe('HEIGHT_UNIT', () => {
    it('converts inches to cm when HEIGHT_UNIT=in', () => {
      setEnv({ HEIGHT_UNIT: 'in', USER_HEIGHT: '72' });
      const cfg = loadConfig();
      expect(cfg.profile.height).toBeCloseTo(182.88, 2);
    });

    it('rejects HEIGHT_UNIT=in with USER_HEIGHT below range (10)', () => {
      setEnv({ HEIGHT_UNIT: 'in', USER_HEIGHT: '10' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('between 20 and 100'));
    });

    it('does not convert when HEIGHT_UNIT=cm', () => {
      setEnv({ HEIGHT_UNIT: 'cm', USER_HEIGHT: '72' });
      const cfg = loadConfig();
      expect(cfg.profile.height).toBe(72);
    });

    it('rejects invalid HEIGHT_UNIT=ft', () => {
      setEnv({ HEIGHT_UNIT: 'ft' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("must be 'cm' or 'in'"));
    });
  });

  describe('DRY_RUN', () => {
    it('defaults to false when not set', () => {
      setEnv();
      const cfg = loadConfig();
      expect(cfg.dryRun).toBe(false);
    });

    it('returns true when DRY_RUN=true', () => {
      setEnv({ DRY_RUN: 'true' });
      const cfg = loadConfig();
      expect(cfg.dryRun).toBe(true);
    });

    it('returns false when DRY_RUN=false', () => {
      setEnv({ DRY_RUN: 'false' });
      const cfg = loadConfig();
      expect(cfg.dryRun).toBe(false);
    });

    it('accepts DRY_RUN=1 as true', () => {
      setEnv({ DRY_RUN: '1' });
      const cfg = loadConfig();
      expect(cfg.dryRun).toBe(true);
    });

    it('rejects DRY_RUN=maybe', () => {
      setEnv({ DRY_RUN: 'maybe' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('true/false/yes/no/1/0'));
    });
  });

  describe('missing required vars', () => {
    it('exits when USER_HEIGHT is missing', () => {
      setEnv();
      clearEnvKeys('USER_HEIGHT');
      expect(() => loadConfig()).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('USER_HEIGHT'));
    });

    it('exits when USER_BIRTH_DATE is missing', () => {
      setEnv();
      clearEnvKeys('USER_BIRTH_DATE');
      expect(() => loadConfig()).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits when USER_GENDER is missing', () => {
      setEnv();
      clearEnvKeys('USER_GENDER');
      expect(() => loadConfig()).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits when USER_IS_ATHLETE is missing', () => {
      setEnv();
      clearEnvKeys('USER_IS_ATHLETE');
      expect(() => loadConfig()).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('invalid values', () => {
    it('rejects USER_HEIGHT="abc" — not a number', () => {
      setEnv({ USER_HEIGHT: 'abc' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    });

    it('rejects USER_HEIGHT=0 — below range', () => {
      setEnv({ USER_HEIGHT: '0' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('between 50 and 250'));
    });

    it('rejects USER_HEIGHT=300 — above range', () => {
      setEnv({ USER_HEIGHT: '300' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('between 50 and 250'));
    });

    it('rejects USER_GENDER=robot', () => {
      setEnv({ USER_GENDER: 'robot' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("must be 'male' or 'female'"));
    });

    it('rejects USER_BIRTH_DATE with invalid format (slash separator)', () => {
      setEnv({ USER_BIRTH_DATE: '2000/01/15' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('YYYY-MM-DD format'));
    });

    it('rejects USER_BIRTH_DATE with year-only format', () => {
      setEnv({ USER_BIRTH_DATE: '2000' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('YYYY-MM-DD format'));
    });

    it('rejects USER_BIRTH_DATE with non-date string', () => {
      setEnv({ USER_BIRTH_DATE: 'abc' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('YYYY-MM-DD format'));
    });

    it('rejects USER_BIRTH_DATE with impossible date (Feb 30)', () => {
      setEnv({ USER_BIRTH_DATE: '2000-02-30' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not a valid date'));
    });

    it('rejects USER_BIRTH_DATE in the future', () => {
      setEnv({ USER_BIRTH_DATE: '2099-01-01' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('cannot be in the future'));
    });

    it('rejects USER_BIRTH_DATE resulting in age < 5', () => {
      const tooRecent = new Date();
      tooRecent.setFullYear(tooRecent.getFullYear() - 2);
      const iso = tooRecent.toISOString().slice(0, 10);
      setEnv({ USER_BIRTH_DATE: iso });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('minimum age is 5'));
    });

    it('computes precise age — birthday not yet reached this year', () => {
      // Use Dec 31 of a year that guarantees age >= 5
      const year = new Date().getFullYear() - 10;
      setEnv({ USER_BIRTH_DATE: `${year}-12-31` });
      const cfg = loadConfig();
      // Today is before Dec 31, so age should be 9 (birthday hasn't happened yet)
      const today = new Date();
      const expected = today.getMonth() === 11 && today.getDate() >= 31 ? 10 : 9;
      expect(cfg.profile.age).toBe(expected);
    });

    it('computes precise age — birthday already passed this year', () => {
      // Use Jan 1 of a year that guarantees age >= 5
      const year = new Date().getFullYear() - 10;
      setEnv({ USER_BIRTH_DATE: `${year}-01-01` });
      const cfg = loadConfig();
      // Today is after Jan 1, so age should be 10
      expect(cfg.profile.age).toBe(10);
    });

    it('rejects invalid SCALE_MAC format', () => {
      setEnv({ SCALE_MAC: 'invalid' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('XX:XX:XX:XX:XX:XX'));
    });

    it('accepts absent SCALE_MAC — returns undefined', () => {
      setEnv();
      clearEnvKeys('SCALE_MAC');
      const cfg = loadConfig();
      expect(cfg.scaleMac).toBeUndefined();
    });

    it('rejects USER_IS_ATHLETE=maybe', () => {
      setEnv({ USER_IS_ATHLETE: 'maybe' });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('true/false/yes/no/1/0'));
    });
  });
});
