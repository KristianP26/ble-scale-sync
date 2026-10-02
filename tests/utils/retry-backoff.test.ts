import { describe, it, expect, vi } from 'vitest';

import { withRetry, httpError, NonRetryableError } from '../../src/utils/retry.js';
import type { Logger } from '../../src/logger.js';

/**
 * There was no delay between attempts at all, so a retriable failure burned all
 * three attempts in the same millisecond. `isRetryableStatus` counts 429 among
 * them, which makes that the wrong answer twice over: the service is told to
 * slow down and is hit twice more immediately, and the retry budget is gone
 * before the condition it exists for could have cleared.
 */

function fakeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

/** Records what it was asked to wait for, without waiting. */
function recordingSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe('withRetry waits between attempts', () => {
  it('backs off before each retry of a rate-limited request', async () => {
    const { waits, sleep } = recordingSleep();
    const attempt = vi.fn(async () => {
      throw httpError(429, 'upload');
    });

    const result = await withRetry(attempt, {
      log: fakeLog(),
      label: 'upload',
      baseDelayMs: 1_000,
      sleep,
    });

    expect(result.success).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(3);
    // Before retry 1 and before retry 2; none before the first attempt.
    expect(waits).toEqual([1_000, 2_000]);
  });

  it('caps the backoff', async () => {
    const { waits, sleep } = recordingSleep();

    await withRetry(
      async () => {
        throw new Error('503');
      },
      {
        log: fakeLog(),
        label: 'upload',
        maxRetries: 4,
        baseDelayMs: 1_000,
        maxDelayMs: 3_000,
        sleep,
      },
    );

    expect(waits).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  it('does not wait when the first attempt succeeds', async () => {
    const { waits, sleep } = recordingSleep();

    const result = await withRetry(async () => ({ success: true }), {
      log: fakeLog(),
      label: 'upload',
      sleep,
    });

    expect(result.success).toBe(true);
    expect(waits).toEqual([]);
  });

  it('does not wait for an error it will not retry', async () => {
    // Fail-fast must stay fast: a bad password should not sit through a backoff
    // on its way to the same answer.
    const { waits, sleep } = recordingSleep();

    const result = await withRetry(
      async () => {
        throw new NonRetryableError('HTTP 401');
      },
      { log: fakeLog(), label: 'upload', sleep },
    );

    expect(result).toMatchObject({ success: false, error: 'HTTP 401' });
    expect(waits).toEqual([]);
  });

  it('honours a zero base delay', async () => {
    // How the test suite keeps its own runs fast, via BLE_RETRY_BASE_DELAY_MS.
    const { waits, sleep } = recordingSleep();

    await withRetry(
      async () => {
        throw new Error('boom');
      },
      { log: fakeLog(), label: 'upload', baseDelayMs: 0, sleep },
    );

    expect(waits).toEqual([]);
  });
});
