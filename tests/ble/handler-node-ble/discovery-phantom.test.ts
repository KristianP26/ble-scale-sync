import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeBluez, bluezError } from '../../helpers/fake-bluez.js';

/**
 * The phantom `Discovering` state seen on the maintainer's Pi (BlueZ 5.82,
 * 2026-10-06): bluetoothd reported Discovering=true, no client owned a
 * session and the kernel was not scanning. Our StopDiscovery came back
 * `No discovery started` every cycle, startDiscoverySafe "continued with the
 * existing scan", and nothing was found for the life of the process.
 *
 * These tests run the real startDiscoverySafe against a model of bluetoothd's
 * discovery state machine (tests/helpers/fake-bluez.ts), not against a script
 * of canned answers, so what they assert is what our calls do to BlueZ.
 */

const HA = ':1.ha';

let bluez = new FakeBluez();
let generation = 0;
/** Our unique bus name: every resetConnection() is a new D-Bus connection. */
let us = ':1.ours-0';
const calls: string[] = [];

vi.mock('../../../src/ble/handler-node-ble/dbus.js', () => ({
  helperOf: (obj: { helper: unknown }) => obj.helper,
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
  getAdapter: async () => {
    calls.push('getAdapter');
    return bluez.adapterFor(us);
  },
  resetConnection: () => {
    calls.push('resetConnection');
    bluez.disconnect(us);
    generation++;
    us = `:1.ours-${generation}`;
  },
  parseHciIndex: () => 0,
  currentConnectionGeneration: () => generation,
}));

vi.mock('../../../src/ble/handler-node-ble/device-object.js', () => ({
  logAdvertisementSnapshot: vi.fn(),
}));

vi.mock('../../../src/ble/handler-node-ble/privacy.js', () => ({
  reensureAdapterPrivacy: async () => {
    calls.push('reensureAdapterPrivacy');
  },
}));

// The tiers below bluetoothd's D-Bus state, refused the way they are on the
// Pi, where the unit has no CAP_NET_ADMIN and no root.
vi.mock('../../../src/ble/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/types.js')>();
  const refused = (name: string) => async () => {
    calls.push(name);
    return false;
  };
  return {
    ...actual,
    resetAdapterBtmgmt: refused('resetAdapterBtmgmt'),
    resetAdapterRfkill: refused('resetAdapterRfkill'),
    restartBluetoothd: refused('restartBluetoothd'),
  };
});

const {
  startDiscoverySafe,
  notifyDiscoveryStopped,
  restartStalledDiscovery,
  _resetDiscoveryRecoveryStateForTests,
} = await import('../../../src/ble/handler-node-ble/discovery.js');
const { bleLog } = await import('../../../src/ble/types.js');

type Adapter = Parameters<typeof startDiscoverySafe>[0];
type Options = Parameters<typeof startDiscoverySafe>[2];

const logged: string[] = [];

/** Drive the fake clock until the call settles; the BlueZ model itself needs no timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; !done && i < 1000; i++) await vi.advanceTimersByTimeAsync(250);
  return p;
}

/** The adapter the caller holds, replaced the way scan.ts replaces it. */
let ours: Adapter;

async function start(opts?: Options) {
  const result = await settle(startDiscoverySafe(ours, undefined, opts));
  if (result) ours = result;
  return result;
}

/** Every call made over any of our connections, method names only. */
const ourMethods = (): string[] =>
  bluez.log.filter((l) => l.startsWith(':1.ours')).map((l) => l.split(' ')[1]);

const failed = () => bluezError('org.bluez.Error.Failed', 'Operation failed');

/** Another D-Bus client with a scan of its own, the way Home Assistant holds one. */
async function otherClientScans(): Promise<void> {
  await bluez.call(HA, 'SetDiscoveryFilter', [
    { Transport: { value: 'le' }, DuplicateData: { value: true } },
  ]);
  await bluez.call(HA, 'StartDiscovery', []);
  await Promise.resolve();
}

