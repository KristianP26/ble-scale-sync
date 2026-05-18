import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { armHardExit, cancelHardExit } from '../../src/runtime/hard-exit.js';
import type { Logger } from '../../src/logger.js';

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('armHardExit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Disarm any state leaked from a previous test (module is reused).
    cancelHardExit();
  });

  afterEach(() => {
    cancelHardExit();
    vi.useRealTimers();
  });

  it('force-exits after the grace window with the current exit code', () => {
    const log = createMockLogger();
    const exit = vi.fn();
    const prev = process.exitCode;
    process.exitCode = 1;

    armHardExit({ timeoutMs: 5_000, log, exit: exit as unknown as (c: number) => never });

    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_999);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.warn).toHaveBeenCalledTimes(1);

    process.exitCode = prev;
  });

  it('falls back to code 1 when no exit code is set', () => {
    const log = createMockLogger();
    const exit = vi.fn();
    const prev = process.exitCode;
    process.exitCode = undefined;

    armHardExit({ timeoutMs: 5_000, log, exit: exit as unknown as (c: number) => never });
    vi.advanceTimersByTime(5_000);

    expect(exit).toHaveBeenCalledWith(1);
    process.exitCode = prev;
  });

  it('is idempotent: a second arm does not stack another timer', () => {
    const log = createMockLogger();
    const exit = vi.fn();

    armHardExit({ timeoutMs: 5_000, log, exit: exit as unknown as (c: number) => never });
    armHardExit({ timeoutMs: 1_000, log, exit: exit as unknown as (c: number) => never });

    // The shorter second window must be ignored (first arm wins).
    vi.advanceTimersByTime(1_000);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('cancelHardExit prevents the force-exit and re-arms cleanly', () => {
    const log = createMockLogger();
    const exit = vi.fn();

    armHardExit({ timeoutMs: 5_000, log, exit: exit as unknown as (c: number) => never });
    cancelHardExit();
    vi.advanceTimersByTime(10_000);
    expect(exit).not.toHaveBeenCalled();

    // After cancel, arming again works (proves the armed flag was reset).
    armHardExit({ timeoutMs: 2_000, log, exit: exit as unknown as (c: number) => never });
    vi.advanceTimersByTime(2_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
