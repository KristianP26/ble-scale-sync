import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ existsSync: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: h.existsSync }));
vi.mock('../../src/config/paths.js', () => ({
  defaultConfigPath: () => '/app/config.yaml',
  defaultEnvPath: () => '/app/.env',
}));

const { detectConfigSource } = await import('../../src/config/source-detect.js');

/**
 * #406: nineteen lines with no tests, and they decide whether config comes from
 * YAML or .env - which in turn gates whether last_known_weight is written back.
 */
describe('detectConfigSource', () => {
  beforeEach(() => h.existsSync.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('prefers config.yaml when both exist', () => {
    h.existsSync.mockReturnValue(true);
    expect(detectConfigSource()).toBe('yaml');
    expect(h.existsSync).toHaveBeenCalledWith('/app/config.yaml');
  });

  it('falls back to .env when there is no config.yaml', () => {
    h.existsSync.mockImplementation((p: string) => p === '/app/.env');
    expect(detectConfigSource()).toBe('env');
  });

  it('reports none when neither exists', () => {
    h.existsSync.mockReturnValue(false);
    expect(detectConfigSource()).toBe('none');
  });

  it('honours an explicit path instead of the default', () => {
    h.existsSync.mockImplementation((p: string) => p === '/etc/scale/config.yaml');
    expect(detectConfigSource('/etc/scale/config.yaml')).toBe('yaml');
  });

  it('does not fall back to anything when an explicit path is missing', () => {
    // Both defaults exist; the explicit path does not. Answering 'yaml' would
    // load a different file than the one asked for, and answering 'env' (what
    // this used to do) ran the legacy single-user mode with another profile and
    // other exporters after a typo in --config, with only an info line.
    h.existsSync.mockImplementation((p: string) => p !== '/etc/scale/config.yaml');
    expect(detectConfigSource('/etc/scale/config.yaml')).toBe('none');
  });
});
