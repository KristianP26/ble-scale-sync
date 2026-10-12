import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EsCs20mAdapter,
  assertAllowedWrite,
  buildGuestProfileFrame,
  buildSetTimeFrame,
} from '../../src/scales/es-cs20m.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { uuid16, buildPayload, computeBiaFat } from '../../src/scales/body-comp-helpers.js';
import { bleLog } from '../../src/ble/types.js';
import type {
  BleDeviceInfo,
  ConnectionContext,
  UserProfile,
} from '../../src/interfaces/scale-adapter.js';

function makeAdapter() {
  return new EsCs20mAdapter();
}

describe('EsCs20mAdapter', () => {
  // The ESCS20MB2 revision (HVIN ESCS20MB2, made 2026-02) advertises with no
  // name and no service UUIDs, only manufacturer data under company 0x1A10,
  // whose payload embeds the device's own address (#376).
  describe('matches() on the anonymous ESCS20MB2 advertisement', () => {
    const MAC = 'CF:EA:02:07:2C:87';
    /** Byte-for-byte from the reporter's capture. */
    const PAYLOAD = '00040031cfea02072c870109';

    function anon(overrides: Partial<BleDeviceInfo> = {}): BleDeviceInfo {
      return {
        localName: '',
        address: MAC,
        serviceUuids: [],
        manufacturerData: { id: 0x1a10, data: Buffer.from(PAYLOAD, 'hex') },
        ...overrides,
      };
    }

    it('claims a device whose payload carries its own address', () => {
      expect(new EsCs20mAdapter().matches(anon())).toBe(true);
    });

    it('accepts the address in reverse byte order too', () => {
      const reversed = Buffer.concat([
        Buffer.from('00040031', 'hex'),
        Buffer.from('872c0702eacf', 'hex'),
        Buffer.from('0109', 'hex'),
      ]);
      expect(
        new EsCs20mAdapter().matches(anon({ manufacturerData: { id: 0x1a10, data: reversed } })),
      ).toBe(true);
    });

    // The point of the echo: company id alone would claim any nameless device
    // that happens to use it, which is how #235, #318 and #320 happened.
    it('does NOT claim a device carrying a different address', () => {
      expect(new EsCs20mAdapter().matches(anon({ address: 'AA:BB:CC:DD:EE:FF' }))).toBe(false);
    });

    it('does NOT claim the same payload when the transport gave no address', () => {
      expect(new EsCs20mAdapter().matches(anon({ address: undefined }))).toBe(false);
    });

    it('does NOT claim a different company id with an otherwise perfect payload', () => {
      expect(
        new EsCs20mAdapter().matches(
          anon({ manufacturerData: { id: 0x02ac, data: Buffer.from(PAYLOAD, 'hex') } }),
        ),
      ).toBe(false);
    });

    it('does NOT claim a payload of the wrong length', () => {
      expect(
        new EsCs20mAdapter().matches(
          anon({ manufacturerData: { id: 0x1a10, data: Buffer.from(PAYLOAD + '00', 'hex') } }),
        ),
      ).toBe(false);
    });

    it('resolves to this adapter through the live registry, not to another one', () => {
      expect(resolveAdapter(anon(), adapters)?.name).toBe('ES-CS20M');
    });
  });

  describe('matches()', () => {
    it('matches "es-cs20m" substring', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('es-cs20m'))).toBe(true);
      expect(adapter.matches(mockPeripheral('My ES-CS20M Scale'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('ES-CS20M'))).toBe(true);
    });

    it('does not match "cs20" without "es-" prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('cs20'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });

    it('matches by vendor service UUID 0x1A10 (unnamed device)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('', ['1a10']))).toBe(true);
    });

    it('matches by full 128-bit vendor service UUID (dashless)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('', ['00001a1000001000800000805f9b34fb']))).toBe(true);
    });

    it('does not match unrelated service UUID', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('', ['ffe0']))).toBe(false);
    });

    it('matches Renpho ES-32MD (same HW family)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('es-32md'))).toBe(true);
      expect(adapter.matches(mockPeripheral('ES-32MD'))).toBe(true);
      expect(adapter.matches(mockPeripheral('My ES-32MD Scale'))).toBe(true);
    });

    it('matches "113360_" placeholder name (ES-32MD firmware)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('113360_ABCDEF'))).toBe(true);
    });

    it('does not match bare "113360" without underscore', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('113360'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses msgId 0x14 weight frame (stripped header)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(12);
      buf[0] = 0x14; // msgId at [0] — stripped header
      buf[5] = 0x01; // stable
      buf.writeUInt16BE(8000, 8); // weight = 8000 / 100 = 80.0 kg
      buf.writeUInt16BE(500, 10); // resistance

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(500);
    });

    it('parses msgId 0x14 with 55 AA header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(14);
      buf[0] = 0x55; // header byte 1
      buf[1] = 0xaa; // header byte 2
      buf[2] = 0x14; // msgId at [2]
      buf[5] = 0x01; // stable
      buf.writeUInt16BE(8000, 8); // weight
      buf.writeUInt16BE(500, 10); // resistance

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(500);
    });

    it('parses msgId 0x14 weight frame (not stable)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x14;
      buf[5] = 0x00; // not stable
      buf.writeUInt16BE(8000, 8);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('returns null for a stored record (0x15) without the header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(11);
      buf[0] = 0x15;
      buf.writeUInt16BE(500, 9); // resistance

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for a stored record (0x15) with the 55 AA header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(13);
      buf[0] = 0x55;
      buf[1] = 0xaa;
      buf[2] = 0x15; // msgId at [2]
      buf.writeUInt16BE(500, 9);

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    // MB1 frames from tests/test_x55aa_protocol.py in
    // https://github.com/ronnnnnnnnnnnnn/renpho-escs20m: a power-on with one
    // stored record waiting, then that record (60.95 kg, 873 ohm, taken 615 s
    // earlier). The R-A016 zero-current final after it carries no resistance of
    // its own, and used to be exported with the earlier weigh-in's 873 ohm.
    it("keeps a stored record's resistance out of the live weigh-in", () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(hex('55aa11000501010107001f'))).toBeNull();
      expect(adapter.parseNotification(hex('55aa15000c000017cf0369000002670000db'))).toBeNull();

      const live = adapter.parseNotification(hex('55aa14000711000023b9000007'))!;
      expect(live).toEqual({ weight: 91.45, impedance: 0 });
      expect(adapter.isComplete(live)).toBe(true);
    });

    it('returns null for unknown msgId', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(12);
      buf[0] = 0x20; // unknown
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(1))).toBeNull();
    });

    it('returns null for 0x14 frame shorter than 10 bytes', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(9);
      buf[0] = 0x14;
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('rejects weight below 0.5 kg', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x14;
      buf[5] = 0x01;
      buf.writeUInt16BE(10, 8); // 0.10 kg
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('rejects weight above 300 kg', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x14;
      buf[5] = 0x01;
      buf.writeUInt16BE(30100, 8); // 301.00 kg
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('parses 0x11 STOP frame and returns accumulated reading', () => {
      const adapter = makeAdapter();

      // Weight frame first
      const w = Buffer.alloc(10);
      w[0] = 0x14;
      w[5] = 0x00; // not stable
      w.writeUInt16BE(7500, 8); // 75.00 kg
      adapter.parseNotification(w);

      // STOP frame
      const stop = Buffer.alloc(6);
      stop[0] = 0x11;
      stop[5] = 0x00; // STOP
      const reading = adapter.parseNotification(stop);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(75);
    });

    it('parses 0x11 STOP frame with 55 AA header', () => {
      const adapter = makeAdapter();

      const w = Buffer.alloc(10);
      w[0] = 0x14;
      w.writeUInt16BE(8000, 8);
      adapter.parseNotification(w);

      const stop = Buffer.alloc(8);
      stop[0] = 0x55;
      stop[1] = 0xaa;
      stop[2] = 0x11;
      stop[5] = 0x00;
      const reading = adapter.parseNotification(stop);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('0x11 START frame resets state', () => {
      const adapter = makeAdapter();

      // Weight frame
      const w = Buffer.alloc(12);
      w[0] = 0x14;
      w[5] = 0x01;
      w.writeUInt16BE(8000, 8);
      w.writeUInt16BE(500, 10);
      adapter.parseNotification(w);

      // START frame resets
      const start = Buffer.alloc(6);
      start[0] = 0x11;
      start[5] = 0x01;
      adapter.parseNotification(start);

      // STOP with no weight accumulated returns null
      const stop = Buffer.alloc(6);
      stop[0] = 0x11;
      stop[5] = 0x00;
      expect(adapter.parseNotification(stop)).toBeNull();
    });

    it('0x11 STOP returns null when no weight accumulated', () => {
      const adapter = makeAdapter();
      const stop = Buffer.alloc(6);
      stop[0] = 0x11;
      stop[5] = 0x00;
      expect(adapter.parseNotification(stop)).toBeNull();
    });

    it('returns null for 0x11 frame shorter than 6 bytes', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(5);
      buf[0] = 0x11;
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and stable flag set', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x14;
      buf[5] = 0x01; // stable
      buf.writeUInt16BE(8000, 8);
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns true when weight > 0 and STOP frame received', () => {
      const adapter = makeAdapter();

      // Weight frame without stable flag
      const w = Buffer.alloc(10);
      w[0] = 0x14;
      w[5] = 0x00;
      w.writeUInt16BE(8000, 8);
      adapter.parseNotification(w);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);

      // STOP frame
      const stop = Buffer.alloc(6);
      stop[0] = 0x11;
      stop[5] = 0x00;
      adapter.parseNotification(stop);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when not stable and no STOP frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x14;
      buf[5] = 0x00; // not stable
      buf.writeUInt16BE(8000, 8);
      adapter.parseNotification(buf);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);
      expect(payload.weight).toBe(80);
      assertPayloadRanges(payload);
    });

    it('returns zero weight in payload for zero weight input', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 0, impedance: 0 }, profile);
      expect(payload.weight).toBe(0);
    });
  });
});

