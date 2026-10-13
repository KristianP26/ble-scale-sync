import { describe, it, expect, vi, afterEach } from 'vitest';
import { PicoocMiniLiteAdapter } from '../../src/scales/picooc-mini-lite.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { applyForcedAdapter } from '../../src/scales/force.js';
import { checkRegistryIntegrity } from '../../src/scales/registry-check.js';
import { buildPayload } from '../../src/scales/body-comp-helpers.js';
import { evaluateAdvertisement } from '../../src/ble/advertisement.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';
import { bleLog } from '../../src/ble/types.js';

/**
 * Real frames only: the manufacturer data of real advertisements from one
 * PICOOC Mini Lite, D0:49:00:4B:4F:1E, the company id 0x49D0 stripped as every
 * transport delivers it. The only altered frames are changes to these, used to
 * show a refusal or a boundary; each says which bytes changed, and its checksum
 * [13] is recomputed so the frame stays well formed.
 */

/*
 * nRF Connect log the scale's owner (dnsfdv) attached to oliexdev/openScale#1512,
 * comment 5552649285: "D0_49_00_4B_4F_1E - 2026-09-05 19_45_07.txt", 252 lines,
 * newest first, two weigh-ins. Every line is the same 31-byte advertisement
 * shape: flags, the name PICOOC-L, the manufacturer data.
 */
const ADDRESS = 'D0:49:00:4B:4F:1E';
const COMPANY_ID = 0x49d0;
/** Line 252, 2026-09-05 19:44:32.834, -63 dBm, the whole advertisement. */
const NRF_ADVERT_LINE_252 = '02010609095049434f4f432d4c11ffd049004b4f1e391f066813b08710000e';
/**
 * Line 252, 19:44:32.834, -63 dBm, the first of 119 identical adverts (lines
 * 252 to 134): 82.00 kg, 180.8 lb, [8..9] 504.0, unit 0x00.
 */
const NRF_82_00 = '004b4f1e391f066813b08710000e';
/**
 * Line 133, 19:44:50.895, -62 dBm, the first of 133 identical adverts (lines
 * 133 to 1): 86.30 kg, 190.2 lb, [8..9] 505.0, unit 0x00.
 */
const NRF_86_30 = '004b4f1e391f06be13ba876e0050';
/**
 * Milliseconds between consecutive lines of that log, oldest first (line 252 to
 * line 1). The payload changes after the 119th advert, across the 10 927 ms gap.
 */
const NRF_GAPS_MS =
  '51 101 48 50 50 49 50 51 60 51 50 49 102 49 50 50 48 50 13 49 50 50 50 50 49 50 50 52 48 ' +
  '11 52 101 47 50 50 150 50 12 99 50 50 100 49 100 51 61 49 51 50 49 50 50 100 50 11 100 50 ' +
  '100 99 52 48 160 52 47 50 100 50 50 53 8 51 49 100 50 101 48 50 61 53 48 50 100 50 50 49 ' +
  '50 61 52 48 150 49 51 49 101 11 102 48 50 50 99 103 47 11 53 48 50 50 52 197 50 61 50 49 ' +
  '51 50 49 101 99 10927 49 49 51 51 98 50 51 48 15 50 48 50 101 51 97 50 50 12 50 100 50 49 ' +
  '100 49 50 52 10 52 49 49 49 51 49 101 49 50 11 50 51 51 48 50 50 50 50 49 49 63 48 50 50 ' +
  '50 100 49 51 111 50 50 49 51 53 46 52 48 49 12 54 48 48 49 51 49 51 100 49 62 102 48 100 ' +
  '50 49 53 47 63 49 50 50 99 50 50 50 50 12 50 50 50 49 101 50 49 49 51 11 51 49 51 49 51 98 ' +
  '100 51 11 51 49 51 50 49 54 46 51 50 49 11 50 100 50 49 52 48 51 49 50';

/*
 * openScale PicoocBroadcastHandlerTest.kt at 9fea9c8 (added in fa8f768, PR
 * #1512, by the same owner): "advertisements captured from a physical PICOOC
 * Mini Lite", the same unit (its address is in the frame).
 */
