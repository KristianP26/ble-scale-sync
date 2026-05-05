import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:child_process before importing the module under test so the
// vi.fn() instance is the one the module captures via execFile.
const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  notifyReady,
  startHeartbeat,
  stopHeartbeat,
  isActive,
  _resetForTesting,
} from '../../src/runtime/systemd-watchdog.js';

const ORIG_NOTIFY_SOCKET = process.env.NOTIFY_SOCKET;
const ORIG_WATCHDOG_USEC = process.env.WATCHDOG_USEC;

function setSystemdEnv(notifySocket: string | undefined, watchdogUsec?: string): void {
  if (notifySocket === undefined) delete process.env.NOTIFY_SOCKET;
  else process.env.NOTIFY_SOCKET = notifySocket;
  if (watchdogUsec === undefined) delete process.env.WATCHDOG_USEC;
  else process.env.WATCHDOG_USEC = watchdogUsec;
}

describe('systemd-watchdog', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    _resetForTesting();
    setSystemdEnv(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetForTesting();
    if (ORIG_NOTIFY_SOCKET === undefined) delete process.env.NOTIFY_SOCKET;
    else process.env.NOTIFY_SOCKET = ORIG_NOTIFY_SOCKET;
    if (ORIG_WATCHDOG_USEC === undefined) delete process.env.WATCHDOG_USEC;
    else process.env.WATCHDOG_USEC = ORIG_WATCHDOG_USEC;
    vi.useRealTimers();
  });

  describe('no-op path (NOTIFY_SOCKET unset)', () => {
    it('notifyReady() does not spawn systemd-notify', () => {
      notifyReady();
      expect(execFileMock).not.toHaveBeenCalled();
      expect(isActive()).toBe(false);
    });

    it('startHeartbeat() schedules nothing', () => {
      startHeartbeat();
      vi.advanceTimersByTime(60_000);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('stopHeartbeat() is safe to call', () => {
      expect(() => stopHeartbeat()).not.toThrow();
    });
  });

  describe('notifyReady() when NOTIFY_SOCKET is set', () => {
    beforeEach(() => {
      setSystemdEnv('/run/systemd/notify');
    });

    it('spawns systemd-notify with READY=1', () => {
      notifyReady();
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith(
        'systemd-notify',
        ['READY=1'],
        expect.any(Function),
      );
      expect(isActive()).toBe(true);
    });

    it('is idempotent on repeated calls', () => {
      notifyReady();
      notifyReady();
      notifyReady();
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('startHeartbeat() when NOTIFY_SOCKET is set', () => {
    it('uses WATCHDOG_USEC/2 as the interval when set', () => {
      // 60 s WatchdogSec = 60_000_000 usec; heartbeat must fire at 30 s
      setSystemdEnv('/run/systemd/notify', '60000000');
      startHeartbeat();
      expect(execFileMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(29_999);
      expect(execFileMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith(
        'systemd-notify',
        ['WATCHDOG=1'],
        expect.any(Function),
      );
      vi.advanceTimersByTime(30_000);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('defaults to 30 s when WATCHDOG_USEC is unset', () => {
      setSystemdEnv('/run/systemd/notify');
      startHeartbeat();
      vi.advanceTimersByTime(30_001);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('defaults to 30 s when WATCHDOG_USEC is malformed', () => {
      setSystemdEnv('/run/systemd/notify', 'not-a-number');
      startHeartbeat();
      vi.advanceTimersByTime(30_001);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('defaults to 30 s when WATCHDOG_USEC is zero', () => {
      setSystemdEnv('/run/systemd/notify', '0');
      startHeartbeat();
      vi.advanceTimersByTime(30_001);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('is idempotent (does not stack timers)', () => {
      setSystemdEnv('/run/systemd/notify', '60000000');
      startHeartbeat();
      startHeartbeat();
      startHeartbeat();
      vi.advanceTimersByTime(30_001);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopHeartbeat()', () => {
    it('cancels the interval', () => {
      setSystemdEnv('/run/systemd/notify', '60000000');
      startHeartbeat();
      vi.advanceTimersByTime(30_001);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      stopHeartbeat();
      vi.advanceTimersByTime(60_000);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('allows startHeartbeat() to be called again afterward', () => {
      setSystemdEnv('/run/systemd/notify', '60000000');
      startHeartbeat();
      stopHeartbeat();
      execFileMock.mockReset();
      startHeartbeat();
      vi.advanceTimersByTime(30_001);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('ENOENT short-circuit', () => {
    it('stops spawning systemd-notify after ENOENT, even when heartbeat keeps ticking', () => {
      setSystemdEnv('/run/systemd/notify', '60000000');
      // Simulate "binary missing" by invoking the callback with ENOENT.
      execFileMock.mockImplementation(
        (_file: string, _args: string[], cb: (err: NodeJS.ErrnoException | null) => void) => {
          const err = Object.assign(new Error('spawn systemd-notify ENOENT'), {
            code: 'ENOENT',
          }) as NodeJS.ErrnoException;
          cb(err);
        },
      );

      startHeartbeat();
      // First tick fires the spawn, callback synchronously sets the "missing" flag
      // and calls stopHeartbeat(). Subsequent ticks must NOT spawn again.
      vi.advanceTimersByTime(30_001);
      expect(execFileMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });
  });
});