// #394: adapters are shared singletons. Before onSessionStart existed, a second
// weigh-in could resolve on the FIRST frame using the previous person's data.

describe('EsCs20mAdapter session boundary (#394)', () => {
  /** 0x14 weight frame, msgId at [2] behind the 55 AA header. */
  function weightFrame(hundredths: number, stable: number, resistance = 0): Buffer {
    const buf = Buffer.alloc(12);
    buf[0] = 0x55;
    buf[1] = 0xaa;
    buf[2] = 0x14;
    buf[5] = stable;
    buf.writeUInt16BE(hundredths, 8);
    buf.writeUInt16BE(resistance, 10);
    return buf;
  }

  /** 0x11 control frame: [5] is 0x01 for START, 0x00 for STOP. */
  function controlFrame(kind: number): Buffer {
    const buf = Buffer.alloc(8);
    buf[0] = 0x55;
    buf[1] = 0xaa;
    buf[2] = 0x11;
    buf[5] = kind;
    return buf;
  }

  it('starts a session clean even when the scale never sends 0x11 START', () => {
    // The reset used to live only inside the 0x11 START branch, and no GATT
    // capture of the anonymous ESCS20MB2 revision exists to show that frame is
    // always sent (#376). A stale `stopped` completed the next session on an
    // unsettled weight, and a stale `lastWeight` replayed the previous reading
    // verbatim on an orphan STOP.
    const adapter = makeAdapter();
    adapter.parseNotification(weightFrame(8000, 1, 500));
    adapter.parseNotification(controlFrame(0x00)); // STOP

    adapter.onSessionStart();

    // An orphan STOP with no weight frame before it used to return the whole
    // previous reading.
    expect(adapter.parseNotification(controlFrame(0x00))).toBeNull();
  });

  it('does not complete the next session on an unsettled weight', () => {
    const adapter = makeAdapter();
    adapter.parseNotification(weightFrame(8000, 1, 500));
    adapter.parseNotification(controlFrame(0x00)); // STOP sets `stopped`

    adapter.onSessionStart();

    const unsettled = adapter.parseNotification(weightFrame(6500, 0))!;
    expect(adapter.isComplete(unsettled)).toBe(false);
  });

  it('does not carry the previous impedance into the next weigh-in', () => {
    const adapter = makeAdapter();
    adapter.parseNotification(weightFrame(8000, 1, 500));

    adapter.onSessionStart();

    const next = adapter.parseNotification(weightFrame(6500, 1))!;
    expect(next.impedance).toBe(0);
  });
});