/** packetA: 81.50 kg, 179.6 lb, [8..9] 492.0. */
const OS_A_81_50 = '004b4f1e391f065e13388704009c';
/** packetB: 81.60 kg, 179.8 lb, [8..9] 498.0. */
const OS_B_81_60 = '004b4f1e391f066013748706005c';
/** packetC: 82.70 kg, 182.4 lb, [8..9] 496.0. */
const OS_C_82_70 = '004b4f1e391f0676136087200040';

const REAL = [
  [NRF_82_00, 82.0],
  [NRF_86_30, 86.3],
  [OS_A_81_50, 81.5],
  [OS_B_81_60, 81.6],
  [OS_C_82_70, 82.7],
] as const;

const NAME = 'PICOOC Mini Lite';

function buf(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/** Sets the checksum [13] so that company id and data sum to 0xFF. */
function sealed(b: Buffer): Buffer {
  if (b.length !== 14) return b;
  let sum = (COMPANY_ID & 0xff) + (COMPANY_ID >> 8);
  for (let i = 0; i < 13; i++) sum += b[i];
  b[13] = ~sum & 0xff;
  return b;
}

/** A real frame with bytes from `index` replaced. Derived; the checksum is recomputed. */
function withBytes(hex: string, index: number, ...values: number[]): Buffer {
  const b = buf(hex);
  values.forEach((v, i) => (b[index + i] = v));
  return sealed(b);
}

function advert(
  data: Buffer | string | undefined,
  address: string | null = ADDRESS,
  localName = 'PICOOC-L',
): BleDeviceInfo {
  return {
    localName,
    ...(address !== null ? { address } : {}),
    serviceUuids: [],
    ...(data !== undefined
      ? { manufacturerData: { id: COMPANY_ID, data: typeof data === 'string' ? buf(data) : data } }
      : {}),
  };
}

const resolved = (d: BleDeviceInfo) => resolveAdapter(d, adapters)?.name;

/** An adapter on a clock the test moves. */
function clocked(start = 0) {
  const clock = { t: start };
  return { adapter: new PicoocMiniLiteAdapter(() => clock.t), clock };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PicoocMiniLiteAdapter (#408)', () => {
  describe('matches() and registry resolution', () => {
    it('resolves every real frame by its name, with the address and without (macOS)', () => {
      for (const [hex] of REAL) {
        expect(resolved(advert(hex))).toBe(NAME);
        expect(resolved(advert(hex, null))).toBe(NAME);
      }
    });

    it('resolves the name alone, a record without manufacturer data', () => {
      expect(resolved(advert(undefined))).toBe(NAME);
      expect(resolved(advert(undefined, null, 'picooc-l'))).toBe(NAME);
    });

    it('claims nothing without the name, with the address or without', () => {
      for (const [hex] of REAL) {
        expect(resolved(advert(hex, ADDRESS, ''))).toBeUndefined();
        expect(resolved(advert(hex, null, ''))).toBeUndefined();
      }
    });

    it('refuses other names: PICOOC-L1, PICOOC-W, PICOOC-CQ', () => {
      const adapter = new PicoocMiniLiteAdapter();
      for (const name of ['PICOOC-L1', 'PICOOC-W', 'PICOOC-CQ', 'xPICOOC-L']) {
        expect(adapter.matches(advert(NRF_82_00, ADDRESS, name))).toBe(false);
        expect(resolved(advert(NRF_82_00, ADDRESS, name))).not.toBe(NAME);
      }
    });

    // The connection-based PICOOC Mini, openScale#401 (artsight), btsnoop_hci.log,
    // ADV_IND at 2019-02-16 14:53:44.187.
    it('leaves the connection-based PICOOC-CQ alone', () => {
      const cq: BleDeviceInfo = {
        localName: 'PICOOC-CQ',
        address: 'D0:49:00:30:0F:5D',
        serviceUuids: ['fff0'],
        manufacturerData: { id: 0x000a, data: buf('d04900300f5d') },
      };
      expect(resolved(cq)).not.toBe(NAME);
    });

    it('is the only adapter that claims any real frame, under any shape', () => {
      const others = adapters.filter((a) => a.name !== NAME);
      for (const [hex] of REAL) {
        for (const info of [
          advert(hex),
          advert(hex, null),
          advert(hex, ADDRESS, ''),
          advert(hex, null, ''),
        ]) {
          expect(others.filter((a) => a.matches(info)).map((a) => a.name)).toEqual([]);
        }
      }
    });
  });

  describe('descriptor', () => {
    const adapter = new PicoocMiniLiteAdapter();

    it('claims the exact name at priority 217, with no company id and no services', () => {
      expect(adapter.match).toEqual({ priority: 217, names: { exact: ['picooc-l'] } });
      // The company id is the unit's own address, so node-ble's broadcast poll
      // must not be told to read only one id.
      expect(adapter.match.manufacturerId).toBeUndefined();
      expect(adapter.match.serviceUuids).toBeUndefined();
      expect(adapter.match.custom).toBeUndefined();
    });

    it('reads from the advertisement and normalises its own weight', () => {
      expect(adapter.preferPassive).toBe(true);
      expect(adapter.normalizesWeight).toBe(true);
      expect('parseLiveBroadcast' in adapter).toBe(false);
    });

    it('passes the registry integrity check', () => {
      const result = checkRegistryIntegrity(adapters);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('fixtures', () => {
    // Proof that the fixtures are aligned with the log, not adapter behaviour.
    it('every real frame sums to 0xFF with the company id', () => {
      for (const [hex] of REAL) {
        const sum = [COMPANY_ID & 0xff, COMPANY_ID >> 8, ...buf(hex)].reduce((a, b) => a + b, 0);
        expect(sum & 0xff).toBe(0xff);
      }
    });

    it('NRF_82_00 is the manufacturer data of the logged advertisement', () => {
      const adv = buf(NRF_ADVERT_LINE_252);
      const ads: Array<[number, Buffer]> = [];
      for (let i = 0; i < adv.length; i += adv[i] + 1) {
        ads.push([adv[i + 1], adv.subarray(i + 2, i + 1 + adv[i])]);
      }
      expect(ads.map(([type]) => type)).toEqual([0x01, 0x09, 0xff]);
      expect(ads[1][1].toString('latin1')).toBe('PICOOC-L');
      expect(ads[2][1].readUInt16LE(0)).toBe(COMPANY_ID);
      expect(ads[2][1].subarray(2).toString('hex')).toBe(NRF_82_00);
    });
  });

  describe('decoding', () => {
    it('reads every real frame, never with an impedance', () => {
      for (const [hex, kg] of REAL) {
        expect(new PicoocMiniLiteAdapter().parseBroadcast(buf(hex))).toEqual({
          weight: kg,
          impedance: 0,
        });
      }
    });

    it('does not warn for any real frame', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const adapter = new PicoocMiniLiteAdapter();
      for (const [hex] of REAL) adapter.parseBroadcast(buf(hex));
      expect(warn).not.toHaveBeenCalled();
    });

    // Derived: NRF_82_00 with [8..9] 0x13b0 -> 0xffff, "not measured".
    it('still reads a frame whose [8..9] is 0xFFFF', () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      expect(
        new PicoocMiniLiteAdapter().parseBroadcast(withBytes(NRF_82_00, 8, 0xff, 0xff)),
      ).toEqual({ weight: 82.0, impedance: 0 });
      expect(String(debug.mock.calls[0][0])).toContain('z=none');
    });

    // Derived: [6..7] and [10..11] moved together to 1.00 kg / 2.2 lb and to
    // 251.50 kg / 554.5 lb, which agree with each other.
    it('refuses a weight outside 2 to 250 kg without a warning, on both decisions', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const light = withBytes(NRF_82_00, 6, 0x00, 0x14, 0x13, 0xb0, 0x80, 0x16);
      const heavy = withBytes(NRF_82_00, 6, 0x13, 0xa6, 0x13, 0xb0, 0x95, 0xa9);
      for (const frame of [light, heavy]) {
        const adapter = new PicoocMiniLiteAdapter();
        expect(adapter.parseBroadcast(frame)).toBeNull();
        expect(evaluateAdvertisement(adapter, advert(frame))).toEqual({ kind: 'wait' });
      }
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('frames the adapter does not decode', () => {
    // Derived: [4] 0x39 -> 0x38 (openScale's own synthetic test frame), 0x3d and
    // 0x3e (the other formats the PICOOC app knows under this name); [5] 0x1f -> 0x1e.
    it.each([
      ['[4] 0x38', 4, 0x38, 'frame type 0x38'],
      ['[4] 0x3d', 4, 0x3d, 'frame type 0x3d'],
      ['[4] 0x3e', 4, 0x3e, 'frame type 0x3e'],
      ['[5] 0x1e', 5, 0x1e, '0x1e at byte 5'],
    ] as const)('refuses %s and warns once for it', (_label, index, value, text) => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const adapter = new PicoocMiniLiteAdapter();
      const frame = withBytes(NRF_82_00, index, value);
      expect(adapter.parseBroadcast(frame)).toBeNull();
      expect(adapter.parseBroadcast(frame)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(text);
      // The real frame still reads afterwards.
      expect(adapter.parseBroadcast(buf(NRF_82_00))?.weight).toBe(82.0);
    });

    // Derived: NRF_82_00 cut to 13 bytes, and padded with three zero bytes to
    // 17, the data length of the longer format.
    it('refuses a 13- or 17-byte frame and warns once per length', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const adapter = new PicoocMiniLiteAdapter();
      const short = buf(NRF_82_00).subarray(0, 13);
      const long = Buffer.concat([buf(NRF_82_00), Buffer.alloc(3)]);
      for (const frame of [short, long, short, long]) {
        expect(adapter.parseBroadcast(frame)).toBeNull();
      }
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0][0])).toContain('13-byte frame');
      expect(String(warn.mock.calls[1][0])).toContain('17-byte frame');
    });

    // Derived: [6..7] 0x0668 -> 0x0334 (41.00 kg against 180.8 lb), and 0x068a
    // (83.70 kg against 180.8 lb, 2 % off, above the 1 % tolerance).
    it('refuses a frame whose kg and pound fields disagree, warning once with the unit and frame', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const adapter = new PicoocMiniLiteAdapter();
      const half = withBytes(NRF_82_00, 6, 0x03, 0x34);
      const near = withBytes(NRF_82_00, 6, 0x06, 0x8a);
      expect(adapter.parseBroadcast(half)).toBeNull();
      expect(adapter.parseBroadcast(half)).toBeNull();
      expect(adapter.parseBroadcast(near)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const text = String(warn.mock.calls[0][0]);
      expect(text).toContain('41.00 kg, 180.8 lb, display unit 0x00');
      expect(text).toContain(`frame=${half.toString('hex')}`);
    });

    // Derived: [6..7] 0x0668 -> 0x13a6, 251.50 kg against 180.8 lb. A field read
    // from another format mostly lands outside the range, and must still warn.
    it('warns for fields that disagree even when the kg field is out of range', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const adapter = new PicoocMiniLiteAdapter();
      expect(adapter.parseBroadcast(withBytes(NRF_82_00, 6, 0x13, 0xa6))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('251.50 kg, 180.8 lb, display unit 0x00');
    });

    // Derived: [6..7] 0x0668 -> 0x0669, 82.05 kg against 180.8 lb, inside the tolerance.
    it('reads a frame whose fields agree within the tolerance', () => {
      expect(
        new PicoocMiniLiteAdapter().parseBroadcast(withBytes(NRF_82_00, 6, 0x06, 0x69)),
      ).toEqual({ weight: 82.05, impedance: 0 });
    });

    // Derived: [6..7] 0x0668 -> 0x0672, 82.50 kg against 180.8 lb (0.49 kg off,
    // over the 0.2 kg floor, inside 1 %); and [6..7] + [10..11] -> 0x0064 /
    // 0x8070, 5.00 kg against 11.2 lb (0.08 kg off, over 1 %, inside the floor).
    it('tolerates the larger of 1 % and 0.2 kg', () => {
      expect(
        new PicoocMiniLiteAdapter().parseBroadcast(withBytes(NRF_82_00, 6, 0x06, 0x72)),
      ).toEqual({ weight: 82.5, impedance: 0 });
      expect(
        new PicoocMiniLiteAdapter().parseBroadcast(
          withBytes(NRF_82_00, 6, 0x00, 0x64, 0x13, 0xb0, 0x80, 0x70),
        ),
      ).toEqual({ weight: 5.0, impedance: 0 });
    });

    // Derived: [12] 0x00 -> 0x01 and 0x02, display units no frame was seen in.
    it('still reads the kg field under another display unit, warning once per unit', () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const { adapter, clock } = clocked();
      const lb1 = withBytes(NRF_82_00, 12, 0x01);
      const lb2 = withBytes(NRF_82_00, 12, 0x02);
      expect(adapter.parseBroadcast(lb1)).toEqual({ weight: 82.0, impedance: 0 });
      clock.t += 120_000;
      expect(adapter.parseBroadcast(lb1)).toEqual({ weight: 82.0, impedance: 0 });
      clock.t += 120_000;
      expect(adapter.parseBroadcast(lb2)).toEqual({ weight: 82.0, impedance: 0 });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0][0])).toContain('displaying unit 0x01');
      expect(String(warn.mock.calls[1][0])).toContain('displaying unit 0x02');
    });

    it('waits on a refused format rather than doing anything else', () => {
      vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const info = advert(withBytes(NRF_82_00, 4, 0x3e));
      expect(evaluateAdvertisement(new PicoocMiniLiteAdapter(), info)).toEqual({ kind: 'wait' });
    });
  });

  // The result repeats for about seven seconds with no counter, and two
  // weigh-ins can send identical frames. A poll transport scans again 5 s after
  // an export at the least, and node-ble may read BlueZ's cached frame later.
  describe('a result seen again after its export', () => {
    it('hands out exactly the two weigh-ins of the logged advertisements, in log order', () => {
      const gaps = NRF_GAPS_MS.split(' ').map(Number);
      expect(gaps).toHaveLength(251);
      const { adapter, clock } = clocked();
      const got: number[] = [];
      for (let i = 0; i < 252; i++) {
        if (i > 0) clock.t += gaps[i - 1];
        const reading = adapter.parseBroadcast(buf(i < 119 ? NRF_82_00 : NRF_86_30));
        if (reading) got.push(reading.weight);
      }
      expect(got).toEqual([82.0, 86.3]);
    });

    it('holds the same frame back at +5 s, +30 s and +59.999 s', () => {
      for (const after of [5_000, 30_000, 59_999]) {
        const { adapter, clock } = clocked();
        adapter.parseBroadcast(buf(NRF_82_00));
        clock.t += after;
        expect(adapter.parseBroadcast(buf(NRF_82_00))).toBeNull();
      }
    });

    it('keeps holding it while it is seen every 30 s, for five minutes (the window slides)', () => {
      const { adapter, clock } = clocked();
      expect(adapter.parseBroadcast(buf(NRF_82_00))?.weight).toBe(82.0);
      for (let i = 0; i < 10; i++) {
        clock.t += 30_000;
        expect(adapter.parseBroadcast(buf(NRF_82_00))).toBeNull();
      }
    });

    it('hands it out again after 60.001 s without it', () => {
      const { adapter, clock } = clocked();
      adapter.parseBroadcast(buf(NRF_82_00));
      clock.t += 60_000;
      expect(adapter.parseBroadcast(buf(NRF_82_00))).toBeNull();
      clock.t += 60_001;
      expect(adapter.parseBroadcast(buf(NRF_82_00))?.weight).toBe(82.0);
    });

    // Derived: [8..9] 0x13b0 -> 0x13b1, the same weight with another value there.
    it('holds back the same weight with another [8..9], with a debug line of its own', () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const { adapter, clock } = clocked();
      adapter.parseBroadcast(buf(NRF_82_00));
      clock.t += 1_000;
      const other = withBytes(NRF_82_00, 8, 0x13, 0xb1);
      expect(adapter.parseBroadcast(other)).toBeNull();
      expect(debug).toHaveBeenCalledTimes(2);
      expect(String(debug.mock.calls[1][0])).toContain('z=504.1');
      expect(String(debug.mock.calls[1][0])).toContain('already reported');
    });

    // Derived: [6..7] 0x0668 -> 0x0669 (82.05 kg), and [0..3] 004b4f1e -> 004b4f1f.
    it('hands out another weight of the same unit, and the same weight of another unit, at once', () => {
      const { adapter, clock } = clocked();
      adapter.parseBroadcast(buf(NRF_82_00));
      clock.t += 1_000;
      expect(adapter.parseBroadcast(withBytes(NRF_82_00, 3, 0x1f))?.weight).toBe(82.0);
      expect(adapter.parseBroadcast(withBytes(NRF_82_00, 6, 0x06, 0x69))?.weight).toBe(82.05);
      expect(adapter.parseBroadcast(buf(NRF_86_30))?.weight).toBe(86.3);
    });

    // Derived: [3] 0x1e -> 0x00 to 0x08, nine units sending the same weight.
    it('tracks eight units at most, dropping the one handed out longest ago', () => {
      const { adapter, clock } = clocked();
      const unit = (n: number) => withBytes(NRF_82_00, 3, n);
      for (let n = 0; n < 9; n++) {
        expect(adapter.parseBroadcast(unit(n))?.weight).toBe(82.0);
        clock.t += 1_000;
      }
      expect(adapter.parseBroadcast(unit(8))).toBeNull();
      expect(adapter.parseBroadcast(unit(0))?.weight).toBe(82.0);
    });

    it('moves only on the injected clock, never on the wall clock', () => {
      vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const wall = vi.spyOn(Date, 'now');
      const perf = vi.spyOn(performance, 'now');
      const { adapter } = clocked();
      adapter.parseBroadcast(buf(NRF_82_00));
      adapter.parseBroadcast(buf(NRF_82_00));
      expect(wall).not.toHaveBeenCalled();
      expect(perf).not.toHaveBeenCalled();
    });
  });

  describe('advertisement decision', () => {
    it('completes on the first frame and waits on its repeat', () => {
      const adapter = new PicoocMiniLiteAdapter();
      expect(evaluateAdvertisement(adapter, advert(NRF_82_00))).toEqual({
        kind: 'complete',
        reading: { weight: 82.0, impedance: 0 },
      });
      expect(evaluateAdvertisement(adapter, advert(NRF_82_00))).toEqual({ kind: 'wait' });
    });

    // The forced wrapper drives the registry's own instance; like Etekcity Fit 8S
    // and Eufy C20/P3, a frame it holds back is then nothing at all.
    it('under ble.force_scale_adapter: completes on a frame, does nothing on its repeat', () => {
      const [forced] = applyForcedAdapter(adapters, NAME);
      const info = advert(OS_C_82_70);
      expect(evaluateAdvertisement(forced, info)).toEqual({
        kind: 'complete',
        reading: { weight: 82.7, impedance: 0 },
      });
      expect(evaluateAdvertisement(forced, info)).toEqual({ kind: 'none' });
    });
  });

  describe('debug log', () => {
    it('logs a payload once, again after the expiry, and says when it was already reported', () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const { adapter, clock } = clocked();
      adapter.parseBroadcast(buf(NRF_82_00));
      clock.t += 400;
      adapter.parseBroadcast(buf(NRF_82_00));
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0][0])).toBe(
        'PICOOC Mini Lite result: 82.00 kg (180.8 lb) unit=0x00 (undecoded: z=504.0 ' +
          `lb bit 15=1 checksum=0x0e, unchecked) frame=${NRF_82_00}`,
      );
      clock.t += 3_001;
      adapter.parseBroadcast(buf(NRF_82_00));
      expect(debug).toHaveBeenCalledTimes(2);
      expect(String(debug.mock.calls[1][0])).toMatch(/, already reported$/);
    });
  });

  describe('completion and body composition', () => {
    const adapter = new PicoocMiniLiteAdapter();

    it('completes only inside the plausible range', () => {
      expect(adapter.isComplete({ weight: 82.0, impedance: 0 })).toBe(true);
      expect(adapter.isComplete({ weight: 1.5, impedance: 0 })).toBe(false);
      expect(adapter.isComplete({ weight: 300, impedance: 0 })).toBe(false);
    });

    it('estimates composition from BMI, ignoring any impedance on the reading', () => {
      const profile = defaultProfile();
      expect(adapter.computeMetrics({ weight: 82.0, impedance: 504 }, profile)).toEqual(
        buildPayload(82.0, 0, {}, profile),
      );
    });
  });
});
