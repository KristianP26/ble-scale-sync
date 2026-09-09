import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

vi.mock('dbus-next', () => ({
  Variant: class {
    constructor(
      public signature: string,
      public value: unknown,
    ) {}
  },
  interface: {
    Interface: class {
      constructor(_name?: string) {}
      static configureMembers(): void {}
    },
    ACCESS_READWRITE: 'readwrite',
  },
  DBusError: class extends Error {},
}));

vi.mock('node-ble', () => ({ default: { createBluetooth: vi.fn() } }));

const { _internals } = await import('../../../src/ble/handler-node-ble/index.js');

interface MockDevice {
  helper: EventEmitter & {
    prop: ReturnType<typeof vi.fn>;
    callMethod: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    removeListeners: ReturnType<typeof vi.fn>;
    object: string;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeDevice(label: string, connectBehavior: () => Promise<void>): MockDevice {
  const helper = new EventEmitter() as MockDevice['helper'];
  helper.prop = vi.fn(async (name: string) => (name === 'RSSI' ? -55 : undefined));
  helper.callMethod = vi.fn(async () => undefined);
  helper.set = vi.fn(async () => undefined);
  // What releaseDeviceProxy() actually calls; the label makes failures readable.
  helper.removeListeners = vi.fn(() => undefined);
  helper.object = `/org/bluez/hci0/${label}`;
  return {
    helper,
    connect: vi.fn(connectBehavior),
    disconnect: vi.fn(async () => undefined),
  };
}

/**
 * #404. `device = await connectWithRecovery(...)` does not run when the call
 * throws, so teardownSession releases the proxy it passed IN. Every proxy the
 * retry loop acquired after that is dropped with its D-Bus match rule and its
 * bus listener still registered - once per failed connect cycle.
 */
describe('connectWithRecovery proxy ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('releases the proxy it acquired when every attempt fails', async () => {
    const initialDevice = makeDevice('initial', async () => {
      throw new Error('br-connection-canceled');
    });
    const reAcquired = makeDevice('reacquired', async () => {
      throw new Error('br-connection-canceled');
    });
    const btAdapter = {
      helper: (() => {
        const h = new EventEmitter() as MockDevice['helper'];
        h.prop = vi.fn(async () => -55);
        h.callMethod = vi.fn(async () => undefined);
        h.set = vi.fn(async () => undefined);
        h.removeListeners = vi.fn();
        h.object = '/org/bluez/hci0';
        return h;
      })(),
      isDiscovering: vi.fn(async () => false),
      startDiscovery: vi.fn(async () => undefined),
      stopDiscovery: vi.fn(async () => undefined),
      waitDevice: vi.fn(async () => reAcquired),
      // Distinct from the re-acquired proxy: removeDevice() fetches and
      // releases its own, and that must not be mistaken for this fix.
      getDevice: vi.fn(async () => makeDevice('removeDevice', async () => undefined)),
    };

    await expect(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: initialDevice as never,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/Connection failed/);

    // The proxy the retry loop ended up holding is handed back. Before this it
    // was simply dropped, with its match rule and listener still registered.
    expect(reAcquired.helper.removeListeners).toHaveBeenCalled();
    // The initial proxy was superseded by the re-discovery, and that path
    // already released it.
    expect(initialDevice.helper.removeListeners).toHaveBeenCalled();
  });

  it('leaves the caller-owned proxy alone when it never acquired one of its own', async () => {
    const initialDevice = makeDevice('initial', async () => {
      throw new Error('br-connection-canceled');
    });
    const btAdapter = {
      helper: (() => {
        const h = new EventEmitter() as MockDevice['helper'];
        h.prop = vi.fn(async () => -55);
        h.callMethod = vi.fn(async () => undefined);
        h.set = vi.fn(async () => undefined);
        h.removeListeners = vi.fn();
        h.object = '/org/bluez/hci0';
        return h;
      })(),
      isDiscovering: vi.fn(async () => false),
      startDiscovery: vi.fn(async () => undefined),
      stopDiscovery: vi.fn(async () => undefined),
      waitDevice: vi.fn(async () => initialDevice),
      getDevice: vi.fn(async () => initialDevice),
    };

    await expect(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: initialDevice as never,
        maxRetries: 0,
      }),
    ).rejects.toThrow(/Connection failed/);

    // teardownSession releases this one; releasing it here too would be a
    // second owner for the same proxy.
    expect(initialDevice.helper.removeListeners).not.toHaveBeenCalled();
  });

  it('does not release the proxy it returns on success', async () => {
    const initialDevice = makeDevice('initial', async () => undefined);
    const btAdapter = {
      helper: (() => {
        const h = new EventEmitter() as MockDevice['helper'];
        h.prop = vi.fn(async () => -55);
        h.callMethod = vi.fn(async () => undefined);
        h.set = vi.fn(async () => undefined);
        h.removeListeners = vi.fn();
        h.object = '/org/bluez/hci0';
        return h;
      })(),
      isDiscovering: vi.fn(async () => false),
      startDiscovery: vi.fn(async () => undefined),
      stopDiscovery: vi.fn(async () => undefined),
      waitDevice: vi.fn(async () => initialDevice),
      getDevice: vi.fn(async () => initialDevice),
    };

    const device = await _internals.connectWithRecovery({
      btAdapter: btAdapter as never,
      mac: 'AA:BB:CC:DD:EE:FF',
      initialDevice: initialDevice as never,
      maxRetries: 0,
    });

    expect(device).toBe(initialDevice as never);
    expect(initialDevice.helper.removeListeners).not.toHaveBeenCalled();
  });
});
