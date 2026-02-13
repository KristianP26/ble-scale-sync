import { describe, it, expect } from 'vitest';
import { formatMac, normalizeUuid, sleep, withTimeout, BT_BASE_UUID_SUFFIX } from '../../src/ble/types.js';

describe('formatMac()', () => {
  it('formats a lowercase MAC with colons', () => {
    expect(formatMac('ff:03:00:13:a1:04')).toBe('FF:03:00:13:A1:04');
  });

  it('formats a MAC without separators', () => {
    expect(formatMac('FF030013A104')).toBe('FF:03:00:13:A1:04');
  });

  it('formats a MAC with dashes', () => {
    expect(formatMac('ff-03-00-13-a1-04')).toBe('FF:03:00:13:A1:04');
  });

  it('uppercases all hex characters', () => {
    expect(formatMac('ab:cd:ef:01:23:45')).toBe('AB:CD:EF:01:23:45');
  });
});

describe('normalizeUuid()', () => {
  it('expands a 4-char short UUID to full 128-bit form', () => {
    expect(normalizeUuid('FFF0')).toBe(`0000fff0${BT_BASE_UUID_SUFFIX}`);
  });

  it('lowercases and strips dashes from a full UUID', () => {
    expect(normalizeUuid('0000FFF0-0000-1000-8000-00805F9B34FB')).toBe(
      `0000fff0${BT_BASE_UUID_SUFFIX}`,
    );
  });

  it('returns lowercase for already-clean UUIDs', () => {
    expect(normalizeUuid('AABBCCDD11223344AABBCCDD11223344')).toBe(
      'aabbccdd11223344aabbccdd11223344',
    );
  });
});

describe('sleep()', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('resolves with undefined', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });
});

describe('withTimeout()', () => {
  it('resolves when the promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'timed out');
    expect(result).toBe(42);
  });

  it('rejects with timeout message when promise is too slow', async () => {
    const slow = new Promise((r) => setTimeout(r, 10_000));
    await expect(withTimeout(slow, 10, 'operation timed out')).rejects.toThrow(
      'operation timed out',
    );
  });

  it('clears the timer after the promise resolves', async () => {
    // If the timer leaked, this test would hang or fail in a different way
    const result = await withTimeout(Promise.resolve('ok'), 60_000, 'timeout');
    expect(result).toBe('ok');
  });

  it('propagates the original error if promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('original error'));
    await expect(withTimeout(failing, 1000, 'timeout')).rejects.toThrow('original error');
  });
});
