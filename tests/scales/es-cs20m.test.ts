import { describe, it, expect } from 'vitest';
import { EsCs20mAdapter } from '../../src/scales/es-cs20m.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

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

    it('parses msgId 0x15 extended frame (returns null, stores resistance)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(11);
      buf[0] = 0x15;
      buf.writeUInt16BE(500, 9); // resistance

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('parses msgId 0x15 with 55 AA header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(13);
      buf[0] = 0x55;
      buf[1] = 0xaa;
      buf[2] = 0x15; // msgId at [2]
      buf.writeUInt16BE(500, 9);

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('uses resistance from 0x15 frame in subsequent 0x14 frame', () => {
      const adapter = makeAdapter();

      // Extended frame stores resistance
      const ext = Buffer.alloc(11);
      ext[0] = 0x15;
      ext.writeUInt16BE(500, 9);
      adapter.parseNotification(ext);

      // Weight frame without resistance
      const w = Buffer.alloc(10);
      w[0] = 0x14;
      w[5] = 0x01;
      w.writeUInt16BE(8000, 8);

      const reading = adapter.parseNotification(w);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(500);
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

  // R-A016 official-app capture, from tests/test_x55aa_protocol.py in
  // https://github.com/ronnnnnnnnnnnnn/renpho-escs20m (91.45 kg).
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
