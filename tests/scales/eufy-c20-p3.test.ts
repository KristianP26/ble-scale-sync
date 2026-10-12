import { describe, it, expect, vi, afterEach } from 'vitest';
import { EufyC20P3Adapter } from '../../src/scales/eufy-c20-p3.js';
import { EufyP2Adapter } from '../../src/scales/eufy-p2.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { applyForcedAdapter } from '../../src/scales/force.js';
import { checkRegistryIntegrity } from '../../src/scales/registry-check.js';
import { buildPayload } from '../../src/scales/body-comp-helpers.js';
import { evaluateAdvertisement } from '../../src/ble/advertisement.js';
import { isHistoricalReading } from '../../src/interfaces/reading-time.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';
import type { BleDeviceInfo, ScaleAdapter } from '../../src/interfaces/scale-adapter.js';
import { bleLog } from '../../src/ble/types.js';

/**
 * Real frames only: the manufacturer data of real advertisements, the company
 * id stripped as every transport delivers it. All of them are from Home
 * Assistant debug logs that owners posted in bdr99/eufylife-ble-client; the
 * comment and the line of the comment body are given with each. Log times are
 * the poster's local time. Nothing here is built from our own reading of the
 * format: the only altered frames are changes to these, used to show a refusal
 * or a boundary, and each says which bytes changed.
 */

/*
 * C20 (T9130), BC:0F:B7:00:9C:9D, company id 0xBC64 on every frame:
 * bdr99/eufylife-ble-client#5, comment 2564606224 (woodsb02), one weigh-in.
 * The poster "narrowed in on the weight of 100.1kg".
 */
const C20_WOODS = 'BC:0F:B7:00:9C:9D';
/** Line 4, 12:02:08.895, idle. */
const S1_IDLE = '0fb7009c9d00c0c970670000000000000000';
/** Line 5, 12:02:09.063, status 0x0D at 0 kg. */
const S1_0D = '0fb7009c9d00c0c970670d00000000000000';
/** Line 14, 12:02:11.930, live 100.10 kg. */
const S1_LIVE = '0fb7009c9d00c3c9706701001a2700000000';
/** Line 19, 12:02:14.197, locked 100.10 kg; scale clock 2024-12-29T04:02:13Z. */
const S1_LOCK = '0fb7009c9d00c5c9706705001a2700000000';
/** Line 20, 12:02:16.245, status 0x15. */
const S1_15 = '0fb7009c9d00c7c9706715001a2700000000';
/** Line 22, 12:02:17.768, status 0x25 with [11] = 0x80, 24 bytes, [17..18] = 445.2. */
const S1_25_END = '0fb7009c9d00c9c9706725801a27000000641104038a0000';
/** Line 23, 12:02:44.596, switching off: 0x0D with [11] = 0x40. */
const S1_OFF = '0fb7009c9d00e2c970670d40000000000000';

/*
 * C20 (T9130), BC:0F:B7:00:BD:B4, company id 0xBC64: bdr99/eufylife-ble-client#5,
 * comment 2698363321 (sefininio). Only a tap, no final frame.
 */
const C20_SEFI = 'BC:0F:B7:00:BD:B4';
/** Line 7, 18:59:52.360, live 3.05 kg. */
const S2_LIVE = '0fb700bdb4008631c7670100310100000000';
/** Line 8, 18:59:52.668, status 0x0D. */
const S2_0D = '0fb700bdb4008631c7670d00000000000000';
/** Line 17, 19:00:08.017, switching off. */
const S2_OFF = '0fb700bdb4009131c7670d40000000000000';

/*
 * P3 (T9150), CF:E7:09:18:28:04: bdr99/eufylife-ble-client#3, comment
 * 2564412265 (duke-of-jbala). Home Assistant's dict holds two keys; the
 * current frames are under 0xCF4D.
 */
