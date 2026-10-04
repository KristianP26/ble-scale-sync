import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  atomicWrite,
  withWriteLock,
  writeLastKnownWeight,
  updateLastKnownWeight,
  _clearPendingWrites,
  _resetWriteLock,
} from '../../src/config/write.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'write-test-'));
  _clearPendingWrites();
  _resetWriteLock();
});

afterEach(() => {
  _clearPendingWrites();
  _resetWriteLock();
  vi.useRealTimers();
});

// --- Helpers ---

function tempFile(name: string, content?: string): string {
  const path = join(tempDir, name);
  if (content !== undefined) writeFileSync(path, content, 'utf8');
  return path;
}

const YAML_TWO_USERS = `# Config file
version: 1
unknown_user: nearest

users:
  - name: Alice
    slug: alice
    height: 165
    birth_date: "1992-03-10"
    gender: female
    is_athlete: false
    weight_range:
      min: 50
      max: 70
    last_known_weight: null  # will be updated
  - name: Bob
    slug: bob
    height: 183
    birth_date: "1988-07-22"
    gender: male
    is_athlete: true
    weight_range:
      min: 75
      max: 100
    last_known_weight: 85.5
`;

// --- atomicWrite ---

describe('atomicWrite', () => {
  it('writes content to a new file', () => {
    const path = join(tempDir, 'new.txt');
    atomicWrite(path, 'hello');
    expect(readFileSync(path, 'utf8')).toBe('hello');
  });

  it('overwrites existing file via tmp+rename', () => {
    const path = tempFile('existing.txt', 'old content');
    atomicWrite(path, 'new content');
    expect(readFileSync(path, 'utf8')).toBe('new content');
  });

  it('does not leave tmp file on success', () => {
    const path = join(tempDir, 'clean.txt');
    atomicWrite(path, 'data');
    expect(existsSync(path + '.tmp')).toBe(false);
  });

  it('cleans up tmp file on write failure', () => {
    // Point to a non-existent directory to trigger writeFileSync failure
    const badDir = join(tempDir, 'nonexistent', 'sub');
    const path = join(badDir, 'file.txt');
    expect(() => atomicWrite(path, 'data')).toThrow();
    expect(existsSync(path + '.tmp')).toBe(false);
  });

  // rename(2) replaces the directory entry it is given. For a symlinked
  // config.yaml that is the link itself, so the first last_known_weight write
  // used to turn the link into a standalone copy, and later edits of the real
  // file (in a dotfiles repo, say) were never seen again.
  it('writes through a symlink and leaves the link in place', (ctx) => {
    const realDir = mkdtempSync(join(tmpdir(), 'write-test-real-'));
    const real = join(realDir, 'scale.yaml');
    writeFileSync(real, 'old');
    const link = join(tempDir, 'config.yaml');
    try {
      symlinkSync(real, link, 'file');
    } catch {
      ctx.skip(); // no symlink permission (Windows without developer mode)
    }

    atomicWrite(link, 'new');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('new');
    expect(existsSync(real + '.tmp')).toBe(false);
  });
});

// --- withWriteLock ---