// 0x14 status byte [5]: low nibble is the phase (0 settling, 1 final), bit 4 is
// the zero-current mode the Renpho app stores on the scale. Every frame below is
// byte-for-byte from a capture, with checksums intact.
describe('EsCs20mAdapter 0x14 status nibble (#376)', () => {
  const frame = (h: string): Buffer => Buffer.from(h, 'hex');

  // Baseline session (no writes) of the #376 unit (CF:EA:02:07:2C:87), stuck in
  // zero-current mode, from x55aa_recover_20260910_095524.log attached to
  // https://github.com/ronnnnnnnnnnnnn/renpho-escs20m/issues/10 (Venomeus).
  // Every settling frame carries status 0x10; the first is 10.60 kg on the way up.
  // The frames run in log order up to the power-off status frame, where the
  // session completes (the log has one more 101.20 kg frame after it).
  const ZERO_CURRENT_SESSION = [
    '55aa11000a0101010000440000000061', // status: power on, right after subscribe
    '55aa1400071000000424000052', // 10.60 kg
    '55aa1400071000000424000052', // 10.60 kg
    '55aa1400071000001da10000e8', // 75.85 kg
    '55aa14000710000026b1000001', // 99.05 kg
    '55aa14000710000027ba00000b', // 101.70 kg
    '55aa1400071000002738000089', // 100.40 kg
    '55aa1400071000002724000075', // 100.20 kg
    '55aa140007100000272e00007f', // 100.30 kg
    '55aa1400071000002738000089', // 100.40 kg
    '55aa14000710000027880000d9', // 101.20 kg
    '55aa1400071000002742000093', // 100.50 kg
    '55aa140007100000274c00009d', // 100.60 kg
    '55aa14000710000027a60000f7', // 101.50 kg
    '55aa14000710000027b0000001', // 101.60 kg
    '55aa14000710000027a60000f7', // 101.50 kg
    '55aa140007100000279c0000ed', // 101.40 kg
    ...Array<string>(16).fill('55aa14000710000027880000d9'), // 101.20 kg, held
    '55aa11000a0001010000440000000060', // status: power off
  ];

  it('does not complete on the first zero-current settling frame (status 0x10)', () => {
    const adapter = makeAdapter();
    expect(adapter.parseNotification(frame(ZERO_CURRENT_SESSION[0]))).toBeNull();

    const first = adapter.parseNotification(frame(ZERO_CURRENT_SESSION[1]))!;
    expect(first.weight).toBe(10.6);
    expect(adapter.isComplete(first)).toBe(false);
  });

  it('completes that session only on the power-off frame, with the held 101.20 kg', () => {
    const adapter = makeAdapter();
    const completedAt: number[] = [];
    let last: unknown = null;
    ZERO_CURRENT_SESSION.forEach((h, i) => {
      const reading = adapter.parseNotification(frame(h));
      if (reading && adapter.isComplete(reading)) {
        completedAt.push(i);
        last = reading;
      }
    });
    expect(completedAt).toEqual([ZERO_CURRENT_SESSION.length - 1]);
    expect(last).toEqual({ weight: 101.2, impedance: 0 });
  });

  // R-A016 frames from tests/test_x55aa_protocol.py in
  // https://github.com/ronnnnnnnnnnnnn/renpho-escs20m (91.45 kg). The 0x10 and
  // 0x11 frames are from the official-app capture (the app had set zero-current
  // mode); the 0x01 final is from a probe run on the same unit after a 0x90
  // mode-1 write.
  it('R-A016: a zero-current settling frame (0x10) is not final', () => {
    const adapter = makeAdapter();
    const reading = adapter.parseNotification(frame('55aa14000710000023b9000006'))!;
    expect(reading.weight).toBe(91.45);
    expect(adapter.isComplete(reading)).toBe(false);
  });

  it('R-A016: a zero-current final (0x11) completes', () => {
    const adapter = makeAdapter();
    const reading = adapter.parseNotification(frame('55aa14000711000023b9000007'))!;
    expect(adapter.isComplete(reading)).toBe(true);
  });

  it('R-A016: a normal-mode final (0x01) completes with its resistance', () => {
    const adapter = makeAdapter();
    const reading = adapter.parseNotification(frame('55aa14000701000023b903110b'))!;
    expect(reading).toEqual({ weight: 91.45, impedance: 785 });
    expect(adapter.isComplete(reading)).toBe(true);
  });

  // The #376 report itself (v1.24.0, ESPHome), before the unit got stuck:
  // settling frames with status 0x00, completed on the power-off frame.
  // https://github.com/KristianP26/ble-scale-sync/issues/376
  it('#376 v1.24.0 session: status 0x00 frames complete on power-off at 103.50 kg', () => {
    const adapter = makeAdapter();
    expect(adapter.parseNotification(frame('55aa11000a0101010000550000000072'))).toBeNull();
    const settling = adapter.parseNotification(frame('55aa140007000000286e0000b0'))!;
    expect(settling.weight).toBe(103.5);
    expect(adapter.isComplete(settling)).toBe(false);
    const done = adapter.parseNotification(frame('55aa11000a0001010000550000000071'))!;
    expect(done).toEqual({ weight: 103.5, impedance: 0 });
    expect(adapter.isComplete(done)).toBe(true);
  });
});

