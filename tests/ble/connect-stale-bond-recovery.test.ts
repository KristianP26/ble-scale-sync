import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Adapter, Device } from '../../src/ble/handler-node-ble/dbus.js';

const removeDevice = vi.fn(async (..._args: unknown[]) => 'removed');
const discovery = vi.hoisted(() => ({ next: undefined as unknown }));

vi.mock('../../src/ble/handler-node-ble/discovery.js', () => ({
  removeDevice: (...args: unknown[]) => removeDevice(...args),
  startDiscoverySafe: vi.fn(async () => {
    const next = discovery.next;
    discovery.next = undefined;
    return next;
  }),
  stopDiscoveryAndQuiesce: vi.fn(async () => undefined),
  notifyDiscoveryStopped: vi.fn(),
  withBluezDeadline: <T>(p: Promise<T>) => p,
}));

vi.mock('../../src/ble/handler-node-ble/freshness.js', () => ({
  startPeerFreshnessTracker: () => ({ stop: () => {}, isFresh: async () => true }),
}));

vi.mock('../../src/ble/handler-node-ble/device-object.js', () => ({
  isDeviceObjectGone: () => false,
}));

const { connectWithRecovery } = await import('../../src/ble/handler-node-ble/connect.js');
const { _resetLinkObserverForTests } =
  await import('../../src/ble/handler-node-ble/link-observer.js');
const { bleLog } = await import('../../src/ble/types.js');

const MAC = 'AA:BB:CC:DD:EE:FF';
const AUTH = 'org.bluez.Reason.Authentication';

/** When Connected goes true, and when the Connect call fails, after it is made. */
const UP_AT_MS = 300;
const ERROR_AT_MS = 1000;

/**
 * One Connect call. `abort` fails with le-connection-abort-by-local; with `up`
 * the connection comes up first and goes down `downMs` after the error, or,
 * with `downOn: 'disconnect'`, 90 ms after our Disconnect. `reason` is what
 * BlueZ 5.83 sends in Device1.Disconnected right before Connected=false.
 */
type Step =
  | { kind: 'ok' }
  | { kind: 'timeout' }
  | { kind: 'abort'; up?: boolean; downMs?: number; downOn?: 'disconnect'; reason?: string };

const ok: Step = { kind: 'ok' };
const timeout: Step = { kind: 'timeout' };
const abort = (s: Omit<Extract<Step, { kind: 'abort' }>, 'kind'> = {}): Step => ({
  kind: 'abort',
  ...s,
});
const times = (n: number, step: Step): Step[] => Array.from({ length: n }, () => step);

interface Scale {
  device: Device;
  helper: EventEmitter;
  iface: EventEmitter;
  getProxyObject: ReturnType<typeof vi.fn>;
  connectCalls: number[];
  probeCalls: number[];
}

/**
 * A scale on a fake BlueZ. `bluez583` makes the device object declare
 * Device1.Disconnected; BlueZ 5.82 declares no such signal.
 */
