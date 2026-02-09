import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/validate-env.js';

// Mock dotenv to prevent it from loading a real .env file
vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

function setEnv(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    USER_HEIGHT: '183',
    USER_BIRTH_YEAR: '2000',
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
    expect(cfg.profile.age).toBe(new Date().getFullYear() - 2000);
    expect(cfg.profile.gender).toBe('male');
    expect(cfg.profile.isAthlete).toBe(true);
    expect(cfg.scaleMac).toBeUndefined();
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

  describe('missing required vars', () => {
    it('exits when USER_HEIGHT is missing', () => {
      setEnv();
      clearEnvKeys('USER_HEIGHT');
      expect(() => loadConfig()).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('USER_HEIGHT'));
    });

    it('exits when USER_BIRTH_YEAR is missing', () => {
      setEnv();
      clearEnvKeys('USER_BIRTH_YEAR');
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

    it('rejects USER_BIRTH_YEAR=9999 — future year', () => {
      setEnv({ USER_BIRTH_YEAR: '9999' });
      expect(() => loadConfig()).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects USER_BIRTH_YEAR resulting in age < 5', () => {
      const tooRecent = String(new Date().getFullYear() - 2);
      setEnv({ USER_BIRTH_YEAR: tooRecent });
      expect(() => loadConfig()).toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('minimum age is 5'));
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