// ─── Writes: the Renpho app's sequence on AE00 units, the kg command elsewhere ──

const hex = (h: string): Buffer => Buffer.from(h, 'hex');

/** Independent of the adapter's builder, so a wrong checksum there cannot hide. */
function frameHex(cmd: number, payload: number[]): string {
  const body = [0x55, 0xaa, cmd, payload.length >> 8, payload.length & 0xff, ...payload];
  const sum = body.reduce((a, b) => a + b, 0) & 0xff;
  return Buffer.from([...body, sum]).toString('hex');
}

// From the #436 reporter's iPhone capture of the Renpho app, the only two frames
// of it used here (the rest carries their personal data): the power-on status
// frame (lb on the display) and the app's 0x97, written at 2026-10-02 20:26:30Z
// from a phone on EDT.
const POWER_ON_436 = '55aa11000a010201000000000000001e';
const APP_SET_TIME_436 = '55aa9700090100006ac01376010458';
const APP_POWER_ON_ACK_436 = '55aa9100010192';

// The #376 unit's own frames (v1.24.0 report, public).
const POWER_ON_376 = '55aa11000a0101010000550000000072';
const WEIGHT_376 = '55aa140007000000286e0000b0'; // 103.50 kg, settling
const POWER_OFF_376 = '55aa11000a0001010000550000000071';

/** The capture's clock: the 0x97 above is exactly this instant on EDT (UTC-4). */
function captureClock(): Date {
  const d = new Date(0x6ac01376 * 1000);
  d.getTimezoneOffset = () => 240;
  return d;
}

// Made up, NOT from any capture: the app's 0x96 in the #436 capture holds the
// reporter's sex, birth date, height and weight, so it never appears in a test.
const MADE_UP_PROFILE: UserProfile = {
  gender: 'female',
  birthDate: '1990-06-15',
  age: 36,
  height: 168,
  lastKnownWeight: 65.5,
  isAthlete: false,
};
const MADE_UP_GUEST_PROFILE = '55aa96000e2907c6060f069000001996aaff05a1';

const AE00_UNIT = [0x2a10, 0x2a11, 0xae01, 0xae02];
// The #376 unit: 1A10 and an unused FFF0, no AE00 (three public btsnoops).
const NO_AE00_UNIT = [0x2a10, 0x2a11, 0xfff1, 0xfff2, 0xfff3];

interface Written {
  char: string;
  hex: string;
  withResponse: boolean | undefined;
}

