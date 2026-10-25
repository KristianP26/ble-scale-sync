import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { FakeBluez, bluezError, type FakeNotification } from '../../helpers/fake-bluez.js';
import { makeController, fakeExecFile, type FakeController } from '../../helpers/fake-btmgmt.js';
import { defaultProfile } from '../../helpers/scale-test-utils.js';
import type { ScaleAdapter, ScaleReading } from '../../../src/interfaces/scale-adapter.js';
import type { ScanOptions } from '../../../src/ble/types.js';

/**
 * Characterization of `scanAndReadRaw` on the D-Bus seam (arch audit X-09,
 * B-01): the real node-ble handler, node-ble and dbus-next, against the BlueZ
 * model in tests/helpers/fake-bluez.ts behind a fake system bus. Nothing of
 * ours is mocked; only node-ble's createBluetooth() (the bus socket) and
 * node:child_process (btmgmt) are.
 *
 * Each scenario pins, in a file next to this test, every D-Bus message the
 * cycle sent with its time, every log line, and the match rules left on the
 * bus. Both branches (ble.scale_mac and auto-discovery), each over GATT and
 * over advertisements; the MAC branch's second cycle on a kept object (D060)
 * and after a broadcast reading; the recovery ladder of a BlueZ that refuses
 * every StartDiscovery; DEBUG on. A refactor of the node-ble handler must leave these files as they
 * are: a changed line is a changed D-Bus sequence, timeout or log text.
 * `npx vitest run tests/ble/handler-node-ble/scan-bluez-wire.test.ts -u`
 * rewrites them; review the diff.
 *
 * The idle cycles check the match-rule balance: a cycle that keeps its D-Bus
 * connection must hand back every rule it added (#396, #397, #404).
 */

/** node-ble (and dbus-next with it) is an optionalDependency; a noble-only install skips this file. */
const nodeBleInstalled = (() => {
  try {
    createRequire(import.meta.url).resolve('node-ble/src/Bluetooth.js');
    return true;
  } catch {
    return false;
  }
})();

let bluez = new FakeBluez();
let ctl: FakeController = makeController();
const btmgmt = fakeExecFile(() => ctl);

vi.mock('node-ble', () => {
  const mod = { createBluetooth: () => bluez.createBluetooth() };
  return { default: mod, ...mod };
});

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], opts: unknown, cb: never) => {
    bluez.note(`exec ${file} ${args.join(' ')}`);
    btmgmt(file, args, opts, cb);
  },
}));

/** Real, captured before the fake timers replace it: lets module loads and I/O settle. */
const realSetImmediate = setImmediate;

const GATT_MAC = 'AA:BB:CC:DD:EE:01';
const BCAST_MAC = 'AA:BB:CC:DD:EE:02';
const PHONE_MAC = '11:22:33:44:55:66';
const uuid = (short: string): string => `0000${short}-0000-1000-8000-00805f9b34fb`;
const NOTIFY = uuid('fff1');
const WRITE = uuid('fff2');
const COMPANY = 0x1234;

/** [0xAA, weight*100 u16 BE, impedance u16 BE] */
function frame(weight: number, impedance: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = 0xaa;
  b.writeUInt16BE(Math.round(weight * 100), 1);
  b.writeUInt16BE(impedance, 3);
  return b;
}

function parse(data: Buffer, offset: number): ScaleReading | null {
  if (data.length < offset + 4) return null;
  return { weight: data.readUInt16BE(offset) / 100, impedance: data.readUInt16BE(offset + 2) };
}

/** A scale that weighs in over GATT once it is sent 0x01. */
function gattAdapter(): ScaleAdapter {
  return {
    name: 'Wire GATT',
    match: { priority: 10 },
    charNotifyUuid: NOTIFY,
    charWriteUuid: WRITE,
    unlockCommand: [0x01],
    unlockIntervalMs: 5000,
    matches: (d) => d.localName === 'WIRE-GATT',
    parseNotification: (data) => (data[0] === 0xaa ? parse(data, 1) : null),
    isComplete: (r) => r.impedance > 0,
    computeMetrics: () => ({}) as never,
  } as ScaleAdapter;
}

/** A scale that only broadcasts its weigh-in in manufacturer data. */
function broadcastAdapter(): ScaleAdapter {
  return {
    name: 'Wire Broadcast',
    match: { priority: 10, manufacturerId: COMPANY },
    preferPassive: true,
    matches: (d) => d.localName === 'WIRE-BCAST' || d.manufacturerData?.id === COMPANY,
    parseBroadcast: (data) => parse(data, 0),
    parseNotification: () => null,
    isComplete: (r) => r.impedance > 0,
    computeMetrics: () => ({}) as never,
  } as ScaleAdapter;
}

