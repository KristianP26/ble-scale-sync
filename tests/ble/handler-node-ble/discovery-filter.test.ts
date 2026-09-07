import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BlueZ applies a discovery filter to the scan it starts, so DuplicateData has
 * to be requested BEFORE StartDiscovery. Setting it afterwards, which is what
 * the broadcast path used to do, leaves the running scan deduplicating: BlueZ
 * keeps handing back the first advertisement it cached and a broadcast scale
 * reads as one frozen weight while the vendor app shows it counting up (#372).
 */

const calls: string[] = [];
const callMethod = vi.fn(async (name: string) => {
  calls.push(`filter:${name}`);
});

vi.mock('../../../src/ble/handler-node-ble/dbus.js', () => ({
  helperOf: () => ({ callMethod }),
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
}));

vi.mock('../../../src/ble/handler-node-ble/device-object.js', () => ({
  logAdvertisementSnapshot: vi.fn(),
}));

const { startDiscoverySafe } = await import('../../../src/ble/handler-node-ble/discovery.js');

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    startDiscovery: vi.fn(async () => {
      calls.push('startDiscovery');
    }),
    isDiscovering: vi.fn(async () => false),
    ...overrides,
  } as never;
}

describe('startDiscoverySafe discovery filter (#372)', () => {
  beforeEach(() => {
    calls.length = 0;
    callMethod.mockClear();
  });

  it('sets the duplicate filter before starting discovery, not after', async () => {
    const adapter = makeAdapter();
    await startDiscoverySafe(adapter);
    expect(calls).toEqual(['filter:SetDiscoveryFilter', 'startDiscovery']);
  });

  it('asks for LE transport and duplicate advertisements', async () => {
    await startDiscoverySafe(makeAdapter());
    const [, args] = callMethod.mock.calls[0] as [string, Record<string, { value: unknown }>];
    expect(args.Transport.value).toBe('le');
    expect(args.DuplicateData.value).toBe(true);
  });

  it('starts the scan anyway when BlueZ rejects the filter', async () => {
    callMethod.mockRejectedValueOnce(new Error('Invalid arguments'));
    const adapter = makeAdapter();
    await expect(startDiscoverySafe(adapter)).resolves.toBe(adapter);
    expect(calls).toEqual(['startDiscovery']);
  });

  // A continuous run reuses one BlueZ session across cycles, so without this a
  // scan started before the filter existed stays deduplicating for the life of
  // the process. Safe at this point because no device has been found yet.
  it('cycles an already-running scan so the filter takes effect', async () => {
    const adapter = makeAdapter({
      startDiscovery: vi
        .fn()
        .mockRejectedValueOnce(new Error('Discovery already in progress'))
        .mockImplementation(async () => {
          calls.push('startDiscovery');
        }),
      isDiscovering: vi.fn(async () => true),
    });
    await startDiscoverySafe(adapter);
    expect(calls).toEqual([
      'filter:SetDiscoveryFilter',
      'filter:StopDiscovery',
      'filter:SetDiscoveryFilter',
      'startDiscovery',
    ]);
  });
});
