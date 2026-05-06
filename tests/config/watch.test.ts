import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConfigWatcher } from '../../src/config/watch.js';
import {
  setSuppressReloadWindow,
  isReloadSuppressed,
  _resetSuppressWindow,
} from '../../src/config/write.js';

// Suppress log noise from the watcher's info/debug lines.
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const DEBOUNCE_MS = 500;
const SETTLE_MS = DEBOUNCE_MS + 200;

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ble-watch-test-'));
  configPath = join(tmpDir, 'config.yaml');
  writeFileSync(configPath, 'version: 1\n');
  _resetSuppressWindow();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('startConfigWatcher', () => {
  it('fires onChange after debounce when the watched file is edited', async () => {
    const onChange = vi.fn();
    const handle = startConfigWatcher(configPath, onChange);

    try {
      writeFileSync(configPath, 'version: 1\nedited: true\n');
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      handle.close();
    }
  });

  it('coalesces rapid edits into a single fire (debounce)', async () => {
    const onChange = vi.fn();
    const handle = startConfigWatcher(configPath, onChange);

    try {
      // Three rapid writes within the debounce window
      writeFileSync(configPath, 'version: 1\nn: 1\n');
      writeFileSync(configPath, 'version: 1\nn: 2\n');
      writeFileSync(configPath, 'version: 1\nn: 3\n');
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      handle.close();
    }
  });

  it('ignores edits to other files in the same directory', async () => {
    const onChange = vi.fn();
    const handle = startConfigWatcher(configPath, onChange);

    try {
      writeFileSync(join(tmpDir, 'unrelated.txt'), 'foo');
      writeFileSync(join(tmpDir, 'config.yaml.tmp'), 'tmp');
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      handle.close();
    }
  });

  it('survives atomic rename (tmp+rename pattern)', async () => {
    const onChange = vi.fn();
    const handle = startConfigWatcher(configPath, onChange);

    try {
      // Simulate atomicWrite: write tmp, rename over original
      const tmpPath = configPath + '.tmp';
      writeFileSync(tmpPath, 'version: 1\nrenamed: true\n');
      renameSync(tmpPath, configPath);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(onChange).toHaveBeenCalledTimes(1);

      // And again after the rename: watcher must still be alive
      onChange.mockClear();
      writeFileSync(configPath, 'version: 1\nsecond: true\n');
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      handle.close();
    }
  });

  it('does not fire while the self-write suppress window is active', async () => {
    const onChange = vi.fn();
    const handle = startConfigWatcher(configPath, onChange);

    try {
      setSuppressReloadWindow(2000);
      writeFileSync(configPath, 'version: 1\nselfwrite: true\n');
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      handle.close();
    }
  });

  it('close() cancels a pending debounce timer', async () => {
    const onChange = vi.fn();
    const handle = startConfigWatcher(configPath, onChange);

    writeFileSync(configPath, 'version: 1\npending: true\n');
    // Close before the 500 ms debounce fires
    await new Promise((r) => setTimeout(r, 50));
    handle.close();
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('returns a no-op handle when fs.watch fails (parent dir missing)', () => {
    const onChange = vi.fn();
    const bogusPath = join(tmpDir, 'does-not-exist', 'config.yaml');
    const handle = startConfigWatcher(bogusPath, onChange);
    // No throw, close() works
    expect(() => handle.close()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('write.ts suppress window', () => {
  beforeEach(() => {
    _resetSuppressWindow();
  });

  it('isReloadSuppressed returns true within the window', () => {
    setSuppressReloadWindow(1000);
    expect(isReloadSuppressed()).toBe(true);
  });

  it('isReloadSuppressed returns false after the window expires', async () => {
    setSuppressReloadWindow(50);
    await new Promise((r) => setTimeout(r, 100));
    expect(isReloadSuppressed()).toBe(false);
  });

  it('isReloadSuppressed returns false when no window has been set', () => {
    expect(isReloadSuppressed()).toBe(false);
  });
});