function mockCtx(
  chars: number[],
  profile: UserProfile = MADE_UP_PROFILE,
  write?: (data: Buffer) => Promise<void>,
): { ctx: ConnectionContext; written: Written[] } {
  const written: Written[] = [];
  const ctx: ConnectionContext = {
    profile,
    deviceAddress: '',
    availableChars: new Set(chars.map(uuid16)),
    write: async (char, data, withResponse) => {
      const buf = Buffer.from(data);
      written.push({ char, hex: buf.toString('hex'), withResponse });
      if (write) await write(buf);
    },
    read: async () => Buffer.alloc(0),
    subscribe: async () => {},
  };
  return { ctx, written };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('EsCs20mAdapter on an AE00 unit (#436)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connected(
    write?: (data: Buffer) => Promise<void>,
  ): Promise<{ adapter: EsCs20mAdapter; written: Written[] }> {
    const adapter = new EsCs20mAdapter(captureClock);
    const { ctx, written } = mockCtx(AE00_UNIT, MADE_UP_PROFILE, write);
    adapter.onSessionStart();
    await adapter.onConnected!(ctx);
    return { adapter, written };
  }

  it('writes nothing at connect: the app writes nothing before the first power-on frame', async () => {
    const { written } = await connected();
    expect(written).toEqual([]);
  });

  it("answers the power-on frame with the app's 0x91, 0x97, 0x96 and 0x90, each with response", async () => {
    const { adapter, written } = await connected();
    expect(adapter.parseNotification(hex(POWER_ON_436))).toBeNull();
    await flush();

    expect(written.map((w) => w.hex)).toEqual([
      APP_POWER_ON_ACK_436,
      APP_SET_TIME_436,
      MADE_UP_GUEST_PROFILE,
      // Unit 02 echoed from the power-on frame, so the lb display stays lb. The
      // app sends mode 1 here (`...02 00 01 00`); mode 0 is the one deliberate
      // change to a frame the app sends.
      '55aa9000040200000095',
    ]);
    expect(written.every((w) => w.withResponse === true)).toBe(true);
    expect(written.every((w) => w.char === uuid16(0x2a11))).toBe(true);
  });

  it('echoes a kg display as kg', async () => {
    const { adapter, written } = await connected();
    adapter.parseNotification(hex(POWER_ON_376));
    await flush();
    expect(written.at(-1)?.hex).toBe('55aa9000040100000094');
  });

  it('sends the sequence once per power-on, and again after a power-off', async () => {
    const { adapter, written } = await connected();
    adapter.parseNotification(hex(POWER_ON_436));
    adapter.parseNotification(hex(POWER_ON_436));
    await flush();
    expect(written).toHaveLength(4);

    adapter.parseNotification(hex(POWER_OFF_376));
    await flush();
    // No 0x91 on power-off: the app sends one, but that is out of scope.
    expect(written).toHaveLength(4);

    adapter.parseNotification(hex(POWER_ON_436));
    await flush();
    expect(written).toHaveLength(8);
  });

  it('drops the rest of the sequence when the session ends mid-way', async () => {
    let release: (() => void) | undefined;
    const { adapter, written } = await connected((data) =>
      data[2] === 0x91
        ? new Promise<void>((r) => {
            release = r;
          })
        : Promise.resolve(),
    );
    adapter.parseNotification(hex(POWER_ON_436));
    await flush();
    expect(written).toHaveLength(1);

    adapter.onSessionEnd!();
    release?.();
    await flush();
    expect(written).toHaveLength(1);
  });

  // Adapters are singletons: a session that ends while the scale is on never
  // sees the power-off that re-arms the sequence.
  it('sends the sequence again in the next session when the last one ended without a power-off', async () => {
    const adapter = new EsCs20mAdapter(captureClock);
    const first = mockCtx(AE00_UNIT);
    adapter.onSessionStart();
    await adapter.onConnected!(first.ctx);
    adapter.parseNotification(hex(POWER_ON_436));
    await flush();
    expect(first.written).toHaveLength(4);
    adapter.onSessionEnd!();

    const second = mockCtx(AE00_UNIT);
    adapter.onSessionStart();
    await adapter.onConnected!(second.ctx);
    adapter.parseNotification(hex(POWER_ON_436));
    await flush();
    expect(second.written.map((w) => w.hex.slice(4, 6))).toEqual(['91', '97', '96', '90']);
  });

  // Synthetic: no header-less 0x11 has been captured. msgId at [0], power-on
  // at [5] and a plausible unit at [6], which the parser would otherwise take.
  it('ignores a power-on frame without the 55AA header', async () => {
    const { adapter, written } = await connected();
    const headerless = Buffer.alloc(16);
    headerless[0] = 0x11;
    headerless[5] = 0x01;
    headerless[6] = 0x02;
    expect(adapter.parseNotification(headerless)).toBeNull();
    await flush();
    expect(written).toEqual([]);
  });

  it('carries on after a failed write', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const { adapter, written } = await connected((data) =>
      data[2] === 0x97 ? Promise.reject(new Error('ATT error')) : Promise.resolve(),
    );
    adapter.parseNotification(hex(POWER_ON_436));
    await flush();
    expect(written.map((w) => w.hex.slice(4, 6))).toEqual(['91', '97', '96', '90']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('clock (0x97) not sent'));
  });

  it('never logs the guest profile bytes', async () => {
    const lines: string[] = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(bleLog, level).mockImplementation((msg: string) => {
        lines.push(msg);
      });
    }
    const { adapter, written } = await connected();
    adapter.parseNotification(hex(POWER_ON_436));
    await flush();
    expect(written).toHaveLength(4);
    expect(lines.some((l) => l.includes('guest profile'))).toBe(true);
    // Neither the frame nor any of its fields: birth year, height, weight.
    for (const secret of [MADE_UP_GUEST_PROFILE, '07c6', '0690', '1996']) {
      expect(lines.filter((l) => l.includes(secret))).toEqual([]);
    }
  });

  it('needs both AE01 and AE02; AE01 alone is the kg path', async () => {
    const adapter = new EsCs20mAdapter(captureClock);
    const { ctx, written } = mockCtx([0x2a10, 0x2a11, 0xae01]);
    adapter.onSessionStart();
    await adapter.onConnected!(ctx);
    expect(written.map((w) => w.hex)).toEqual(['55aa9000040100000094']);
  });
});

// ─── The 0x18 result on an AE00 unit (#436) ─────────────────────────────────

