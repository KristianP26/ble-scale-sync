import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { constants as fsConstants } from 'node:fs';

// Mock node:fs before importing the module under test so the vi.fn() instance
// is the one the module captures.
//
// The heartbeat opens the file itself rather than letting writeFileSync resolve
// the path, so it can pass O_NOFOLLOW; the write then targets the fd. `constants`
// has to be real, because the module folds the flags at import time.
const writeFileSyncMock = vi.fn();
const openSyncMock = vi.fn(() => 7);
const closeSyncMock = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    constants: actual.constants,
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    openSync: (...args: unknown[]) => openSyncMock(...(args as [])),
    closeSync: (...args: unknown[]) => closeSyncMock(...args),
  };
});

import {
  touchHeartbeat,
  startFileHeartbeat,
  stopFileHeartbeat,
  _resetForTesting,
} from '../../src/runtime/file-heartbeat.js';

const HEARTBEAT_PATH = '/tmp/.ble-scale-sync-heartbeat';

describe('file-heartbeat (#277)', () => {
  beforeEach(() => {
    writeFileSyncMock.mockReset();
    openSyncMock.mockReset();
    openSyncMock.mockReturnValue(7);
    closeSyncMock.mockReset();
    _resetForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetForTesting();
    vi.useRealTimers();
  });

  it('touchHeartbeat() writes the heartbeat file', () => {
    touchHeartbeat();
    expect(openSyncMock).toHaveBeenCalledTimes(1);
    expect(openSyncMock.mock.calls[0][0]).toBe(HEARTBEAT_PATH);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    // The write targets the fd from openSync, not the path: that is what makes
    // the O_NOFOLLOW check above the one that decides where the bytes land.
    expect(writeFileSyncMock.mock.calls[0][0]).toBe(7);
  });

  // The path is fixed, world-predictable, in a world-writable directory, and
  // rewritten every 30s with every error swallowed. A local user could
  // pre-create it as a symlink to any file this process can write - config.yaml,
  // a crontab, an authorized_keys - and each tick would follow it and truncate
  // the target. O_NOFOLLOW makes the open fail with ELOOP instead.
  it.skipIf(process.platform === 'win32')(
    'opens with O_NOFOLLOW so a symlink cannot be followed',
    () => {
      touchHeartbeat();
      const flags = openSyncMock.mock.calls[0][1] as number;
      expect(flags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
      expect(flags & fsConstants.O_CREAT).toBe(fsConstants.O_CREAT);
      expect(flags & fsConstants.O_TRUNC).toBe(fsConstants.O_TRUNC);
    },
  );

  it('closes the descriptor even when the write throws', () => {
    writeFileSyncMock.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(() => touchHeartbeat()).not.toThrow();
    expect(closeSyncMock).toHaveBeenCalledWith(7);
  });

  it('skips the tick when the open itself fails (ELOOP on a planted symlink)', () => {
    openSyncMock.mockImplementationOnce(() => {
      throw new Error('ELOOP');
    });
    expect(() => touchHeartbeat()).not.toThrow();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(closeSyncMock).not.toHaveBeenCalled();
  });

  it('touchHeartbeat() swallows a write error (/tmp not writable on Windows)', () => {
    writeFileSyncMock.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(() => touchHeartbeat()).not.toThrow();
  });

  it('startFileHeartbeat() touches immediately, before any timer advance', () => {
    startFileHeartbeat();
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });

  // The bug: the file went stale while the loop blocked in nextReading() waiting
  // for a weigh-in, so an idle container flipped to unhealthy after 5 minutes
  // and the HA Supervisor watchdog restarted it. The tick must be independent of
  // readings.
  it('keeps ticking every 30s with no reading activity at all', () => {
    startFileHeartbeat();
    writeFileSyncMock.mockClear();

    vi.advanceTimersByTime(29_999);
    expect(writeFileSyncMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);

    // Well past the 5 minute freshness window the HEALTHCHECK enforces.
    vi.advanceTimersByTime(10 * 60_000);
    expect(writeFileSyncMock.mock.calls.length).toBeGreaterThanOrEqual(20);
  });

  // A ref'd interval would keep the process alive forever, which breaks the
  // consecutive-failure watchdog: its recovery is letting the process exit so
  // the supervisor restarts it.
  it('unrefs the interval so it cannot hold the process open', () => {
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    startFileHeartbeat();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('is idempotent and does not stack timers', () => {
    startFileHeartbeat();
    startFileHeartbeat();
    writeFileSyncMock.mockClear();

    vi.advanceTimersByTime(30_000);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('a throwing write does not kill the interval', () => {
    startFileHeartbeat();
    writeFileSyncMock.mockClear();
    writeFileSyncMock.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    vi.advanceTimersByTime(30_000);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it('stopFileHeartbeat() cancels the interval, and start works again after', () => {
    startFileHeartbeat();
    stopFileHeartbeat();
    writeFileSyncMock.mockClear();

    vi.advanceTimersByTime(120_000);
    expect(writeFileSyncMock).not.toHaveBeenCalled();

    startFileHeartbeat();
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('stopFileHeartbeat() before any start is safe', () => {
    expect(() => stopFileHeartbeat()).not.toThrow();
  });
});
