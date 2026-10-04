import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * node-ble's `Adapter.getDevice()` returns a BRAND NEW Device every call, and a
 * Device's BusHelper is built with `usePropsEvents: true`, so the first property
 * read registers a listener on the bus-wide signal emitter and adds a D-Bus
 * match rule. Anything that creates a proxy just to read a property has to hand
 * it back, or a continuous run in a busy room grows both without bound: first
 * `MaxListenersExceededWarning ... 11 listeners added` per device path (#397),
 * then `org.freedesktop.DBus.Error.LimitsExceeded` and a dead process (#396).
 *
 * The one proxy that must NOT be released is the matched device, which the
 * caller goes on to use.
 */

const released: string[] = [];

vi.mock('../../../src/ble/handler-node-ble/dbus.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/handler-node-ble/dbus.js')>();
  return {
    ...actual,
    helperOf: (obj: { helper?: unknown }) => obj.helper,
    getDbusNext: async () => ({ Variant: class {} }),
    releaseDeviceProxy: (dev: { id: string }) => {
      released.push(dev.id);
    },
  };
});

vi.mock('../../../src/ble/handler-node-ble/connection.js', () => ({
  getAdapter: vi.fn(),
  resetConnection: vi.fn(),
  parseHciIndex: () => 0,
  currentConnectionGeneration: () => 0,
}));

vi.mock('../../../src/ble/handler-node-ble/device-object.js', () => ({
  logAdvertisementSnapshot: vi.fn(async () => ({})),
}));

const resolveAdapter = vi.fn();
vi.mock('../../../src/scales/resolve.js', () => ({
  resolveAdapter: (...args: unknown[]) => resolveAdapter(...args),
}));

const { makeLivenessAdapter } = await import('../../../src/ble/handler-node-ble/liveness.js');
const { logAdvertisementSnapshot } =
  await import('../../../src/ble/handler-node-ble/device-object.js');
const { autoDiscover, removeDevice } =
  await import('../../../src/ble/handler-node-ble/discovery.js');

function device(id: string, opts: { rssi?: unknown; name?: string; paired?: boolean } = {}) {
  return {
    id,
    getName: async () => opts.name ?? id,
    isPaired: async () => opts.paired ?? false,
    helper: {
      prop: async (n: string) => {
        if (n === 'RSSI') return opts.rssi;
        return undefined;
      },
      callMethod: vi.fn(async () => undefined),
      object: '/org/bluez/hci0',
    },
  };
}

beforeEach(() => {
  released.length = 0;
  resolveAdapter.mockReset();
});

describe('liveness probe proxy release (#396, #397)', () => {
  it('releases the throwaway proxy after reading RSSI', async () => {
    const la = makeLivenessAdapter({
      devices: async () => ['AA:BB:CC:DD:EE:01'],
      getDevice: async (addr: string) => device(addr, { rssi: -55 }),
    } as never);

    await expect(la.rssiOf('AA:BB:CC:DD:EE:01')).resolves.toBe(-55);
    expect(released).toEqual(['AA:BB:CC:DD:EE:01']);
  });

  it('releases the proxy even when the property read throws', async () => {
    const la = makeLivenessAdapter({
      devices: async () => [],
      getDevice: async (addr: string) => ({
        id: addr,
        helper: {
          prop: async () => {
            throw new Error('No such property RSSI');
          },
        },
      }),
    } as never);

    await expect(la.rssiOf('AA:BB:CC:DD:EE:02')).resolves.toBeUndefined();
    expect(released).toEqual(['AA:BB:CC:DD:EE:02']);
  });

  // Guards the undefined check, not the release: a bare
  // `finally { releaseDeviceProxy(dev) }` would throw here on a proxy that was
  // never created.
  it('does not try to release a proxy that was never created', async () => {
    const la = makeLivenessAdapter({
      devices: async () => [],
      getDevice: async () => {
        throw new Error('Device not found');
      },
    } as never);

    await expect(la.rssiOf('AA:BB:CC:DD:EE:03')).resolves.toBeUndefined();
    expect(released).toEqual([]);
  });
});