// Frames from the #436 reporter's public logs (comments 6073310202 and
// 6112383314), byte-for-byte except where marked. In every 0x18 the scale's
// BMI and body fat ([14..17]) are zeroed and the checksum recomputed: those two
// are health values the scale computed, the adapter does not read them, and
// they stay out of the repository. Weight and resistance are as received.
const POWER_OFF_436 = '55aa11000a000201000000000000001d';
const REPLY_17 = '55aa17000201011a';
const REPLY_16 = '55aa160001091f';
const REPLY_10 = '55aa1000010111';
const W_139_10 = '55aa14000700000036560000a6';
const W_139_20 = '55aa14000700000036600000b0';
const W_136_40 = '55aa1400070000003548000097';
/** 6073310202, in socks: 139.20 kg, 0 ohm. */
const RESULT_SOCKS = '55aa18000d01010900003660000000000000c5';
/** 6112383314, first barefoot weigh-in: 139.10 kg, 470 ohm. */
const RESULT_470 = '55aa18000d0101090000365601d60000000092';
/** 6112383314, second barefoot weigh-in: 139.10 kg, 404 ohm. */
const RESULT_404 = '55aa18000d0101090000365601940000000050';
// Edited from RESULT_470 (checksum recomputed unless the checksum is the
// point), each failing exactly one check.
/** Slot 00, as in the first 0x18 of the #436 app capture (no 0x14 before it). */
const RESULT_SLOT_0 = '55aa18000d0101000000365601d60000000089';
/** Status 02: not a final. */
const RESULT_STATUS_2 = '55aa18000d0201090000365601d60000000093';
/** Checksum off by one (the right one is 92). */
const RESULT_BAD_SUM = '55aa18000d0101090000365601d60000000093';

/** The 25 weight frames of the second barefoot weigh-in, in log order. */
const SECOND_WEIGH_IN = [
  '3548000097', // 136.40
  '36c4000014', // 140.20
  '358e0000dd', // 137.10
  '37500000a1', // 141.60
  '35d4000023', // 137.80
  '369c0000ec', // 139.80
  '3732000083', // 141.30
  '35d4000023', // 137.80
  '367e0000ce', // 139.50
  '36740000c4', // 139.40
  '36740000c4', // 139.40
  '36e2000032', // 140.50
  '35b6000005', // 137.50
  '36920000e2', // 139.70
  '369c0000ec', // 139.80
  '36560000a6', // 139.10
  '36560000a6', // 139.10
  '369c0000ec', // 139.80
  ...Array<string>(7).fill('36560000a6'), // 139.10, held
].map((tail) => '55aa140007000000' + tail);

