import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const brake = vi.hoisted(() => ({ noteReadingForStaleLink: vi.fn() }));

vi.mock('../../../src/ble/handler-node-ble/stale-link.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/stale-link.js')>();
  return { ...actual, noteReadingForStaleLink: brake.noteReadingForStaleLink };
});

/** When set, startDiscoverySafe answers with it instead of starting discovery. */
const discovery = vi.hoisted(() => ({
  start: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock('../../../src/ble/handler-node-ble/discovery.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/discovery.js')>();
  return {
    ...actual,
    startDiscoverySafe: (...args: Parameters<typeof actual.startDiscoverySafe>) =>
      discovery.start ? discovery.start() : actual.startDiscoverySafe(...args),
  };
});

const { _internals } = await import('../../../src/ble/handler-node-ble/index.js');
const { stopDiscoveryAndQuiesce } = await import('../../../src/ble/handler-node-ble/discovery.js');
const { bleFailureKind } = await import('../../../src/ble/failure-kind.js');
const { bleLog } = await import('../../../src/ble/types.js');
const { setLogLevel, LogLevel } = await import('../../../src/logger.js');

type Helper = EventEmitter & {
  prop: ReturnType<typeof vi.fn>;
  callMethod: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  removeListeners: ReturnType<typeof vi.fn>;
  object: string;
};

function makeHelper(object: string, props: Record<string, unknown> = {}): Helper {
  const h = new EventEmitter() as Helper;
  h.prop = vi.fn(async (name: string) => (name === 'RSSI' ? -55 : props[name]));
  h.callMethod = vi.fn(async () => undefined);
  h.set = vi.fn(async () => undefined);
  h.removeListeners = vi.fn();
  h.object = object;
  return h;
}

const never = (): Promise<void> => new Promise<void>(() => {});

function makeDevice(
  label: string,
  connect: () => Promise<void>,
  disconnect: () => Promise<void>,
  props: Record<string, unknown> = {},
) {
  return {
    helper: makeHelper(`/org/bluez/hci0/${label}`, props),
    connect: vi.fn(connect),
    disconnect: vi.fn(disconnect),
  };
}

function makeAdapter(waitDevice: () => Promise<unknown>) {
  return {
    helper: makeHelper('/org/bluez/hci0'),
    isDiscovering: vi.fn(async () => false),
    startDiscovery: vi.fn(async () => undefined),
    stopDiscovery: vi.fn(async () => undefined),
    waitDevice: vi.fn(waitDevice),
    getDevice: vi.fn(async () => {
      throw new Error('Device not found');
    }),
  };
}

/** Settles to the state of `p` without ever throwing out of the test. */
function track(p: Promise<unknown>): {
  state: () => 'pending' | 'resolved' | 'rejected';
  error: () => unknown;
} {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  let error: unknown;
  p.then(
    () => (state = 'resolved'),
    (err: unknown) => {
      state = 'rejected';
      error = err;
    },
  );
  return { state: () => state, error: () => error };
}

/**
 * #472. After a connect timeout the retry asked BlueZ to Disconnect and waited
 * for the answer with no deadline. BlueZ answers a Disconnect for a device it
 * lists as connected only once that connection is gone, and with a kernel that
 * already dropped it (MGMT status 0x0e, BlueZ < 5.84) that never happens, so the
 * cycle sat there until the 900 s poll deadline, and every cycle after it got an
 * instant "connected" from BlueZ and parked the same way in its teardown.
 */
describe('connectWithRecovery and a Disconnect BlueZ never answers (#472)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    setLogLevel(LogLevel.INFO);
  });

  it('settles when BlueZ never answers the Disconnect after a connect timeout', async () => {
    const device = makeDevice('initial', never, never);
    const btAdapter = makeAdapter(async () => device);
    const result = track(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: device as never,
        maxRetries: 5,
      }),
    );

    await vi.advanceTimersByTimeAsync(31_000 + 11_000);

    expect(result.state()).toBe('rejected');
    expect(String(result.error())).toMatch(/did not complete a Disconnect/);
    expect(bleFailureKind(result.error())).toBe('wedge-suspect');
    // No second attempt: it would "succeed" at once from BlueZ's stale state and
    // then time out waiting for services.
    expect(device.connect).toHaveBeenCalledTimes(1);
    expect(btAdapter.waitDevice).not.toHaveBeenCalled();
  });

  it('releases the proxy the retry loop acquired when its Disconnect never answers', async () => {
    const initial = makeDevice('initial', never, async () => undefined);
    const reAcquired = makeDevice('reacquired', never, never);
    const btAdapter = makeAdapter(async () => reAcquired);
    const result = track(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: initial as never,
        maxRetries: 5,
      }),
    );

    await vi.advanceTimersByTimeAsync(120_000);

    expect(result.state()).toBe('rejected');
    expect(reAcquired.connect).toHaveBeenCalledTimes(1);
    expect(reAcquired.helper.removeListeners).toHaveBeenCalled();
  });

  it('stops waiting for a hung Disconnect on abort', async () => {
    const device = makeDevice('initial', never, never);
    const btAdapter = makeAdapter(async () => device);
    const ctrl = new AbortController();
    const result = track(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: device as never,
        maxRetries: 5,
        abortSignal: ctrl.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(31_000);
    expect(device.disconnect).toHaveBeenCalledTimes(1);
    expect(result.state()).toBe('pending');

    ctrl.abort(new Error('shutdown'));
    await vi.advanceTimersByTimeAsync(100);

    expect(result.state()).toBe('rejected');
    expect(String(result.error())).toMatch(/shutdown/);
    // Nothing after the Disconnect: a RemoveDevice would be one more BlueZ
    // round trip, up to 10 s, inside the 5 s grace.
    expect(btAdapter.getDevice).not.toHaveBeenCalled();
    expect(btAdapter.helper.callMethod).not.toHaveBeenCalledWith('RemoveDevice', expect.anything());
  });

  it('never waits for a StopDiscovery BlueZ does not answer between attempts', async () => {
    let attempts = 0;
    const device = makeDevice(
      'initial',
      async () => {
        attempts++;
        if (attempts === 1) throw new Error('le-connection-abort-by-local');
      },
      async () => undefined,
    );
    const btAdapter = makeAdapter(async () => device);
    btAdapter.stopDiscovery.mockImplementation(never);
    const result = track(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: device as never,
        maxRetries: 5,
      }),
    );

    await vi.advanceTimersByTimeAsync(20_000);

    expect(btAdapter.stopDiscovery).toHaveBeenCalled();
    expect(result.state()).toBe('resolved');
    expect(device.connect).toHaveBeenCalledTimes(2);
  });

  it('gives the debug link check 5 s and then connects anyway', async () => {
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    setLogLevel(LogLevel.DEBUG);
    const device = makeDevice(
      'hung-props',
      async () => undefined,
      async () => undefined,
    );
    device.helper.prop.mockImplementation((name: string) =>
      name === 'RSSI' ? Promise.resolve(-55) : never(),
    );
    const result = track(
      _internals.connectWithRecovery({
        btAdapter: makeAdapter(async () => device) as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: device as never,
        maxRetries: 5,
      }),
    );

    await vi.advanceTimersByTimeAsync(6_000);

    expect(result.state()).toBe('resolved');
    expect(device.connect).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('Link check before connect failed: no answer within 5s');
    debug.mockRestore();
  });

  it('keeps the retry path when the Disconnect is answered', async () => {
    let attempts = 0;
    const device = makeDevice(
      'initial',
      async () => {
        attempts++;
        if (attempts === 1) throw new Error('le-connection-abort-by-local');
      },
      async () => undefined,
    );
    const btAdapter = makeAdapter(async () => device);
    const result = track(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: device as never,
        maxRetries: 5,
      }),
    );

    await vi.advanceTimersByTimeAsync(20_000);

    expect(result.state()).toBe('resolved');
    expect(device.connect).toHaveBeenCalledTimes(2);
    expect(btAdapter.waitDevice).toHaveBeenCalled();
  });

  it('logs the link state before the first connect only with debug on, and never disconnects first', async () => {
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    setLogLevel(LogLevel.DEBUG);
    const withDebug = makeDevice(
      'debug',
      async () => undefined,
      async () => undefined,
      { Connected: true, ServicesResolved: false },
    );
    const first = track(
      _internals.connectWithRecovery({
        btAdapter: makeAdapter(async () => withDebug) as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: withDebug as never,
        maxRetries: 5,
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.state()).toBe('resolved');
    expect(withDebug.disconnect).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      'Link check before connect: Connected=true, ServicesResolved=false',
    );

    setLogLevel(LogLevel.INFO);
    const withoutDebug = makeDevice(
      'plain',
      async () => undefined,
      async () => undefined,
      { Connected: true, ServicesResolved: false },
    );
    const second = track(
      _internals.connectWithRecovery({
        btAdapter: makeAdapter(async () => withoutDebug) as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: withoutDebug as never,
        maxRetries: 5,
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.state()).toBe('resolved');
    const read = withoutDebug.helper.prop.mock.calls.map(([name]) => name);
    expect(read).not.toContain('Connected');
    expect(read).not.toContain('ServicesResolved');
    debug.mockRestore();
  });

  it('does not lift the stale-link brake on a successful connect', async () => {
    // With a stuck link BlueZ answers Connect at once from its own state, so a
    // connect that "worked" says nothing about whether the link is healthy.
    const device = makeDevice(
      'initial',
      async () => undefined,
      async () => undefined,
    );
    const result = track(
      _internals.connectWithRecovery({
        btAdapter: makeAdapter(async () => device) as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: device as never,
        maxRetries: 5,
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.state()).toBe('resolved');
    expect(brake.noteReadingForStaleLink).not.toHaveBeenCalled();
  });
});

/**
 * #472, finding A-1 of the review: a re-discovery in the retry loop that
 * replaced the D-Bus connection kept the new adapter to itself, so the caller's
 * teardown went on talking to BlueZ through proxies on the dropped bus.
 */
describe('connectWithRecovery after a re-discovery replaced the D-Bus connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    discovery.start = undefined;
    vi.useRealTimers();
  });

  it('hands the caller the live adapter and device, and leaves that device to it', async () => {
    const refused = async (): Promise<void> => {
      throw new Error('le-connection-abort-by-local');
    };
    const initial = makeDevice('initial', refused, async () => undefined);
    const fresh = makeDevice('fresh', refused, async () => undefined);
    const oldAdapter = makeAdapter(async () => initial);
    const liveAdapter = makeAdapter(async () => fresh);
    discovery.start = async () => liveAdapter;
    const seen: { btAdapter: unknown; device: unknown }[] = [];

    const result = track(
      _internals.connectWithRecovery({
        btAdapter: oldAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: initial as never,
        maxRetries: 1,
        onLive: (live) => seen.push(live),
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(result.state()).toBe('rejected');
    expect(seen.at(-1)).toEqual({ btAdapter: liveAdapter, device: fresh });
    expect(liveAdapter.waitDevice).toHaveBeenCalled();
    expect(oldAdapter.waitDevice).not.toHaveBeenCalled();
    // The caller's now: its teardown disconnects and releases it.
    expect(fresh.helper.removeListeners).not.toHaveBeenCalled();
    expect(initial.helper.removeListeners).toHaveBeenCalled();
  });

  it('hands the caller the live adapter even when no device can be had on it', async () => {
    // The throw comes before any device swap, so only the adapter change can
    // tell the caller where its teardown has to go.
    const initial = makeDevice(
      'initial',
      async () => {
        throw new Error('le-connection-abort-by-local');
      },
      async () => undefined,
    );
    const oldAdapter = makeAdapter(async () => initial);
    const liveAdapter = makeAdapter(async () => {
      throw new Error('Device not found');
    });
    discovery.start = async () => liveAdapter;
    const seen: { btAdapter: unknown; device: unknown }[] = [];

    const result = track(
      _internals.connectWithRecovery({
        btAdapter: oldAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: initial as never,
        maxRetries: 1,
        onLive: (live) => seen.push(live),
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(result.state()).toBe('rejected');
    expect(String(result.error())).toMatch(/device re-acquisition failed/);
    expect(liveAdapter.getDevice).toHaveBeenCalled();
    expect(seen.at(-1)).toEqual({ btAdapter: liveAdapter, device: initial });
    // Still the caller's proxy: its teardown disconnects and releases it.
    expect(initial.helper.removeListeners).not.toHaveBeenCalled();
  });

  it('hands the caller the device an RSSI re-discovery swapped in, and leaves it to it', async () => {
    const refused = async (): Promise<void> => {
      throw new Error('le-connection-abort-by-local');
    };
    // 127: BlueZ's "no advertisement heard", which sends the loop into the
    // one RSSI re-discovery before its first connect.
    const initial = makeDevice('initial', refused, async () => undefined);
    initial.helper.prop.mockImplementation(async () => 127);
    const fresh = makeDevice('fresh', refused, async () => undefined);
    const btAdapter = makeAdapter(async () => fresh);
    discovery.start = async () => false;
    const seen: { btAdapter: unknown; device: unknown }[] = [];

    const result = track(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: initial as never,
        maxRetries: 0,
        onLive: (live) => seen.push(live),
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(result.state()).toBe('rejected');
    expect(initial.connect).not.toHaveBeenCalled();
    expect(fresh.connect).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual({ btAdapter, device: fresh });
    // The caller's now: its teardown disconnects and releases it.
    expect(fresh.helper.removeListeners).not.toHaveBeenCalled();
    expect(initial.helper.removeListeners).toHaveBeenCalled();
  });

  it('still releases its last proxy on a throw for a caller that does not follow it', async () => {
    const refused = async (): Promise<void> => {
      throw new Error('le-connection-abort-by-local');
    };
    const initial = makeDevice('initial', refused, async () => undefined);
    const fresh = makeDevice('fresh', refused, async () => undefined);
    discovery.start = async () => makeAdapter(async () => fresh);

    const result = track(
      _internals.connectWithRecovery({
        btAdapter: makeAdapter(async () => initial) as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: initial as never,
        maxRetries: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(result.state()).toBe('rejected');
    expect(fresh.helper.removeListeners).toHaveBeenCalled();
  });
});

describe('stopDiscoveryAndQuiesce and a StopDiscovery BlueZ never answers (#472)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives up on it after 10 s and goes on to the quiesce', async () => {
    // BlueZ answers StopDiscovery only once the kernel's Stop Discovery
    // completes; before the deadline a parked one held the cycle until the
    // poll deadline, right before the connect.
    const btAdapter = makeAdapter(async () => undefined);
    btAdapter.stopDiscovery.mockImplementation(never);
    const result = track(stopDiscoveryAndQuiesce(btAdapter as never));

    await vi.advanceTimersByTimeAsync(9_000);
    expect(result.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(result.state()).toBe('resolved');
  });
});