function makeScale(opts: {
  steps: Step[];
  bluez583?: boolean;
  paired?: boolean;
  probe?: () => Promise<unknown>;
}): Scale {
  const steps = [...opts.steps];
  const helper = new EventEmitter() as EventEmitter & {
    object: string;
    dbus: { getProxyObject: ReturnType<typeof vi.fn> };
  };
  helper.object = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';
  const iface = new EventEmitter() as EventEmitter & { $signals: unknown[] };
  iface.$signals = opts.bluez583 ? [{ name: 'Disconnected', signature: 'ss' }] : [];
  const probeCalls: number[] = [];
  const getProxyObject = vi.fn((..._args: unknown[]) => {
    probeCalls.push(Date.now());
    return opts.probe ? opts.probe() : Promise.resolve({ getInterface: () => iface });
  });
  helper.dbus = { getProxyObject };

  let linkUp = false;
  let pendingReason: string | undefined;
  let waiters: (() => void)[] = [];
  const goDown = (): void => {
    if (!linkUp) return;
    linkUp = false;
    if (pendingReason !== undefined) iface.emit('Disconnected', pendingReason, 'from the fake');
    helper.emit('PropertiesChanged', { Connected: { signature: 'b', value: false } });
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  };
  const goUp = (): void => {
    linkUp = true;
    helper.emit('PropertiesChanged', { Connected: { signature: 'b', value: true } });
  };
  let downOnDisconnect = false;

  const connectCalls: number[] = [];
  const device = {
    helper,
    connect: vi.fn(() => {
      connectCalls.push(Date.now());
      const step = steps.shift() ?? opts.steps[opts.steps.length - 1];
      if (step.kind === 'timeout') return new Promise<void>(() => {});
      if (step.kind === 'ok') {
        return new Promise<void>((resolve) => {
          setTimeout(goUp, UP_AT_MS);
          setTimeout(resolve, UP_AT_MS + 100);
        });
      }
      pendingReason = opts.bluez583 ? step.reason : undefined;
      downOnDisconnect = step.downOn === 'disconnect';
      return new Promise<void>((_resolve, reject) => {
        if (step.up) setTimeout(goUp, UP_AT_MS);
        setTimeout(() => {
          reject(new Error('le-connection-abort-by-local'));
          if (step.up && step.downMs !== undefined) setTimeout(goDown, step.downMs);
        }, ERROR_AT_MS);
      });
    }),
    // BlueZ answers a Disconnect for a connected device only once the
    // connection is gone, and node-ble then drops the helper's listeners.
    disconnect: vi.fn(async () => {
      if (linkUp) {
        if (downOnDisconnect) setTimeout(goDown, 90);
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      helper.removeAllListeners('PropertiesChanged');
    }),
    isPaired: vi.fn(async () => opts.paired ?? true),
  } as unknown as Device;
  return { device, helper, iface, getProxyObject, connectCalls, probeCalls };
}

function makeAdapter(device: Device): Adapter {
  return {
    waitDevice: vi.fn(async () => device),
    getDevice: vi.fn(async () => device),
    stopDiscovery: vi.fn(async () => undefined),
  } as unknown as Adapter;
}

interface Outcome {
  result: string;
  endedAt: number;
}

function run(
  scale: Scale,
  opts: { autoClear?: boolean; abortSignal?: AbortSignal; btAdapter?: Adapter } = {},
): Promise<Outcome> {
  return connectWithRecovery({
    btAdapter: opts.btAdapter ?? makeAdapter(scale.device),
    mac: MAC,
    initialDevice: scale.device,
    maxRetries: 5,
    ...(opts.autoClear === undefined ? {} : { autoClearStaleBond: opts.autoClear }),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  }).then(
    () => ({ result: 'connected', endedAt: Date.now() }),
    (err: unknown) => ({ result: (err as Error).message, endedAt: Date.now() }),
  );
}

/** Drive the retry loop on fake time until it settles. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  return p;
}

let debug: ReturnType<typeof vi.spyOn>;
const debugLines = (): string[] => debug.mock.calls.map((c: unknown[]) => String(c[0]));
const attemptLine = (n: number): string | undefined =>
  debugLines().find((l) => l.startsWith(`Connect attempt ${n}/6 failed`));

beforeEach(() => {
  removeDevice.mockClear();
  discovery.next = undefined;
  vi.useFakeTimers();
  _resetLinkObserverForTests(() => Date.now());
  debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  vi.spyOn(bleLog, 'info').mockImplementation(() => {});
  vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetLinkObserverForTests();
});

describe('how each failed connect ended (#471, D066)', () => {
  it('logs, per attempt, when the connection came up and how long it outlived the error', async () => {
    const scale = makeScale({ steps: times(6, abort({ up: true, downMs: 95 })) });
    await drive(run(scale));
    expect(attemptLine(1)).toBe(
      'Connect attempt 1/6 failed after 1000 ms (le-connection-abort-by-local): the connection ' +
        'came up after 300 ms and stayed up 95 ms after the error, as it does when this host ' +
        'gives up on a refused pairing key',
    );
    for (let n = 2; n <= 6; n++) expect(attemptLine(n)).toContain('stayed up 95 ms');
  });

  it('says when the connection never came up', async () => {
    const scale = makeScale({ steps: times(6, abort()) });
    await drive(run(scale));
    for (let n = 1; n <= 6; n++) {
      expect(attemptLine(n)).toMatch(/: the connection never came up$/);
    }
  });

  it('adds no line to a timeout that never got a connection', async () => {
    const scale = makeScale({ steps: [timeout, ok] });
    expect((await drive(run(scale))).result).toBe('connected');
    expect(attemptLine(1)).toBeUndefined();
  });

  it('reads the reason BlueZ sends with its answer to the retry Disconnect', async () => {
    const scale = makeScale({
      steps: times(6, abort({ up: true, downOn: 'disconnect', reason: AUTH })),
      bluez583: true,
    });
    await drive(run(scale));
    expect(attemptLine(2)).toContain(`BlueZ: ${AUTH}, the scale refused the stored pairing key`);
  });

  it('waits for the reason on the last attempt, which BlueZ sends after the error', async () => {
    const scale = makeScale({
      steps: times(6, abort({ up: true, downMs: 95, reason: AUTH })),
      bluez583: true,
    });
    await drive(run(scale));
    expect(attemptLine(6)).toContain(`BlueZ: ${AUTH}`);
  });

  it('waits no longer than 1.5 s for the last connection to go down', async () => {
    const scale = makeScale({ steps: times(6, abort({ up: true, downMs: 2000 })) });
    const { endedAt } = await drive(run(scale));
    const lastError = scale.connectCalls[5] + ERROR_AT_MS;
    expect(endedAt - lastError).toBeGreaterThanOrEqual(1500);
    expect(endedAt - lastError).toBeLessThanOrEqual(1600);
    expect(attemptLine(5)).toContain('went down 2000 ms after the error');
    expect(attemptLine(6)).toContain('was not seen going down after the error');
  });
});

describe('the reason probe (#471, D066)', () => {
  it('asks for no reasons when the first attempt connects', async () => {
    const scale = makeScale({ steps: [ok], bluez583: true });
    expect((await drive(run(scale))).result).toBe('connected');
    expect(scale.getProxyObject).not.toHaveBeenCalled();
  });

  it('asks for no reasons when no attempt ever gets a connection', async () => {
    const scale = makeScale({ steps: times(6, abort()), bluez583: true });
    await drive(run(scale));
    expect(scale.getProxyObject).not.toHaveBeenCalled();
  });

  it('asks from the attempt after the first connection that came up and failed', async () => {
    const scale = makeScale({
      steps: [abort(), abort({ up: true, downMs: 95 }), ok],
      bluez583: true,
    });
    await drive(run(scale));
    expect(scale.getProxyObject).toHaveBeenCalledTimes(1);
    expect(scale.probeCalls[0]).toBeGreaterThan(scale.connectCalls[1]);
    expect(scale.probeCalls[0]).toBeLessThanOrEqual(scale.connectCalls[2]);
  });

  it('does not hold up the connect when the probe never answers', async () => {
    const scale = makeScale({
      steps: [abort({ up: true, downMs: 95 }), ok],
      bluez583: true,
      probe: () => new Promise(() => {}),
    });
    expect((await drive(run(scale))).result).toBe('connected');
    expect(scale.connectCalls[1] - scale.probeCalls[0]).toBeLessThanOrEqual(2000);
  });

  it('goes on at once when the probe fails on a replaced D-Bus connection', async () => {
    const scale = makeScale({
      steps: [abort({ up: true, downMs: 95 }), ok],
      bluez583: true,
      probe: async () => {
        throw Object.assign(new Error('The D-Bus connection closed'), {
          type: 'org.freedesktop.DBus.Error.Disconnected',
        });
      },
    });
    expect((await drive(run(scale))).result).toBe('connected');
    expect(scale.connectCalls[1] - scale.probeCalls[0]).toBe(0);
  });

  it('does not connect when a shutdown comes during the probe', async () => {
    const ac = new AbortController();
    const scale = makeScale({
      steps: [abort({ up: true, downMs: 95 }), ok],
      bluez583: true,
      probe: () => {
        ac.abort(new Error('shutting down'));
        return new Promise(() => {});
      },
    });
    const { result } = await drive(run(scale, { abortSignal: ac.signal }));
    expect(result).toBe('shutting down');
    expect(scale.device.connect).toHaveBeenCalledTimes(1);
  });

  it('probes the bus of the device the retry moved to', async () => {
    const first = makeScale({ steps: [abort({ up: true, downMs: 95 })], bluez583: true });
    const second = makeScale({ steps: [ok], bluez583: true });
    discovery.next = makeAdapter(second.device);
    expect((await drive(run(first))).result).toBe('connected');
    expect(second.getProxyObject).toHaveBeenCalledTimes(1);
    expect(first.getProxyObject).not.toHaveBeenCalled();
  });

  it('leaves no listener on the device or on Device1', async () => {
    const failing = makeScale({
      steps: times(6, abort({ up: true, downMs: 95, reason: AUTH })),
      bluez583: true,
    });
    await drive(run(failing));
    expect(failing.helper.listenerCount('PropertiesChanged')).toBe(0);
    expect(failing.iface.listenerCount('Disconnected')).toBe(0);

    const working = makeScale({
      steps: [abort({ up: true, downMs: 95, reason: AUTH }), ok],
      bluez583: true,
    });
    expect((await drive(run(working))).result).toBe('connected');
    expect(working.helper.listenerCount('PropertiesChanged')).toBe(0);
    expect(working.iface.listenerCount('Disconnected')).toBe(0);
  });
});

/**
 * A peer that rejects the stored key on every connect, which is what a scale
 * that has forgotten its half of the pairing looks like from BlueZ (#335).
 */
function makeDevice(opts: { paired: boolean }): Device {
  return {
    connect: vi.fn(async () => {
      throw new Error('le-connection-abort-by-local');
    }),
    disconnect: vi.fn(async () => undefined),
    isPaired: vi.fn(async () => opts.paired),
  } as unknown as Device;
}

async function runLegacy(opts: { paired: boolean; autoClear?: boolean }): Promise<string> {
  const device = makeDevice(opts);
  const btAdapter = makeAdapter(device);
  try {
    await connectWithRecovery({
      btAdapter,
      mac: MAC,
      initialDevice: device,
      maxRetries: 4,
      ...(opts.autoClear === undefined ? {} : { autoClearStaleBond: opts.autoClear }),
    });
    return 'connected';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('stale-bond recovery (#335)', () => {
  it('leaves the bond alone by default and reports the diagnosis', async () => {
    const msg = await drive(runLegacy({ paired: true }));
    expect(msg).toContain('rejected the stored pairing key');
    for (const call of removeDevice.mock.calls) {
      expect(call[2]).toEqual({ includeBonded: false });
    }
  });

  it('clears the bond once when the opt-in is set and the peer is bonded', async () => {
    await drive(runLegacy({ paired: true, autoClear: true }));
    const clearing = removeDevice.mock.calls.filter(
      (c) => (c[2] as { includeBonded?: boolean })?.includeBonded === true,
    );
    // Exactly one: re-clearing would delete the bond the previous attempt just
    // established and turn a slow re-pair into an endless one.
    expect(clearing).toHaveLength(1);
  });

  it('never clears the bond of a peer BlueZ does not list as paired', async () => {
    await drive(runLegacy({ paired: false, autoClear: true }));
    for (const call of removeDevice.mock.calls) {
      expect((call[2] as { includeBonded?: boolean }).includeBonded).toBe(false);
    }
  });
});