describe('withWriteLock', () => {
  it('serializes concurrent calls', async () => {
    const order: number[] = [];

    const p1 = withWriteLock(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const p2 = withWriteLock(async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('propagates errors without blocking queue', async () => {
    const failing = withWriteLock(async () => {
      throw new Error('fail');
    });
    await expect(failing).rejects.toThrow('fail');

    // Next call should still work
    let executed = false;
    await withWriteLock(async () => {
      executed = true;
    });
    expect(executed).toBe(true);
  });

  it('returns the value from the function', async () => {
    const result = await withWriteLock(async () => 42);
    expect(result).toBe(42);
  });
});

// --- writeLastKnownWeight ---

describe('writeLastKnownWeight', () => {
  it('updates the correct user by slug', () => {
    const path = tempFile('config.yaml', YAML_TWO_USERS);
    writeLastKnownWeight(path, 'alice', 62.3);

    const content = readFileSync(path, 'utf8');
    expect(content).toContain('last_known_weight: 62.3');
    // Bob's weight should be unchanged
    expect(content).toContain('last_known_weight: 85.5');
  });

  it('preserves YAML comments', () => {
    const path = tempFile('config.yaml', YAML_TWO_USERS);
    writeLastKnownWeight(path, 'alice', 63);

    const content = readFileSync(path, 'utf8');
    expect(content).toContain('# Config file');
  });

  it('rounds weight to 2 decimal places', () => {
    const path = tempFile('config.yaml', YAML_TWO_USERS);
    writeLastKnownWeight(path, 'bob', 87.456);

    const content = readFileSync(path, 'utf8');
    expect(content).toContain('87.46');
  });

  it('overwrites existing last_known_weight', () => {
    const path = tempFile('config.yaml', YAML_TWO_USERS);
    writeLastKnownWeight(path, 'bob', 90);

    const content = readFileSync(path, 'utf8');
    // Bob's old weight (85.5) should be replaced
    expect(content).not.toContain('85.5');
    expect(content).toContain('last_known_weight: 90');
  });

  it('warns and skips if slug not found', () => {
    const path = tempFile('config.yaml', YAML_TWO_USERS);
    // Should not throw
    writeLastKnownWeight(path, 'unknown-user', 75);

    // File should be unchanged (no atomicWrite called)
    const content = readFileSync(path, 'utf8');
    expect(content).toBe(YAML_TWO_USERS);
  });

  it('warns and skips if no users array', () => {
    const noUsers = 'version: 1\n';
    const path = tempFile('config.yaml', noUsers);
    // Should not throw
    writeLastKnownWeight(path, 'alice', 60);
    expect(readFileSync(path, 'utf8')).toBe(noUsers);
  });
});

// --- updateLastKnownWeight ---

describe('updateLastKnownWeight', () => {
  it('debounces writes (only last call wins)', async () => {
    vi.useFakeTimers();
    const path = tempFile('config.yaml', YAML_TWO_USERS);

    updateLastKnownWeight(path, 'alice', 60, null);
    updateLastKnownWeight(path, 'alice', 62, null);
    updateLastKnownWeight(path, 'alice', 64, null);

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(6000);

    const content = readFileSync(path, 'utf8');
    // Only the last value should be written
    expect(content).toContain('64');
    expect(content).not.toContain('last_known_weight: 60');
    expect(content).not.toContain('last_known_weight: 62');
  });

  it('skips update when change is less than 0.5 kg', () => {
    vi.useFakeTimers();
    const path = tempFile('config.yaml', YAML_TWO_USERS);

    updateLastKnownWeight(path, 'bob', 85.7, 85.5);

    // Advance past debounce
    vi.advanceTimersByTime(6000);

    // File should be unchanged — change was only 0.2 kg
    const content = readFileSync(path, 'utf8');
    expect(content).toBe(YAML_TWO_USERS);
  });

  it('writes when change exceeds 0.5 kg', async () => {
    vi.useFakeTimers();
    const path = tempFile('config.yaml', YAML_TWO_USERS);

    updateLastKnownWeight(path, 'bob', 87, 85.5);

    await vi.advanceTimersByTimeAsync(6000);

    const content = readFileSync(path, 'utf8');
    expect(content).toContain('last_known_weight: 87');
  });

  it('writes when currentWeight is null (first measurement)', async () => {
    vi.useFakeTimers();
    const path = tempFile('config.yaml', YAML_TWO_USERS);

    updateLastKnownWeight(path, 'alice', 61, null);

    await vi.advanceTimersByTimeAsync(6000);

    const content = readFileSync(path, 'utf8');
    expect(content).toContain('last_known_weight: 61');
  });

  it('handles independent per-slug debounce', async () => {
    vi.useFakeTimers();
    const path = tempFile('config.yaml', YAML_TWO_USERS);

    updateLastKnownWeight(path, 'alice', 62, null);
    updateLastKnownWeight(path, 'bob', 90, 85.5);

    await vi.advanceTimersByTimeAsync(6000);

    const content = readFileSync(path, 'utf8');
    expect(content).toContain('62');
    expect(content).toContain('90');
  });
});