beforeEach(() => {
  bluez = new FakeBluez();
  generation = 0;
  us = ':1.ours-0';
  ours = bluez.adapterFor(us) as unknown as Adapter;
  calls.length = 0;
  logged.length = 0;
  _resetDiscoveryRecoveryStateForTests();
  vi.useFakeTimers();
  for (const level of ['debug', 'info', 'warn'] as const) {
    vi.spyOn(bleLog, level).mockImplementation((msg: string) => {
      logged.push(`${level}: ${msg}`);
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the model reproduces the Pi', () => {
  // Without this the tests below could pass against a model that never had
  // the bug: a fresh StartDiscovery in the phantom answers success and starts
  // nothing.
  it('answers StartDiscovery with success in the phantom and starts no scan', async () => {
    bluez.enterPhantom({ enable: 0 });
    await bluez.call(us, 'SetDiscoveryFilter', [
      { Transport: { value: 'le' }, DuplicateData: { value: true } },
    ]);
    await bluez.call(us, 'StartDiscovery', []);
    expect(bluez.discovering).toBe(true);
    expect(bluez.kernelScanning).toBe(false);
  });

  it('retries a restart the kernel refused 10 s later, when no client waits on it', async () => {
    // start_discovery_complete(): only a failed first start is answered and
    // dropped; a restart bluetoothd made on its own is tried again.
    await bluez.call(us, 'SetDiscoveryFilter', [
      { Transport: { value: 'le' }, DuplicateData: { value: true } },
    ]);
    await bluez.call(us, 'StartDiscovery', []);
    bluez.stallScan({ enable: 0 });
    // A kernel still busy refuses the restart our filter change triggers.
    bluez.kernelScanning = true;
    await bluez.call(us, 'SetDiscoveryFilter', [
      { Transport: { value: 'auto' }, DuplicateData: { value: true } },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    bluez.kernelScanning = false;
    const kernelStarts = bluez.kernelStarts;

    await vi.advanceTimersByTimeAsync(9_000);
    expect(bluez.kernelStarts).toBe(kernelStarts);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bluez.kernelStarts).toBe(kernelStarts + 1);
    expect(bluez.delivering(us)).toBe(true);
  });
});

describe('startDiscoverySafe in the phantom Discovering state', () => {
  it('takes the session over and really starts the scan, without a power cycle', async () => {
    bluez.enterPhantom({ enable: 0 });

    await start();

    expect(ourMethods()).toEqual([
      'StopDiscovery', // No discovery started: the session is nobody's
      'SetDiscoveryFilter',
      'StartDiscovery', // join, answered without touching the kernel
      'StopDiscovery', // ours now, so the local path: Discovering goes false
      'SetDiscoveryFilter',
      'StartDiscovery', // this one reaches the kernel
    ]);
    expect(bluez.delivering(us)).toBe(true);
    expect(bluez.poweredWrites).toEqual([]);
    const info = logged.filter((l) => l.startsWith('info: '));
    expect(info).toHaveLength(1);
    expect(info[0]).toMatch(/not ours; restarted it under our own session/);
  });

  it('says the takeover at info once per process, then at debug', async () => {
    // On a shared adapter it happens every time our session is cycled.
    bluez.enterPhantom({ enable: 0 });
    await start();
    // A later cycle that ended deaf (classifyBleFailure) drops the claim, and
    // the phantom forms again.
    notifyDiscoveryStopped(ours);
    bluez.enterPhantom({ enable: 0 });
    await start();

    expect(bluez.delivering(us)).toBe(true);
    const takeover = logged.filter((l) => /not ours; restarted it under our own session/.test(l));
    expect(takeover.map((l) => l.split(':')[0])).toEqual(['info', 'debug']);
  });

  it('leaves the healed scan alone on the next cycle (#397)', async () => {
    bluez.enterPhantom({ enable: 0 });
    await start();
    bluez.log.length = 0;

    await start();

    expect(ourMethods()).toEqual([]);
    expect(bluez.delivering(us)).toBe(true);
  });

  it('does not count the scan as filtered when BlueZ refused the filter', async () => {
    // The latch is what makes later cycles leave the scan alone. Set without
    // the filter, it would keep a deduplicating scan for the life of the
    // process (#372).
    bluez.enterPhantom({ enable: 0 });
    bluez.failAlways.set(
      'SetDiscoveryFilter',
      bluezError('org.bluez.Error.InvalidArguments', 'Invalid arguments'),
    );
    await start();
    expect(bluez.delivering(us)).toBe(true);
    bluez.log.length = 0;

    await start();

    expect(ourMethods()).toContain('StopDiscovery');
  });

  it('on InProgress drops our bus, says to restart bluetoothd, and skips the D-Bus tiers', async () => {
    // discovery_enable stuck at 1: our Stop goes to a kernel that is not
    // scanning, which rejects it, and BlueZ answers InProgress. Nothing over
    // D-Bus clears that, a power cycle included.
    bluez.enterPhantom({ enable: 1 });

    const result = await start();

    expect(bluez.poweredWrites).toEqual([]);
    expect(calls.indexOf('resetConnection')).toBeGreaterThan(-1);
    expect(calls.indexOf('resetConnection')).toBeLessThan(calls.indexOf('resetAdapterBtmgmt'));
    expect(calls).toEqual(
      expect.arrayContaining(['resetAdapterBtmgmt', 'resetAdapterRfkill', 'restartBluetoothd']),
    );
    // Nothing went over the new connection: tier 2 would only join the
    // phantom and call it a scan.
    expect(bluez.methodsOf(us)).toEqual([]);
    const warns = logged.filter(
      (l) => l.startsWith('warn: ') && /systemctl restart bluetooth/.test(l),
    );
    expect(warns).toHaveLength(1);
    // The adapter of the new connection, not false: the old one is gone, and
    // the next cycle has to talk over the new one.
    expect(result).not.toBe(false);
    bluez.log.length = 0;
    await start();
    expect(bluez.log.some((l) => l.startsWith(':1.ours-0 '))).toBe(false);
    expect(bluez.methodsOf(':1.ours-1')).not.toEqual([]);
  });

  it('warns about the stuck state once per process, not every cycle', async () => {
    bluez.enterPhantom({ enable: 1 });
    await start();
    await start();

    expect(
      logged.filter((l) => l.startsWith('warn: ') && /systemctl restart bluetooth/.test(l)),
    ).toHaveLength(1);
  });

  it('releases a StartDiscovery BlueZ never answers by dropping our bus', async () => {
    // Another filter than ours in current_discovery_filter and discovery_enable
    // at 1: the join is held forever (start_discovery_timeout's Stop has no
    // completion handler), and every later call of ours would get InProgress.
    bluez.enterPhantom({ enable: 1, filter: { type: 'auto' } });

    const t0 = Date.now();
    await start();

    // Bounded by the call deadline, not by the poll loop giving up on the cycle.
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(calls).toContain('resetConnection');
    // discovery_disconnect() freed the client that held the message.
    expect(bluez.isDiscoveringClient(':1.ours-0')).toBe(false);
    expect(bluez.poweredWrites).toEqual([]);
  });

  it('with Discovering off but discovery_enable stuck at 1, drops our bus without a power cycle', async () => {
    // What adapter_stop() leaves after any power cycle in the stuck state
    // (ble.adapter_privacy's btmgmt cycle, tiers 4 and 5, the preemptive
    // reset): our start is held for good. Going on to tier 2 met InProgress,
    // and tier 3 power-cycled the adapter on every cycle while each held
    // message piled up.
    bluez.enterPhantom({ enable: 1 });
    bluez.discovering = false;

    const result = await start();

    expect(bluez.poweredWrites).toEqual([]);
    expect(calls.indexOf('resetConnection')).toBeGreaterThan(-1);
    expect(calls.indexOf('resetConnection')).toBeLessThan(calls.indexOf('resetAdapterBtmgmt'));
    expect(
      logged.filter((l) => l.startsWith('warn: ') && /systemctl restart bluetooth/.test(l)),
    ).toHaveLength(1);
    expect(bluez.isDiscoveringClient(':1.ours-0')).toBe(false);
    // Nothing more is sent to a bluetoothd that holds our start, not even
    // tier 2's stop.
    expect(bluez.methodsOf(':1.ours-0')).toEqual(['SetDiscoveryFilter', 'StartDiscovery']);
    expect(bluez.methodsOf(us)).toEqual([]);
    expect(result).not.toBe(false);

    // The next cycle meets the same state on the new bus and handles it the
    // same way, still without a power cycle or a second warning.
    await start();
    expect(bluez.poweredWrites).toEqual([]);
    expect(
      logged.filter((l) => l.startsWith('warn: ') && /systemctl restart bluetooth/.test(l)),
    ).toHaveLength(1);
    expect(bluez.isDiscoveringClient(':1.ours-1')).toBe(false);
  });

  it('a start the kernel refused still gets the power cycle, and no stuck warning', async () => {
    // BlueZ answers a first start the kernel refused with InProgress too
    // (discovery_complete()). Here the kernel is still scanning with nobody's
    // session and discovery_enable at 0, so it answers busy until the power
    // cycle stops it. That InProgress is no stuck bluetoothd.
    bluez.kernelScanning = true;

    await start();

    expect(bluez.poweredWrites).toEqual([false, true]);
    expect(bluez.delivering(us)).toBe(true);
    expect(calls).not.toContain('resetConnection');
    expect(logged.some((l) => l.startsWith('warn: '))).toBe(false);
  });

  it('after a call that got no answer, the next cycle heals what it can', async () => {
    bluez.enterPhantom({ enable: 0 });
    bluez.stallNext.add('StopDiscovery');

    await start();
    expect(calls).toContain('resetConnection');
    expect(bluez.delivering(us)).toBe(false);

    await start();

    expect(bluez.delivering(us)).toBe(true);
    expect(bluez.poweredWrites).toEqual([]);
  });
});

describe('a start the scan activity watchdog left held', () => {
  // restartStalledDiscovery() never resets the bus, so a rejoin whose start
  // timed out leaves that StartDiscovery held (client->msg) into the next
  // cycle. A second start from us gets InProgress, which is no stuck evidence
  // (refusedStarts). Our StopDiscovery gets InProgress from the held message
  // too, and that has to be caught before tier 3: a power cycle does not reset
  // discovery_enable.
  async function watchdogLeftAHeldStart(): Promise<void> {
    bluez.enterPhantom({ enable: 1, filter: { type: 'auto' } });
    expect(await settle(restartStalledDiscovery(ours))).toBe('stuck');
    expect(bluez.methodsOf(':1.ours-0')).toEqual([
      'StopDiscovery',
      'SetDiscoveryFilter',
      'StartDiscovery',
    ]);
    bluez.log.length = 0;
  }

  it('with Discovering on, the restart branch stop catches it', async () => {
    await watchdogLeftAHeldStart();

    await start();

    expect(bluez.methodsOf(':1.ours-0')).toEqual(['StopDiscovery']);
    expect(calls).toContain('resetConnection');
    expect(bluez.isDiscoveringClient(':1.ours-0')).toBe(false);
    expect(bluez.poweredWrites).toEqual([]);
  });

  it('with Discovering off, the tier-2 stop catches it before the power cycle', async () => {
    await watchdogLeftAHeldStart();
    bluez.discovering = false;

    await start();

    expect(bluez.methodsOf(':1.ours-0')).toEqual([
      'SetDiscoveryFilter',
      'StartDiscovery', // InProgress: we already have a session
      'StopDiscovery', // InProgress: the held start
    ]);
    expect(calls).toContain('resetConnection');
    expect(bluez.isDiscoveringClient(':1.ours-0')).toBe(false);
    expect(bluez.poweredWrites).toEqual([]);
  });
});

describe('startDiscoverySafe recovery tiers', () => {
  it('goes on to the D-Bus tiers when the start after our own Stop fails', async () => {
    // A session of ours, but not latched as filtered: the restart branch
    // stops it. With the start after that failing there is no scan left to
    // "continue with", so the tiers have to run.
    await bluez.call(us, 'StartDiscovery', []);
    await Promise.resolve();
    bluez.failAlways.set('StartDiscovery', failed());

    await start();

    expect(ourMethods().slice(0, 3)).toEqual([
      'StartDiscovery',
      'StopDiscovery',
      'SetDiscoveryFilter',
    ]);
    // Tier 3 ran: the power cycle.
    expect(bluez.poweredWrites).toEqual([false, true]);
  });

  it('power-cycles through BlueZ when a plain start keeps failing (tier 3)', async () => {
    bluez.failAlways.set('StartDiscovery', failed());

    await start();

    expect(bluez.poweredWrites).toEqual([false, true]);
    expect(bluez.powered).toBe(true);
    expect(calls).toContain('resetAdapterBtmgmt');
  });

  it('takes a tier-2 stop that gets no answer for stuck: no tier-2 start, no power cycle', async () => {
    bluez.failAlways.set('StartDiscovery', failed());
    bluez.stallNext.add('StopDiscovery');

    await start();

    expect(ourMethods()).toEqual(['SetDiscoveryFilter', 'StartDiscovery', 'StopDiscovery']);
    expect(bluez.poweredWrites).toEqual([]);
    expect(calls.indexOf('resetConnection')).toBeGreaterThan(-1);
    expect(calls.indexOf('resetConnection')).toBeLessThan(calls.indexOf('resetAdapterBtmgmt'));
  });

  it('takes a tier-2 start that gets no answer for stuck: no power cycle', async () => {
    bluez.failAlways.set('StartDiscovery', failed());
    bluez.onCall = (_sender, method) => {
      // Tier 2's stop: from here on BlueZ no longer answers a start.
      if (method !== 'StopDiscovery') return;
      bluez.failAlways.delete('StartDiscovery');
      bluez.stallNext.add('StartDiscovery');
    };

    await start();

    expect(bluez.poweredWrites).toEqual([]);
    expect(calls.indexOf('resetConnection')).toBeGreaterThan(-1);
    expect(calls.indexOf('resetConnection')).toBeLessThan(calls.indexOf('resetAdapterBtmgmt'));
  });

  it('drops our bus when the start after the power cycle gets no answer (tier 3)', async () => {
    // bluetoothd believes the kernel scans (discovery_enable 1), which the
    // power cycle does not reset (adapter_stop()). The start after it is
    // then held for good, and the next cycle must not talk over that bus.
    bluez.enable = 1;
    bluez.failAlways.set('StartDiscovery', failed());
    bluez.onPoweredWrite = (on) => {
      if (on) bluez.failAlways.delete('StartDiscovery');
    };

    await start();

    expect(bluez.poweredWrites).toEqual([false, true]);
    expect(bluez.methodsOf(':1.ours-0').slice(-2)).toEqual([
      'SetDiscoveryFilter',
      'StartDiscovery',
    ]);
    expect(calls.indexOf('resetConnection')).toBeGreaterThan(-1);
    expect(calls.indexOf('resetConnection')).toBeLessThan(calls.indexOf('resetAdapterBtmgmt'));
    expect(bluez.isDiscoveringClient(':1.ours-0')).toBe(false);
    expect(
      logged.filter((l) => l.startsWith('warn: ') && /systemctl restart bluetooth/.test(l)),
    ).toHaveLength(1);
  });

  it('goes on to the btmgmt tier when BlueZ refuses the Powered writes', async () => {
    bluez.failAlways.set('StartDiscovery', failed());
    bluez.refusePoweredWrites = true;

    await start();

    // Both writes attempted: the power-on runs whatever the power-off did.
    expect(bluez.poweredWrites).toEqual([false, true]);
    expect(calls).toContain('resetAdapterBtmgmt');
  });

  it('runs no recovery tier at all once the cycle is aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('shutdown'));
    bluez.failAlways.set('StartDiscovery', failed());

    const result = await start({ abortSignal: ctrl.signal });

    expect(result).toBe(false);
    expect(ourMethods()).toEqual(['SetDiscoveryFilter', 'StartDiscovery']);
    expect(bluez.poweredWrites).toEqual([]);
    expect(calls).not.toContain('resetAdapterBtmgmt');
  });

  it('does not power-cycle when the abort arrives during the D-Bus stop and start', async () => {
    const ctrl = new AbortController();
    bluez.failAlways.set('StartDiscovery', failed());
    bluez.onCall = (_sender, method) => {
      if (method === 'StopDiscovery') ctrl.abort(new Error('shutdown'));
    };

    await start({ abortSignal: ctrl.signal });

    expect(ourMethods()).toContain('StopDiscovery');
    expect(bluez.poweredWrites).toEqual([]);
    expect(calls).not.toContain('resetAdapterBtmgmt');
  });

  it('powers the adapter back on when the cycle is aborted between off and on', async () => {
    const ctrl = new AbortController();
    bluez.failAlways.set('StartDiscovery', failed());
    bluez.onPoweredWrite = (on) => {
      if (!on) ctrl.abort(new Error('shutdown'));
    };

    await start({ abortSignal: ctrl.signal });

    expect(bluez.poweredWrites).toEqual([false, true]);
    expect(bluez.powered).toBe(true);
    // Nothing after it.
    expect(calls).not.toContain('resetAdapterBtmgmt');
  });
});

describe('startDiscoverySafe with a healthy BlueZ', () => {
  it('starts a scan with no Stop and no Powered write, and keeps it (#397)', async () => {
    await start();
    expect(ourMethods()).toEqual(['SetDiscoveryFilter', 'StartDiscovery']);
    expect(bluez.delivering(us)).toBe(true);

    bluez.log.length = 0;
    await start();

    expect(bluez.log).toEqual([]);
    expect(bluez.poweredWrites).toEqual([]);
  });

  it("ends joined to another client's working scan, without a power cycle", async () => {
    await otherClientScans();
    expect(bluez.kernelScanning).toBe(true);

    await start();

    expect(bluez.delivering(us)).toBe(true);
    expect(bluez.isDiscoveringClient(HA)).toBe(true);
    expect(bluez.poweredWrites).toEqual([]);
    // Joining is ordinary on a shared adapter: said once, at info, with no
    // claim that anything was stuck.
    const info = logged.filter((l) => l.startsWith('info: '));
    expect(info).toHaveLength(1);
    expect(info[0]).not.toMatch(/stuck/i);
    expect(logged.some((l) => l.startsWith('warn: '))).toBe(false);
  });
});