const P3_DUKE = 'CF:E7:09:18:28:04';
/** Line 15, 19:19:08.600, under 0xCF4D: locked 82.80 kg; scale clock 19:19:08Z. */
const S3_LOCK = 'e709182804002c4f706705005820000000000000000000';
/** Line 19, 19:19:12.245, under 0xCF4D: status 0x25, [17..18] = 513.1. */
const S3_25 = 'e709182804002f4f7067250058200000000b143534d900';
/**
 * Lines 21 to 25, 29 and 30 (19:19:14.910 to 19:19:20.539), under 0xCF4D:
 * status 0x65, the scale clock one second further on each.
 */
const S3_65 = [
  'e70918280400324f7067650058200000000b143534d900',
  'e70918280400334f7067650058200000000b143534d900',
  'e70918280400344f7067650058200000000b143534d900',
  'e70918280400354f7067650058200000000b143534d900',
  'e70918280400364f7067650058200000000b143534d900',
  'e70918280400374f7067650058200000000b143534d900',
  'e70918280400384f7067650058200000000b143534d900',
];
/** Line 32, 19:19:21.341, under 0xCF4D: status 0xA5 with [11] = 0x80, heart rate 95. */
const S3_A5_END = 'e70918280400384f7067a5805820005f000b143534d900';

/*
 * P3 (T9150), CF:E8:07:12:20:9D: bdr99/eufylife-ble-client#3, comment
 * 2870205491 (branda92). The scale's clock was never set: it reads 2022.
 */
const P3_BRANDA = 'CF:E8:07:12:20:9D';
/** Line 55, 23:19:34.170, under 0xCF5D: locked 68.55 kg; scale clock 2022-02-02T00:54:48Z. */
const S4_LOCK = 'e80712209d0058d6f9610500c71a010000000000000000';
/** Line 72, 23:19:38.012, under 0xCF5D: status 0x25, [17..18] = 435.0. */
const S4_25 = 'e80712209d005cd6f9612500c71a010000fe10dcd6e300';
/** Line 8, 23:19:30.486, under 0xCF53: the frame cached from switching off, 23 min earlier. */
const S4_OFF = 'e80712209d00c6d0f9610d400000010000000000000000';

/*
 * P3 (T9150), CF:E7:0B:08:81:8A, company id 0xCF45: bdr99/eufylife-ble-client#3,
 * comment 2873299889 (NoLifer88).
 */
const P3_NOLIFER = 'CF:E7:0B:08:81:8A';
/** Line 13, 17:44:51.267, live 123.20 kg. */
const S5_LIVE = 'e70b08818a008025226801002030000000000000000000';
/**
 * Line 18, 17:45:02.073, the first final frame in the log: status 0x25 with
 * [11] = 0x80, 123.00 kg, [17..18] = 433.1; scale clock 2025-05-12T16:45:00Z.
 */
const S5_25_END = 'e70b08818a008c25226825800c30000000eb10f1f73500';
/** Line 11, 17:44:45.584, the frame cached from switching off, 12.6 h earlier. */
const S5_OFF = 'e70b08818a006b7421680d400000000000000000000000';

/*
 * P3 (T9150), address and company id not in the log: bdr99/eufylife-ble-client#3,
 * comment 3369241833 (imanshafiei540), the library's own debug lines
 * ("Multiple advertisement packets found"), the current frame second in each.
 */
/**
 * Line 67, 11:17:14.299, the first final frame in the log: status 0x25,
 * 60.55 kg, [17..18] = 533.3; scale clock 2025-10-05T18:17:11Z.
 */
const S6_25 = 'e81127057f0027b6e2682500a717000000d5145f55ab00';
/** Line 121, 11:17:22.381: status 0xA5 with [11] = 0x80, heart rate 72. */
const S6_A5_END = 'e81127057f0032b6e268a580a717004800d5145f55ab00';