describe('EsCs20mAdapter 0x18 result (#436)', () => {
  async function connected(chars = AE00_UNIT): Promise<EsCs20mAdapter> {
    const adapter = new EsCs20mAdapter(captureClock);
    adapter.onSessionStart();
    await adapter.onConnected!(mockCtx(chars).ctx);
    return adapter;
  }

  /** Feed frames in order and return what the last one parsed to. */
  function feed(adapter: EsCs20mAdapter, frames: string[]) {
    let last = null as ReturnType<EsCs20mAdapter['parseNotification']>;
    for (const f of frames) last = adapter.parseNotification(hex(f));
    return last;
  }

  it('second barefoot weigh-in: completes on 0x18 with its resistance and holds until power-off', async () => {
    const adapter = await connected();
    feed(adapter, [POWER_ON_436, REPLY_17, REPLY_16, ...SECOND_WEIGH_IN.slice(0, 1), REPLY_10]);
    feed(adapter, SECOND_WEIGH_IN.slice(1));
    expect(adapter.completionHoldMs).toBeUndefined();

    const result = adapter.parseNotification(hex(RESULT_404))!;
    expect(result).toEqual({ weight: 139.1, impedance: 404 });
    expect(adapter.isComplete(result)).toBe(true);
    expect(adapter.isFinal(result)).toBe(false);
    expect(adapter.completionHoldMs).toBe(30_000);

    const off = adapter.parseNotification(hex(POWER_OFF_436));
    expect(off).toBe(result);
    expect(adapter.isComplete(off!)).toBe(true);
    expect(adapter.isFinal(off!)).toBe(true);
  });

  it('weigh-in in socks: the 0x18 completes with 0 ohm', async () => {
    const adapter = await connected();
    feed(adapter, [POWER_ON_436, W_139_20, W_139_20, W_139_20, W_139_20]);
    const result = adapter.parseNotification(hex(RESULT_SOCKS))!;
    expect(result).toEqual({ weight: 139.2, impedance: 0 });
    expect(adapter.isComplete(result)).toBe(true);
  });

  it('ignores a 0x18 with no weight frame since power-on (the capture shape)', async () => {
    const adapter = await connected();
    expect(feed(adapter, [POWER_ON_436, RESULT_470])).toBeNull();
    expect(adapter.completionHoldMs).toBeUndefined();
    expect(adapter.parseNotification(hex(POWER_OFF_436))).toBeNull();
  });

  it('ignores a 0x18 from slot 00 and completes on power-off as before', async () => {
    const adapter = await connected();
    expect(feed(adapter, [POWER_ON_436, W_139_10, RESULT_SLOT_0])).toBeNull();
    expect(adapter.completionHoldMs).toBeUndefined();
    expect(adapter.parseNotification(hex(POWER_OFF_436))).toEqual({ weight: 139.1, impedance: 0 });
  });

  it('ignores a 0x18 whose weight is more than 0.5 kg from the last weight frame', async () => {
    const adapter = await connected();
    expect(feed(adapter, [POWER_ON_436, W_136_40, RESULT_470])).toBeNull();
    expect(adapter.completionHoldMs).toBeUndefined();
  });

  it('ignores a 0x18 that is not a final or fails its checksum', async () => {
    const adapter = await connected();
    expect(feed(adapter, [POWER_ON_436, W_139_10, RESULT_STATUS_2])).toBeNull();
    expect(adapter.parseNotification(hex(RESULT_BAD_SUM))).toBeNull();
    expect(adapter.completionHoldMs).toBeUndefined();
  });

  it('ignores weight frames after the 0x18 and exports the 0x18 on power-off', async () => {
    const adapter = await connected();
    const result = feed(adapter, [POWER_ON_436, W_139_10, RESULT_404])!;
    expect(result).toEqual({ weight: 139.1, impedance: 404 });
    expect(adapter.parseNotification(hex(W_136_40))).toBeNull();
    expect(adapter.parseNotification(hex(POWER_OFF_436))).toEqual({
      weight: 139.1,
      impedance: 404,
    });
  });

  it('takes one 0x18 per weigh-in', async () => {
    const adapter = await connected();
    expect(feed(adapter, [POWER_ON_436, W_139_10, RESULT_404])).not.toBeNull();
    expect(adapter.parseNotification(hex(RESULT_470))).toBeNull();
  });

  it('ignores a 0x18 on a unit without AE00, where no guest profile was sent', async () => {
    const adapter = await connected(NO_AE00_UNIT);
    expect(feed(adapter, [POWER_ON_436, W_139_10, RESULT_470])).toBeNull();
    expect(adapter.completionHoldMs).toBeUndefined();
    expect(adapter.parseNotification(hex(POWER_OFF_436))).toEqual({ weight: 139.1, impedance: 0 });
  });

  // Adapters are singletons: a session that ended during the hold must not
  // hand its result to the next one.
  it('drops the result at the next session start', async () => {
    const adapter = await connected();
    expect(feed(adapter, [POWER_ON_436, W_139_10, RESULT_404])).not.toBeNull();
    adapter.onSessionEnd!();
    adapter.onSessionStart();
    expect(adapter.completionHoldMs).toBeUndefined();
    expect(adapter.parseNotification(hex(POWER_OFF_436))).toBeNull();
  });

  it('drops the result at the next power-on', async () => {
    const adapter = await connected();
    expect(feed(adapter, [POWER_ON_436, W_139_10, RESULT_404])).not.toBeNull();
    adapter.parseNotification(hex(POWER_ON_436));
    expect(adapter.completionHoldMs).toBeUndefined();
  });

  // The profile is the made-up defaultProfile(), never one derived from the
  // reporter's log.
  describe('body composition', () => {
    it('computes body fat from the resistance of an accepted 0x18 (BIA)', async () => {
      const adapter = await connected();
      const p = defaultProfile();
      const result = feed(adapter, [POWER_ON_436, W_139_10, RESULT_470])!;
      const payload = adapter.computeMetrics(result, p);
      expect(payload).toEqual(buildPayload(139.1, 470, { fat: computeBiaFat(139.1, 470, p) }, p));
      expect(payload.bodyFatPercent).not.toBe(buildPayload(139.1, 470, {}, p).bodyFatPercent);
    });

    it('keeps the BMI estimate for a 0x18 in socks (0 ohm)', async () => {
      const adapter = await connected();
      const p = defaultProfile();
      const result = feed(adapter, [POWER_ON_436, W_139_20, RESULT_SOCKS])!;
      expect(adapter.computeMetrics(result, p)).toEqual(buildPayload(139.2, 0, {}, p));
    });

    // Basic flavor (R-A016 normal-mode final, see the #376 status describe):
    // its resistance is exported, body fat stays the estimate until a
    // basic-flavor unit can be checked against the app (D046).
    it('keeps the BMI estimate for a 0x14 final with its own resistance', () => {
      const adapter = makeAdapter();
      const p = defaultProfile();
      const reading = adapter.parseNotification(hex('55aa14000701000023b903110b'))!;
      expect(reading).toEqual({ weight: 91.45, impedance: 785 });
      expect(adapter.computeMetrics(reading, p)).toEqual(buildPayload(91.45, 785, {}, p));
    });
  });
});

describe('EsCs20mAdapter on a unit without AE00 (#376)', () => {
  it('sends the kg command without response at connect and once more on the first power-on', async () => {
    const adapter = new EsCs20mAdapter(captureClock);
    const { ctx, written } = mockCtx(NO_AE00_UNIT);
    adapter.onSessionStart();
    await adapter.onConnected!(ctx);
    expect(written).toEqual([
      { char: uuid16(0x2a11), hex: '55aa9000040100000094', withResponse: false },
    ]);

    expect(adapter.parseNotification(hex(POWER_ON_376))).toBeNull();
    await flush();
    expect(written.map((w) => [w.hex, w.withResponse])).toEqual([
      ['55aa9000040100000094', false],
      ['55aa9000040100000094', false],
    ]);

    // The #376 v1.24.0 session still completes on power-off, with no more writes.
    const settling = adapter.parseNotification(hex(WEIGHT_376))!;
    expect(adapter.isComplete(settling)).toBe(false);
    const done = adapter.parseNotification(hex(POWER_OFF_376))!;
    expect(done).toEqual({ weight: 103.5, impedance: 0 });
    expect(adapter.isComplete(done)).toBe(true);
    adapter.parseNotification(hex(POWER_ON_376));
    await flush();
    expect(written).toHaveLength(2);
  });

  it('repeats the kg command on the first power-on of the next session too', async () => {
    const adapter = new EsCs20mAdapter(captureClock);
    for (let session = 0; session < 2; session++) {
      const { ctx, written } = mockCtx(NO_AE00_UNIT);
      adapter.onSessionStart();
      await adapter.onConnected!(ctx);
      adapter.parseNotification(hex(POWER_ON_376));
      await flush();
      expect(written).toHaveLength(2);
      adapter.onSessionEnd!();
    }
  });
});