function gattScale(): void {
  bluez.advertise(GATT_MAC, {
    connectable: true,
    name: 'WIRE-GATT',
    services: [
      {
        uuid: uuid('fff0'),
        chars: [
          { uuid: NOTIFY, flags: ['notify'] },
          { uuid: WRITE, flags: ['write-without-response'] },
        ],
      },
    ],
    respond: (char, data): FakeNotification[] =>
      char === WRITE && data.equals(Buffer.from([0x01]))
        ? [
            { afterMs: 200, charUuid: NOTIFY, data: frame(80.4, 0) },
            { afterMs: 600, charUuid: NOTIFY, data: frame(80.5, 512) },
          ]
        : [],
  });
}

function broadcastScale(): void {
  const md = Buffer.alloc(4);
  md.writeUInt16BE(7250, 0);
  md.writeUInt16BE(480, 2);
  bluez.advertise(BCAST_MAC, {
    name: 'WIRE-BCAST',
    manufacturerData: { id: COMPANY, data: md },
  });
}

/** Someone's phone in the room: named, not a scale, not connectable. */
function phone(): void {
  bluez.advertise(PHONE_MAC, { name: 'Phone', intervalMs: 1000 });
}

type Scan = typeof import('../../../src/ble/handler-node-ble/scan.js');
let scan: Scan;
let t0 = 0;

beforeEach(async () => {
  bluez = new FakeBluez();
  ctl = makeController();
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'Date',
      'performance',
    ],
  });
  vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
  // Every module of the handler fresh, so no process-lifetime state (pairing
  // backoff, device cache, announcements) carries over from another scenario.
  vi.resetModules();
  const { setLogLevel, LogLevel } = await import('../../../src/logger.js');
  setLogLevel(LogLevel.INFO);
  const { bleLog } = await import('../../../src/ble/types.js');
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(bleLog, level).mockImplementation((msg: string) => bluez.note(`[${level}] ${msg}`));
  }
  scan = await import('../../../src/ble/handler-node-ble/scan.js');
  // The dynamic imports on the way (dbus-next, node:child_process) load now,
  // not in the middle of a cycle where the fake clock would run past them.
  await import('dbus-next');
  await import('node:child_process');
  t0 = Date.now();
});

