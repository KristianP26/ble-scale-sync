import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const h = vi.hoisted(() => ({
  probeLiveness: vi.fn(),
  buildCharMap: vi.fn(),
}));

vi.mock('../../../src/ble/handler-node-ble/liveness.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/liveness.js')>();
  return { ...actual, probeLiveness: h.probeLiveness, makeLivenessAdapter: () => ({}) };
});
vi.mock('../../../src/ble/handler-node-ble/gatt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/handler-node-ble/gatt.js')>();
  return { ...actual, buildCharMap: h.buildCharMap };
});

const { classifyBleFailure, buildCharMapWithRetry } =
  await import('../../../src/ble/handler-node-ble/scan-stages.js');
const { bleFailureKind } = await import('../../../src/ble/failure-kind.js');

/**
 * #406: this module is the primary Linux/RPi GATT path and the home of #143,
 * #297 and #335, and no test imported it. classifyBleFailure decides whether
 * the watchdog restarts the process; buildCharMapWithRetry decides whether a
 * scale whose GATT enumeration is slow is usable at all.
 */
describe('classifyBleFailure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls a failure after a GATT attempt a wedge suspect, without probing', async () => {
    const err = new Error('le-connection-abort-by-local');
    await classifyBleFailure(err, { gattAttempted: true, probeAdapter: {} as never });
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(h.probeLiveness).not.toHaveBeenCalled();
  });

  it('calls it a wedge suspect when we never got far enough to probe', async () => {
    const err = new Error('adapter unavailable');
    await classifyBleFailure(err, { gattAttempted: false, probeAdapter: undefined });
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(h.probeLiveness).not.toHaveBeenCalled();
  });

  it('calls a no-show idle when the radio still sees other advertisers', async () => {
    h.probeLiveness.mockResolvedValue(true);
    const err = new Error('Device not found');
    await classifyBleFailure(err, { gattAttempted: false, probeAdapter: {} as never });
    expect(bleFailureKind(err)).toBe('idle');
  });

  it('calls a no-show a wedge suspect when the radio sees nothing at all', async () => {
    h.probeLiveness.mockResolvedValue(false);
    const err = new Error('Device not found');
    await classifyBleFailure(err, { gattAttempted: false, probeAdapter: {} as never });
    expect(bleFailureKind(err)).toBe('wedge-suspect');
  });

  it('leaves an already tagged error alone', async () => {
    const err = new Error('Device not found');
    await classifyBleFailure(err, { gattAttempted: true, probeAdapter: {} as never });
    await classifyBleFailure(err, { gattAttempted: false, probeAdapter: {} as never });
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(h.probeLiveness).not.toHaveBeenCalled();
  });

  it('tags nothing during a shutdown', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = new Error('Device not found');
    await classifyBleFailure(err, {
      gattAttempted: false,
      probeAdapter: {} as never,
      abortSignal: ac.signal,
    });
    expect(bleFailureKind(err)).toBeUndefined();
  });
});

describe('buildCharMapWithRetry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the first map when nothing is missing', async () => {
    const map = new Map([['a', {} as never]]);
    h.buildCharMap.mockResolvedValue(map);
    const result = await buildCharMapWithRetry({} as never, () => []);
    expect(result).toBe(map);
    expect(h.buildCharMap).toHaveBeenCalledTimes(1);
  });

  it('rebuilds until the missing characteristic appears', async () => {
    const partial = new Map([['a', {} as never]]);
    const complete = new Map([
      ['a', {} as never],
      ['b', {} as never],
    ]);
    h.buildCharMap.mockResolvedValueOnce(partial).mockResolvedValue(complete);

    const result = await buildCharMapWithRetry({} as never, (m) => (m.has('b') ? [] : ['b']));
    expect(result).toBe(complete);
    expect(h.buildCharMap).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('gives up and returns what it has rather than failing the session', async () => {
    const partial = new Map([['a', {} as never]]);
    h.buildCharMap.mockResolvedValue(partial);

    const result = await buildCharMapWithRetry({} as never, () => ['b']);
    // The incomplete map is returned: an adapter may still work with what was
    // discovered, and failing here would turn a slow enumeration into no
    // reading at all.
    expect(result).toBe(partial);
    expect(h.buildCharMap.mock.calls.length).toBeGreaterThan(1);
  }, 20_000);
});
