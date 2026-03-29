import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { runNonInteractive } from '../../src/wizard/non-interactive.js';

const TEST_DIR = join(import.meta.dirname, '..', '..', 'tests', 'wizard');
const TEST_CONFIG = join(TEST_DIR, '_test-config-ni.yaml');

function writeTestConfig(data: Record<string, unknown>): void {
  writeFileSync(TEST_CONFIG, stringifyYaml(data), 'utf8');
}

function cleanupTestConfig(): void {
  try {
    if (existsSync(TEST_CONFIG)) unlinkSync(TEST_CONFIG);
    // Also clean tmp file
    if (existsSync(TEST_CONFIG + '.tmp')) unlinkSync(TEST_CONFIG + '.tmp');
  } catch {
    // ignore
  }
}

// ─── runNonInteractive() ─────────────────────────────────────────────────

describe('runNonInteractive()', () => {
  beforeEach(() => {
    cleanupTestConfig();
  });

  afterEach(() => {
    cleanupTestConfig();
  });

  it('validates a correct config without errors', async () => {
    writeTestConfig({
      version: 1,
      users: [
        {
          name: 'Alice',
          slug: 'alice',
          height: 168,
          birth_date: '1995-03-20',
          gender: 'female',
          is_athlete: false,
          weight_range: { min: 50, max: 75 },
        },
      ],
    });

    // Should not throw or exit
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      await runNonInteractive(TEST_CONFIG);
    } catch (err) {
      // process.exit mock throws — should NOT be called for valid config
      expect(err).not.toBeDefined();
    }

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('auto-generates missing slugs', async () => {
    writeTestConfig({
      version: 1,
      users: [
        {
          name: 'Mama Janka',
          height: 165,
          birth_date: '1970-01-01',
          gender: 'female',
          is_athlete: false,
          weight_range: { min: 50, max: 80 },
        },
      ],
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      await runNonInteractive(TEST_CONFIG);
    } catch {
      // may throw on exit mock
    }

    // Check that the file was updated with a slug
    const updated = readFileSync(TEST_CONFIG, 'utf8');
    expect(updated).toContain('mama-janka');

    exitSpy.mockRestore();
  });

  it('exits with code 1 for invalid config', async () => {
    writeTestConfig({
      version: 1,
      users: [], // Empty users array — violates min(1)
    });

    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      exitCode = code;
      throw new Error('process.exit called');
    }) as never);

    try {
      await runNonInteractive(TEST_CONFIG);
    } catch {
      // Expected — mock throws
    }

    expect(exitCode).toBe(1);
    exitSpy.mockRestore();
  });

  it('exits with code 1 for missing config file', async () => {
    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      exitCode = code;
      throw new Error('process.exit called');
    }) as never);

    try {
      await runNonInteractive('/nonexistent/path/config.yaml');
    } catch {
      // Expected — mock throws
    }

    expect(exitCode).toBe(1);
    exitSpy.mockRestore();
  });

  it('does not modify file when all slugs present and defaults complete', async () => {
    const config = {
      version: 1,
      scale: { weight_unit: 'kg', height_unit: 'cm' },
      unknown_user: 'nearest',
      users: [
        {
          name: 'Bob',
          slug: 'bob',
          height: 180,
          birth_date: '1990-06-15',
          gender: 'male',
          is_athlete: false,
          weight_range: { min: 70, max: 100 },
          last_known_weight: null,
        },
      ],
      update_check: true,
    };
    writeTestConfig(config);

    const before = readFileSync(TEST_CONFIG, 'utf8');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      await runNonInteractive(TEST_CONFIG);
    } catch {
      // should not throw for valid config
    }

    const after = readFileSync(TEST_CONFIG, 'utf8');
    expect(after).toBe(before);

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