describe('EsCs20mAdapter frame builders', () => {
  it('builds the 0x96 guest profile from the profile (made-up profile)', () => {
    expect(buildGuestProfileFrame(MADE_UP_PROFILE, captureClock()).toString('hex')).toBe(
      MADE_UP_GUEST_PROFILE,
    );
  });

  // The birth date parses as UTC midnight, so a host west of Greenwich read it
  // back as the day before with the local getters.
  it('keeps the birth day on a host behind UTC', () => {
    const savedTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const f = buildGuestProfileFrame(
        { ...MADE_UP_PROFILE, birthDate: '1990-06-15' },
        new Date(0x6ac01376 * 1000),
      );
      expect([f.readUInt16BE(6), f[8], f[9]]).toEqual([1990, 6, 15]);
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  it('falls back to 1 January, 170.0 cm and 70.00 kg, and flags the athlete curve', () => {
    const f = buildGuestProfileFrame(
      { gender: 'male', age: 36, height: 0, isAthlete: true },
      captureClock(),
    );
    expect(() => assertAllowedWrite(f)).not.toThrow();
    expect(f[5]).toBe(0x19); // male, slot 9
    expect(f.readUInt16BE(6)).toBe(2026 - 36);
    expect([f[8], f[9]]).toEqual([1, 1]);
    expect(f.readUInt16BE(10)).toBe(1700);
    expect(f.readUInt32BE(12)).toBe(7000);
    expect(f[16]).toBe(0x6a);
    expect([f[17], f[18]]).toEqual([0xff, 0x05]);
  });

  it('never sends a zero last weight', () => {
    const f = buildGuestProfileFrame({ ...MADE_UP_PROFILE, lastKnownWeight: 0 }, captureClock());
    expect(f.readUInt32BE(12)).toBe(7000);
  });

  it('encodes the zone as sign (1 = behind UTC) and whole hours', () => {
    const at = (offset: number): string => {
      const d = captureClock();
      d.getTimezoneOffset = () => offset;
      return buildSetTimeFrame(d).toString('hex').slice(-6, -2);
    };
    expect(at(240)).toBe('0104'); // EDT, as in the capture
    expect(at(-120)).toBe('0002'); // CEST, as the 0x31 unit's app sends
    expect(at(0)).toBe('0000');
    expect(at(-330)).toBe('0005'); // a half-hour zone is truncated
  });
});

describe('EsCs20mAdapter write allow-list', () => {
  it('accepts every frame the adapter builds', () => {
    for (const h of [
      APP_POWER_ON_ACK_436,
      APP_SET_TIME_436,
      MADE_UP_GUEST_PROFILE,
      '55aa9000040200000095',
      '55aa9000040100000094',
    ]) {
      expect(() => assertAllowedWrite(hex(h))).not.toThrow();
    }
  });

  it('refuses a 0x90 with a mode byte', () => {
    // Mode 1 is what the Renpho app sends to the 0x31 unit (three public
    // btsnoops on renpho-escs20m#10); mode 2 is the probe write that left the
    // #376 unit in zero-current mode (Venomeus log).
    expect(() => assertAllowedWrite(hex('55aa9000040100010095'))).toThrow(/0x90/);
    expect(() => assertAllowedWrite(hex('55aa9000040100020096'))).toThrow(/0x90/);
  });

  it('refuses a 0x96 outside the guest slot', () => {
    const p = [...hex(MADE_UP_GUEST_PROFILE).subarray(5, 19)];
    p[0] = 0x21; // slot 1: a registered user the app owns
    expect(() => assertAllowedWrite(hex(frameHex(0x96, p)))).toThrow(/0x96/);
    const q = [...hex(MADE_UP_GUEST_PROFILE).subarray(5, 19)];
    q[12] = 0x00;
    expect(() => assertAllowedWrite(hex(frameHex(0x96, q)))).toThrow(/0x96/);
  });

  it('refuses a 0x96 with a sex other than 1 or 2', () => {
    const p = [...hex(MADE_UP_GUEST_PROFILE).subarray(5, 19)];
    p[0] = 0x39; // sex 3, still slot 9
    expect(() => assertAllowedWrite(hex(frameHex(0x96, p)))).toThrow(/0x96/);
  });

  it('refuses a 0x97 other than the clock', () => {
    const p = [...hex(APP_SET_TIME_436).subarray(5, 14)];
    p[0] = 0x10; // sub-op 16, probed on these units with unknown effect
    expect(() => assertAllowedWrite(hex(frameHex(0x97, p)))).toThrow(/0x97/);
  });

  it('refuses a 0x97 with an offset past 14 hours', () => {
    const p = [...hex(APP_SET_TIME_436).subarray(5, 14)];
    p[8] = 15;
    expect(() => assertAllowedWrite(hex(frameHex(0x97, p)))).toThrow(/0x97/);
  });

  it('refuses a bad checksum, a length mismatch and any other command', () => {
    expect(() => assertAllowedWrite(hex('55aa9700090100006ac01376010459'))).toThrow(/checksum/);
    // An allowed frame with a forbidden one riding behind it.
    expect(() => assertAllowedWrite(hex(APP_POWER_ON_ACK_436 + '55aa9000040100020096'))).toThrow(
      /length/,
    );
    expect(() => assertAllowedWrite(hex(frameHex(0x99, [0x01])))).toThrow(/0x99/);
  });
});