afterEach(async () => {
  const { resetConnection } = await import('../../../src/ble/handler-node-ble/connection.js');
  resetConnection();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

const realPlatform = process.platform;

type Outcome = { reading: ScaleReading; adapter: string } | { error: string };

/** Run one cycle on the fake clock until it settles. */
async function cycle(opts: Partial<ScanOptions>): Promise<Outcome> {
  let outcome: Outcome | undefined;
  scan
    .scanAndReadRaw({
      adapters: [gattAdapter(), broadcastAdapter()],
      profile: defaultProfile(),
      ...opts,
    })
    .then(
      (raw) => (outcome = { reading: raw.reading, adapter: raw.adapter.name }),
      (err: unknown) => (outcome = { error: (err as Error).message }),
    );
  for (let i = 0; outcome === undefined && i < 20_000; i++) {
    await new Promise((r) => realSetImmediate(r));
    if (outcome === undefined) await vi.advanceTimersToNextTimerAsync();
  }
  if (!outcome) throw new Error('the cycle did not settle');
  bluez.note(`=> ${JSON.stringify(outcome)}`);
  return outcome;
}

/** What the scenario file pins: the wire, the logs, and the rules left held. */
function record(): string {
  return [...bluez.transcript(t0), '--- match rules held', ...bluez.heldMatches(), ''].join('\n');
}

/** Let the poll loop's pause between two cycles go by. */
async function pause(ms: number): Promise<void> {
  bluez.note(`(${ms} ms between cycles)`);
  await vi.advanceTimersByTimeAsync(ms);
}

describe.skipIf(!nodeBleInstalled)('scanAndReadRaw on the D-Bus seam (X-09)', () => {
  it('ble.scale_mac, GATT: a first cycle, then one on the kept object (D060)', async () => {
    gattScale();
    phone();
    const first = await cycle({ targetMac: GATT_MAC });
    expect(first).toEqual({ reading: { weight: 80.5, impedance: 512 }, adapter: 'Wire GATT' });
    await pause(5000);
    const second = await cycle({ targetMac: GATT_MAC });
    expect(second).toEqual(first);
    await expect(record()).toMatchFileSnapshot('./bluez-wire/mac-gatt.txt');
  });

  it('auto-discovery, GATT', async () => {
    phone();
    gattScale();
    const outcome = await cycle({});
    expect(outcome).toEqual({ reading: { weight: 80.5, impedance: 512 }, adapter: 'Wire GATT' });
    await expect(record()).toMatchFileSnapshot('./bluez-wire/auto-gatt.txt');
  });

  // Two cycles: the first remembers which adapter read the scale, and the
  // second removes the object before its scan for that reason (D060).
  it('ble.scale_mac, broadcast', async () => {
    broadcastScale();
    phone();
    const outcome = await cycle({ targetMac: BCAST_MAC });
    expect(outcome).toEqual({
      reading: { weight: 72.5, impedance: 480 },
      adapter: 'Wire Broadcast',
    });
    await pause(5000);
    expect(await cycle({ targetMac: BCAST_MAC })).toEqual(outcome);
    await expect(record()).toMatchFileSnapshot('./bluez-wire/mac-broadcast.txt');
  });

  it('auto-discovery, broadcast', async () => {
    phone();
    broadcastScale();
    const outcome = await cycle({});
    expect(outcome).toEqual({
      reading: { weight: 72.5, impedance: 480 },
      adapter: 'Wire Broadcast',
    });
    await expect(record()).toMatchFileSnapshot('./bluez-wire/auto-broadcast.txt');
  });

  // The connection outlives an idle cycle, so whatever it added and did not
  // hand back stays held, cycle after cycle, until the daemon refuses more
  // (#396). Two cycles: the second must leave exactly what the first did.
  it.each([
    ['ble.scale_mac', 'mac-idle', { targetMac: GATT_MAC }],
    ['auto-discovery', 'auto-idle', {}],
  ])(
    '%s, idle: a room without the scale, twice, leaves no match rule behind',
    async (_n, file, opts) => {
      phone();
      const first = await cycle(opts);
      expect(first).toHaveProperty('error');
      const afterFirst = bluez.heldMatches();
      await pause(5000);
      await cycle(opts);
      expect(bluez.heldMatches()).toEqual(afterFirst);
      // No device object keeps a rule past its cycle; node-ble's adapter
      // helper takes none.
      expect(afterFirst).toEqual([]);
      await expect(record()).toMatchFileSnapshot(`./bluez-wire/${file}.txt`);
    },
  );

  // node-ble's waitDevice arms its own 120 s deadline just before ours, so its
  // `operation timed out` used to end the cycle, and the no-show was never
  // counted: a held pairing stayed held after the scale came back (D063).
  it('ble.scale_mac, the scale does not show up: a no-show, and a held pairing goes on its return', async () => {
    const { pairingBackoff } = await import('../../../src/ble/handler-node-ble/pairing-backoff.js');
    // Four unconfirmed pairings hold the next one for 4 min, longer than the cycle.
    for (let i = 0; i < 4; i++) pairingBackoff().recordFailure(GATT_MAC, 'Wire GATT', undefined);
    phone();
    const outcome = await cycle({ targetMac: GATT_MAC });
    expect(outcome).toEqual({ error: `Device ${GATT_MAC} not found within 120s` });
    expect(bluez.transcript(t0).join('\n')).toContain(
      `${GATT_MAC} was not found in this cycle; its next pairing goes at once`,
    );
    expect(pairingBackoff().decide(GATT_MAC, 60)).toEqual({ go: true, why: 'returned' });
  });

  // Every tier of startDiscoverySafe's ladder in order, each one's log line
  // and what it sends; then the cycle waits without a scan.
  it('ble.scale_mac, BlueZ refuses every StartDiscovery: the recovery ladder', async () => {
    bluez.failAlways.set(
      'StartDiscovery',
      bluezError('org.bluez.Error.Failed', 'Operation failed'),
    );
    gattScale();
    const outcome = await cycle({ targetMac: GATT_MAC });
    expect(outcome).toHaveProperty('error');
    await expect(record()).toMatchFileSnapshot('./bluez-wire/mac-discovery-refused.txt');
  });

  // DEBUG is how reporters run, and it adds D-Bus reads of its own (the link
  // check before a connect, the advertisement line).
  it('ble.scale_mac, GATT, with DEBUG on', async () => {
    const { setLogLevel, LogLevel } = await import('../../../src/logger.js');
    setLogLevel(LogLevel.DEBUG);
    gattScale();
    phone();
    const outcome = await cycle({ targetMac: GATT_MAC });
    expect(outcome).toEqual({ reading: { weight: 80.5, impedance: 512 }, adapter: 'Wire GATT' });
    await expect(record()).toMatchFileSnapshot('./bluez-wire/mac-gatt-debug.txt');
  });
});

/**
 * BlueZ 5.83 and later say why a connection ended (Device1.Disconnected), and
 * with DEBUG on the handler writes it down (#434). Asserted on the lines
 * themselves rather than on scenario files: the rest of the cycle is what the
 * files above already pin.
 */
describe.skipIf(!nodeBleInstalled)('why a connection ended, BlueZ 5.83 (#434)', () => {
  const ENDED = /^\+\d+ms \[debug\] BlueZ: .* disconnected /;
  const lines = (): string[] => bluez.transcript(t0);

  /** Every line is there, in this order. */
  function expectInOrder(all: string[], wanted: string[]): void {
    const at = wanted.map((w) => all.indexOf(w));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  }

  async function debugOn(): Promise<void> {
    const { setLogLevel, LogLevel } = await import('../../../src/logger.js');
    setLogLevel(LogLevel.DEBUG);
  }

  /** The R-MSC04 of #434: one frame of an unsettled weight, then the link goes at 5.4 s. */
  function droppingScale(): void {
    bluez.advertise(GATT_MAC, {
      connectable: true,
      name: 'WIRE-GATT',
      services: [
        {
          uuid: uuid('fff0'),
          chars: [
            { uuid: NOTIFY, flags: ['notify'] },
            { uuid: WRITE, flags: ['write-without-response'] },
          ],
        },
      ],
      respond: (char, data): FakeNotification[] =>
        char === WRITE && data.equals(Buffer.from([0x01]))
          ? [{ afterMs: 200, charUuid: NOTIFY, data: frame(80.4, 0) }]
          : [],
      dropAfterConnectMs: 5400,
      dropReason: 'remote',
    });
  }

  it('the scale hangs up 5.4 s in: one line, with the reason and the time', async () => {
    bluez.sendsDisconnectReason = true;
    await debugOn();
    droppingScale();
    const outcome = await cycle({ targetMac: GATT_MAC });
    expect(outcome).toEqual({ error: 'Scale disconnected before reading completed' });
    const all = lines();
    const ended = all.filter((l) => ENDED.test(l));
    expect(ended).toEqual([
      `+6900ms [debug] BlueZ: ${GATT_MAC} disconnected 5.40 s after connect: ` +
        'org.bluez.Reason.Remote (Connection terminated by remote user) - the scale ended it',
    ]);
    // Before the teardown's own Disconnect: the scale's word, not ours.
    expectInOrder(all, [
      ended[0],
      `+6900ms [debug] Disconnecting ${GATT_MAC} after the session...`,
    ]);
  });

  it('a normal reading: our own Disconnect after reading shows as Local', async () => {
    bluez.sendsDisconnectReason = true;
    await debugOn();
    gattScale();
    const outcome = await cycle({ targetMac: GATT_MAC });
    expect(outcome).toEqual({ reading: { weight: 80.5, impedance: 512 }, adapter: 'Wire GATT' });
    const all = lines();
    const ended = all.filter((l) => ENDED.test(l));
    expect(ended).toEqual([
      `+2100ms [debug] BlueZ: ${GATT_MAC} disconnected 0.60 s after connect: ` +
        'org.bluez.Reason.Local (Connection terminated by local host) - this host ended it (this app, BlueZ or the kernel)',
    ]);
    // Sent before BlueZ answers the Disconnect, as device_disconnected() is.
    expectInOrder(all, [
      '+2100ms :1.1 Device1.Disconnect hci0/dev_AA_BB_CC_DD_EE_01',
      ended[0],
      '+2100ms [debug] Disconnect (after reading) answered in 0 ms',
    ]);
  });

  it('without DEBUG: no match rule for it and no line', async () => {
    bluez.sendsDisconnectReason = true;
    droppingScale();
    await cycle({ targetMac: GATT_MAC });
    expect(lines().some((l) => l.includes('Device1.Disconnected'))).toBe(false);
    expect(lines().some((l) => ENDED.test(l))).toBe(false);
  });
});
