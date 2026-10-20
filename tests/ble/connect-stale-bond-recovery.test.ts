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
const { _resetStaleBondAnnouncementsForTests } =
  await import('../../src/ble/handler-node-ble/stale-bond.js');
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
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
const debugLines = (): string[] => debug.mock.calls.map((c: unknown[]) => String(c[0]));
const attemptLine = (n: number): string | undefined =>
  debugLines().find((l) => l.startsWith(`Connect attempt ${n}/6 failed`));

beforeEach(() => {
  removeDevice.mockClear();
  discovery.next = undefined;
  vi.useFakeTimers();
  _resetLinkObserverForTests(() => Date.now());
  debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
  warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
  _resetStaleBondAnnouncementsForTests();
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

/** removeDevice calls that took the pairing keys with them. */
const clears = (): number[] =>
  removeDevice.mock.calls
    .map((c, i) => ((c[2] as { includeBonded?: boolean })?.includeBonded === true ? i + 1 : 0))
    .filter((i) => i > 0);

const logged = (spy: ReturnType<typeof vi.spyOn>, text: string): string[] =>
  spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes(text));

describe('auto_clear_stale_bond clears only on proof of a refused key (#471, D066)', () => {
  it('keeps the bond when two timeouts come before three aborts (#471, 15:36 UTC)', async () => {
    const scale = makeScale({
      steps: [timeout, timeout, ...times(4, abort({ up: true, downMs: 2 }))],
    });
    await drive(run(scale, { autoClear: true }));
    expect(clears()).toEqual([]);
    expect(logged(info, 'but its bond is kept')).toHaveLength(1);
    expect(logged(info, 'but its bond is kept')[0]).toContain('went down at once with the error');
  });

  it('keeps the bond when the connection never came up on any attempt', async () => {
    const scale = makeScale({ steps: times(6, abort()) });
    const { result } = await drive(run(scale, { autoClear: true }));
    expect(clears()).toEqual([]);
    expect(result).toBe('Connection failed after 6 attempts: le-connection-abort-by-local');
  });

  it('keeps the bond when every attempt aborts and the connection goes down with the error, as on the good BF788 bond in #229', async () => {
    const scale = makeScale({ steps: times(6, abort({ up: true, downMs: 5 })) });
    const { result } = await drive(run(scale, { autoClear: true }));
    expect(clears()).toEqual([]);
    expect(result).toContain(
      'le-connection-abort-by-local on 6 of them after the connection to AA:BB:CC:DD:EE:FF came up',
    );
    expect(result).not.toContain('rejected the stored pairing key');
  });

  it('on BlueZ before 5.83, keeps a bond whose connections outlive the error and says to clear it by hand (#290 timings)', async () => {
    const scale = makeScale({ steps: times(6, abort({ up: true, downMs: 95 })) });
    const { result } = await drive(run(scale, { autoClear: true }));
    expect(clears()).toEqual([]);
    const lines = logged(warn, 'looks like it has forgotten its pairing');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('stayed up about 95 ms after le-connection-abort-by-local');
    expect(lines[0]).toContain('that needs BlueZ 5.83');
    expect(lines[0]).toContain('remove AA:BB:CC:DD:EE:FF');
    expect(lines[0]).toContain('ble.adapter_privacy');
    expect(result).toContain('on 6 attempts the connection came up and stayed up after');
  });

  it('clears on three authentication failures even with a timeout between them', async () => {
    const refusal = abort({ up: true, downMs: 95, reason: AUTH });
    const scale = makeScale({
      steps: [refusal, refusal, timeout, refusal, refusal, ok],
      bluez583: true,
    });
    const { result } = await drive(run(scale, { autoClear: true }));
    // The first attempt runs without the reason probe; 2, 4 and 5 are refusals.
    expect(clears()).toEqual([5]);
    expect(result).toBe('connected');
    expect(logged(warn, 'so the bond is being cleared')[0]).toContain(
      'rejected the stored pairing key on 3 attempts (BlueZ reported an authentication failure)',
    );
  });

  it('keeps the bond when BlueZ names another reason', async () => {
    const scale = makeScale({
      steps: times(6, abort({ up: true, downMs: 3, reason: 'org.bluez.Reason.Timeout' })),
      bluez583: true,
    });
    const { result } = await drive(run(scale, { autoClear: true }));
    expect(clears()).toEqual([]);
    expect(logged(info, 'but its bond is kept')[0]).toContain(
      'BlueZ reported org.bluez.Reason.Timeout (the radio link timed out), not a refused key',
    );
    expect(result).toBe('Connection failed after 6 attempts: le-connection-abort-by-local');
  });

  it('without the opt-in, does not call link drops a refused key (#471)', async () => {
    const scale = makeScale({
      steps: [timeout, timeout, ...times(4, abort({ up: true, downMs: 2 }))],
    });
    const { result } = await drive(run(scale));
    expect(result).toContain('le-connection-abort-by-local on 4 of them after the connection');
    expect(result).not.toContain('rejected the stored pairing key');
    expect(clears()).toEqual([]);
    // The notices are about what the opt-in did; without it the error says it all.
    expect(logged(info, 'but its bond is kept')).toEqual([]);
  });

  it('waits for the reason on the last attempt before the diagnosis', async () => {
    const scale = makeScale({
      steps: times(6, abort({ up: true, downMs: 95, reason: AUTH })),
      bluez583: true,
    });
    const { result } = await drive(run(scale));
    // 2-6: the first attempt runs without the reason probe.
    expect(result).toContain(
      'rejected the stored pairing key on 5 attempts (BlueZ reported an authentication failure)',
    );
  });

  it('does not take a connection still up 1.5 s after the error as a refused key', async () => {
    const scale = makeScale({ steps: times(6, abort({ up: true, downMs: 2000 })) });
    const { result } = await drive(run(scale, { autoClear: true }));
    expect(clears()).toEqual([]);
    expect(logged(warn, 'looks like it has forgotten')).toEqual([]);
    expect(logged(info, 'but its bond is kept')[0]).toContain(
      'stayed up past the error for longer than it does over a refused key',
    );
    expect(result).not.toContain('stayed up after le-connection-abort-by-local');
  });
});

describe('stale-bond recovery with BlueZ reporting the refused key (#335)', () => {
  const refusing = (paired = true): Scale =>
    makeScale({
      steps: times(6, abort({ up: true, downMs: 95, reason: AUTH })),
      bluez583: true,
      paired,
    });

  it('leaves the bond alone by default and reports the diagnosis', async () => {
    const { result } = await drive(run(refusing()));
    expect(result).toContain('rejected the stored pairing key');
    expect(result).toContain('remove AA:BB:CC:DD:EE:FF');
    for (const call of removeDevice.mock.calls) expect(call[2]).toEqual({ includeBonded: false });
  });

  it('clears the bond once when the opt-in is set and the peer is bonded', async () => {
    await drive(run(refusing(), { autoClear: true }));
    // Exactly one: re-clearing would delete the bond the previous attempt just
    // established and turn a slow re-pair into an endless one.
    expect(clears()).toEqual([4]);
  });

  it('never clears the bond of a peer BlueZ does not list as paired', async () => {
    const { result } = await drive(run(refusing(false), { autoClear: true }));
    expect(clears()).toEqual([]);
    expect(result).toBe('Connection failed after 6 attempts: le-connection-abort-by-local');
  });

  it('clears at once after a connect that worked minutes ago when BlueZ names the reason (#417)', async () => {
    const scale = makeScale({
      steps: [ok, ...times(4, abort({ up: true, downMs: 95, reason: AUTH })), ok],
      bluez583: true,
    });
    expect((await drive(run(scale, { autoClear: true }))).result).toBe('connected');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect((await drive(run(scale, { autoClear: true }))).result).toBe('connected');
    expect(clears()).toEqual([4]);
  });

  it('warns once per scale that a bond looks stale, and says once that it is kept', async () => {
    for (let i = 0; i < 2; i++) {
      await drive(
        run(makeScale({ steps: times(6, abort({ up: true, downMs: 95 })) }), { autoClear: true }),
      );
      await drive(
        run(makeScale({ steps: times(6, abort({ up: true, downMs: 2 })) }), { autoClear: true }),
      );
    }
    expect(logged(warn, 'looks like it has forgotten')).toHaveLength(1);
    expect(logged(info, 'but its bond is kept')).toHaveLength(1);
    expect(logged(debug, 'looks like it has forgotten')).toHaveLength(1);
    expect(logged(debug, 'but its bond is kept')).toHaveLength(1);
  });
});