/*
 * Eufy P2 Pro (T9149), bdr99/eufylife-ble-client#8 (fft1010, the issue body):
 * manufacturer data Home Assistant showed for one unit. Its address,
 * CF:E8:12:18:33:EE, is the frame's own [0..5]. The issue gives no company id;
 * 0xFF48 is the one another P2 Pro (CF:E6:03:1D:09:F7) advertised in #98
 * (comment 4188979134) and the one the P2 adapter requires.
 */
const P2_PRO_8 = 'cfe8121833eecf51c00e29dcd69700000000e4';
const P2_PRO_MAC = 'CF:E8:12:18:33:EE';

const NAME = 'Eufy Smart Scale C20/P3';
const P2_NAME = 'Eufy Smart Scale P2/P2 Pro';

/** A wall clock far from every scale clock here, so no reading is stamped. */
const FAR = Date.parse('2030-01-01T00:00:00Z');

function buf(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/** A real frame with byte `index` replaced. Derived, only ever used to show a refusal or a boundary. */
function withByte(hex: string, index: number, value: number): Buffer {
  const b = buf(hex);
  b[index] = value;
  return b;
}

/** A real frame with its scale clock ([6..9]) moved by `seconds`. Derived. */
function shifted(hex: string, seconds: number): Buffer {
  const b = buf(hex);
  b.writeUInt32LE(b.readUInt32LE(6) + seconds, 6);
  return b;
}

function clockMs(hex: string): number {
  return buf(hex).readUInt32LE(6) * 1000;
}

function advert(
  data: Buffer | string,
  id: number,
  address: string | undefined,
  localName = '',
): BleDeviceInfo {
  return {
    localName,
    ...(address !== undefined ? { address } : {}),
    serviceUuids: [],
    manufacturerData: { id, data: typeof data === 'string' ? buf(data) : data },
  };
}

const resolved = (d: BleDeviceInfo) => resolveAdapter(d, adapters)?.name;

/** An adapter whose clocks never stamp a reading and never expire a log key. */
const fresh = () => new EufyC20P3Adapter(() => FAR);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EufyC20P3Adapter (#408)', () => {
  describe('matches() and registry resolution', () => {
    const units = [
      { mac: C20_WOODS, id: 0xbc64, frame: S1_LOCK, name: 'eufy T9130' },
      { mac: P3_DUKE, id: 0xcf4d, frame: S3_LOCK, name: 'eufy T9150' },
      { mac: P3_BRANDA, id: 0xcf5d, frame: S4_LOCK, name: 'eufy T9150' },
      { mac: P3_NOLIFER, id: 0xcf45, frame: S5_25_END, name: 'eufy T9150' },
      { mac: C20_SEFI, id: 0xbc64, frame: S2_LIVE, name: 'eufy T9130' },
    ];

    it('resolves every unit by name and address', () => {
      for (const u of units) expect(resolved(advert(u.frame, u.id, u.mac, u.name))).toBe(NAME);
    });

    it('resolves every unit without its name, by the address echoed in the company id and [0..4]', () => {
      for (const u of units) expect(resolved(advert(u.frame, u.id, u.mac))).toBe(NAME);
      // P3 frames under the other key of the same unit (the low byte changes).
      expect(resolved(advert(S3_LOCK, 0xcf4e, P3_DUKE))).toBe(NAME);
      expect(resolved(advert(S4_OFF, 0xcf53, P3_BRANDA))).toBe(NAME);
    });

    it('resolves by name alone: a scan response without manufacturer data, or no address (macOS)', () => {
      for (const name of ['eufy T9130', 'eufy T9150']) {
        expect(resolved({ localName: name, serviceUuids: [] })).toBe(NAME);
        expect(resolved(advert(S3_LOCK, 0xcf4d, undefined, name))).toBe(NAME);
      }
    });

    it('does not claim a frame with neither a name nor an address', () => {
      const adapter = new EufyC20P3Adapter();
      expect(adapter.matches(advert(S1_LOCK, 0xbc64, undefined))).toBe(false);
      expect(resolved(advert(S1_LOCK, 0xbc64, undefined))).toBeUndefined();
      expect(resolved(advert(S3_LOCK, 0xcf4d, undefined))).toBeUndefined();
    });

    it("refuses a real frame heard from another unit's address", () => {
      expect(resolved(advert(S1_LOCK, 0xbc64, C20_SEFI))).toBeUndefined();
      expect(resolved(advert(S3_LOCK, 0xcf4d, P3_BRANDA))).toBeUndefined();
    });

    it('refuses an echo off by one byte: [0] 0x0f -> 0x0e, or the company id high byte 0xBC -> 0xBD', () => {
      const adapter = new EufyC20P3Adapter();
      expect(adapter.matches(advert(withByte(S1_LOCK, 0, 0x0e), 0xbc64, C20_WOODS))).toBe(false);
      expect(adapter.matches(advert(S1_LOCK, 0xbd64, C20_WOODS))).toBe(false);
      expect(adapter.matches(advert(S1_LOCK, 0xbc64, 'BC:0F:B7:00:9C:9E'))).toBe(false);
    });

    it('refuses [5] other than zero ([5] 0x00 -> 0x01) and a frame cut to 17 bytes', () => {
      const adapter = new EufyC20P3Adapter();
      expect(adapter.matches(advert(withByte(S1_LOCK, 5, 0x01), 0xbc64, C20_WOODS))).toBe(false);
      expect(adapter.matches(advert(buf(S1_LOCK).subarray(0, 17), 0xbc64, C20_WOODS))).toBe(false);
    });

    it('declares no manufacturerId: the low byte of the company id changes', () => {
      expect(new EufyC20P3Adapter().match.manufacturerId).toBeUndefined();
    });
  });

  describe('neighbours: Eufy P2 and 1byone', () => {
    it('leaves the P2 to the P2 adapter, by name and by its broadcast', () => {
      expect(resolved({ localName: 'eufy T9149', serviceUuids: [] })).toBe(P2_NAME);
      expect(resolved({ localName: 'eufy T9148', serviceUuids: [] })).toBe(P2_NAME);
      const p2 = advert(P2_PRO_8, 0xff48, P2_PRO_MAC);
      expect(new EufyC20P3Adapter().matches(p2)).toBe(false);
      expect(resolved(p2)).toBe(P2_NAME);
    });

    it('leaves eufy T9146 to the 1byone adapters', () => {
      expect(resolved({ localName: 'eufy T9146', serviceUuids: [] })).toMatch(/^1byone/);
    });

    // Derived: S3_LOCK with [6] 0x2c -> 0xcf, heard under 0xFF48 from
    // FF:E7:09:18:28:04. No P3 has been seen with such an address; the P2 claim
    // would take it and read 13.83 kg from the clock and status bytes.
    it('keeps a P3 that would meet the P2 broadcast claim (address FF:.., id 0xFF48, [6] 0xCF)', () => {
      const frame = withByte(S3_LOCK, 6, 0xcf);
      const info = advert(frame, 0xff48, 'FF:E7:09:18:28:04');
      expect(new EufyP2Adapter().matches(info)).toBe(true);
      expect(resolved(info)).toBe(NAME);
    });

    it('passes the registry integrity check, whose invariant puts C20/P3 above P2', () => {
      expect(checkRegistryIntegrity(adapters).errors).toEqual([]);
      const lowered: ScaleAdapter[] = adapters.map((a) =>
        a.name === NAME
          ? Object.assign(new EufyC20P3Adapter(), { match: { ...a.match!, priority: 265 } })
          : a,
      );
      expect(checkRegistryIntegrity(lowered).errors.join('\n')).toContain(
        `"${NAME}" (priority 265) must outrank "${P2_NAME}"`,
      );
    });
  });

  describe('decoding', () => {
    it('reads the first final frame of every weigh-in', () => {
      for (const [hex, kg] of [
        [S1_LOCK, 100.1],
        [S3_LOCK, 82.8],
        [S4_LOCK, 68.55],
        [S5_25_END, 123.0],
        [S6_25, 60.55],
      ] as const) {
        expect(fresh().parseBroadcast(buf(hex))).toEqual({ weight: kg, impedance: 0 });
      }
    });

    it('reads the same weight from every final status of one weigh-in', () => {
      for (const hex of [S1_LOCK, S1_15, S1_25_END]) {
        expect(fresh().parseBroadcast(buf(hex))?.weight).toBe(100.1);
      }
      for (const hex of [S3_LOCK, S3_25, S3_65[0], S3_A5_END]) {
        expect(fresh().parseBroadcast(buf(hex))?.weight).toBe(82.8);
      }
      expect(fresh().parseBroadcast(buf(S4_25))?.weight).toBe(68.55);
      expect(fresh().parseBroadcast(buf(S6_A5_END))?.weight).toBe(60.55);
    });

    it('reports live frames (0x01) as live weights, never as readings', () => {
      const adapter = fresh();
      for (const [hex, kg] of [
        [S1_LIVE, 100.1],
        [S5_LIVE, 123.2],
        [S2_LIVE, 3.05],
      ] as const) {
        expect(adapter.parseBroadcast(buf(hex))).toBeNull();
        expect(adapter.parseLiveBroadcast(buf(hex))).toEqual({ weight: kg });
      }
    });

    it('reports nothing for idle, 0x0D and switching-off frames', () => {
      const adapter = fresh();
      for (const hex of [S1_IDLE, S1_0D, S1_OFF, S2_0D, S2_OFF, S4_OFF, S5_OFF]) {
        expect(adapter.parseBroadcast(buf(hex))).toBeNull();
        expect(adapter.parseLiveBroadcast(buf(hex))).toBeNull();
      }
    });

    it('never reports a final frame on the live channel (#356)', () => {
      const adapter = fresh();
      for (const hex of [S1_LOCK, S1_25_END, S3_A5_END, S5_25_END]) {
        expect(adapter.parseLiveBroadcast(buf(hex))).toBeNull();
      }
    });

    // The adapter prefers passive reading, so a reading isComplete() refuses
    // would be held as partial and exported later; the frame itself is refused.
    it('refuses a weight outside 2 to 250 kg on both channels ([13] 0x27 -> 0x62, 251.14 kg)', () => {
      const adapter = fresh();
      const heavy = withByte(S1_LOCK, 13, 0x62);
      expect(adapter.parseBroadcast(heavy)).toBeNull();
      expect(evaluateAdvertisement(adapter, advert(heavy, 0xbc64, C20_WOODS))).toEqual({
        kind: 'wait',
      });
      expect(adapter.parseLiveBroadcast(withByte(S1_LIVE, 13, 0x62))).toBeNull();
    });

    it('refuses a frame cut to 17 bytes or with [5] other than zero', () => {
      const adapter = fresh();
      expect(adapter.parseBroadcast(buf(S1_LOCK).subarray(0, 17))).toBeNull();
      expect(adapter.parseBroadcast(withByte(S1_LOCK, 5, 0x01))).toBeNull();
      expect(adapter.parseLiveBroadcast(withByte(S1_LIVE, 5, 0x01))).toBeNull();
    });

    it('never publishes [17..18], although 445 to 533 would pass as plausible ohm', () => {
      for (const hex of [S1_25_END, S3_25, S3_65[0], S3_A5_END, S4_25, S5_25_END, S6_A5_END]) {
        expect(fresh().parseBroadcast(buf(hex))?.impedance).toBe(0);
      }
    });
  });

  describe('statuses the adapter does not decode', () => {
    it('refuses an unknown status ([10] 0x05 -> 0x45) on both channels and warns once', () => {
      const adapter = fresh();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const frame = withByte(S1_LOCK, 10, 0x45);
      expect(adapter.parseBroadcast(frame)).toBeNull();
      expect(adapter.parseBroadcast(frame)).toBeNull();
      expect(adapter.parseLiveBroadcast(frame)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('status 0x45');
    });

    it('does not warn for any captured frame', () => {
      const adapter = fresh();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      for (const hex of [
        S1_IDLE,
        S1_0D,
        S1_LIVE,
        S1_LOCK,
        S1_15,
        S1_25_END,
        S1_OFF,
        S2_LIVE,
        S2_0D,
        S2_OFF,
        S3_LOCK,
        S3_25,
        ...S3_65,
        S3_A5_END,
        S4_OFF,
        S4_LOCK,
        S4_25,
        S5_OFF,
        S5_LIVE,
        S5_25_END,
        S6_25,
        S6_A5_END,
      ]) {
        adapter.parseBroadcast(buf(hex));
        adapter.parseLiveBroadcast(buf(hex));
      }
      expect(warn).not.toHaveBeenCalled();
    });

    // Derived: S3_A5_END with [10] 0xa5 -> 0xe5, a status a pull request to
    // eufylife-ble-client names after 0xA5 but no log shows.
    it('only logs an unknown status that follows a weigh-in already reported', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const e5 = withByte(S3_A5_END, 10, 0xe5);

      const reported = fresh();
      expect(reported.parseBroadcast(buf(S3_LOCK))?.weight).toBe(82.8);
      expect(reported.parseBroadcast(e5)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      expect(
        debug.mock.calls.some(([m]) => String(m).includes('status 0xe5 after a reported')),
      ).toBe(true);

      // The same frame without the export before it does ask for a report.
      expect(fresh().parseBroadcast(e5)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('the scale clock as the reading time', () => {
    const at = (hex: string, wallMs: number) =>
      new EufyC20P3Adapter(() => wallMs).parseBroadcast(buf(hex));

    it('stamps the reading when the scale clock agrees with the host within two minutes', () => {
      // Each host time is the log line's time moved by whole hours to UTC: the
      // poster's time zone, inferred as the shift that brings it nearest the
      // scale clock (+8, 0, +1 and -7 hours from UTC).
      const cases = [
        [S1_LOCK, '2024-12-29T04:02:14.197Z', '2024-12-29T04:02:13.000Z'],
        [S3_LOCK, '2024-12-28T19:19:08.600Z', '2024-12-28T19:19:08.000Z'],
        [S5_25_END, '2025-05-12T16:45:02.073Z', '2025-05-12T16:45:00.000Z'],
        [S6_25, '2025-10-05T18:17:14.299Z', '2025-10-05T18:17:11.000Z'],
      ] as const;
      for (const [hex, host, stamp] of cases) {
        const reading = at(hex, Date.parse(host));
        expect(reading?.timestamp?.toISOString()).toBe(stamp);
        expect(isHistoricalReading(reading!, Date.parse(host))).toBe(false);
      }
    });

    it('uses the receipt time for a clock never set (2022), still reading the weight, logging it once', () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const adapter = new EufyC20P3Adapter(() => Date.parse('2025-05-11T21:19:34.170Z'));
      expect(adapter.parseBroadcast(buf(S4_LOCK))).toEqual({ weight: 68.55, impedance: 0 });
      // Derived: S4_LOCK with [12] 0xc7 -> 0xd1, a second weigh-in of the unit.
      expect(adapter.parseBroadcast(withByte(S4_LOCK, 12, 0xd1))?.timestamp).toBeUndefined();
      const clockLines = debug.mock.calls.filter(([m]) => String(m).includes('clock reads'));
      expect(clockLines).toHaveLength(1);
      expect(String(clockLines[0][0])).toContain('2022-02-02T00:54:48.000Z');
    });

    it('keeps the stamp at 120 s either way and drops it at 121 s', () => {
      const t = clockMs(S1_LOCK);
      expect(at(S1_LOCK, t + 120_000)?.timestamp).toBeDefined();
      expect(at(S1_LOCK, t - 120_000)?.timestamp).toBeDefined();
      expect(at(S1_LOCK, t + 121_000)?.timestamp).toBeUndefined();
      expect(at(S1_LOCK, t - 121_000)?.timestamp).toBeUndefined();
      expect(at(S1_LOCK, t + 121_000)?.weight).toBe(100.1);
    });
  });

  // The last final frame repeats unchanged for half a minute, and a poll
  // transport starts its next scan 5 s after an export at the least.
  describe('a weigh-in seen again after its export', () => {
    it('is handed out once for all final frames of one weigh-in (C20: 0x05, 0x15, 0x25 repeated)', () => {
      const adapter = fresh();
      const got = [S1_LOCK, S1_15, S1_15, S1_25_END, S1_25_END, S1_25_END, S1_25_END]
        .map((hex) => adapter.parseBroadcast(buf(hex)))
        .filter((r) => r !== null);
      expect(got).toEqual([{ weight: 100.1, impedance: 0 }]);
    });

    it('is handed out once for a P3 weigh-in from 0x05 to 0xA5, 12 s of scale clock', () => {
      const adapter = fresh();
      const got = [S3_LOCK, S3_25, ...S3_65, S3_A5_END]
        .map((hex) => adapter.parseBroadcast(buf(hex)))
        .filter((r) => r !== null);
      expect(got).toHaveLength(1);
    });

    // Derived: S1_LOCK with the scale clock moved on by 60 s and 61 s.
    it('is held back up to 60 s of scale clock, and handed out again at 61 s', () => {
      const held = fresh();
      held.parseBroadcast(buf(S1_LOCK));
      expect(held.parseBroadcast(shifted(S1_LOCK, 60))).toBeNull();

      const again = fresh();
      again.parseBroadcast(buf(S1_LOCK));
      expect(again.parseBroadcast(shifted(S1_LOCK, 61))?.weight).toBe(100.1);
    });

    // Derived: the S3 0x65 frame at the lock's clock + 50 s, the 0xA5 frame at + 100 s.
    it('measures the window from the last final frame held back, not from the export', () => {
      const adapter = fresh();
      expect(adapter.parseBroadcast(buf(S3_LOCK))?.weight).toBe(82.8);
      const lock = buf(S3_LOCK).readUInt32LE(6);
      const at = (hex: string, s: number) => shifted(hex, lock + s - buf(hex).readUInt32LE(6));
      expect(adapter.parseBroadcast(at(S3_65[0], 50))).toBeNull();
      expect(adapter.parseBroadcast(at(S3_A5_END, 100))).toBeNull();
    });

    it('does not depend on the host clock', () => {
      let wall = FAR;
      const adapter = new EufyC20P3Adapter(() => wall);
      adapter.parseBroadcast(buf(S1_LOCK));
      wall += 3_600_000;
      expect(adapter.parseBroadcast(buf(S1_25_END))).toBeNull();
    });

    it('does not hold back another unit, or another weight of the same unit', () => {
      const adapter = fresh();
      adapter.parseBroadcast(buf(S1_LOCK));
      // Derived: S1_LOCK with [4] 0x9d -> 0x9e, the same weigh-in from another unit.
      expect(adapter.parseBroadcast(withByte(S1_LOCK, 4, 0x9e))?.weight).toBe(100.1);
      // Derived: S1_15 with [12] 0x1a -> 0x10, someone else weighing 2 s later.
      expect(adapter.parseBroadcast(withByte(S1_15, 12, 0x10))?.weight).toBe(100.0);
      expect(adapter.parseBroadcast(buf(S3_LOCK))?.weight).toBe(82.8);
    });
  });

  describe('advertisement decision', () => {
    it('completes on the first final frame', () => {
      expect(evaluateAdvertisement(fresh(), advert(S1_LOCK, 0xbc64, C20_WOODS))).toEqual({
        kind: 'complete',
        reading: { weight: 100.1, impedance: 0 },
      });
      expect(evaluateAdvertisement(fresh(), advert(S5_25_END, 0xcf45, P3_NOLIFER))).toEqual({
        kind: 'complete',
        reading: { weight: 123.0, impedance: 0 },
      });
    });

    it('waits on a live frame with its weight, and on idle frames without one', () => {
      expect(evaluateAdvertisement(fresh(), advert(S1_LIVE, 0xbc64, C20_WOODS))).toEqual({
        kind: 'wait',
        live: { weight: 100.1 },
      });
      expect(evaluateAdvertisement(fresh(), advert(S1_IDLE, 0xbc64, C20_WOODS))).toEqual({
        kind: 'wait',
      });
      expect(evaluateAdvertisement(fresh(), advert(S1_0D, 0xbc64, C20_WOODS))).toEqual({
        kind: 'wait',
      });
    });

    it('waits on a final frame already reported', () => {
      const adapter = fresh();
      evaluateAdvertisement(adapter, advert(S1_LOCK, 0xbc64, C20_WOODS));
      expect(evaluateAdvertisement(adapter, advert(S1_25_END, 0xbc64, C20_WOODS))).toEqual({
        kind: 'wait',
      });
    });

    // The forced wrapper drives the registry's own instance; like Etekcity
    // Fit 8S, a frame it holds back is then nothing at all.
    it('under ble.force_scale_adapter: completes on a final frame, does nothing on its repeat', () => {
      const [forced] = applyForcedAdapter(adapters, NAME);
      const info = advert(S5_25_END, 0xcf45, P3_NOLIFER);
      expect(evaluateAdvertisement(forced, info).kind).toBe('complete');
      expect(evaluateAdvertisement(forced, info)).toEqual({ kind: 'none' });
    });
  });

  describe('debug log', () => {
    it('logs a final payload once, whatever the clock in it, and again after the expiry', () => {
      let t = 0;
      const adapter = new EufyC20P3Adapter(
        () => FAR,
        () => t,
      );
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const finals = () => debug.mock.calls.filter(([m]) => String(m).includes('final:'));
      adapter.parseBroadcast(buf(S3_25));
      for (const hex of S3_65) {
        t += 400;
        adapter.parseBroadcast(buf(hex));
      }
      // One line for 0x25, one for the seven 0x65 frames.
      expect(finals()).toHaveLength(2);
      expect(String(finals()[1][0])).toBe(
        'Eufy C20/P3 final: 82.80 kg status=0x65 end=0x00 (undecoded: [14]=0x00 hr=0 ' +
          'z=513.1 [19..21]=3534d9) scale clock 2024-12-28T19:19:14.000Z ' +
          `(${Math.round((Date.parse('2024-12-28T19:19:14Z') - FAR) / 1000)} s from host) ` +
          `frame=${S3_65[0]}, already reported`,
      );
      t += 5_000;
      adapter.parseBroadcast(buf(S3_65[6]));
      expect(finals()).toHaveLength(3);
    });

    it('logs a live value once, and again only when it changes', () => {
      const adapter = fresh();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const live = () => debug.mock.calls.filter(([m]) => String(m).includes('live:'));
      adapter.parseBroadcast(buf(S1_LIVE));
      adapter.parseBroadcast(buf(S1_LIVE));
      expect(live()).toHaveLength(1);
      adapter.parseBroadcast(buf(S5_LIVE));
      expect(live()).toHaveLength(2);
    });
  });

  describe('completion and body composition', () => {
    const adapter = fresh();

    it('completes only inside the plausible range', () => {
      expect(adapter.isComplete({ weight: 100.1, impedance: 0 })).toBe(true);
      expect(adapter.isComplete({ weight: 1.5, impedance: 0 })).toBe(false);
      expect(adapter.isComplete({ weight: 300, impedance: 0 })).toBe(false);
    });

    it('estimates composition from BMI, ignoring any impedance on the reading', () => {
      const profile = defaultProfile();
      expect(adapter.computeMetrics({ weight: 100.1, impedance: 445.2 }, profile)).toEqual(
        buildPayload(100.1, 0, {}, profile),
      );
    });
  });
});
