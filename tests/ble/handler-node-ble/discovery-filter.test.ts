import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/**
 * BlueZ applies a discovery filter to the scan it starts, so DuplicateData has
 * to be requested BEFORE StartDiscovery. Setting it afterwards, which is what
 * the broadcast path used to do, leaves the running scan deduplicating: BlueZ
 * keeps handing back the first advertisement it cached and a broadcast scale
 * reads as one frozen weight while the vendor app shows it counting up (#372).
 *
 * The second half of the same problem, and the reason these tests drive
 * `callMethod` rather than a stubbed `startDiscovery`: node-ble's own
 * `Adapter.startDiscovery()` sets a Transport-only filter of its own right
 * before StartDiscovery, and BlueZ REPLACES the filter dict rather than merging
 * into it, so calling ours and then node-ble's put the scan straight back to
 * deduplicating. A test that stubs `startDiscovery` cannot see that at all,
 * which is how it shipped (#397).
 */

const nodeRequire = createRequire(import.meta.url);

const calls: string[] = [];
const recordCall = async (name: string): Promise<void> => {
  calls.push(`filter:${name}`);
};
const callMethod = vi.fn(recordCall);

vi.mock('../../../src/ble/handler-node-ble/dbus.js', () => ({
  helperOf: () => ({ callMethod }),
  releaseDeviceProxy: vi.fn(),
  getDbusNext: async () => ({
    Variant: class {
      constructor(
        readonly sig: string,
        readonly value: unknown,
      ) {}
    },
  }),
}));

vi.mock('../../../src/ble/handler-node-ble/connection.js', () => ({
  getAdapter: vi.fn(),
  resetConnection: vi.fn(),
  parseHciIndex: () => 0,
  currentConnectionGeneration: () => 0,
}));

vi.mock('../../../src/ble/handler-node-ble/device-object.js', () => ({
  logAdvertisementSnapshot: vi.fn(),
}));

const { startDiscoverySafe, _resetDiscoveryFilterLatch } =
  await import('../../../src/ble/handler-node-ble/discovery.js');

/**
 * Only `isDiscovering` is node-ble's; everything else must reach BlueZ through
 * `callMethod`. `startDiscovery` is deliberately a throwing stub: if production
 * code ever reaches for node-ble's version again, these tests fail loudly
 * instead of quietly re-introducing the filter clobber.
 */
function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    isDiscovering: vi.fn(async () => false),
    startDiscovery: vi.fn(async () => {
      throw new Error("node-ble's startDiscovery must not be used: it overwrites the filter");
    }),
    ...overrides,
  } as never;
}

describe('startDiscoverySafe discovery filter (#372, #397)', () => {
  beforeEach(() => {
    calls.length = 0;
    // mockClear alone would leave a previous test's implementation in place.
    callMethod.mockReset();
    callMethod.mockImplementation(recordCall);
    // Module state: which running scan already carries the filter.
    _resetDiscoveryFilterLatch();
  });

  it('sets the duplicate filter before starting discovery, not after', async () => {
    await startDiscoverySafe(makeAdapter());
    expect(calls).toEqual(['filter:SetDiscoveryFilter', 'filter:StartDiscovery']);
  });

  it('asks for LE transport and duplicate advertisements', async () => {
    await startDiscoverySafe(makeAdapter());
    const [, args] = callMethod.mock.calls[0] as [string, Record<string, { value: unknown }>];
    expect(args.Transport.value).toBe('le');
    expect(args.DuplicateData.value).toBe(true);
  });

  it('never lets a second SetDiscoveryFilter land after StartDiscovery', async () => {
    await startDiscoverySafe(makeAdapter());
    const startedAt = calls.indexOf('filter:StartDiscovery');
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(calls.slice(startedAt)).not.toContain('filter:SetDiscoveryFilter');
  });

  it('starts the scan anyway when BlueZ rejects the filter', async () => {
    callMethod.mockImplementation(async (name: string) => {
      if (name === 'SetDiscoveryFilter') throw new Error('Invalid arguments');
      calls.push(`filter:${name}`);
    });
    const adapter = makeAdapter();
    await expect(startDiscoverySafe(adapter)).resolves.toBe(adapter);
    expect(calls).toEqual(['filter:StartDiscovery']);
  });

  // A continuous run reuses one BlueZ session across cycles, so without this a
  // scan started before the filter existed stays deduplicating for the life of
  // the process. Safe at this point because no device has been found yet.
  it('cycles an already-running scan so the filter takes effect', async () => {
    const adapter = makeAdapter({ isDiscovering: vi.fn(async () => true) });
    await startDiscoverySafe(adapter);
    expect(calls).toEqual([
      'filter:StopDiscovery',
      'filter:SetDiscoveryFilter',
      'filter:StartDiscovery',
    ]);
  });

  // Cycling the scan is a one-time correction, not a per-cycle habit. Repeating
  // it every cycle drops BlueZ's Device1 objects (#297) and opens a window with
  // the radio not scanning, which is what a reporter saw nine cycles running
  // while his scale was never found (#397).
  it('does not cycle a scan it already started with the filter', async () => {
    let discovering = false;
    callMethod.mockImplementation(async (name: string) => {
      calls.push(`filter:${name}`);
      if (name === 'StartDiscovery') discovering = true;
      if (name === 'StopDiscovery') discovering = false;
    });
    const adapter = makeAdapter({ isDiscovering: vi.fn(async () => discovering) });

    await startDiscoverySafe(adapter);
    calls.length = 0;
    await startDiscoverySafe(adapter);

    expect(calls).toEqual([]);
  });

  // A scan BlueZ refused the filter for is not a filtered scan, so the next
  // cycle has to try again rather than latch a lie.
  it('does not latch when BlueZ rejected the filter', async () => {
    let discovering = false;
    callMethod.mockImplementation(async (name: string) => {
      if (name === 'SetDiscoveryFilter') throw new Error('Invalid arguments');
      calls.push(`filter:${name}`);
      if (name === 'StartDiscovery') discovering = true;
      if (name === 'StopDiscovery') discovering = false;
    });
    const adapter = makeAdapter({ isDiscovering: vi.fn(async () => discovering) });

    await startDiscoverySafe(adapter);
    calls.length = 0;
    await startDiscoverySafe(adapter);

    expect(calls).toContain('filter:StopDiscovery');
  });
});

/**
 * Guards the reason the code above bypasses node-ble. If a future node-ble drops
 * the SetDiscoveryFilter call from startDiscovery, this fails and the bypass can
 * be reconsidered; while it keeps it, the bypass stays load-bearing.
 */
describe('node-ble startDiscovery clobbers the filter (#397)', () => {
  it('still sets its own Transport-only filter immediately before StartDiscovery', () => {
    const src = readFileSync(nodeRequire.resolve('node-ble/src/Adapter.js'), 'utf-8');
    const body = /async startDiscovery \(\)[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(body).toContain('SetDiscoveryFilter');
    expect(body).toContain('StartDiscovery');
    expect(body).not.toContain('DuplicateData');
    expect(body.indexOf('SetDiscoveryFilter')).toBeLessThan(body.indexOf("'StartDiscovery'"));
  });
});