describe('autoDiscover proxy release (#396, #397)', () => {
  const adapterFor = (addresses: string[], names: Record<string, string> = {}) =>
    ({
      devices: async () => addresses,
      getDevice: async (addr: string) => device(addr, { name: names[addr] ?? addr }),
    }) as never;

  it('keeps the matched device and releases every other proxy', async () => {
    const scale = { name: 'Test Scale' };
    resolveAdapter.mockImplementation((info: { localName: string }) =>
      info.localName === 'scale' ? scale : undefined,
    );

    const result = await autoDiscover(
      adapterFor(['AA:01', 'AA:02', 'AA:03'], { 'AA:02': 'scale' }),
      [],
    );

    expect(result.mac).toBe('AA:02');
    expect(released).toEqual(['AA:01']);
    expect(released).not.toContain('AA:02');
  });

  it('releases a proxy whose device has no name', async () => {
    resolveAdapter.mockReturnValue({ name: 'Test Scale' });
    const btAdapter = {
      devices: async () => ['AA:04', 'AA:05'],
      getDevice: async (addr: string) => device(addr, { name: addr === 'AA:04' ? '' : 'named' }),
    } as never;

    await autoDiscover(btAdapter, []);
    expect(released).toContain('AA:04');
  });
});

/**
 * A Device1 object can exist before its scan response has been merged in: the
 * kernel sends a held ADV_IND on alone when another address reports first, so
 * a scale whose name is in the scan response shows up nameless for a moment
 * (A-05). autoDiscover used to write an address off on its first look.
 */
describe('autoDiscover second look at an incomplete device (A-05)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Settles to the matched MAC, or to the error text. */
  function discover(btAdapter: never): Promise<string> {
    return autoDiscover(btAdapter, []).then(
      (r) => r.mac,
      (e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  it('matches a scale whose name arrived after the first poll', async () => {
    resolveAdapter.mockImplementation((info: { localName: string }) =>
      info.localName === 'scale' ? { name: 'Test Scale' } : undefined,
    );
    let looks = 0;
    const btAdapter = {
      devices: async () => ['AA:06'],
      getDevice: async (addr: string) => device(addr, { name: looks++ === 0 ? '' : 'scale' }),
    } as never;

    const found = discover(btAdapter);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(await found).toBe('AA:06');
  });

  it('matches a named scale whose advertisement data arrived after the first poll', async () => {
    const manufacturerData = { id: 0x0611, data: Buffer.alloc(0) };
    resolveAdapter.mockImplementation((info: { manufacturerData?: unknown }) =>
      info.manufacturerData ? { name: 'Test Scale' } : undefined,
    );
    vi.mocked(logAdvertisementSnapshot)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValue({ manufacturerData } as never);
    const btAdapter = {
      devices: async () => ['AA:07'],
      getDevice: async (addr: string) => device(addr, { name: '108' }),
    } as never;

    const found = discover(btAdapter);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(await found).toBe('AA:07');
    vi.mocked(logAdvertisementSnapshot)
      .mockReset()
      .mockResolvedValue({} as never);
  });

  it('stops looking at a device that never gets a name', async () => {
    // Every look costs a proxy and a match rule, and many neighbours never
    // advertise a name at all, so the second look is bounded.
    resolveAdapter.mockReturnValue(undefined);
    let looks = 0;
    const btAdapter = {
      devices: async () => ['AA:08'],
      getDevice: async (addr: string) => {
        looks++;
        return device(addr, { name: '' });
      },
    } as never;

    const found = discover(btAdapter);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(await found).toMatch(/^error: No recognized scale/);
    expect(looks).toBe(5);
    expect(released.filter((id) => id === 'AA:08')).toHaveLength(5);
  });
});

describe('removeDevice proxy release (#396, #397)', () => {
  // Same guard as above on the other call site: the probe does not exist, so
  // there is nothing to hand back and nothing may be attempted.
  it('does not try to release a probe the cache lookup never produced', async () => {
    const btAdapter = {
      getDevice: async () => {
        throw new Error('Device not found');
      },
      helper: { callMethod: vi.fn(async () => undefined), object: '/org/bluez/hci0' },
    } as never;

    await removeDevice(btAdapter, 'AA:BB:CC:DD:EE:06');
    expect(released).toEqual([]);
  });

  it('releases the isPaired probe when the device is in the cache', async () => {
    const btAdapter = {
      getDevice: async (addr: string) => device(addr, { paired: false }),
      helper: { callMethod: vi.fn(async () => undefined), object: '/org/bluez/hci0' },
    } as never;

    await removeDevice(btAdapter, 'AA:BB:CC:DD:EE:07');
    expect(released).toEqual(['AA:BB:CC:DD:EE:07']);
  });
});
