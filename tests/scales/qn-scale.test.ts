import { describe, it, expect, vi } from 'vitest';
import { jieliAuthResponseFrame } from '../../src/scales/jieli-auth.js';
import {
  QnScaleAdapter,
  buildMeasurementTrigger,
  buildTimeSync,
  buildConfig,
  buildUserProfileFrame,
} from '../../src/scales/qn-scale/index.js';
import {
  decodeStoredRecord,
  decryptQnResistance,
  hasValidSumChecksum,
  timeZoneByte,
} from '../../src/scales/qn-scale/frames.js';
import { qnAdvertTraits } from '../../src/scales/qn-scale/matching.js';
import { NINETEEN_BYTE_RESULT_HOLD_MS } from '../../src/scales/qn-scale/constants.js';
import { bleLog } from '../../src/ble/types.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type {
  AdapterRuntimeConfig,
  BleDeviceInfo,
  ConnectionContext,
  ScaleReading,
  UserProfile,
} from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new QnScaleAdapter();
}

/**
 * #461, the Physiq's 18-byte 0x12 (es26m), byte for byte from the reporter's
 * public DEBUG log, as are READY_461 and CONFIG_REQ_461 (2026-10-11 session).
 */
const INFO_461 = Buffer.from([
  0x12, 0x12, 0xff, 0x25, 0xe0, 0x16, 0x00, 0x05, 0xff, 0x13, 0x07, 0x16, 0x00, 0x00, 0x05, 0x9f,
  0x32, 0x48,
]);
const READY_461 = Buffer.from([0x14, 0x0b, 0xff, 0x01, 0x00, 0x01, 0x09, 0x03, 0x00, 0x00, 0x2c]);
const CONFIG_REQ_461 = Buffer.from([0x21, 0x05, 0xff, 0x01, 0x26]);

/** #283, a classic scale's 17-byte 0x12, from its public log. */
const INFO_283 = Buffer.from([
  0x12, 0x11, 0xff, 0xd3, 0x60, 0x18, 0x00, 0x01, 0xfb, 0x0a, 0x03, 0x19, 0x00, 0x04, 0x05, 0x07,
  0x9f,
]);

/** Build a fake AABB broadcast buffer with the given weight and stability. */
function makeBroadcast(weightKg: number, stable: boolean): Buffer {
  const buf = Buffer.alloc(23);
  buf[0] = 0xaa;
  buf[1] = 0xbb;
  buf[15] = stable ? 0x23 : 0x04;
  buf.writeUInt16LE(Math.round(weightKg * 100), 17);
  return buf;
}

function mockBroadcastDevice(data: Buffer): BleDeviceInfo {
  return {
    localName: 'QN-Scale',
    serviceUuids: [],
    manufacturerData: { id: 0xffff, data },
  };
}

describe('QnScaleAdapter', () => {
  describe('matches()', () => {
    it('matches "QN-Scale" with FFF0 service UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('QN-Scale', ['fff0']);
      expect(adapter.matches(p)).toBe(true);
    });

    it('matches "Renpho" with FFE0 service UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Renpho', ['ffe0']);
      expect(adapter.matches(p)).toBe(true);
    });

    // #191: a 'renpho' device advertising SIG WSS/BCS but no QN vendor service
    // is a Renpho ES-WBE28 — QN must defer to RenphoScaleAdapter.
    it('does not match "renpho" with SIG WSS 0x181D and no QN vendor service', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Renpho Body Scale', ['181d']))).toBe(false);
    });

    it('does not match "renpho" with SIG BCS 0x181B and no QN vendor service', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('renpho-scale', ['181b']))).toBe(false);
    });

    it('still matches "renpho" with SIG service AND a QN vendor service (QN-protocol)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Renpho', ['181b', 'ffe0']))).toBe(true);
    });

    it('still matches "renpho" with empty UUIDs (Linux QN scan, not ES-WBE28)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Renpho Scale', []))).toBe(true);
    });

    it('matches "SENSSUN" with full 128-bit FFF0 UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('SENSSUN', ['0000fff000001000800000805f9b34fb']);
      expect(adapter.matches(p)).toBe(true);
    });

    it('matches "sencor" with FFE0', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Sencor Scale', ['ffe0']);
      expect(adapter.matches(p)).toBe(true);
    });

    it('matches name with unrelated service UUIDs', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('QN-Scale', ['1234']);
      expect(adapter.matches(p)).toBe(true);
    });

    it('matches name with empty service UUIDs (Linux scan)', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('QN-Scale', []);
      expect(adapter.matches(p)).toBe(true);
    });

    it('matches by UUID alone for unnamed device', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('', ['fff0']);
      expect(adapter.matches(p)).toBe(true);
    });

    it('does not match unknown name without QN UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Random Scale', ['1234']);
      expect(adapter.matches(p)).toBe(false);
    });

    it('does not match named device by UUID alone (prevents false positives)', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('eufy T9149', ['fff0']);
      expect(adapter.matches(p)).toBe(false);
    });

    it('UUID fallback only applies to unnamed devices', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('', ['fff0']))).toBe(true);
      expect(adapter.matches(mockPeripheral('Random Scale', ['fff0']))).toBe(false);
    });

    it('name matching is case-insensitive', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('qn-scale', ['fff0']);
      expect(adapter.matches(p)).toBe(true);
    });

    // #272: the ESP32 autonomous-connect path resolves from characteristics
    // alone (no name, no service UUIDs). A Type-1 QN exposes notify 0xFFE1 +
    // write 0xFFE3; without a structural match it is mis-picked as Yunmai on the
    // shared 0xFFE4 char and hangs. The FFE1+FFE3 pair is QN-unique.
    it('matches unnamed device by Type-1 char pair FFE1+FFE3 (ESP32 autonomous)', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('', [], undefined, ['ffe1', 'ffe2', 'ffe3', 'ffe4', 'ffe5']);
      expect(adapter.matches(p)).toBe(true);
    });

    it('matches unnamed device by Type-1 char pair in 128-bit form', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('', [], undefined, [
        '0000ffe100001000800000805f9b34fb',
        '0000ffe300001000800000805f9b34fb',
      ]);
      expect(adapter.matches(p)).toBe(true);
    });

    it('does not match unnamed device with FFE1 notify char but no FFE3 write', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('', [], undefined, ['ffe1', 'ffe2']);
      expect(adapter.matches(p)).toBe(false);
    });

    it('does not match unnamed device with only the Yunmai notify char FFE4', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('', [], undefined, ['ffe4', 'ffe5']);
      expect(adapter.matches(p)).toBe(false);
    });

    it('does not claim a named non-QN device that happens to expose FFE1+FFE3', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('yunmai', [], undefined, ['ffe1', 'ffe3', 'ffe4']);
      expect(adapter.matches(p)).toBe(false);
    });

    it('matches AABB broadcast header with company ID 0xFFFF', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockBroadcastDevice(makeBroadcast(70, true)))).toBe(true);
    });

    it('rejects broadcast without manufacturer data', () => {
      const adapter = makeAdapter();
      expect(adapter.matches({ localName: 'Unknown', serviceUuids: [] })).toBe(false);
    });

    it('rejects broadcast with wrong company ID', () => {
      const adapter = makeAdapter();
      const dev: BleDeviceInfo = {
        localName: 'Unknown',
        serviceUuids: [],
        manufacturerData: { id: 0x0001, data: makeBroadcast(70, true) },
      };
      expect(adapter.matches(dev)).toBe(false);
    });

    it('rejects broadcast buffer without AABB magic', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(23);
      const dev: BleDeviceInfo = {
        localName: 'Unknown',
        serviceUuids: [],
        manufacturerData: { id: 0xffff, data: buf },
      };
      expect(adapter.matches(dev)).toBe(false);
    });

    it('rejects broadcast with too-short buffer', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0xaa;
      buf[1] = 0xbb;
      const dev: BleDeviceInfo = {
        localName: 'Unknown',
        serviceUuids: [],
        manufacturerData: { id: 0xffff, data: buf },
      };
      expect(adapter.matches(dev)).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses valid 0x10 stable frame', () => {
      const adapter = makeAdapter();
      // opcode=0x10, len/flags=0x0A, protocol=0x01, weight BE=7D00 (32000/100=320→ heuristic: /10=3200→ still bad, /100=320→ still bad)
      // Let's use weight=8000 (80.00 kg with /100)
      const buf = Buffer.alloc(10);
      buf[0] = 0x10; // opcode
      buf[1] = 0x0a; // length
      buf[2] = 0x01; // protocol
      buf.writeUInt16BE(8000, 3); // weight raw = 8000 / 100 = 80.00 kg
      buf[5] = 1; // stable
      buf.writeUInt16BE(550, 6); // R1 impedance
      buf.writeUInt16BE(530, 8); // R2 impedance

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(550); // R1 preferred
    });

    it('uses R2 when R1 is zero', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x10;
      buf[1] = 0x0a;
      buf[2] = 0x01;
      buf.writeUInt16BE(7500, 3); // 75.00 kg
      buf[5] = 1; // stable
      buf.writeUInt16BE(0, 6); // R1 = 0
      buf.writeUInt16BE(480, 8); // R2 = 480

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(480);
    });

    it('returns null for non-stable reading', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x10;
      buf[1] = 0x0a;
      buf[2] = 0x01;
      buf.writeUInt16BE(8000, 3);
      buf[5] = 0; // not stable
      buf.writeUInt16BE(500, 6);
      buf.writeUInt16BE(500, 8);

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for invalid opcode', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0x15; // unknown opcode

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(2))).toBeNull();
    });

    it('logs the discarded frame so an AE00 challenge is visible in a debug log (#75)', () => {
      const adapter = makeAdapter();
      const debugSpy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      // A real 17-byte AE02 challenge from the Arboleaf capture in #75. It has
      // no 0x10 opcode, so it is discarded, but it must not vanish silently.
      const buf = Buffer.from('00664d6b485e50d84a9eb9405f9ef787f3', 'hex');

      expect(adapter.parseNotification(buf)).toBeNull();

      const logged = debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('opcode=0x00');
      expect(logged).toContain('len=17');
      expect(logged).toContain('664d6b485e50d84a9eb9405f9ef787f3');
      debugSpy.mockRestore();
    });

    it('returns null for 0x10 frame shorter than 10 bytes', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(5);
      buf[0] = 0x10;
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('0x12 frame updates weightScaleFactor', () => {
      const adapter = makeAdapter();
      // 0x12 frame with data[10] = 0 → weightScaleFactor = 10
      const infoBuf = Buffer.alloc(11);
      infoBuf[0] = 0x12;
      infoBuf[10] = 0; // NOT 1 → scale factor becomes 10

      const infoResult = adapter.parseNotification(infoBuf);
      expect(infoResult).toBeNull(); // info frames return null

      // Now parse a 0x10 frame — weight should be divided by 10 instead of 100
      const dataBuf = Buffer.alloc(10);
      dataBuf[0] = 0x10;
      dataBuf[1] = 0x0a;
      dataBuf[2] = 0x01;
      dataBuf.writeUInt16BE(800, 3); // 800 / 10 = 80.00 kg
      dataBuf[5] = 1;
      dataBuf.writeUInt16BE(500, 6);
      dataBuf.writeUInt16BE(500, 8);

      const reading = adapter.parseNotification(dataBuf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    // Review C-06, owner decision 2026-10-04: when the divisor is in doubt, pick
    // the reading that fits a configured user, otherwise drop the frame. The
    // frame is the classic 10-byte stable 0x10 shape every test in this block
    // uses (openScale layout; no classic capture exists): the tests pin the
    // divisor choice over its raw weight, not the layout.
    describe('weight divisor in doubt (C-06)', () => {
      function classicStable(raw: number): Buffer {
        const buf = Buffer.alloc(10);
        buf[0] = 0x10;
        buf[1] = 0x0a;
        buf[2] = 0x01;
        buf.writeUInt16BE(raw, 3);
        buf[5] = 1;
        buf.writeUInt16BE(500, 6);
        buf.writeUInt16BE(500, 8);
        return buf;
      }
      const user = (min: number, max: number, last: number | null = null) => ({
        weight_range: { min, max },
        last_known_weight: last,
      });

      it('reads a lost-0x12 weight with the divisor that fits the user (83.2, not 8.32 kg)', () => {
        const adapter = makeAdapter();
        adapter.configure({ userWeights: [user(70, 90)] });
        expect(adapter.parseNotification(classicStable(832))?.weight).toBeCloseTo(83.2);
      });

      it('lets last_known_weight decide when no weight_range fits', () => {
        const adapter = makeAdapter();
        adapter.configure({ userWeights: [user(50, 60, 84)] });
        expect(adapter.parseNotification(classicStable(832))?.weight).toBeCloseTo(83.2);
      });

      it('drops 3.00 kg / 30.0 kg when it fits no user, instead of exporting 30 kg', () => {
        const adapter = makeAdapter();
        adapter.configure({ userWeights: [user(60, 90)] });
        expect(adapter.parseNotification(classicStable(300))).toBeNull();
      });

      it('reads 3.00 kg for a user whose range is that light', () => {
        const adapter = makeAdapter();
        adapter.configure({ userWeights: [user(2, 10)] });
        expect(adapter.parseNotification(classicStable(300))?.weight).toBe(3);
      });

      it('drops a weight both readings of which fit a user', () => {
        const adapter = makeAdapter();
        adapter.configure({ userWeights: [user(2, 10), user(20, 40)] });
        const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
        try {
          expect(adapter.parseNotification(classicStable(300))).toBeNull();
          expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('both fit');
        } finally {
          warn.mockRestore();
        }
      });

      it('drops it with no user configured at all', () => {
        expect(makeAdapter().parseNotification(classicStable(832))).toBeNull();
      });
    });

    it('applies weight heuristic when factor=10 gives >= 250 (tries /100)', () => {
      const adapter = makeAdapter();
      // 0x12 frame sets weightScaleFactor = 10
      const infoBuf = Buffer.alloc(11);
      infoBuf[0] = 0x12;
      infoBuf[10] = 0; // NOT 1 → scale factor becomes 10

      adapter.parseNotification(infoBuf);

      // rawWeight=8320, 8320/10=832 → >=250, try /100 → 83.20 kg (user's exact scenario)
      const buf = Buffer.alloc(10);
      buf[0] = 0x10;
      buf[1] = 0x0a;
      buf[2] = 0x01;
      buf.writeUInt16BE(8320, 3);
      buf[5] = 1;
      buf.writeUInt16BE(500, 6);
      buf.writeUInt16BE(500, 8);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(83.2);
    });

    it('returns null for 0x14 ready frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from([0x14, 0x0b, 0xff, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x1f]);
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for 0x21 config request frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from([0x21, 0x05, 0xff, 0x01, 0x26]);
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for 0xA1 acknowledgment frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from([0xa1, 0x06, 0x04, 0xfe, 0x01, 0xaa]);
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for 0xA3 acknowledgment frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from([0xa3, 0x04, 0x01, 0xa8]);
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for a too-short 0x23 frame (under 17 bytes)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from([0x23, 0x13, 0xff, 0x01, 0x01, 0xf0, 0x06, 0x4f, 0x43, 0x31]);
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    // #213 / #75: V10 Renpho / ES-CS20M firmware delivers the weigh-in via the
    // stored-data query path (0x22 -> 0x23), not reliably via live 0x10 frames.
    // Layout: time u32le[6..9] (2000-epoch seconds), weight u16be[10..11]/100,
    // R50 u16be[12..13], R500 u16be[14..15] (#461, see decodeStoredRecord).
    it('parses a fresh 0x23 stored measurement as a reading', () => {
      vi.useFakeTimers();
      try {
        // The real record from #213, at the time it was logged.
        vi.setSystemTime(new Date('2026-06-05T09:17:26.294Z'));
        const adapter = makeAdapter();
        const buf = Buffer.from([
          0x23, 0x13, 0xff, 0x01, 0x01, 0xf0, 0xa1, 0x50, 0xb5, 0x31, 0x21, 0x2f, 0x01, 0xf8, 0x01,
          0xf6, 0x00, 0x00, 0x3e,
        ]);
        const reading = adapter.parseNotification(buf);
        expect(reading).not.toBeNull();
        expect(reading!.weight).toBeCloseTo(84.95);
        expect(reading!.impedance).toBe(504);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects a stale 0x23 stored record (older than 90s before now)', () => {
      const adapter = makeAdapter();
      const staleScaleSeconds = Math.floor(Date.now() / 1000) - 946684800 - 200;
      const buf = Buffer.alloc(19);
      buf[0] = 0x23;
      buf[1] = 0x13;
      buf[2] = 0xff;
      buf.writeUInt32LE(staleScaleSeconds >>> 0, 6);
      buf.writeUInt16BE(8495, 10);
      buf.writeUInt16LE(504, 13);
      buf.writeUInt16LE(246, 15);
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('rejects an empty 0x23 stored record (weight 0)', () => {
      const adapter = makeAdapter();
      const nowScaleSeconds = Math.floor(Date.now() / 1000) - 946684800;
      const buf = Buffer.alloc(19);
      buf[0] = 0x23;
      buf[1] = 0x13;
      buf[2] = 0xff;
      buf.writeUInt32LE(nowScaleSeconds >>> 0, 6);
      buf.writeUInt16BE(0, 10); // 0 kg empty slot
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('re-queries 0x22 after a stale 0x23, bounded by the attempt limit', async () => {
      vi.useFakeTimers();
      try {
        const adapter = makeAdapter();
        const writes: number[][] = [];
        const ctx = {
          write: async (_uuid: string, data: Buffer | number[]) => {
            writes.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile,
          deviceAddress: '',
          availableChars: new Set<string>(),
        } as unknown as ConnectionContext;

        await adapter.onConnected(ctx);
        // Feed a 0x12 scale-info frame so handleScaleInfo cancels the fallback
        // timer (which would otherwise send its own 0x22). Then flush its writes
        // so we only count retry-driven queries.
        const info = Buffer.alloc(11);
        info[0] = 0x12;
        info[2] = 0xff;
        info[10] = 0;
        adapter.parseNotification(info);
        await vi.advanceTimersByTimeAsync(1000);
        writes.length = 0;

        const staleScaleSeconds = Math.floor(Date.now() / 1000) - 946684800 - 200;
        const stale = Buffer.alloc(19);
        stale[0] = 0x23;
        stale[1] = 0x13;
        stale[2] = 0xff;
        stale.writeUInt32LE(staleScaleSeconds >>> 0, 6);
        stale.writeUInt16BE(8495, 10);
        stale.writeUInt16LE(504, 13);

        for (let i = 0; i < 12; i++) {
          adapter.parseNotification(stale);
          await vi.advanceTimersByTimeAsync(3000);
        }

        const queries = writes.filter((w) => w[0] === 0x22);
        expect(queries.length).toBeGreaterThan(0);
        expect(queries.length).toBeLessThanOrEqual(6);
      } finally {
        vi.useRealTimers();
      }
    });

    // #269: the 0x13 config command tells the scale which unit to display.
    // Hardcoding kg flipped a user's lbs scale on every read. byte[3] is the unit
    // bit (0x01 kg, 0x02 lb, 0x08 stone) follows the configured display_unit.
    async function captureConfigWrite(adapter: QnScaleAdapter): Promise<number[][]> {
      vi.useFakeTimers();
      try {
        const writes: number[][] = [];
        const ctx = {
          write: async (_uuid: string, data: Buffer | number[]) => {
            writes.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile,
          deviceAddress: '',
          availableChars: new Set<string>(),
        } as unknown as ConnectionContext;
        await adapter.onConnected(ctx);
        const info = Buffer.alloc(11);
        info[0] = 0x12;
        info[2] = 0xff;
        info[10] = 0;
        adapter.parseNotification(info);
        await vi.advanceTimersByTimeAsync(1000);
        return writes;
      } finally {
        vi.useRealTimers();
      }
    }

    it('sends the kg unit flag (0x01) in the 0x13 config by default', async () => {
      const adapter = makeAdapter();
      const writes = await captureConfigWrite(adapter);
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config).toBeDefined();
      expect(config![3]).toBe(0x01);
      // Checksum is the low byte of the sum of the preceding bytes.
      expect(config![8]).toBe(config!.slice(0, 8).reduce((a, b) => a + b, 0) & 0xff);
    });

    it('sends the lb unit flag (0x02) when display_unit is lbs (#269)', async () => {
      const adapter = makeAdapter();
      adapter.configure({ displayUnit: 'lbs' });
      const writes = await captureConfigWrite(adapter);
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config).toBeDefined();
      expect(config![3]).toBe(0x02);
      expect(config![8]).toBe(config!.slice(0, 8).reduce((a, b) => a + b, 0) & 0xff);
    });

    it('sends the stone unit flag (0x08) while retaining the required 0x13 command', async () => {
      const adapter = makeAdapter();
      adapter.configure({ displayUnit: 'st' });
      const writes = await captureConfigWrite(adapter);
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config).toBeDefined();
      expect(config![3]).toBe(0x08);
      expect(config![8]).toBe(config!.slice(0, 8).reduce((a, b) => a + b, 0) & 0xff);
    });

    it('honours the unit flag on the older-firmware unlock path too (#269)', async () => {
      // No AE00 (subscribe rejects) so onConnected sends the legacy unlocks.
      const adapter = makeAdapter();
      adapter.configure({ displayUnit: 'lbs' });
      const writes: number[][] = [];
      const ctx = {
        write: async (_uuid: string, data: Buffer | number[]) => {
          writes.push([...data]);
        },
        read: async () => Buffer.alloc(0),
        subscribe: async () => {
          throw new Error('no AE02');
        },
        profile: defaultProfile,
        deviceAddress: '',
        availableChars: new Set<string>(),
      } as unknown as ConnectionContext;
      await adapter.onConnected(ctx);
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config).toBeDefined();
      expect(config![3]).toBe(0x02);
      expect(config![8]).toBe(config!.slice(0, 8).reduce((a, b) => a + b, 0) & 0xff);
    });

    it('sends the stone unit flag on the older-firmware unlock path', async () => {
      const adapter = makeAdapter();
      adapter.configure({ displayUnit: 'st' });
      const writes: number[][] = [];
      const ctx = {
        write: async (_uuid: string, data: Buffer | number[]) => {
          writes.push([...data]);
        },
        read: async () => Buffer.alloc(0),
        subscribe: async () => {
          throw new Error('no AE02');
        },
        profile: defaultProfile,
        deviceAddress: '',
        availableChars: new Set<string>(),
      } as unknown as ConnectionContext;
      await adapter.onConnected(ctx);
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config).toBeDefined();
      expect(config![3]).toBe(0x08);
      expect(config![8]).toBe(config!.slice(0, 8).reduce((a, b) => a + b, 0) & 0xff);
      expect(writes.some((w) => w[0] === 0x13 && w[4] !== 0x10)).toBe(true);
    });

    it('carries the forced protocol byte into the older-firmware unlock config', async () => {
      // Same no-AE00 path, with qn_protocol_byte set. The unlock byte[2] must be
      // the forced value, and it must stay 0x00 when the override is unset.
      const build = async (opts?: { qnProtocolByte: number }): Promise<number[]> => {
        const adapter = makeAdapter();
        if (opts) adapter.configure(opts);
        const writes: number[][] = [];
        const ctx = {
          write: async (_uuid: string, data: Buffer | number[]) => {
            writes.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {
            throw new Error('no AE02');
          },
          profile: defaultProfile,
          deviceAddress: '',
          availableChars: new Set<string>(),
        } as unknown as ConnectionContext;
        await adapter.onConnected(ctx);
        return writes.find((w) => w[0] === 0x13 && w[4] === 0x10)!;
      };
      expect((await build({ qnProtocolByte: 0x15 }))[2]).toBe(0x15);
      expect((await build())[2]).toBe(0x00);
    });

    it('keeps the unlock at 0x00 when a 0x12 arrives during the AE02 subscribe and no override is set', async () => {
      vi.useFakeTimers();
      const adapter = makeAdapter();
      try {
        const writes: number[][] = [];
        let rejectSubscribe!: (e: Error) => void;
        const ctx = {
          write: async (_uuid: string, data: Buffer | number[]) => {
            writes.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: () =>
            new Promise<void>((_resolve, reject) => {
              rejectSubscribe = reject;
            }),
          profile: defaultProfile,
          deviceAddress: '',
          availableChars: new Set<string>(),
        } as unknown as ConnectionContext;
        const connected = adapter.onConnected(ctx);
        await vi.advanceTimersByTimeAsync(0);

        // The 0x12 lands while the AE02 subscribe is still in flight (the Linux
        // node-ble ordering) and seeds seenProtocolType with the scale's byte.
        const info = Buffer.alloc(11);
        info[0] = 0x12;
        info[2] = 0xab;
        info[10] = 0;
        adapter.parseNotification(info);

        writes.length = 0;
        rejectSubscribe(new Error('no AE02'));
        await connected;

        // The legacy unlock must not inherit 0xab from that timing.
        const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
        expect(config).toBeDefined();
        expect(config![2]).toBe(0x00);
      } finally {
        adapter.onSessionEnd!();
        vi.useRealTimers();
      }
    });

    it('0x12 frame captures protocol type', () => {
      const adapter = makeAdapter();
      const infoBuf = Buffer.alloc(11);
      infoBuf[0] = 0x12;
      infoBuf[2] = 0xff; // protocol type
      infoBuf[10] = 0;
      adapter.parseNotification(infoBuf);

      // Verify protocol type was captured by checking ES-30M parsing
      // works (requires weightScaleFactor=10 which was set by the 0x12 frame)
      const dataBuf = Buffer.alloc(14);
      dataBuf[0] = 0x10;
      dataBuf[1] = 0x0e;
      dataBuf[2] = 0xff;
      dataBuf[3] = 0x01;
      dataBuf[4] = 0x02; // stable (ES-30M)
      dataBuf.writeUInt16BE(750, 5); // 75.0 kg
      dataBuf.writeUInt16BE(500, 7); // R1
      dataBuf.writeUInt16BE(490, 9); // R2

      const reading = adapter.parseNotification(dataBuf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(75);
      expect(reading!.impedance).toBe(500);
    });
  });

  describe('ES-30M format parsing', () => {
    it('parses ES-30M stable frame (state=0x02) with impedance', () => {
      const adapter = makeAdapter();
      // Set weightScaleFactor=10 via 0x12
      const infoBuf = Buffer.alloc(11);
      infoBuf[0] = 0x12;
      infoBuf[2] = 0xff;
      infoBuf[10] = 0;
      adapter.parseNotification(infoBuf);

      // From actual Renpho Elis 1 packet capture:
      // 10 0E FF 01 02 02 58 01 FD 01 FB 00 33 A7
      const buf = Buffer.from([
        0x10, 0x0e, 0xff, 0x01, 0x02, 0x02, 0x58, 0x01, 0xfd, 0x01, 0xfb, 0x00, 0x33, 0xa7,
      ]);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(60); // 0x0258 = 600 / 10
      expect(reading!.impedance).toBe(509); // R1 = 0x01FD
    });

    it('returns null for ES-30M measuring frame (state=0x00)', () => {
      const adapter = makeAdapter();
      const infoBuf = Buffer.alloc(11);
      infoBuf[0] = 0x12;
      infoBuf[10] = 0;
      adapter.parseNotification(infoBuf);

      const buf = Buffer.alloc(14);
      buf[0] = 0x10;
      buf[1] = 0x0e;
      buf[2] = 0xff;
      buf[3] = 0x01;
      buf[4] = 0x00; // measuring
      buf.writeUInt16BE(560, 5);

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for ES-30M stabilizing frame (state=0x01)', () => {
      const adapter = makeAdapter();
      const infoBuf = Buffer.alloc(11);
      infoBuf[0] = 0x12;
      infoBuf[10] = 0;
      adapter.parseNotification(infoBuf);

      const buf = Buffer.alloc(14);
      buf[0] = 0x10;
      buf[1] = 0x0e;
      buf[2] = 0xff;
      buf[3] = 0x01;
      buf[4] = 0x01; // stabilizing (not final)
      buf.writeUInt16BE(580, 5);

      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('uses R2 when R1 is zero in ES-30M format', () => {
      const adapter = makeAdapter();
      const infoBuf = Buffer.alloc(11);
      infoBuf[0] = 0x12;
      infoBuf[10] = 0;
      adapter.parseNotification(infoBuf);

      const buf = Buffer.alloc(14);
      buf[0] = 0x10;
      buf[1] = 0x0e;
      buf[2] = 0xff;
      buf[3] = 0x01;
      buf[4] = 0x02; // stable
      buf.writeUInt16BE(700, 5); // 70.0 kg
      buf.writeUInt16BE(0, 7); // R1 = 0
      buf.writeUInt16BE(480, 9); // R2 = 480

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(70);
      expect(reading!.impedance).toBe(480);
    });

    it('skips ES-30M stable frame with impedance=0 (waits for impedance)', () => {
      const adapter = makeAdapter();
      const infoBuf = Buffer.alloc(11);
      infoBuf[0] = 0x12;
      infoBuf[2] = 0xff;
      infoBuf[10] = 0;
      adapter.parseNotification(infoBuf);

      // Stable frame (state=0x02) but R1=R2=0 (impedance not measured yet)
      const buf = Buffer.alloc(14);
      buf[0] = 0x10;
      buf[1] = 0x0e;
      buf[2] = 0xff;
      buf[3] = 0x01;
      buf[4] = 0x02; // stable
      buf.writeUInt16BE(600, 5); // 60.0 kg
      buf.writeUInt16BE(0, 7); // R1 = 0
      buf.writeUInt16BE(0, 9); // R2 = 0

      // Should return null because impedance isn't ready yet
      expect(adapter.parseNotification(buf)).toBeNull();

      // Next frame with impedance should be accepted
      buf.writeUInt16BE(509, 7); // R1 = 509
      buf.writeUInt16BE(507, 9); // R2 = 507
      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(60);
      expect(reading!.impedance).toBe(509);
    });

    it('does not trigger ES-30M detection when weightScaleFactor=100', () => {
      const adapter = makeAdapter();
      // Default weightScaleFactor=100, do not send 0x12

      // Even with data[4]=0x02 and 14 bytes, factor=100 prevents ES-30M detection
      const buf = Buffer.alloc(14);
      buf[0] = 0x10;
      buf[1] = 0x0e;
      buf[2] = 0x01;
      buf.writeUInt16BE(8000, 3); // old format: weight at [3-4], data[4] = low byte
      buf[5] = 1; // old format: stable
      buf.writeUInt16BE(500, 6); // R1
      buf.writeUInt16BE(490, 8); // R2

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80); // 8000/100
      expect(reading!.impedance).toBe(500);
    });
  });

  describe('extended-dialect result frames (#235)', () => {
    // Real 20-byte extended scale-info frame from a reporter's GE CS 10 G capture (#235).
    // byte[1] == 0x14 (20) marks the long frame; length 20 sets the extended
    // dialect, which is what gates the 0xB4/0xB1 decode.
    const EXT_INFO = Buffer.from('1214ff4ec70e0007ff140f4200020503e06f2b37', 'hex');

    // Every frame below is real, from the three data-bearing connects in the
    // log attached to #235. The scale's display read 75.20 kg throughout.

    // Connect 1, 17:44:11. The 0xB4 carries 67.10 kg stamped 2026-08-13
    // 06:05:06 with an all-zero impedance body: a six-day-old history record.
    const B4_STALE_6_DAYS = Buffer.from(
      'b42c0401f01001121b1032361a000000000000000000000000000000000000000000000000000000000000a5',
      'hex',
    );
    // ...and the live 0xB1 from that same burst, 75.25 kg.
    const B1_LIVE_7525 = Buffer.from(
      'b12c030101651d030bbb09ac0a4f09790a4f09b3095a081b011601440bea091a0bb509a90a7d09480a090932',
      'hex',
    );
    // Connect 2, 18:03:10. No 0xB4 in this burst at all, only the live 0xB1.
    const B1_LIVE_7520 = Buffer.from(
      'b12c030101601dd20b7c0ab50b560a0c0ad608bd099f0828015a01530bfa092a0bc6099a0a6d093a0afe0890',
      'hex',
    );
    // Connect 3, 18:06:32. The 0xB4 decodes to a plausible 75.20 kg but is
    // stamped 18:03:34, which is connect 2's weigh-in, not this one.
    const B4_PREVIOUS_SESSION = Buffer.from(
      'b42c040101010176ac1832601dd20b7c0ab50b560a0c0ad608bd099f0828015a01530bfa092a0bc6099a0a42',
      'hex',
    );

    /** Scale-epoch (2000) seconds for a wall-clock instant. */
    const scaleSeconds = (iso: string): number =>
      Math.floor(new Date(iso).getTime() / 1000) - 946684800;

    /** Rewrite a 0xB4's timestamp and fix up the trailing sum. */
    function stampB4(frame: Buffer, seconds: number): Buffer {
      const out = Buffer.from(frame);
      out.writeUInt32LE(seconds, 7);
      let sum = 0;
      for (let i = 0; i < out.length - 1; i++) sum = (sum + out[i]) & 0xff;
      out[out.length - 1] = sum;
      return out;
    }

    /**
     * An adapter in the state a real session is in: connected (so the record
     * freshness is judged against this session's start, as in production) and
     * having seen the extended 0x12.
     */
    async function extendedAdapter() {
      const adapter = makeAdapter();
      await adapter.onConnected({
        write: async () => {},
        read: async () => Buffer.alloc(0),
        subscribe: async () => {},
        profile: defaultProfile(),
        deviceAddress: '',
        availableChars: new Set<string>(),
      } as unknown as ConnectionContext);
      expect(adapter.parseNotification(EXT_INFO)).toBeNull(); // sets isExtendedLongFrame
      return adapter;
    }

    /** Freeze the clock at connect 3, so record ages are the real ones. */
    async function atConnect3(fn: () => Promise<void>): Promise<void> {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-19T18:06:32.000Z'));
      try {
        await fn();
      } finally {
        vi.useRealTimers();
      }
    }

    it('takes the live weight from 0xB1, not the stale 0xB4 in the same burst', async () => {
      // The whole point: on this connect the 0xB4 says 67.10 kg from six days
      // ago. Publishing it would have written a wrong weight to Garmin.
      await atConnect3(async () => {
        const adapter = await extendedAdapter();
        expect(adapter.parseNotification(B4_STALE_6_DAYS)).toBeNull();
        expect(adapter.parseNotification(B4_STALE_6_DAYS)).toBeNull(); // repeat
        const reading = adapter.parseNotification(B1_LIVE_7525);
        expect(reading).not.toBeNull();
        expect(reading!.weight).toBe(75.25);
        // Impedance intentionally 0: raw sweep channels are not BIA-calibrated.
        expect(reading!.impedance).toBe(0);
      });
    });

    it('decodes the live 0xB1 when the scale sends no 0xB4 at all', async () => {
      await atConnect3(async () => {
        const adapter = await extendedAdapter();
        const reading = adapter.parseNotification(B1_LIVE_7520);
        expect(reading).not.toBeNull();
        expect(reading!.weight).toBe(75.2);
      });
    });

    it("rejects the previous session's 0xB4 even though its weight looks right", async () => {
      // 75.20 kg is the correct number, but the record is 178 seconds older
      // than this session: it describes the previous weigh-in, and accepting it
      // would republish an old measurement whenever the scale is quiet.
      await atConnect3(async () => {
        const adapter = await extendedAdapter();
        expect(adapter.parseNotification(B4_PREVIOUS_SESSION)).toBeNull();
      });
    });

    it('accepts a 0xB4 whose record belongs to this session', async () => {
      await atConnect3(async () => {
        const adapter = await extendedAdapter();
        const fresh = stampB4(B4_PREVIOUS_SESSION, scaleSeconds('2026-08-19T18:06:30.000Z'));
        const reading = adapter.parseNotification(fresh);
        expect(reading).not.toBeNull();
        expect(reading!.weight).toBe(75.2);
      });
    });

    it('emits the result exactly once across the repeated burst', async () => {
      await atConnect3(async () => {
        const adapter = await extendedAdapter();
        expect(adapter.parseNotification(B1_LIVE_7525)).not.toBeNull();
        // The rest of the burst (the 0xB1 03 02/03 records, a repeat 0xB1)
        // describes the same weigh-in and must not produce a second reading.
        expect(adapter.parseNotification(B1_LIVE_7525)).toBeNull();
        expect(adapter.parseNotification(B1_LIVE_7520)).toBeNull();
      });
    });

    it('rejects a result frame with a corrupted checksum', async () => {
      await atConnect3(async () => {
        const adapter = await extendedAdapter();
        const bad = Buffer.from(B1_LIVE_7525);
        bad[bad.length - 1] ^= 0xff; // break the trailing sum checksum
        expect(adapter.parseNotification(bad)).toBeNull();
      });
    });

    it('does not decode result frames on a non-extended dialect', async () => {
      await atConnect3(async () => {
        const adapter = makeAdapter(); // no extended 0x12 seen -> classic dialect
        // Same bytes, but the gate is closed, so it falls through to the ignore
        // branch and returns null rather than a spurious weight.
        expect(adapter.parseNotification(B1_LIVE_7525)).toBeNull();
      });
    });
  });

  describe('parseBroadcast()', () => {
    it('parses stable reading', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseBroadcast(makeBroadcast(72.5, true));
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(72.5);
      expect(reading!.impedance).toBe(0);
    });

    it('returns null for unstable reading', () => {
      const adapter = makeAdapter();
      expect(adapter.parseBroadcast(makeBroadcast(72.5, false))).toBeNull();
    });

    it('returns null for zero weight', () => {
      const adapter = makeAdapter();
      expect(adapter.parseBroadcast(makeBroadcast(0, true))).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseBroadcast(Buffer.alloc(10))).toBeNull();
    });

    it('returns null for wrong magic header', () => {
      const adapter = makeAdapter();
      const buf = makeBroadcast(70, true);
      buf[0] = 0x00;
      expect(adapter.parseBroadcast(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true for GATT reading (weight > 10 and impedance > 200)', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns true for broadcast reading (weight > 0 and impedance = 0)', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 72.5, impedance: 0 })).toBe(true);
    });

    it('returns false for broadcast reading with zero weight', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });

    it('returns false when GATT weight <= 10', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 5, impedance: 500 })).toBe(false);
    });

    it('returns false when GATT impedance <= 200', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 100 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns all BodyComposition fields (GATT with impedance)', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);

      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(500);
      assertPayloadRanges(payload);
    });

    it('returns BodyComposition for broadcast reading (no impedance)', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 75, impedance: 0 }, profile);
      expect(payload.weight).toBe(75);
      expect(payload.impedance).toBe(0);
      assertPayloadRanges(payload);
    });

    it('returns payload even with zero weight (guarded by isComplete in practice)', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 0, impedance: 500 }, profile);
      expect(payload.weight).toBe(0);
    });

    it('uses Deurenberg fallback when impedance is 0 (broadcast mode)', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 0 }, profile);

      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(0);
      // Deurenberg formula produces a reasonable body fat estimate from BMI
      expect(payload.bodyFatPercent).toBeGreaterThan(5);
      expect(payload.bodyFatPercent).toBeLessThan(40);
      assertPayloadRanges(payload);
    });
  });
  // ── Tests to append inside the describe('QnScaleAdapter', () => { block ──

  describe('ES-26M long-frame variant', () => {
    /** Build an 18-byte 0x12 frame matching the ES-26M format. */
    function makeLongScaleInfo(): Buffer {
      // Real captured frame: 12 12 ff 0f ac 14 00 04 ff 0f 07 0a 00 00 05 9f 30 e9
      return Buffer.from([
        0x12, 0x12, 0xff, 0x0f, 0xac, 0x14, 0x00, 0x04, 0xff, 0x0f, 0x07, 0x0a, 0x00, 0x00, 0x05,
        0x9f, 0x30, 0xe9,
      ]);
    }

    /** Build an ES-30M-format 0x10 weight frame. */
    function makeWeightFrame(weightRaw: number, state: number, r1: number, r2: number): Buffer {
      const buf = Buffer.alloc(14);
      buf[0] = 0x10;
      buf[1] = 0x0e;
      buf[2] = 0xff;
      buf[3] = 0x01;
      buf[4] = state;
      buf.writeUInt16BE(weightRaw, 5);
      buf.writeUInt16BE(r1, 7);
      buf.writeUInt16BE(r2, 9);
      return buf;
    }

    it('18B 0x12 frame sets isLongFrameVariant, proto=0x00, factor=10', () => {
      const adapter = makeAdapter();
      const result = adapter.parseNotification(makeLongScaleInfo());
      expect(result).toBeNull(); // info frames return null

      // Verify factor=10 by parsing a weight frame: rawWeight=9790,
      // 9790/10=979 >=250 → heuristic tries /100 → 97.90 kg
      const weightBuf = makeWeightFrame(9790, 0x02, 501, 499);
      const reading = adapter.parseNotification(weightBuf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(97.9);
      expect(reading!.impedance).toBe(501);
    });

    it('classic 11B 0x12 frame still reads proto from data[2]', () => {
      const adapter = makeAdapter();
      const infoBuf = Buffer.alloc(11);
      infoBuf[0] = 0x12;
      infoBuf[2] = 0xab; // protocol type
      infoBuf[10] = 1; // weightScaleFactor = 100

      adapter.parseNotification(infoBuf);

      // Verify classic behavior: factor=100, weight at [3-4]
      const dataBuf = Buffer.alloc(10);
      dataBuf[0] = 0x10;
      dataBuf.writeUInt16BE(7500, 3); // 75.00 kg
      dataBuf[5] = 1; // stable
      dataBuf.writeUInt16BE(500, 6);
      dataBuf.writeUInt16BE(490, 8);

      const reading = adapter.parseNotification(dataBuf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(75);
    });

    it('long-frame: barefoot reading with R1>0 returns impedance', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(makeLongScaleInfo());

      // Actual captured ES-26M barefoot frame:
      // 10 0e ff 01 02 26 39 01 f5 01 f3 01 34 9e
      const buf = Buffer.from([
        0x10, 0x0e, 0xff, 0x01, 0x02, 0x26, 0x39, 0x01, 0xf5, 0x01, 0xf3, 0x01, 0x34, 0x9e,
      ]);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      // 0x2639 = 9785, /10=978.5 >=250, heuristic /100 = 97.85
      expect(reading!.weight).toBeCloseTo(97.85);
      expect(reading!.impedance).toBe(501); // R1 = 0x01F5
    });

    it('long-frame: first stable R1=R2=0 is skipped (grace period)', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(makeLongScaleInfo());

      // First stable frame with no impedance: should be skipped
      const buf = makeWeightFrame(9790, 0x02, 0, 0);
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('long-frame: R1=R2=0 accepted after grace period (socks path)', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(makeLongScaleInfo());

      const buf = makeWeightFrame(9790, 0x02, 0, 0);

      // First stable R1=R2=0, skipped, starts grace timer
      expect(adapter.parseNotification(buf)).toBeNull();

      // Simulate grace period elapsed by manipulating internal state.
      // Access private field for testing. The grace period is 1500ms.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).firstStableNoImpedanceAt = Date.now() - 2000;

      // Now it should be accepted
      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(97.9);
      expect(reading!.impedance).toBe(0);
    });

    it('long-frame: impedance frame within grace period supersedes', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(makeLongScaleInfo());

      // First stable R1=R2=0, skipped
      const noImpBuf = makeWeightFrame(9790, 0x02, 0, 0);
      expect(adapter.parseNotification(noImpBuf)).toBeNull();

      // Impedance frame arrives within grace period: accepted immediately
      const impBuf = makeWeightFrame(9790, 0x02, 501, 499);
      const reading = adapter.parseNotification(impBuf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(97.9);
      expect(reading!.impedance).toBe(501);
    });

    it('classic ES-30M: stable R1=R2=0 is still skipped (regression guard)', () => {
      const adapter = makeAdapter();
      // Classic 11-byte 0x12 frame → isLongFrameVariant=false
      const infoBuf = Buffer.alloc(11);
      infoBuf[0] = 0x12;
      infoBuf[2] = 0xff;
      infoBuf[10] = 0; // factor=10
      adapter.parseNotification(infoBuf);

      // Stable frame with R1=R2=0
      const buf = makeWeightFrame(600, 0x02, 0, 0);
      expect(adapter.parseNotification(buf)).toBeNull();

      // Next frame with impedance should be accepted
      const impBuf = makeWeightFrame(600, 0x02, 509, 507);
      const reading = adapter.parseNotification(impBuf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(60);
      expect(reading!.impedance).toBe(509);
    });
  });
});

describe('AE02 dispatch (#75, #235)', () => {
  const AE02 = '0000ae0200001000800000805f9b34fb';
  const AE01 = '0000ae0100001000800000805f9b34fb';
  // Real AE00 challenge from the Arboleaf capture in #75.
  const challenge = Buffer.from('00664d6b485e50d84a9eb9405f9ef787f3', 'hex');

  /** Connect an adapter and capture every AE01 write. */
  async function connectCapturingAe01(
    adapter: QnScaleAdapter,
  ): Promise<{ writes: Buffer[]; flush: () => Promise<void> }> {
    const writes: Buffer[] = [];
    const ctx = {
      write: async (uuid: string, data: Buffer | number[]) => {
        if (uuid === AE01) writes.push(Buffer.from(data as number[]));
      },
      read: async () => Buffer.alloc(0),
      subscribe: async () => {},
      profile: defaultProfile,
      deviceAddress: '',
      availableChars: new Set<string>([AE01, AE02]),
    } as unknown as ConnectionContext;
    await adapter.onConnected(ctx);
    writes.length = 0; // drop the handshake init frame; only challenge traffic matters here
    return {
      writes,
      flush: async () => {
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  it('swallows the AE00 challenge instead of parsing it as a vendor frame', () => {
    const adapter = makeAdapter();
    const debugSpy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});

    expect(adapter.parseCharNotification(AE02, challenge)).toBeNull();

    const logged = debugSpy.mock.calls.map((c) => String(c[0])).join(' | ');
    expect(logged).toContain('QN AE02 (17B)');
    expect(logged).toContain('AE00 challenge received');
    debugSpy.mockRestore();
  });

  it('reports the challenge once per session', () => {
    const adapter = makeAdapter();
    const debugSpy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});

    adapter.parseCharNotification(AE02, challenge);
    adapter.parseCharNotification(AE02, challenge);

    const hits = debugSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('AE00 challenge received'));
    expect(hits).toHaveLength(1);
    debugSpy.mockRestore();
  });

  // The gate itself: without this write the scale never sends a 0x10 frame.
  // The expected bytes are the JieLi RcspAuth response for this exact
  // challenge, computed by src/scales/jieli-auth.ts (verified in #235 against
  // ten captured pairs).
  it('answers the challenge on AE01 with the JieLi response frame', async () => {
    const adapter = makeAdapter();
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const { writes, flush } = await connectCapturingAe01(adapter);

    adapter.parseCharNotification(AE02, challenge);
    await flush();

    expect(writes).toHaveLength(1);
    const expected = jieliAuthResponseFrame(challenge);
    expect(writes[0].toString('hex')).toBe(expected.toString('hex'));
    expect(writes[0][0]).toBe(0x01);
    expect(writes[0]).toHaveLength(17);
    vi.restoreAllMocks();
  });

  it('stops answering (and warns) when the scale keeps re-challenging', async () => {
    const adapter = makeAdapter();
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const warnSpy = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const { writes, flush } = await connectCapturingAe01(adapter);

    for (let i = 0; i < 6; i++) {
      adapter.parseCharNotification(AE02, challenge);
      await flush();
    }

    expect(writes).toHaveLength(3);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join(' | ')).toContain('re-issued the AE00');
    vi.restoreAllMocks();
  });

  it('still parses a real weight frame arriving on the notify characteristic', () => {
    const adapter = makeAdapter();
    const buf = Buffer.alloc(10);
    buf[0] = 0x10;
    buf[1] = 0x0a;
    buf[2] = 0x01;
    buf.writeUInt16BE(8000, 3);
    buf[5] = 1; // stable
    buf.writeUInt16BE(500, 6);
    buf.writeUInt16BE(500, 8);

    const reading = adapter.parseCharNotification('0000fff100001000800000805f9b34fb', buf);
    expect(reading?.weight).toBeGreaterThan(0);
  });

  it('does not swallow a non-challenge frame seen on AE02', () => {
    const adapter = makeAdapter();
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    // 17 bytes but not the 0x00 header: must fall through to the normal parser.
    const notChallenge = Buffer.from('10664d6b485e50d84a9eb9405f9ef787f3', 'hex');
    // Falls through and is rejected by the vendor parser, not by the AE02 gate.
    expect(adapter.parseCharNotification(AE02, notChallenge)).toBeNull();
    vi.restoreAllMocks();
  });

  describe('onSessionEnd (#235)', () => {
    it('clears the fallback timer so it cannot fire against a dead session', async () => {
      vi.useFakeTimers();
      try {
        const adapter = makeAdapter();
        const writes: number[][] = [];
        const ctx = {
          write: async (_uuid: string, data: Buffer | number[]) => {
            writes.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile(),
          deviceAddress: '',
          availableChars: new Set<string>(),
        } as unknown as ConnectionContext;
        await adapter.onConnected(ctx);
        writes.length = 0;
        adapter.onSessionEnd!();
        // The 2s fallback handshake must not run after the session ended.
        await vi.advanceTimersByTimeAsync(5000);
        expect(writes).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still delivers the 0x1F ack on FFE3 when the session ends before the FFF2 fallback runs', async () => {
      const adapter = makeAdapter();
      const writes: Array<{ uuid: string; data: number[] }> = [];
      const ctx = {
        // An FFE3-only scale: the FFF2 attempt rejects, the fallback must land on FFE3.
        write: async (uuid: string, data: Buffer | number[]) => {
          if (uuid === '0000fff200001000800000805f9b34fb') {
            throw new Error(`Characteristic ${uuid} not found`);
          }
          writes.push({ uuid, data: [...data] });
        },
        read: async () => Buffer.alloc(0),
        subscribe: async () => {},
        profile: defaultProfile(),
        deviceAddress: '',
        availableChars: new Set<string>(),
      } as unknown as ConnectionContext;
      await adapter.onConnected(ctx);
      writes.length = 0;

      const stable = Buffer.alloc(10);
      stable[0] = 0x10;
      stable[1] = 0x0a;
      stable[2] = 0x01;
      stable.writeUInt16BE(8000, 3);
      stable[5] = 1;
      stable.writeUInt16BE(550, 6);
      stable.writeUInt16BE(530, 8);

      // waitForReading's finishWith runs cleanup -> onSessionEnd synchronously
      // after parseNotification returns, before the rejected FFF2 write is observed.
      expect(adapter.parseNotification(stable)).not.toBeNull();
      adapter.onSessionEnd!();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const ack = writes.find((w) => w.data[0] === 0x1f);
      expect(ack?.uuid).toBe('0000ffe300001000800000805f9b34fb');
      expect(ack?.data).toEqual([0x1f, 0x05, 0x00, 0x10, 0x34]);
    });
  });

  // ── GE CS 10 G "Fit Plus" extended long frame (#235) ────────────────────────
  describe('GE CS 10 G extended long frame (#235)', () => {
    /** Real 20-byte 0x12 from a GE CS 10 G "Fit Plus" (#235). */
    function makeExtendedScaleInfo(): Buffer {
      return Buffer.from([
        0x12, 0x14, 0xff, 0x4e, 0xc7, 0x0e, 0x00, 0x07, 0xff, 0x14, 0x0f, 0x42, 0x00, 0x08, 0x05,
        0x03, 0xe0, 0x6f, 0x2b, 0x3d,
      ]);
    }

    /** Real 18-byte 0x12 from a Renpho ES-26M (45e4d6e). */
    function makeEs26mScaleInfo(): Buffer {
      return Buffer.from([
        0x12, 0x12, 0xff, 0x0f, 0xac, 0x14, 0x00, 0x04, 0xff, 0x0f, 0x07, 0x0a, 0x00, 0x00, 0x05,
        0x9f, 0x30, 0xe9,
      ]);
    }

    /** A write with the (fake) wall-clock time it was issued at. */
    interface TimedWrite {
      at: number;
      data: number[];
    }

    interface HandshakeOptions {
      /** The 0x14 ready frame to feed. Defaults to the GE CS 10 G one (#235). */
      ready?: Buffer;
      /** The 0x21 config request to feed. Defaults to the GE CS 10 G one. */
      configReq?: Buffer;
      /** Filled with every write and its Date.now(), for timing assertions. */
      timed?: TimedWrite[];
    }

    /**
     * Drive the handshake from a 0x12 scale-info frame all the way to the 0x22
     * START, collecting every write. The 0x14 and 0x21 frames default to the
     * ones the GE CS 10 G actually sends (#235); pass a unit's own frames from
     * its capture through `opts`.
     */
    async function driveHandshake(
      adapter: QnScaleAdapter,
      info: Buffer,
      profile: UserProfile = defaultProfile(),
      opts: HandshakeOptions = {},
    ): Promise<number[][]> {
      vi.useFakeTimers();
      try {
        const writes: number[][] = [];
        const ctx = {
          write: async (_uuid: string, data: Buffer | number[]) => {
            writes.push([...data]);
            opts.timed?.push({ at: Date.now(), data: [...data] });
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile,
          deviceAddress: '',
          availableChars: new Set<string>(),
        } as unknown as ConnectionContext;
        // The session hook, then the connect hook: that is the order every
        // transport uses, and since #406 the per-session reset lives in the
        // first of the two rather than in onConnected, which runs after the
        // notify bindings are already live.
        adapter.onSessionStart?.();
        await adapter.onConnected(ctx);
        adapter.parseNotification(info);
        adapter.parseNotification(
          opts.ready ??
            Buffer.from([0x14, 0x0c, 0xff, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0xfd, 0x1f]),
        );
        adapter.parseNotification(
          opts.configReq ?? Buffer.from([0x21, 0x07, 0xff, 0x01, 0x61, 0x2c, 0xb5]),
        );
        await vi.advanceTimersByTimeAsync(2000);
        return writes;
      } finally {
        vi.useRealTimers();
      }
    }

    // #331: the Arboleaf vendor app sends two 0xA4 0x0F frames between START and
    // the first live 0x10 frame, and the reporter's HCI capture shows the app
    // going straight into a weight stream after them while this app goes silent.
    describe('0xA4 prelude (ble.qn_a4_prelude, #331)', () => {
      const A4_ONE = [
        0xa4, 0x0f, 0x01, 0x21, 0x0a, 0x48, 0x08, 0xf1, 0x0a, 0x33, 0x08, 0xda, 0x08, 0x80, 0xc7,
      ];
      const A4_TWO = [
        0xa4, 0x0f, 0x01, 0x22, 0x06, 0x78, 0x09, 0xf3, 0x07, 0xdb, 0x01, 0xc1, 0x01, 0xa5, 0x9a,
      ];

      it('sends nothing extra by default, so the rest of the QN family is untouched', async () => {
        const adapter = makeAdapter();
        const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
        expect(writes.some((w) => w[0] === 0xa4)).toBe(false);
      });

      it('sends both frames after START when the flag is on', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnA4Prelude: true });
        const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
        const startIdx = writes.findIndex((w) => w[0] === 0x22);
        const a4 = writes.filter((w) => w[0] === 0xa4);
        expect(a4).toEqual([A4_ONE, A4_TWO]);
        expect(writes.findIndex((w) => w[0] === 0xa4)).toBeGreaterThan(startIdx);
      });

      // Both Android captures of the Arboleaf app send the A4 frames only after
      // the two anchor A2s (#75, #331), so with both switches on that is the order.
      it('sends the A4 frames after the anchor pair on the 19-byte dialect', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnWeightAck: true, qnA4Prelude: true });
        const writes = await driveHandshake(
          adapter,
          ARBOLEAF_2A_INFO,
          defaultProfile({ lastKnownWeight: 74.05 }),
          arboleaf2a,
        );
        const startIdx = writes.findIndex((w) => w[0] === 0x22);
        const anchor = [0xa2, 0x06, 0x01, 0x1c, 0xed, 0xb2];
        expect(writes.slice(startIdx + 1)).toEqual([anchor, anchor, A4_ONE, A4_TWO]);
      });

      it('sends the A4 frames straight after START when the anchor is not on', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnA4Prelude: true });
        const writes = await driveHandshake(
          adapter,
          ARBOLEAF_2A_INFO,
          defaultProfile({ lastKnownWeight: 74.05 }),
          arboleaf2a,
        );
        const startIdx = writes.findIndex((w) => w[0] === 0x22);
        expect(writes.slice(startIdx + 1)).toEqual([A4_ONE, A4_TWO]);
      });

      it('keeps the extended order, A4 frames before the trigger burst', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnA4Prelude: true });
        const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
        const startIdx = writes.findIndex((w) => w[0] === 0x22);
        // No anchor in the profile: the capture's own 77.15 kg.
        const trigger = [0xa2, 0x06, 0x01, 0x1e, 0x23, 0xea];
        expect(writes.slice(startIdx + 1)).toEqual([A4_ONE, A4_TWO, trigger, trigger]);
      });

      // Both frames are replayed verbatim, so the checksum is the only thing
      // proving they were transcribed correctly from the capture.
      it('carries the checksums from the capture, which are the byte sum', () => {
        for (const frame of [A4_ONE, A4_TWO]) {
          const body = frame.slice(0, -1);
          const sum = body.reduce((a, b) => a + b, 0) & 0xff;
          expect(frame[frame.length - 1]).toBe(sum);
        }
      });
    });

    it('20B 0x12 frame echoes the protocol type into the 0x13 config', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config).toEqual([0x13, 0x09, 0xff, 0x01, 0x10, 0x00, 0x00, 0x00, 0x2c]);
    });

    // `a0 0d 04 <mask> ..`, sent on 0x21 since openScale's port and read as a
    // "history response", is the user-delete command in the vendor's published
    // SDK, and the scales answer it as a successful delete (#461 `a1 06 04 fc 01
    // a8`). No dialect gets it by default any more; the A00D profile frame and
    // START still follow the 0x21.
    describe('A00D user-delete frame (#461)', () => {
      /** Real 0x12 frames from the logs, one per dialect. */
      const DIALECT_INFO: [string, Buffer][] = [
        // #283, classic (17 bytes, `[1]` 0x11)
        [
          'classic',
          Buffer.from([
            0x12, 0x11, 0xff, 0xd3, 0x60, 0x18, 0x00, 0x01, 0xfb, 0x0a, 0x03, 0x19, 0x00, 0x04,
            0x05, 0x07, 0x9f,
          ]),
        ],
        // #461 Physiq, es26m (18 bytes)
        [
          'es26m 18-byte',
          Buffer.from([
            0x12, 0x12, 0xff, 0x25, 0xe0, 0x16, 0x00, 0x05, 0xff, 0x13, 0x07, 0x16, 0x00, 0x00,
            0x05, 0x9f, 0x32, 0x48,
          ]),
        ],
        ['extended 20-byte', makeExtendedScaleInfo()],
      ];

      it.each(DIALECT_INFO)('sends none on the %s dialect by default', async (_name, info) => {
        const adapter = makeAdapter();
        const writes = await driveHandshake(adapter, info);
        expect(writes.some((w) => w[0] === 0xa0 && w[2] === 0x04)).toBe(false);
        // The rest of the 0x21 answer is unchanged.
        expect(writes.some((w) => w[0] === 0xa0 && w[2] === 0x02)).toBe(true);
        expect(writes.some((w) => w[0] === 0x22)).toBe(true);
      });

      it('sends none on the no-0x12 fallback handshake either', async () => {
        vi.useFakeTimers();
        try {
          const adapter = makeAdapter();
          const writes: number[][] = [];
          const ctx = {
            write: async (_uuid: string, data: Buffer | number[]) => {
              writes.push([...data]);
            },
            read: async () => Buffer.alloc(0),
            subscribe: async () => {},
            profile: defaultProfile(),
            deviceAddress: '',
            availableChars: new Set<string>(),
          } as unknown as ConnectionContext;
          adapter.onSessionStart?.();
          await adapter.onConnected(ctx);
          await vi.advanceTimersByTimeAsync(6000);
          expect(writes.some((w) => w[0] === 0x22)).toBe(true);
          expect(writes.some((w) => w[0] === 0xa0 && w[2] === 0x04)).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps the profile frame 200 ms after the 0x21, where it was', async () => {
        const adapter = makeAdapter();
        const timed: TimedWrite[] = [];
        await driveHandshake(adapter, makeExtendedScaleInfo(), defaultProfile(), { timed });
        const start = timed[0].at;
        const profile = timed.find((w) => w.data[0] === 0xa0 && w.data[2] === 0x02);
        expect(profile!.at - start).toBe(200);
      });

      it('warns when ble.qn_report_byte opts back in', () => {
        const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
        try {
          makeAdapter().configure({ qnReportByte: 0xfc });
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('deletes the user slots'));
          warn.mockClear();
          makeAdapter().configure({});
          expect(warn).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      });
    });

    it('applies ble.qn_report_byte to the A00D payload byte and recomputes the checksum', async () => {
      // 0xFC is the value both vendor-app captures send in this position.
      const adapter = makeAdapter();
      adapter.configure({ qnReportByte: 0xfc });
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const msg1 = writes.find((w) => w[0] === 0xa0 && w[2] === 0x04);
      expect(msg1![3]).toBe(0xfc);
      expect(msg1![12]).toBe(msg1!.slice(0, 12).reduce((a, b) => a + b, 0) & 0xff);
    });

    it('leaves the second A00D frame alone when the report byte is overridden', async () => {
      // Only byte[3] of the 0x04 frame is in question. The 0x02 frame is a
      // separate command and must not move with it.
      const adapter = makeAdapter();
      adapter.configure({ qnReportByte: 0xfc });
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const msg2 = writes.find((w) => w[0] === 0xa0 && w[2] === 0x02);
      expect(msg2).toEqual([
        0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 0x21, 0x06, 0xb8, 0x04, 0x02, 0x9d,
      ]);
    });

    it('20B 0x12 frame makes the 0x22 START byte identical to the vendor app', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const start = writes.find((w) => w[0] === 0x22);
      expect(start).toEqual([0x22, 0x06, 0xff, 0x00, 0x03, 0x2a]);
    });

    it('20B 0x12 frame echoes the protocol type into the 0x20 time sync', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const timeSync = writes.find((w) => w[0] === 0x20);
      expect(timeSync).toBeDefined();
      expect(timeSync![2]).toBe(0xff);
      // The four time bytes are wall-clock dependent; the checksum is not.
      expect(timeSync![7]).toBe(timeSync!.slice(0, 7).reduce((a, b) => a + b, 0) & 0xff);
    });

    // Hardware regression guard for 45e4d6e: on the 18-byte ES-26M frame,
    // echoing data[2] made the scale reject every command. It must stay 0x00.
    it('18B 0x12 frame still sends proto 0x00 (ES-26M hardware guard)', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeEs26mScaleInfo());
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config).toEqual([0x13, 0x09, 0x00, 0x01, 0x10, 0x00, 0x00, 0x00, 0x2d]);
      const start = writes.find((w) => w[0] === 0x22);
      expect(start).toEqual([0x22, 0x06, 0x00, 0x00, 0x03, 0x2b]);
    });

    /** Real 19-byte 0x12 from an Arboleaf, posted in #75 by a reporter. */
    function makeArboleafScaleInfo(): Buffer {
      return Buffer.from([
        0x12, 0x13, 0xff, 0x54, 0x0b, 0x04, 0x00, 0x07, 0xff, 0x15, 0x0f, 0x27, 0x00, 0x02, 0x05,
        0x03, 0xe0, 0x6f, 0x31,
      ]);
    }

    // The same Arboleaf unit, from a reporter's Android btsnoop of a
    // complete vendor-app weigh-in posted in #331 on 2026-09-29. Byte for byte
    // from the capture; [13] changes between sessions of this one unit.
    const ARBOLEAF_2A_INFO = Buffer.from([
      0x12, 0x13, 0xff, 0x54, 0x0b, 0x04, 0x00, 0x07, 0xff, 0x15, 0x0f, 0x27, 0x00, 0x0c, 0x05,
      0x03, 0xe0, 0x6f, 0x3b,
    ]);
    const ARBOLEAF_2A_READY = Buffer.from([
      0x14, 0x0b, 0xff, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x20,
    ]);
    const ARBOLEAF_2A_CONFIG_REQ = Buffer.from([0x21, 0x05, 0xff, 0x01, 0x26]);
    /** First live 0x10 of that capture: 0x1dc4 at [5..6] = 76.20 kg. */
    const ARBOLEAF_2A_LIVE = Buffer.from([
      0x10, 0x14, 0x01, 0x00, 0x11, 0x1d, 0xc4, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x17,
    ]);
    /** A live 0x10 from the GE CS 10 G vendor-app capture (#235): 78.70 kg. */
    const GE_LIVE = Buffer.from([
      0x10, 0x14, 0x01, 0x00, 0x11, 0x1e, 0xbe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x12,
    ]);
    const arboleaf2a: HandshakeOptions = {
      ready: ARBOLEAF_2A_READY,
      configReq: ARBOLEAF_2A_CONFIG_REQ,
    };

    it('19B 0x12 frame echoes the protocol type (Arboleaf, #75/#331)', async () => {
      // Two reporters get the whole handshake acknowledged on 0x00 and then
      // silence, and every captured 0x12 in this family carries 0xff at [2].
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeArboleafScaleInfo());
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config![2]).toBe(0xff);
      expect(writes.find((w) => w[0] === 0x22)![2]).toBe(0xff);
    });

    it('leaves the next connection alone when a session produced no weight', async () => {
      // A scale on the wrong protocol byte acknowledges the whole handshake and
      // stays silent, which is exactly what a scale nobody is standing on does.
      // Nothing may be inferred from silence: these scales keep advertising
      // after a weigh-in, so the routine reconnect that follows one is silent
      // too, and reacting to it would break the next real weigh-in (#75).
      const adapter = makeAdapter();
      await driveHandshake(adapter, makeArboleafScaleInfo());
      adapter.onSessionEnd!();
      const second = await driveHandshake(adapter, makeArboleafScaleInfo());
      expect(second.find((w) => w[0] === 0x13 && w[4] === 0x10)![2]).toBe(0xff);
    });

    it('lets ble.qn_protocol_byte override the length-based default', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnProtocolByte: 0x00 });
      const writes = await driveHandshake(adapter, makeArboleafScaleInfo());
      expect(writes.find((w) => w[0] === 0x13 && w[4] === 0x10)![2]).toBe(0x00);
      expect(writes.find((w) => w[0] === 0x22)![2]).toBe(0x00);
    });

    it('applies the override to the 18-byte dialect too', async () => {
      // The only vendor-app capture of this length drives the scale on 0xff,
      // so an 18-byte owner who gets nothing has somewhere to go.
      const adapter = makeAdapter();
      adapter.configure({ qnProtocolByte: 0xff });
      const writes = await driveHandshake(adapter, makeEs26mScaleInfo());
      expect(writes.find((w) => w[0] === 0x13 && w[4] === 0x10)![2]).toBe(0xff);
    });

    it('returns to the length-based default when the override is removed', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnProtocolByte: 0x00 });
      adapter.configure({});
      const writes = await driveHandshake(adapter, makeArboleafScaleInfo());
      expect(writes.find((w) => w[0] === 0x13 && w[4] === 0x10)![2]).toBe(0xff);
    });

    it('applies the override to the classic dialect', async () => {
      // A classic-dialect scale whose firmware wants a different byte than its
      // 0x12 reports had no working override before: the classic branch read
      // data[2] unconditionally.
      const adapter = makeAdapter();
      adapter.configure({ qnProtocolByte: 0x15 });
      const info = Buffer.alloc(11);
      info[0] = 0x12;
      info[2] = 0xab;
      info[10] = 1;
      const writes = await driveHandshake(adapter, info);
      expect(writes.find((w) => w[0] === 0x13 && w[4] === 0x10)![2]).toBe(0x15);
      expect(writes.find((w) => w[0] === 0x22)![2]).toBe(0x15);
    });

    it('opens with the override before 0x12 and keeps it through the no-0x12 fallback', async () => {
      // Proxy transports can lose the 0x12 scale-info frame entirely. The
      // session must then still open the unlock config with the forced byte and
      // run the fallback handshake on it, not on the 0x00/0xff guesses.
      const adapter = makeAdapter();
      adapter.configure({ qnProtocolByte: 0x15 });
      vi.useFakeTimers();
      try {
        const writes: number[][] = [];
        const ctx = {
          write: async (_uuid: string, data: Buffer | number[]) => {
            writes.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile(),
          deviceAddress: '',
          availableChars: new Set<string>(),
        } as unknown as ConnectionContext;
        adapter.onSessionStart?.();
        await adapter.onConnected(ctx);

        // A 0x14 ready frame arriving before the 2 s fallback drives handleReady
        // off the onConnected seed, so the 0x20 it emits pins that seed rather
        // than the fallback's own protocol assignment.
        adapter.parseNotification(Buffer.from([0x14, 0x0b, 0x15, 0, 0, 0, 0, 0, 0, 0, 0x34]));
        await vi.advanceTimersByTimeAsync(0);
        expect(writes.find((w) => w[0] === 0x20)![2]).toBe(0x15);

        await vi.advanceTimersByTimeAsync(4000);
        const configs = writes.filter((w) => w[0] === 0x13 && w[4] === 0x10);
        expect(configs.length).toBeGreaterThan(0);
        for (const c of configs) expect(c[2]).toBe(0x15);
        expect(writes.find((w) => w[0] === 0x22)![2]).toBe(0x15);
      } finally {
        vi.useRealTimers();
      }
    });

    it('classic 11B 0x12 frame is unaffected by the extended-dialect rule', async () => {
      const adapter = makeAdapter();
      const info = Buffer.alloc(11);
      info[0] = 0x12;
      info[2] = 0xab;
      info[10] = 1;
      const writes = await driveHandshake(adapter, info);
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config).toBeDefined();
      expect(config![2]).toBe(0xab);
    });

    // #235: after START the GE CS 10 G stays silent until the vendor app writes
    // this frame twice. hedoric's retest on the proto fix proved every other
    // command already matches the app byte for byte.
    it('sends the measurement trigger twice after START on the extended dialect', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      const after = writes.slice(startIndex + 1);
      const triggers = after.filter((w) => w[0] === 0xa2);
      expect(triggers).toHaveLength(2);
      for (const t of triggers) {
        // No anchor in the profile: the capture's own 77.15 kg is the fallback.
        expect(t).toEqual([0xa2, 0x06, 0x01, 0x1e, 0x23, 0xea]);
        // Self-consistent QN frame: checksum is the low byte of the sum.
        expect(t[5]).toBe(t.slice(0, 5).reduce((a, b) => a + b, 0) & 0xff);
      }
    });

    // #75: payload [3..4] is kg*100 big-endian and the scale gates the weigh-in
    // on it, so a household member who is not near the captured 77.15 kg gets a
    // clean handshake and then silence. The anchor has to come from config.
    it('encodes the profile weight anchor into the measurement trigger', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(
        adapter,
        makeExtendedScaleInfo(),
        defaultProfile({ lastKnownWeight: 65 }),
      );
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      const triggers = writes.slice(startIndex + 1).filter((w) => w[0] === 0xa2);
      expect(triggers).toHaveLength(2);
      for (const t of triggers) {
        // 6500 = 0x1964
        expect(t).toEqual([0xa2, 0x06, 0x01, 0x19, 0x64, 0x26]);
        expect(t[5]).toBe(t.slice(0, 5).reduce((a, b) => a + b, 0) & 0xff);
      }
    });

    // One reading of the vendor-app capture answers every live 0x10 with that
    // frame's own weight bytes: `11 1e be` -> `a2 06 01 1e be 85`. The frames
    // here are SYNTHETIC 14-byte ones with the weight at [3..4]; the real GE live
    // frame is 20 bytes with the weight at [5..6], is not echoed at all, and is
    // covered by the 20-byte tests below (#331).
    it('echoes each live weight frame back as an A2 on the extended dialect', async () => {
      const adapter = makeAdapter();
      const writes: number[][] = [];
      const ctx = {
        write: async (_uuid: string, data: Buffer | number[]) => {
          writes.push([...data]);
        },
        read: async () => Buffer.alloc(0),
        subscribe: async () => {},
        profile: defaultProfile(),
        deviceAddress: '',
        availableChars: new Set<string>(),
      } as unknown as ConnectionContext;
      await adapter.onConnected(ctx);
      adapter.parseNotification(makeExtendedScaleInfo());
      writes.length = 0;

      // Settling frame, then the same weight settled. Both are acknowledged:
      // the scale streams the unstable ones while it decides whether to finish.
      const frame = (raw: number, stable: boolean): Buffer => {
        const b = Buffer.alloc(14);
        b[0] = 0x10;
        b[1] = 0x0e;
        b[2] = 0xff;
        b.writeUInt16BE(raw, 3);
        b[5] = stable ? 1 : 0;
        return b;
      };
      adapter.parseNotification(frame(0x1ebe, false));
      adapter.parseNotification(frame(0x1ec3, false));
      await Promise.resolve();

      const acks = writes.filter((w) => w[0] === 0xa2);
      expect(acks).toEqual([
        [0xa2, 0x06, 0x01, 0x1e, 0xbe, 0x85],
        [0xa2, 0x06, 0x01, 0x1e, 0xc3, 0x8a],
      ]);
    });

    // #75: an es26m Arboleaf completes the whole handshake and then streams
    // nothing. The echo is the remaining difference from the vendor app, so it
    // gets the same kind of opt-in knob as qn_protocol_byte and qn_report_byte
    // rather than a blind default change on a dialect no capture covers.
    // #331/#75: with the flag off, the ready-time A2 keeps openScale's bytes,
    // which decode as ~128 kg under the weight reading. That is deliberate:
    // every QN scale in the registry reads with them today.
    it('keeps openScale placeholder bytes in the ready-time A2 by default', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(
        adapter,
        makeEs26mScaleInfo(),
        defaultProfile({ lastKnownWeight: 76 }),
      );
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      const beforeStart = writes.slice(0, startIndex).filter((w) => w[0] === 0xa2);
      expect(beforeStart).toHaveLength(1);
      expect(beforeStart[0][3]).toBe(0x32);
      expect(beforeStart[0][4]).toBe(30); // defaultProfile age
    });

    // The add-on defaults to a 40 to 150 kg range, whose span locates nobody and
    // is rejected as a hint, so a reporter can enable the setting, change
    // nothing else, and silently get the same 77.15 kg that was already
    // failing. That would be a false negative on the experiment (#331).
    it('warns when it falls back to the capture weight instead of a configured one', async () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      try {
        const adapter = makeAdapter();
        adapter.configure({ qnWeightAck: true });
        await driveHandshake(adapter, makeEs26mScaleInfo(), defaultProfile());
        const msg = warn.mock.calls.flat().join(' ');
        expect(msg).toContain('no usable weight anchor');
        expect(msg).toContain('weight_range');
      } finally {
        warn.mockRestore();
      }
    });

    it('stays quiet about the anchor when config supplies one', async () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      try {
        const adapter = makeAdapter();
        adapter.configure({ qnWeightAck: true });
        await driveHandshake(
          adapter,
          makeEs26mScaleInfo(),
          defaultProfile({ lastKnownWeight: 76 }),
        );
        expect(warn.mock.calls.flat().join(' ')).not.toContain('no usable weight anchor');
      } finally {
        warn.mockRestore();
      }
    });

    // #331, #75: two Android btsnoops of the Arboleaf app completing a weigh-in
    // on one unit, a month apart, both send the anchor twice AFTER START and
    // never before it. The 2026-09-29 one, with its timestamps:
    //
    //   APP    22 06 ff 00 03 2a    START
    //   APP    a2 06 01 1c ed b2    +75.0 ms, 0x1ced = 74.05 kg
    //   SCALE  a3 04 01 a8          +62.2 ms, the ack to that A2
    //   APP    a2 06 01 1c ed b2    +9.0 ms, identical
    //   SCALE  10 14 01 00 11 ...   +22.2 ms, the first live frame
    //
    // The position these tests used to pin, one A2 immediately before START,
    // came from a single iOS transcript without timestamps whose order is in
    // doubt. Replaying it from v1.28.0 never produced a weight on either
    // reporter's unit.
    const ANCHOR_2A = [0xa2, 0x06, 0x01, 0x1c, 0xed, 0xb2];
    const START_FF = [0x22, 0x06, 0xff, 0x00, 0x03, 0x2a];

    it('sends the anchor twice after START on the 19-byte dialect, as the Arboleaf app does', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const timed: TimedWrite[] = [];
      const writes = await driveHandshake(
        adapter,
        ARBOLEAF_2A_INFO,
        defaultProfile({ lastKnownWeight: 74.05 }),
        { ...arboleaf2a, timed },
      );
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      expect(writes[startIndex]).toEqual(START_FF);
      // Exactly the two captured frames follow START, with nothing between.
      expect(writes.slice(startIndex + 1)).toEqual([ANCHOR_2A, ANCHOR_2A]);
      // The capture's 75 ms before the first copy, and at least the trigger gap
      // between the copies, so the second reaches the scale after its ack.
      expect(timed[startIndex + 1].at - timed[startIndex].at).toBeGreaterThanOrEqual(75);
      expect(timed[startIndex + 2].at - timed[startIndex + 1].at).toBeGreaterThanOrEqual(150);
      // No A2 at all before START, as in the capture (#331, D033).
      const beforeStart = writes.slice(0, startIndex).filter((w) => w[0] === 0xa2);
      expect(beforeStart).toEqual([]);
      const a00d2 = writes.findIndex((w) => w[0] === 0xa0 && w[2] === 0x02);
      expect(a00d2).toBeGreaterThanOrEqual(0);
      expect(writes.slice(a00d2, startIndex).filter((w) => w[0] === 0xa2)).toEqual([]);
      expect(writes[startIndex - 1][0]).not.toBe(0xa2);
    });

    /** openScale's constant A00D #2 (age 33, 1720 mm), which every other path sends. */
    const OPENSCALE_PROFILE = [
      0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 0x21, 0x06, 0xb8, 0x04, 0x02, 0x9d,
    ];
    /** The profile frame of capture 2a, with the app user's configured age and height. */
    const PROFILE_2A = [
      0xa0, 0x0d, 0x02, 0x01, 0x03, 0xe8, 0x00, 0x33, 0x07, 0x1c, 0x04, 0x02, 0xf7,
    ];

    // #331: with qn_weight_ack on the 19-byte dialect, the A00D, START and A2
    // frames from the first A00D through the second anchor match what the
    // capture shows the app writing, given the same profile and report byte.
    // The harness feeds 0x12, 0x14 and 0x21 back to back, so AE01 and 0x13
    // writes interleave; only the FFF2 frames the capture lists are compared.
    it('sends capture 2a from the first A00D frame on, given the same profile', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true, qnReportByte: 0xfe });
      const writes = await driveHandshake(
        adapter,
        ARBOLEAF_2A_INFO,
        defaultProfile({ age: 51, height: 182, lastKnownWeight: 74.05 }),
        arboleaf2a,
      );
      const first = writes.findIndex((w) => w[0] === 0xa0);
      const sequence = writes
        .slice(first)
        .filter((w) => w[0] === 0xa0 || w[0] === 0x22 || w[0] === 0xa2);
      expect(sequence).toEqual([
        [0xa0, 0x0d, 0x04, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xaf],
        PROFILE_2A,
        START_FF,
        ANCHOR_2A,
        ANCHOR_2A,
      ]);
    });

    it("sends the first user's sex in the profile frame (#331)", async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true, qnReportByte: 0xfe });
      const writes = await driveHandshake(
        adapter,
        ARBOLEAF_2A_INFO,
        defaultProfile({ age: 51, height: 182, gender: 'female', lastKnownWeight: 74.05 }),
        arboleaf2a,
      );
      const female = [...PROFILE_2A];
      female[6] = 0x01;
      female[12] = (female[12] + 1) & 0xff;
      expect(writes.filter((w) => w[0] === 0xa0 && w[2] === 0x02)).toEqual([female]);
    });

    it.each([
      ['18-byte es26m', () => makeEs26mScaleInfo()],
      ['20-byte extended', () => makeExtendedScaleInfo()],
      [
        '11-byte classic',
        () => {
          const info = Buffer.alloc(11);
          info[0] = 0x12;
          info[2] = 0xab;
          info[10] = 1;
          return info;
        },
      ],
    ])('keeps openScale profile frame on the %s dialect with the ack on', async (_name, info) => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const writes = await driveHandshake(adapter, info(), defaultProfile({ lastKnownWeight: 76 }));
      expect(writes.filter((w) => w[0] === 0xa0 && w[2] === 0x02)).toEqual([OPENSCALE_PROFILE]);
    });

    /** Feed frames with time in between; `advance` runs the fake clock after the frame. */
    async function driveSteps(
      adapter: QnScaleAdapter,
      profile: UserProfile,
      steps: Array<{ frame?: Buffer; advance: number }>,
    ): Promise<number[][]> {
      vi.useFakeTimers();
      try {
        const writes: number[][] = [];
        const ctx = {
          write: async (_uuid: string, data: Buffer | number[]) => {
            writes.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile,
          deviceAddress: '',
          availableChars: new Set<string>(),
        } as unknown as ConnectionContext;
        adapter.onSessionStart?.();
        await adapter.onConnected(ctx);
        for (const step of steps) {
          if (step.frame) adapter.parseNotification(step.frame);
          await vi.advanceTimersByTimeAsync(step.advance);
        }
        return writes;
      } finally {
        vi.useRealTimers();
      }
    }

    const preStartA2 = (writes: number[][]): number[][] => {
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      return writes.slice(0, startIndex).filter((w) => w[0] === 0xa2);
    };

    // A session whose 0x12 is lost runs the fallback handshake with openScale's
    // frames. A 19-byte 0x12 that shows up after its ready step must not switch
    // the profile frame alone, or the scale gets half of each sequence.
    it('keeps both openScale frames when the 19-byte 0x12 arrives after a fallback ready', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const writes = await driveSteps(adapter, defaultProfile({ age: 51, height: 182 }), [
        { advance: 2701 },
        { frame: ARBOLEAF_2A_INFO, advance: 3000 },
      ]);
      expect(writes.filter((w) => w[0] === 0xa0 && w[2] === 0x02)).toEqual([OPENSCALE_PROFILE]);
      expect(preStartA2(writes)).toEqual([[0xa2, 0x06, 0x01, 0x32, 0x33, 0x0e]]);
    });

    // Same rule the other way round: a 0x21 ahead of the 0x14 decides first.
    it('takes both frames from one decision when 0x21 comes before 0x14', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const writes = await driveSteps(adapter, defaultProfile({ age: 51, height: 182 }), [
        { frame: ARBOLEAF_2A_INFO, advance: 0 },
        { frame: ARBOLEAF_2A_CONFIG_REQ, advance: 300 },
        { frame: ARBOLEAF_2A_READY, advance: 2000 },
      ]);
      expect(writes.filter((w) => w[0] === 0xa0 && w[2] === 0x02)).toEqual([PROFILE_2A]);
      expect(preStartA2(writes)).toEqual([]);
    });

    // The classic branch accepts any length when [1] is not the frame length,
    // so a 19-byte classic frame must not pass for the Arboleaf dialect.
    // Synthetic, like the other classic frames in this file: no classic
    // capture exists.
    it('keeps openScale frames for a 19-byte classic 0x12', async () => {
      const info = Buffer.alloc(19);
      info[0] = 0x12;
      info[2] = 0xab;
      info[10] = 1;
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const writes = await driveHandshake(adapter, info, defaultProfile({ age: 51, height: 182 }));
      expect(writes.filter((w) => w[0] === 0xa0 && w[2] === 0x02)).toEqual([OPENSCALE_PROFILE]);
      expect(preStartA2(writes)).toHaveLength(1);
    });

    it('keeps openScale profile frame and ready-time A2 on the 19-byte dialect without the ack', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(
        adapter,
        ARBOLEAF_2A_INFO,
        defaultProfile({ age: 51, height: 182 }),
        arboleaf2a,
      );
      expect(writes.filter((w) => w[0] === 0xa0 && w[2] === 0x02)).toEqual([OPENSCALE_PROFILE]);
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      expect(writes.slice(0, startIndex).filter((w) => w[0] === 0xa2)).toEqual([
        [0xa2, 0x06, 0x01, 0x32, 0x33, 0x0e],
      ]);
    });

    // #463: the profile frame carries the user key the vendor app registered the
    // slot with. The Physiq refuses openScale's key 8 and accepts the Feelfit
    // app's 1000. Its own 0x12, 0x14 and 0x21 below are from the public #461
    // log; the profile is a neutral one (capture 2a's), so the frame the option
    // sends can be compared with PROFILE_2A.
    describe('ble.qn_user_key (#463)', () => {
      const physiq: HandshakeOptions = { ready: READY_461, configReq: CONFIG_REQ_461 };
      const profileFrames = (writes: number[][]): number[][] =>
        writes.filter((w) => w[0] === 0xa0 && w[2] === 0x02);
      /** The writes without 0x20, whose timestamp follows the wall clock. */
      const timeless = (writes: number[][]): number[][] => writes.filter((w) => w[0] !== 0x20);
      /** Accepted, `a1 06 02 01 01 ab`, from the #213 and #253 logs. */
      const ACCEPTED = Buffer.from([0xa1, 0x06, 0x02, 0x01, 0x01, 0xab]);
      /** Refused, `a1 06 02 01 00 aa`, from the #461 log. */
      const REFUSED = Buffer.from([0xa1, 0x06, 0x02, 0x01, 0x00, 0xaa]);

      it('sends the vendor profile frame on the 18-byte dialect, without the ready-time A2', async () => {
        const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
        try {
          const adapter = makeAdapter();
          adapter.configure({ qnUserKey: 1000 });
          const writes = await driveHandshake(
            adapter,
            INFO_461,
            defaultProfile({ age: 51, height: 182 }),
            physiq,
          );
          expect(profileFrames(writes)).toEqual([PROFILE_2A]);
          // No A2 anywhere: none before START, and no anchor after it without
          // qn_weight_ack.
          expect(writes.filter((w) => w[0] === 0xa2)).toEqual([]);
          // The ES-26M hardware guard still holds: proto 0x00 on 0x13 and 0x22.
          expect(writes.find((w) => w[0] === 0x13 && w[4] === 0x10)![2]).toBe(0x00);
          expect(writes.find((w) => w[0] === 0x22)).toEqual([0x22, 0x06, 0x00, 0x00, 0x03, 0x2b]);
          const lines = debug.mock.calls.map((c) => String(c[0]));
          expect(lines).toContain(
            'QN: no A2 before START on the 18-byte dialect, as the vendor app (ble.qn_user_key, #463)',
          );
          expect(lines).toContain(
            'QN: A00D profile frame with key 1000, age 51, height 1820 mm, sex male, athlete no ' +
              '(ble.qn_user_key, 18-byte dialect, #463)',
          );
        } finally {
          debug.mockRestore();
        }
      });

      it('sends the athlete algorithm on the 18-byte dialect for an adult athlete only', async () => {
        const adult = makeAdapter();
        adult.configure({ qnUserKey: 1000 });
        const adultWrites = await driveHandshake(
          adult,
          INFO_461,
          defaultProfile({ age: 51, height: 182, isAthlete: true }),
          physiq,
        );
        const athlete = [...PROFILE_2A];
        athlete[10] = 0x0e;
        athlete[12] = (athlete[12] + 10) & 0xff;
        expect(profileFrames(adultWrites)).toEqual([athlete]);

        // The vendor's published SDK sets the athlete step only above 17 years.
        const young = makeAdapter();
        young.configure({ qnUserKey: 1000 });
        const youngWrites = await driveHandshake(
          young,
          INFO_461,
          defaultProfile({ age: 17, height: 182, isAthlete: true }),
          physiq,
        );
        expect(profileFrames(youngWrites)[0][10]).toBe(0x04);
      });

      it('takes the key from the option on the 19-byte dialect and keeps 04 for an athlete', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnWeightAck: true, qnUserKey: 1234 });
        const writes = await driveHandshake(
          adapter,
          ARBOLEAF_2A_INFO,
          defaultProfile({ age: 51, height: 182, isAthlete: true, lastKnownWeight: 74.05 }),
          arboleaf2a,
        );
        const expected = [...PROFILE_2A];
        expected[4] = 0x04;
        expected[5] = 0xd2;
        expected[12] = expected.slice(0, 12).reduce((a, b) => a + b, 0) & 0xff;
        expect(profileFrames(writes)).toEqual([expected]);
        // The rest of the qn_weight_ack sequence is unchanged.
        const startIndex = writes.findIndex((w) => w[0] === 0x22);
        expect(preStartA2(writes)).toEqual([]);
        expect(writes.slice(startIndex + 1)).toEqual([ANCHOR_2A, ANCHOR_2A]);
      });

      it('sends the vendor profile frame on the 19-byte dialect without qn_weight_ack', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnUserKey: 1000 });
        const writes = await driveHandshake(
          adapter,
          ARBOLEAF_2A_INFO,
          defaultProfile({ age: 51, height: 182, lastKnownWeight: 74.05 }),
          arboleaf2a,
        );
        expect(profileFrames(writes)).toEqual([PROFILE_2A]);
        // Neither the ready-time A2 nor the anchor pair after START.
        expect(writes.filter((w) => w[0] === 0xa2)).toEqual([]);
      });

      it.each([
        ['18-byte #461', INFO_461],
        ['18-byte ES-26M', makeEs26mScaleInfo()],
      ])("keeps openScale's frames on the %s dialect without the option", async (_name, info) => {
        for (const qnWeightAck of [undefined, true]) {
          const adapter = makeAdapter();
          adapter.configure({ qnWeightAck });
          const writes = await driveHandshake(
            adapter,
            info,
            defaultProfile({ age: 51, height: 182, lastKnownWeight: 76 }),
            physiq,
          );
          expect(profileFrames(writes)).toEqual([OPENSCALE_PROFILE]);
          expect(preStartA2(writes)).toEqual([[0xa2, 0x06, 0x01, 0x32, 0x33, 0x0e]]);
        }
      });

      it.each([
        ['20-byte extended', makeExtendedScaleInfo()],
        ['17-byte classic (#283)', INFO_283],
      ])('changes nothing on the %s dialect', async (_name, info) => {
        const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
        try {
          const profile = defaultProfile({ age: 51, height: 182, lastKnownWeight: 76 });
          const plain = await driveHandshake(makeAdapter(), info, profile);
          const keyed = makeAdapter();
          keyed.configure({ qnUserKey: 1000 });
          const writes = await driveHandshake(keyed, info, profile);
          expect(timeless(writes)).toEqual(timeless(plain));
          expect(profileFrames(writes)).toEqual([OPENSCALE_PROFILE]);
          const notUsed = debug.mock.calls.filter((c) =>
            String(c[0]).includes('ble.qn_user_key is not used on this dialect'),
          );
          expect(notUsed).toHaveLength(1);
        } finally {
          debug.mockRestore();
        }
      });

      it('changes nothing on the fallback handshake without a 0x12', async () => {
        const profile = defaultProfile({ age: 51, height: 182 });
        const keyed = makeAdapter();
        keyed.configure({ qnUserKey: 1000 });
        const writes = await driveSteps(keyed, profile, [{ advance: 6000 }]);
        expect(profileFrames(writes)).toEqual([OPENSCALE_PROFILE]);
        expect(preStartA2(writes)).toEqual([[0xa2, 0x06, 0x01, 0x32, 0x33, 0x0e]]);
      });

      // As with qn_weight_ack on the 19-byte dialect: an 18-byte 0x12 after the
      // fallback's ready step does not switch the profile frame alone.
      it('keeps both openScale frames when the 18-byte 0x12 arrives after a fallback ready', async () => {
        const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
        try {
          const adapter = makeAdapter();
          adapter.configure({ qnUserKey: 1000 });
          const writes = await driveSteps(adapter, defaultProfile({ age: 51, height: 182 }), [
            { advance: 2701 },
            { frame: INFO_461, advance: 3000 },
          ]);
          expect(profileFrames(writes)).toEqual([OPENSCALE_PROFILE]);
          expect(preStartA2(writes)).toEqual([[0xa2, 0x06, 0x01, 0x32, 0x33, 0x0e]]);
          // The late 0x12 says why; "not used on this dialect" would be wrong here.
          const lines = debug.mock.calls.map((c) => String(c[0]));
          expect(lines).toContain(
            "QN: 18-byte 0x12 after the handshake already chose openScale's frames; " +
              'the profile frame stays as sent (#331)',
          );
          expect(lines.filter((l) => l.includes('is not used on this dialect'))).toEqual([]);
        } finally {
          debug.mockRestore();
        }
      });

      it('logs one info line when the scale refuses the frame sent with the option', async () => {
        const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
        const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
        const keyLines = () =>
          info.mock.calls.filter((c) => String(c[0]).includes('refused the profile frame'));
        try {
          const keyed = makeAdapter();
          keyed.configure({ qnUserKey: 1234 });
          await driveHandshake(keyed, INFO_461, defaultProfile(), physiq);
          keyed.parseNotification(REFUSED);
          keyed.parseNotification(REFUSED);
          // The text configuration.md quotes, with the key that was sent.
          expect(keyLines().map((c) => String(c[0]))).toEqual([
            'QN: the scale refused the profile frame sent with ble.qn_user_key 1234 for user ' +
              'slot 1. Most likely the vendor app set up that slot with another key, or never ' +
              'set it up. Check ble.qn_user_key, and that the first user in config.yaml is the ' +
              'first user in the vendor app (#463).',
          ]);
          expect(warn).not.toHaveBeenCalled();
          // The debug line the docs quote stays as it was.
          expect(debug.mock.calls.map((c) => String(c[0]))).toContain(
            'QN: the scale did not accept the profile for user slot 1 (#331)',
          );

          info.mockClear();
          const accepted = makeAdapter();
          accepted.configure({ qnUserKey: 1000 });
          await driveHandshake(accepted, INFO_461, defaultProfile(), physiq);
          accepted.parseNotification(ACCEPTED);
          expect(keyLines()).toEqual([]);

          // Without the option the log does not change.
          const plain = makeAdapter();
          await driveHandshake(plain, INFO_461, defaultProfile(), physiq);
          plain.parseNotification(REFUSED);
          expect(keyLines()).toEqual([]);
          // Nor where the vendor frame goes out without it (19-byte, qn_weight_ack).
          const acked = makeAdapter();
          acked.configure({ qnWeightAck: true });
          await driveHandshake(
            acked,
            ARBOLEAF_2A_INFO,
            defaultProfile({ lastKnownWeight: 74.05 }),
            arboleaf2a,
          );
          acked.parseNotification(REFUSED);
          expect(keyLines()).toEqual([]);
          expect(warn).not.toHaveBeenCalled();
        } finally {
          info.mockRestore();
          warn.mockRestore();
          debug.mockRestore();
        }
      });
    });

    it.each([
      ['18-byte es26m', () => makeEs26mScaleInfo()],
      [
        '11-byte classic',
        () => {
          const info = Buffer.alloc(11);
          info[0] = 0x12;
          info[2] = 0xab;
          info[10] = 1;
          return info;
        },
      ],
    ])('sends the anchor pair after START on the %s dialect too', async (_name, info) => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const writes = await driveHandshake(adapter, info(), defaultProfile({ lastKnownWeight: 76 }));
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      // 7600 = 0x1db0.
      const anchor = [0xa2, 0x06, 0x01, 0x1d, 0xb0, 0x76];
      expect(writes.slice(startIndex + 1)).toEqual([anchor, anchor]);
      const beforeStart = writes.slice(0, startIndex).filter((w) => w[0] === 0xa2);
      expect(beforeStart).toHaveLength(1);
      expect(beforeStart[0][3]).toBe(0x32);
    });

    it('sends no anchor after START on the 19-byte dialect when forced off', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: false });
      const writes = await driveHandshake(
        adapter,
        ARBOLEAF_2A_INFO,
        defaultProfile({ lastKnownWeight: 74.05 }),
        arboleaf2a,
      );
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      expect(writes.slice(startIndex + 1).filter((w) => w[0] === 0xa2)).toHaveLength(0);
      expect(writes.slice(0, startIndex).filter((w) => w[0] === 0xa2)).toHaveLength(1);
    });

    // The extended burst is the hardware-confirmed one (#235) and must not pick
    // up the 75 ms the es26m pair waits before its first copy.
    it('starts the extended burst straight after START, without the es26m delay', async () => {
      const adapter = makeAdapter();
      const timed: TimedWrite[] = [];
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo(), defaultProfile(), {
        timed,
      });
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      const trigger = [0xa2, 0x06, 0x01, 0x1e, 0x23, 0xea];
      expect(writes.slice(startIndex + 1)).toEqual([trigger, trigger]);
      expect(timed[startIndex + 1].at).toBe(timed[startIndex].at);
    });

    // The pair spans two timers and writeCmd reads this.ctx when it writes, so
    // a session that ends inside the window and reconnects must not be handed
    // the previous session's anchor.
    it('does not hand a reconnected session the previous session anchor', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const makeCtx = (sink: number[][], profile: UserProfile): ConnectionContext =>
        ({
          write: async (_uuid: string, data: Buffer | number[]) => {
            sink.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile,
          deviceAddress: '',
          availableChars: new Set<string>(),
        }) as unknown as ConnectionContext;
      vi.useFakeTimers();
      try {
        const first: number[][] = [];
        const second: number[][] = [];
        adapter.onSessionStart?.();
        await adapter.onConnected(makeCtx(first, defaultProfile({ lastKnownWeight: 74.05 })));
        adapter.parseNotification(ARBOLEAF_2A_INFO);
        adapter.parseNotification(ARBOLEAF_2A_READY);
        adapter.parseNotification(ARBOLEAF_2A_CONFIG_REQ);
        // Up to and including START, then end the session inside the 75 ms.
        await vi.advanceTimersByTimeAsync(400);
        expect(first.some((w) => w[0] === 0x22)).toBe(true);
        adapter.onSessionEnd!();
        adapter.onSessionStart?.();
        await adapter.onConnected(makeCtx(second, defaultProfile({ lastKnownWeight: 60 })));
        // Well past the pair, well short of the new session's 2 s fallback.
        await vi.advanceTimersByTimeAsync(1000);
        expect(second.filter((w) => w[0] === 0xa2)).toEqual([]);
        expect(first.filter((w) => w[0] === 0xa2 && w[3] === 0x1c)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    // The same binding for every other step that sleeps between writes: the
    // A00D profile frame and START here, the 0x13 config after the AE01 init, and the
    // whole fallback handshake below. Default config, no opt-ins.
    it('does not hand a reconnected session the previous session A00D or START', async () => {
      const adapter = makeAdapter();
      const makeCtx = (sink: number[][]): ConnectionContext =>
        ({
          write: async (_uuid: string, data: Buffer | number[]) => {
            sink.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile(),
          deviceAddress: '',
          availableChars: new Set<string>(),
        }) as unknown as ConnectionContext;
      vi.useFakeTimers();
      try {
        const first: number[][] = [];
        const second: number[][] = [];
        adapter.onSessionStart?.();
        await adapter.onConnected(makeCtx(first));
        adapter.parseNotification(ARBOLEAF_2A_INFO);
        adapter.parseNotification(ARBOLEAF_2A_READY);
        adapter.parseNotification(ARBOLEAF_2A_CONFIG_REQ);
        // The time sync is out; the A00D profile frame and START are still
        // sleeping when the session ends (no user-delete frame by default,
        // #461, so the 200 ms before the profile frame is what is pending).
        await vi.advanceTimersByTimeAsync(100);
        expect(first.some((w) => w[0] === 0x20)).toBe(true);
        expect(first.some((w) => w[0] === 0xa0)).toBe(false);
        adapter.onSessionEnd!();
        adapter.onSessionStart?.();
        await adapter.onConnected(makeCtx(second));
        // Past the old sequence, short of the new session's 2 s fallback.
        await vi.advanceTimersByTimeAsync(1000);
        expect(second).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not let a previous fallback handshake run into a reconnected session', async () => {
      const adapter = makeAdapter();
      const makeCtx = (sink: number[][]): ConnectionContext =>
        ({
          write: async (_uuid: string, data: Buffer | number[]) => {
            sink.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile(),
          deviceAddress: '',
          availableChars: new Set<string>(),
        }) as unknown as ConnectionContext;
      vi.useFakeTimers();
      try {
        const first: number[][] = [];
        const second: number[][] = [];
        adapter.onSessionStart?.();
        await adapter.onConnected(makeCtx(first));
        // No 0x12 ever arrives, so the 2 s fallback starts and sends the AE01
        // init, then sleeps 200 ms before the 0x13 config.
        await vi.advanceTimersByTimeAsync(2100);
        expect(first.some((w) => w[0] === 0xfe)).toBe(true);
        adapter.onSessionEnd!();
        adapter.onSessionStart?.();
        await adapter.onConnected(makeCtx(second));
        // Past the old fallback's config, time sync and START, short of the
        // new session's own fallback.
        await vi.advanceTimersByTimeAsync(1500);
        expect(second).toEqual([]);
        // The new session's own fallback still runs in full: the old one must
        // not have set its dedup flags. It fires 2 s after this connect and
        // reaches START about 1.6 s later.
        await vi.advanceTimersByTimeAsync(3000);
        expect(second.some((w) => w[0] === 0x13)).toBe(true);
        expect(second.some((w) => w[0] === 0x20)).toBe(true);
        expect(second.some((w) => w[0] === 0x22)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('sends no pre-START anchor on the 19-byte dialect by default', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(
        adapter,
        makeArboleafScaleInfo(),
        defaultProfile({ lastKnownWeight: 88.45 }),
      );
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      const beforeStart = writes.slice(0, startIndex).filter((w) => w[0] === 0xa2);
      // Only openScale's ready-time profile frame, `a2 06 01 32 <age>`.
      expect(beforeStart).toHaveLength(1);
      expect(beforeStart[0][3]).toBe(0x32);
      expect(writes.slice(startIndex + 1).filter((w) => w[0] === 0xa2)).toHaveLength(0);
    });

    // #331: the Arboleaf vendor app's 0x20 is 9 bytes where ours is 8. Both
    // close under the family checksum, both carry the same little-endian
    // 2000-epoch timestamp at [3..6], and the whole difference is one 0x08
    // before the checksum. The meaning of that byte is not decoded.
    describe('0x20 time sync (ble.qn_time_sync_long, #331)', () => {
      it('reproduces our own 8-byte frame from the reporter log byte for byte', () => {
        // 0x3222aaa1 = 841132705 s since 2000-01-01.
        expect(buildTimeSync(0xff, 0x3222aaa1)).toEqual([
          0x20, 0x08, 0xff, 0xa1, 0xaa, 0x22, 0x32, 0xc6,
        ]);
      });

      it('reproduces the vendor-app 9-byte frame byte for byte', () => {
        // 0x3222b3f3 = 841135091 s since 2000-01-01, 2386 s after the frame
        // above and on the same capture day.
        expect(buildTimeSync(0xff, 0x3222b3f3, true)).toEqual([
          0x20, 0x09, 0xff, 0xf3, 0xb3, 0x22, 0x32, 0x08, 0x2a,
        ]);
      });

      it('reproduces a second, independent vendor-app 9-byte frame', () => {
        // #331 Android btsnoop, 2026-09-29: 0x324ebca0 = 2026-09-29 18:14:56
        // on the scale clock.
        expect(buildTimeSync(0xff, 0x324ebca0, true)).toEqual([
          0x20, 0x09, 0xff, 0xa0, 0xbc, 0x4e, 0x32, 0x08, 0x0c,
        ]);
      });

      it('sends the 8-byte form by default', async () => {
        const adapter = makeAdapter();
        const writes = await driveHandshake(adapter, makeArboleafScaleInfo());
        const t = writes.find((w) => w[0] === 0x20)!;
        expect(t).toHaveLength(8);
        expect(t.slice(0, 3)).toEqual([0x20, 0x08, 0xff]);
      });

      // The extra byte is the host's UTC offset in 15-minute units, bit 7 west
      // of UTC (the vendor's published SDK). All three captures were taken in
      // CEST, hence their 0x08. It used to be that 0x08 for every host.
      it.each([
        ['UTC+2, as in the captures', -120, 0x08],
        ['UTC+1', -60, 0x04],
        ['UTC-5', 300, 0x94],
        ['UTC+5:45', -345, 0x17],
        ['UTC', 0, 0x00],
      ])(
        'sends the 9-byte form with the host UTC offset (%s) when ble.qn_time_sync_long is set',
        async (_name, jsOffset, tz) => {
          const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(jsOffset);
          try {
            const adapter = makeAdapter();
            adapter.configure({ qnTimeSyncLong: true });
            const writes = await driveHandshake(adapter, makeArboleafScaleInfo());
            const t = writes.find((w) => w[0] === 0x20)!;
            expect(t).toHaveLength(9);
            // The timestamp bytes are wall-clock dependent, but nothing else is:
            // the trailer must be appended after them, never inside them. The
            // tests above pin the arithmetic against the captured frames.
            expect(t.slice(0, 3)).toEqual([0x20, 0x09, 0xff]);
            expect(t[7]).toBe(tz);
            expect(hasValidSumChecksum(t)).toBe(true);
          } finally {
            spy.mockRestore();
          }
        },
      );

      it('reproduces both captured 9-byte frames from the CEST offset', () => {
        expect(buildTimeSync(0xff, 0x3222b3f3, true, timeZoneByte(120))).toEqual([
          0x20, 0x09, 0xff, 0xf3, 0xb3, 0x22, 0x32, 0x08, 0x2a,
        ]);
        expect(buildTimeSync(0xff, 0x324ebca0, true, timeZoneByte(120))).toEqual([
          0x20, 0x09, 0xff, 0xa0, 0xbc, 0x4e, 0x32, 0x08, 0x0c,
        ]);
      });

      it('leaves every other frame alone when the long form is on', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnTimeSyncLong: true });
        const writes = await driveHandshake(adapter, makeArboleafScaleInfo());
        expect(writes.find((w) => w[0] === 0x13 && w[4] === 0x10)).toHaveLength(9);
        expect(writes.find((w) => w[0] === 0x22)).toEqual([0x22, 0x06, 0xff, 0x00, 0x03, 0x2a]);
      });
    });

    // The last documented difference between our QN handshake and the vendor
    // app's. Two independent captures show a 10-byte 0x13 where we send 9; the
    // first seven bytes are identical, all three close under the family
    // checksum, and the captures disagree on the trailing pair's value.
    describe('0x13 config (ble.qn_config_long, #331)', () => {
      // This 9-byte frame is also exactly what the Arboleaf app sends in both
      // Android captures of one unit (#331, #75).
      it('reproduces our own 9-byte frame from the #235 capture byte for byte', () => {
        expect(buildConfig(0xff, 0x01)).toEqual([
          0x13, 0x09, 0xff, 0x01, 0x10, 0x00, 0x00, 0x00, 0x2c,
        ]);
      });

      it('reproduces the vendor-app 10-byte frame byte for byte', () => {
        expect(buildConfig(0xff, 0x01, true)).toEqual([
          0x13, 0x0a, 0xff, 0x01, 0x10, 0x00, 0x00, 0x02, 0x00, 0x2f,
        ]);
      });

      it('keeps the length byte and the checksum consistent for lb as well', () => {
        const lb = buildConfig(0xff, 0x02, true);
        expect(lb).toHaveLength(10);
        expect(lb[1]).toBe(0x0a);
        expect(lb[lb.length - 1]).toBe(lb.slice(0, -1).reduce((a, b) => a + b, 0) & 0xff);
      });

      it('sends the 9-byte form by default', async () => {
        const adapter = makeAdapter();
        const writes = await driveHandshake(adapter, makeArboleafScaleInfo());
        const c = writes.find((w) => w[0] === 0x13 && w[4] === 0x10)!;
        expect(c).toHaveLength(9);
        expect(c[1]).toBe(0x09);
      });

      it('sends the 10-byte form when ble.qn_config_long is set', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnConfigLong: true });
        const writes = await driveHandshake(adapter, makeArboleafScaleInfo());
        const c = writes.find((w) => w[0] === 0x13 && w[4] === 0x10)!;
        expect(c).toHaveLength(10);
        expect(c[1]).toBe(0x0a);
        expect(c.slice(7)).toEqual([0x02, 0x00, 0x2f]);
      });

      it('leaves every other frame alone when the long form is on', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnConfigLong: true });
        const writes = await driveHandshake(adapter, makeArboleafScaleInfo());
        expect(writes.find((w) => w[0] === 0x20)).toHaveLength(8);
        expect(writes.find((w) => w[0] === 0x22)).toEqual([0x22, 0x06, 0xff, 0x00, 0x03, 0x2a]);
      });

      it('is independent of qn_time_sync_long', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnConfigLong: true, qnTimeSyncLong: true });
        const writes = await driveHandshake(adapter, makeArboleafScaleInfo());
        expect(writes.find((w) => w[0] === 0x13 && w[4] === 0x10)).toHaveLength(10);
        expect(writes.find((w) => w[0] === 0x20)).toHaveLength(9);
      });
    });

    it('leaves the extended dialect anchor after START, never before', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const writes = await driveHandshake(
        adapter,
        makeExtendedScaleInfo(),
        defaultProfile({ lastKnownWeight: 76 }),
      );
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      // Ready-time A2 only before START; the burst of two stays after it, where
      // the #235 hardware confirmation put it.
      expect(writes.slice(0, startIndex).filter((w) => w[0] === 0xa2)).toHaveLength(1);
      expect(writes.slice(startIndex + 1).filter((w) => w[0] === 0xa2)).toHaveLength(2);
    });

    it('echoes on any dialect when qn_weight_ack forces it on', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const writes: number[][] = [];
      const ctx = {
        write: async (_uuid: string, data: Buffer | number[]) => {
          writes.push([...data]);
        },
        read: async () => Buffer.alloc(0),
        subscribe: async () => {},
        profile: defaultProfile(),
        deviceAddress: '',
        availableChars: new Set<string>(),
      } as unknown as ConnectionContext;
      await adapter.onConnected(ctx);
      adapter.parseNotification(makeEs26mScaleInfo());
      writes.length = 0;
      const b = Buffer.alloc(14);
      b[0] = 0x10;
      b[1] = 0x0e;
      b[2] = 0xff;
      b.writeUInt16BE(0x1ebe, 3);
      adapter.parseNotification(b);
      await Promise.resolve();
      expect(writes.filter((w) => w[0] === 0xa2)).toEqual([[0xa2, 0x06, 0x01, 0x1e, 0xbe, 0x85]]);
    });

    it('suppresses the echo on the extended dialect when forced off', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: false });
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      // The post-START trigger still goes out; only the per-frame echo is off,
      // and no live frame was fed here.
      expect(writes.slice(startIndex + 1).filter((w) => w[0] === 0xa2)).toHaveLength(2);
      const b = Buffer.alloc(14);
      b[0] = 0x10;
      b[1] = 0x0e;
      b[2] = 0xff;
      b.writeUInt16BE(0x1ebe, 3);
      const before = writes.length;
      adapter.parseNotification(b);
      await Promise.resolve();
      expect(writes.length).toBe(before);
    });

    it('does not echo live weight frames on the es26m dialect', async () => {
      const adapter = makeAdapter();
      const writes: number[][] = [];
      const ctx = {
        write: async (_uuid: string, data: Buffer | number[]) => {
          writes.push([...data]);
        },
        read: async () => Buffer.alloc(0),
        subscribe: async () => {},
        profile: defaultProfile(),
        deviceAddress: '',
        availableChars: new Set<string>(),
      } as unknown as ConnectionContext;
      await adapter.onConnected(ctx);
      adapter.parseNotification(makeEs26mScaleInfo());
      writes.length = 0;
      const b = Buffer.alloc(14);
      b[0] = 0x10;
      b[1] = 0x0e;
      b[2] = 0xff;
      b.writeUInt16BE(0x1ebe, 3);
      adapter.parseNotification(b);
      await Promise.resolve();
      expect(writes.filter((w) => w[0] === 0xa2)).toHaveLength(0);
    });

    // #331: the live frame both Arboleaf captures show is 20 bytes with the
    // weight at [5..6]. The parser reads [3..4] there, 0x0011, so with the echo
    // on every live frame used to be answered with `a2 06 01 00 11 ba`: 0.17 kg.
    it('does not answer a real 20-byte live frame with an A2 (es26m, forced on)', async () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      try {
        const adapter = makeAdapter();
        adapter.configure({ qnWeightAck: true });
        const writes = await driveHandshake(
          adapter,
          ARBOLEAF_2A_INFO,
          defaultProfile({ lastKnownWeight: 74.05 }),
          arboleaf2a,
        );
        const before = writes.length;
        expect(adapter.parseNotification(ARBOLEAF_2A_LIVE)).toBeNull();
        await Promise.resolve();
        expect(writes.slice(before).filter((w) => w[0] === 0xa2)).toEqual([]);
        // The one diagnostic line carries the weight from where the captures put it.
        const lines = debug.mock.calls.map((c) => String(c[0]));
        const line = lines.find((l) => l.startsWith('QN: 20-byte live frame'));
        expect(line).toContain('76.2 kg at [5..6]');
        // Once per session, not once per frame.
        adapter.parseNotification(ARBOLEAF_2A_LIVE);
        const again = debug.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.startsWith('QN: 20-byte live frame'));
        expect(again).toHaveLength(1);
      } finally {
        debug.mockRestore();
      }
    });

    // Same layout on the GE CS 10 G, where the echo is on by default. Latent
    // there: none of the reporter's logs ever delivered a 0x10 to this adapter,
    // but should one arrive it must not be answered with 0.17 kg either.
    it('does not answer a real 20-byte live frame with an A2 on the extended default', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const before = writes.length;
      expect(adapter.parseNotification(GE_LIVE)).toBeNull();
      await Promise.resolve();
      expect(writes.slice(before).filter((w) => w[0] === 0xa2)).toEqual([]);
    });

    // The original layout reads [5] as its stability byte, which in this shape
    // is the weight's high byte, so a frame between 2.56 and 5.11 kg read as a
    // stable 1.7 kg, was acknowledged with 0x1F, and at exactly 2.56 kg ([6]
    // zero, so no impedance either) completed the session. The live stream does
    // ramp through low weights: the #235 GE capture shows `11 14 78`, `11 11 e4`,
    // `11 0f 78` in a row (52.40, 45.80, 39.60 kg; posted truncated). No capture
    // has a frame inside that band, so these are the captured Arboleaf frame
    // with only its weight field and checksum changed. They test that the frame
    // is NOT read, not how it is read.
    it.each([
      ['2.56 kg, no impedance bytes', 0x0100],
      ['5.00 kg', 0x01f4],
    ])('does not turn a 20-byte live frame at %s into a reading', async (_name, raw) => {
      const frame = Buffer.from(ARBOLEAF_2A_LIVE);
      frame.writeUInt16BE(raw, 5);
      frame[19] = [...frame.subarray(0, 19)].reduce((a, b) => a + b, 0) & 0xff;
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const writes = await driveHandshake(
        adapter,
        ARBOLEAF_2A_INFO,
        defaultProfile({ lastKnownWeight: 74.05 }),
        arboleaf2a,
      );
      const before = writes.length;
      expect(adapter.parseNotification(frame)).toBeNull();
      await Promise.resolve();
      // No 0x1F stable ack and no A2: nothing is written for this frame at all.
      expect(writes.slice(before)).toEqual([]);
    });

    // #331, D037: the 19-byte dialect streams 20-byte 0x10 frames, sends one
    // stable frame, runs its BIA for about 13 s, and closes the weigh-in with a
    // 0x23 marker, a three-part result block, 0x15 and 0x16.
    describe('19-byte dialect weigh-in stream (#331, D037)', () => {
      const hex = (h: string): Buffer => Buffer.from(h.replace(/ /g, ''), 'hex');
      const withSum = (frame: Buffer): Buffer => {
        const f = Buffer.from(frame);
        f[f.length - 1] = [...f.subarray(0, f.length - 1)].reduce((a, b) => a + b, 0) & 0xff;
        return f;
      };
      /** A copy of `frame` with `bytes` written at `at` and the checksum recomputed. */
      const patched = (frame: Buffer, at: number, ...bytes: number[]): Buffer => {
        const f = Buffer.from(frame);
        f.set(bytes, at);
        return withSum(f);
      };

      // #331 DEBUG log, 2026-10-06. Byte for byte from the log.
      const INFO = hex('12 13 ff 54 0b 04 00 07 ff 15 0f 27 00 00 05 03 e0 6f 2f');
      const READY = hex('14 0b ff 01 00 01 00 00 00 00 20');
      const CONFIG_REQ = hex('21 05 ff 01 26');
      const MEASURING = hex('10 14 01 00 11 1e 05 00 00 00 00 00 00 00 00 00 00 00 00 59');
      const STABLE = hex('10 14 01 01 11 1e 05 00 00 00 00 00 00 00 00 00 00 00 00 5a');
      const END_MARKER = hex('23 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 23');
      // Derived from the captured frames: payload zeroed, checksum recomputed.
      // The captured payload is the person's body composition, which nothing
      // here decodes. Kept as captured: [0] and [1] of every frame, [2] on
      // 0x15/0x16, part 1's [2], status [3] and weight [5..6], and the part byte
      // [4] of each part. On parts 2 and 3, [2..3] is payload and was zeroed.
      const PART1 = withSum(hex('10 14 01 02 31 1e 05' + ' 00'.repeat(13)));
      const PART2 = withSum(hex('10 14 00 00 32' + ' 00'.repeat(15)));
      const PART3 = withSum(hex('10 14 00 00 33' + ' 00'.repeat(15)));
      const COMP_15 = withSum(hex('15 10 ff' + ' 00'.repeat(13)));
      const DONE_16 = withSum(hex('16 10 ff' + ' 00'.repeat(13)));

      const WEIGHT = { weight: 76.85, impedance: 0 };

      /** Hand-driven session under fake timers; the caller owns useFakeTimers. */
      async function openSession(
        adapter: QnScaleAdapter,
        info: Buffer = INFO,
        frames: { ready?: Buffer; configReq?: Buffer } = { ready: READY, configReq: CONFIG_REQ },
      ): Promise<number[][]> {
        const writes: number[][] = [];
        const ctx = {
          write: async (_uuid: string, data: Buffer | number[]) => {
            writes.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile({ lastKnownWeight: 76 }),
          deviceAddress: '',
          availableChars: new Set<string>(),
        } as unknown as ConnectionContext;
        adapter.onSessionStart?.();
        await adapter.onConnected(ctx);
        adapter.parseNotification(info);
        if (frames.ready) adapter.parseNotification(frames.ready);
        if (frames.configReq) adapter.parseNotification(frames.configReq);
        await vi.advanceTimersByTimeAsync(2000);
        return writes;
      }

      it('fixtures close under the family checksum', () => {
        for (const f of [MEASURING, STABLE, END_MARKER, PART1, PART2, PART3, COMP_15, DONE_16]) {
          expect(hasValidSumChecksum(f)).toBe(true);
        }
      });

      it.each([
        ['the reporter config (qn_weight_ack on)', { qnWeightAck: true }],
        ['the default config', {}],
      ])(
        'reads the stable weight as a provisional reading and writes nothing, with %s',
        async (_name, config) => {
          vi.useFakeTimers();
          try {
            const adapter = makeAdapter();
            adapter.configure(config);
            const writes = await openSession(adapter);
            const before = writes.length;

            expect(adapter.parseNotification(MEASURING)).toBeNull();
            expect(adapter.completionHoldMs).toBeUndefined();
            const reading = adapter.parseNotification(STABLE);
            expect(reading).toEqual(WEIGHT);
            expect(adapter.completionHoldMs).toBe(NINETEEN_BYTE_RESULT_HOLD_MS);
            expect(adapter.isFinal(reading!)).toBe(false);
            expect(adapter.isComplete(reading!)).toBe(true);

            await vi.advanceTimersByTimeAsync(0);
            // No 0x1F stable ack, no A2 echo: the logged weigh-in had neither.
            expect(writes.slice(before)).toEqual([]);
          } finally {
            vi.useRealTimers();
          }
        },
      );

      it('publishes the held weight on 0x16, final, and nothing else of the weigh-in', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
        try {
          const adapter = makeAdapter();
          adapter.configure({ qnWeightAck: true });
          const writes = await openSession(adapter);
          const before = writes.length;
          warn.mockClear();

          const sequence: [string, Buffer][] = [
            ['measuring', MEASURING],
            ['stable', STABLE],
            ['marker', END_MARKER],
            ['part1', PART1],
            ['part2', PART2],
            ['part3', PART3],
            ['0x15', COMP_15],
            ['0x16', DONE_16],
          ];
          const returned: string[] = [];
          const pending: Record<string, boolean> = {};
          const readings: Record<string, ReturnType<QnScaleAdapter['parseNotification']>> = {};
          for (const [name, frame] of sequence) {
            const r = adapter.parseNotification(frame);
            if (r) returned.push(name);
            readings[name] = r;
            // Optional call: on the code before D037 the method does not exist,
            // and this test has to fail on the readings, not on a TypeError.
            pending[name] = adapter.isCompositionPending?.() === true;
          }

          expect(returned).toEqual(['stable', 'part1', '0x16']);
          expect(readings['0x16']).toEqual(WEIGHT);
          expect(adapter.isFinal(readings.stable!)).toBe(false);
          expect(adapter.isFinal(readings.part1!)).toBe(false);
          expect(adapter.isFinal(readings['0x16']!)).toBe(true);
          // Pending over the whole BIA, from the stable weight to 0x16, not only
          // across the result block: the hold only asks when its window ends.
          expect(pending).toEqual({
            measuring: false,
            stable: true,
            marker: true,
            part1: true,
            part2: true,
            part3: true,
            '0x15': true,
            '0x16': false,
          });
          // A continuation part read as a first part would trip the [2] warning.
          expect(warn).not.toHaveBeenCalled();

          await vi.advanceTimersByTimeAsync(20_000);
          expect(writes.slice(before)).toEqual([]);
        } finally {
          warn.mockRestore();
          vi.useRealTimers();
        }
      });

      // Continuation parts carry payload at [2..3] and [5..6] too, so they must be
      // skipped on the part byte before the first-part checks run. This one is
      // shaped like a stable first part in every byte those checks look at.
      it('skips a continuation part whose payload looks like a stable weight', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
        try {
          const adapter = makeAdapter();
          await openSession(adapter);
          warn.mockClear();
          adapter.parseNotification(STABLE);
          adapter.parseNotification(END_MARKER);
          adapter.parseNotification(PART1);

          // PART2 with [2..3] = 01 01 and [5..6] = 0x2000 (81.92 kg).
          const lookalike = patched(patched(PART2, 2, 0x01, 0x01), 5, 0x20, 0x00);
          expect(adapter.parseNotification(lookalike)).toBeNull();
          expect(adapter.completionHoldMs).toBe(NINETEEN_BYTE_RESULT_HOLD_MS);
          expect(warn).not.toHaveBeenCalled();
          // The weight 0x16 publishes is still the stable one.
          expect(adapter.parseNotification(DONE_16)).toEqual(WEIGHT);
        } finally {
          warn.mockRestore();
          vi.useRealTimers();
        }
      });

      // The log: `23 00 .. 00 23` read as an empty stored record, and 3 s later
      // the re-query `22 06 ff 00 03 2a` into a finished weigh-in. Per the
      // vendor's published SDK the 0x23 is the "no stored weigh-ins" answer to
      // that same 0x22.
      it('does not re-send 0x22 after the "no stored weigh-ins" answer', async () => {
        vi.useFakeTimers();
        try {
          const adapter = makeAdapter();
          adapter.configure({ qnWeightAck: true });
          const writes = await openSession(adapter);
          expect(writes.filter((w) => w[0] === 0x22)).toHaveLength(1);

          adapter.parseNotification(STABLE);
          expect(adapter.parseNotification(END_MARKER)).toBeNull();
          await vi.advanceTimersByTimeAsync(20_000);
          expect(writes.filter((w) => w[0] === 0x22)).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      // Per the vendor's published SDK only the part count in [4] decides
      // whether a 0x23 holds a stored record; with 0 parts it is the "none"
      // answer whatever else it carries. Neither it nor a 0x23 that fails its
      // checksum is answered with another 0x22, which is the same request again.
      it('reads a 0x23 with no parts as "no stored weigh-ins", without a re-query', async () => {
        vi.useFakeTimers();
        const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
        try {
          const adapter = makeAdapter();
          const writes = await openSession(adapter);
          adapter.parseNotification(STABLE);
          // The marker with one payload byte set: still 0 parts at [4].
          expect(adapter.parseNotification(patched(END_MARKER, 5, 0x01))).toBeNull();
          const lines = debug.mock.calls.map((c) => String(c[0]));
          expect(lines).toContain(
            'QN: 0x23 with no parts: the scale holds no stored weigh-ins (#331)',
          );
          await vi.advanceTimersByTimeAsync(20_000);
          expect(writes.filter((w) => w[0] === 0x22)).toHaveLength(1);
        } finally {
          debug.mockRestore();
          vi.useRealTimers();
        }
      });

      // With [1..18] all zero the sum is 0x23, so only the checksum tells
      // `23 00 .. 00 24` from the "none" answer.
      it('drops a 0x23 with a bad checksum, without a re-query', async () => {
        vi.useFakeTimers();
        const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
        try {
          const adapter = makeAdapter();
          const writes = await openSession(adapter);
          adapter.parseNotification(STABLE);
          const bad = Buffer.from(END_MARKER);
          bad[19] = 0x24;
          expect(adapter.parseNotification(bad)).toBeNull();
          const lines = debug.mock.calls.map((c) => String(c[0]));
          expect(lines.some((l) => l.includes('not a stored-record part dropped'))).toBe(true);
          await vi.advanceTimersByTimeAsync(20_000);
          expect(writes.filter((w) => w[0] === 0x22)).toHaveLength(1);
        } finally {
          debug.mockRestore();
          vi.useRealTimers();
        }
      });

      // Before the stream as well. No log shows the scale answering before it
      // measures; even so the answer is never re-queried (#331).
      it('reads the "no stored weigh-ins" answer before the stream without a re-query', async () => {
        vi.useFakeTimers();
        try {
          const adapter = makeAdapter();
          const writes = await openSession(adapter);
          expect(adapter.parseNotification(END_MARKER)).toBeNull();
          await vi.advanceTimersByTimeAsync(20_000);
          expect(writes.filter((w) => w[0] === 0x22)).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('drops a stable frame with a bad checksum', async () => {
        vi.useFakeTimers();
        try {
          const adapter = makeAdapter();
          await openSession(adapter);
          const bad = Buffer.from(STABLE);
          bad[19] ^= 0x01;
          expect(adapter.parseNotification(bad)).toBeNull();
          expect(adapter.completionHoldMs).toBeUndefined();
        } finally {
          vi.useRealTimers();
        }
      });

      it('drops a stable frame with an unknown status', async () => {
        vi.useFakeTimers();
        try {
          const adapter = makeAdapter();
          await openSession(adapter);
          expect(adapter.parseNotification(patched(STABLE, 3, 0x03))).toBeNull();
          expect(adapter.completionHoldMs).toBeUndefined();
        } finally {
          vi.useRealTimers();
        }
      });

      // [2] is the scale's user slot per the vendor's published SDK, not a unit
      // (#331): a weigh-in the scale assigned to another slot is still read.
      it('reads the weight of a weigh-in on another user slot, without a warning', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
        try {
          const adapter = makeAdapter();
          await openSession(adapter);
          const slot2 = patched(STABLE, 2, 0x02);
          const reading = adapter.parseNotification(slot2);
          expect(reading).toEqual(WEIGHT);
          expect(adapter.isFinal(reading!)).toBe(false);
          expect(adapter.completionHoldMs).toBe(NINETEEN_BYTE_RESULT_HOLD_MS);
          expect(warn).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
          vi.useRealTimers();
        }
      });

      // Same bounds as the extended result frames: exclusive, so 5.00 kg is out.
      it.each([
        ['2.56 kg', 0x0100, null],
        ['5.00 kg', 0x01f4, null],
        ['5.01 kg', 0x01f5, { weight: 5.01, impedance: 0 }],
      ])('reads a stable %s frame as %j', async (_name, raw, expected) => {
        vi.useFakeTimers();
        try {
          const adapter = makeAdapter();
          await openSession(adapter);
          const frame = patched(STABLE, 5, raw >> 8, raw & 0xff);
          expect(adapter.parseNotification(frame)).toEqual(expected);
        } finally {
          vi.useRealTimers();
        }
      });

      it.each([
        ['index 0', 0x10],
        ['index past the count', 0x12],
        ['a count of 0', 0x01],
      ])('drops a stable frame whose part byte has %s', async (_name, part) => {
        vi.useFakeTimers();
        const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
        try {
          const adapter = makeAdapter();
          await openSession(adapter);
          expect(adapter.parseNotification(patched(STABLE, 4, part))).toBeNull();
          expect(adapter.completionHoldMs).toBeUndefined();
          // Index past the count would otherwise pass as a continuation part,
          // also null, so the line is what tells the guard apart.
          const lines = debug.mock.calls.map((c) => String(c[0]));
          const byte = part.toString(16).padStart(2, '0');
          expect(lines).toContain(`QN: 20-byte frame with part byte 0x${byte} dropped (#331)`);
        } finally {
          debug.mockRestore();
          vi.useRealTimers();
        }
      });

      it('publishes nothing on a 0x16 that follows no stable weight', async () => {
        vi.useFakeTimers();
        try {
          const adapter = makeAdapter();
          await openSession(adapter);
          adapter.parseNotification(MEASURING);
          expect(adapter.parseNotification(DONE_16)).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it('starts the next session with nothing held', async () => {
        vi.useFakeTimers();
        try {
          const adapter = makeAdapter();
          await openSession(adapter);
          adapter.parseNotification(STABLE);
          adapter.onSessionEnd();
          adapter.onSessionStart();
          expect(adapter.completionHoldMs).toBeUndefined();
          expect(adapter.isCompositionPending()).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      // Scope: every other dialect, and the 19-byte one without a stream, stays
      // as it was. These pass on the code before D037 as well.
      // With ble.qn_result_ack as well: it is for the 19-byte stream only.
      describe.each([
        ['by default', {}],
        ['with ble.qn_result_ack', { qnResultAck: true }],
      ])('other dialects are untouched, %s', (_label, config: AdapterRuntimeConfig) => {
        it('extended: a GE-shaped stable 20-byte frame is still not read or answered', async () => {
          const adapter = makeAdapter();
          adapter.configure(config);
          const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
          const before = writes.length;
          // GE_LIVE (#235) with [3] 00 -> 01 and its checksum recomputed.
          expect(adapter.parseNotification(patched(GE_LIVE, 3, 0x01))).toBeNull();
          await Promise.resolve();
          expect(writes.slice(before)).toEqual([]);
          expect(adapter.completionHoldMs).toBeUndefined();
        });

        it('18-byte es26m: the barefoot frame still reads weight and impedance at once', async () => {
          const adapter = makeAdapter();
          adapter.configure(config);
          await driveHandshake(adapter, makeEs26mScaleInfo());
          const reading = adapter.parseNotification(
            hex('10 0e ff 01 02 26 39 01 f5 01 f3 01 34 9e'),
          );
          expect(reading).not.toBeNull();
          expect(reading!.weight).toBeCloseTo(97.85);
          expect(reading!.impedance).toBe(501);
          expect(adapter.completionHoldMs).toBeUndefined();
          // As waitForRawReading asks it; before D037 the method did not exist.
          const final = adapter.isFinal ? adapter.isFinal(reading!) : true;
          expect(final).toBe(true);
        });

        it('18-byte es26m: the 0x23 marker shape still triggers the re-query', async () => {
          vi.useFakeTimers();
          try {
            const adapter = makeAdapter();
            adapter.configure(config);
            const writes = await openSession(adapter, makeEs26mScaleInfo(), {});
            const starts = writes.filter((w) => w[0] === 0x22).length;
            expect(adapter.parseNotification(END_MARKER)).toBeNull();
            await vi.advanceTimersByTimeAsync(3000);
            expect(writes.filter((w) => w[0] === 0x22)).toHaveLength(starts + 1);
          } finally {
            vi.useRealTimers();
          }
        });

        it.each([
          ['classic', 'classic'],
          ['19-byte with no 20-byte stream', '19'],
        ])('%s: 0x15 and 0x16 still reach the ignore branch', (_name, which) => {
          const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
          try {
            const adapter = makeAdapter();
            adapter.configure(config);
            adapter.onSessionStart();
            if (which === 'classic') {
              const info = Buffer.alloc(11);
              info[0] = 0x12;
              info[2] = 0xab;
              info[10] = 1;
              adapter.parseNotification(info);
            } else {
              adapter.parseNotification(INFO);
            }
            expect(adapter.parseNotification(COMP_15)).toBeNull();
            expect(adapter.parseNotification(DONE_16)).toBeNull();
            const ignored = debug.mock.calls
              .map((c) => String(c[0]))
              .filter((l) => l.startsWith('QN: ignoring frame'));
            expect(ignored).toEqual([
              `QN: ignoring frame opcode=0x15 len=16 hex=${COMP_15.toString('hex')}`,
              `QN: ignoring frame opcode=0x16 len=16 hex=${DONE_16.toString('hex')}`,
            ]);
          } finally {
            debug.mockRestore();
          }
        });
      });
    });

    // Every anchor frame a capture shows, rebuilt from its weight. 74.05 and
    // 71.85 sit on the Math.round boundary (7404.999... and 7184.999...).
    it('rebuilds the captured anchor frames byte for byte', () => {
      // #331 Android btsnoop, 2026-09-29.
      expect(buildMeasurementTrigger(74.05)).toEqual([0xa2, 0x06, 0x01, 0x1c, 0xed, 0xb2]);
      // #75 Android btsnoop of the same unit, a month earlier.
      expect(buildMeasurementTrigger(71.85)).toEqual([0xa2, 0x06, 0x01, 0x1c, 0x11, 0xd6]);
      // #331 iOS transcript.
      expect(buildMeasurementTrigger(88.45)).toEqual([0xa2, 0x06, 0x01, 0x22, 0x8d, 0x58]);
    });

    it('rounds the anchor to the nearest 10 g and keeps the frame well formed', () => {
      expect(buildMeasurementTrigger(76.004)).toEqual([0xa2, 0x06, 0x01, 0x1d, 0xb0, 0x76]);
      expect(buildMeasurementTrigger(76.006)).toEqual([0xa2, 0x06, 0x01, 0x1d, 0xb1, 0x77]);
    });

    it('clamps an out-of-range anchor instead of emitting a malformed frame', () => {
      const huge = buildMeasurementTrigger(10_000);
      expect(huge).toEqual([0xa2, 0x06, 0x01, 0xff, 0xff, 0xa7]);
      const negative = buildMeasurementTrigger(-5);
      expect(negative).toEqual([0xa2, 0x06, 0x01, 0x00, 0x00, 0xa9]);
      for (const t of [huge, negative]) {
        expect(t[5]).toBe(t.slice(0, 5).reduce((a, b) => a + b, 0) & 0xff);
      }
    });

    // #320: the nameless fallback keys on serviceUuids, so it can claim a
    // 1byone/Eufy device on a transport that delivers no local name. That shape
    // has no QN write characteristic at all, so the handshake cannot work and
    // the session used to end in two failed writes explaining nothing.
    it('warns when the discovered characteristics are the 1byone layout', async () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      try {
        const adapter = makeAdapter();
        await adapter.onConnected({
          write: async () => {},
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile(),
          deviceAddress: '',
          // fff1 + fff4, never fff2: the 1byone signature.
          availableChars: new Set([uuid16(0xfff1), uuid16(0xfff4)]),
        } as unknown as ConnectionContext);
        const msg = warn.mock.calls.flat().join(' ');
        expect(msg).toContain('1byone/Eufy layout');
        expect(msg).toContain('#320');
      } finally {
        warn.mockRestore();
      }
    });

    it('does not warn about the 1byone layout when a QN write characteristic exists', async () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      try {
        const adapter = makeAdapter();
        await adapter.onConnected({
          write: async () => {},
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile(),
          deviceAddress: '',
          // A genuine QN scale that also exposes fff4 keeps its own fff2.
          availableChars: new Set([uuid16(0xfff1), uuid16(0xfff2), uuid16(0xfff4)]),
        } as unknown as ConnectionContext);
        expect(warn.mock.calls.flat().join(' ')).not.toContain('1byone/Eufy layout');
      } finally {
        warn.mockRestore();
      }
    });

    it('does not send the trigger on the ES-26M dialect', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeEs26mScaleInfo());
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(writes.slice(startIndex + 1).filter((w) => w[0] === 0xa2)).toHaveLength(0);
    });

    it('does not send the trigger on the classic dialect', async () => {
      const adapter = makeAdapter();
      const info = Buffer.alloc(11);
      info[0] = 0x12;
      info[2] = 0xab;
      info[10] = 1;
      const writes = await driveHandshake(adapter, info);
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(writes.slice(startIndex + 1).filter((w) => w[0] === 0xa2)).toHaveLength(0);
    });

    // The trigger is a different frame from the A2 user profile sent at ready
    // time, so the profile must still go out exactly once, before START.
    it('keeps the ready-time A2 user profile distinct from the trigger', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      const beforeStart = writes.slice(0, startIndex).filter((w) => w[0] === 0xa2);
      expect(beforeStart).toHaveLength(1);
      expect(beforeStart[0][3]).toBe(0x32);
      expect(beforeStart[0][4]).toBe(30); // defaultProfile age
    });

    it('keeps the long-frame impedance grace path on the extended dialect', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(makeExtendedScaleInfo());
      const stableNoImpedance = Buffer.alloc(14);
      stableNoImpedance[0] = 0x10;
      stableNoImpedance[1] = 0x0e;
      stableNoImpedance[2] = 0xff;
      stableNoImpedance[3] = 0x01;
      stableNoImpedance[4] = 0x02;
      stableNoImpedance.writeUInt16BE(9790, 5);
      // First stable R1=R2=0 frame only starts the grace timer.
      expect(adapter.parseNotification(stableNoImpedance)).toBeNull();
      (adapter as unknown as { firstStableNoImpedanceAt: number }).firstStableNoImpedanceAt =
        Date.now() - 2000;
      const reading = adapter.parseNotification(stableNoImpedance);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(97.9);
      expect(reading!.impedance).toBe(0);
    });
  });
});

describe('QN per-session reset ordering (#406)', () => {
  it('clears the previous session before any frame can be parsed', () => {
    const adapter = new QnScaleAdapter();
    // Session 1 learns a long-frame dialect and a protocol byte from its own
    // scale-info frame.
    adapter.onSessionStart?.();
    // A 19-byte 0x12 scale-info frame from an Arboleaf capture: it is what
    // switches the adapter onto the long-frame dialect.
    adapter.parseNotification(
      Buffer.from([
        0x12, 0x13, 0xff, 0x54, 0x0b, 0x04, 0x00, 0x07, 0xff, 0x15, 0x0f, 0x27, 0x00, 0x02, 0x05,
        0x03, 0xe0, 0x6f, 0x31,
      ]),
    );
    const first = adapter as unknown as {
      seenProtocolType: number;
      isLongFrameVariant: boolean;
      configSent: boolean;
      weightScaleFactor: number;
    };
    expect(first.isLongFrameVariant).toBe(true);

    adapter.onSessionEnd?.();
    // Session 2 starts. onConnected has NOT run yet, which is the real
    // ordering: subscribeAndInit enables every notify binding before it awaits
    // init, so a frame can arrive in this window.
    adapter.onSessionStart?.();

    expect(first.isLongFrameVariant).toBe(false);
    expect(first.configSent).toBe(false);
    expect(first.weightScaleFactor).toBe(100);
  });

  // The test above checks three fields. This one covers every instance field
  // that is not configuration or a session-boundary value, so a reset dropped
  // from onSessionStart, or a new per-session field added without one, fails
  // here by name. A field that genuinely must survive a session belongs in
  // SURVIVES, with the reason next to it.
  it('resets every per-session field to its constructor value', () => {
    const SURVIVES = new Set([
      // Identity and wiring, fixed for the instance.
      'name',
      'match',
      'charNotifyUuid',
      'charWriteUuid',
      'altCharNotifyUuid',
      'altCharWriteUuid',
      'normalizesWeight',
      // Configuration from configure(), not session state.
      'displayUnit',
      'forcedProtocolType',
      'forcedReportByte',
      'forcedWeightAck',
      'forcedUserKey',
      'a4PreludeEnabled',
      'configLong',
      'timeSyncLong',
      'forcedResultAck',
      'userWeights',
      // Session-boundary values: set by onConnected / onSessionEnd, bumped
      // rather than reset, re-stamped with the current time, or replaced by a
      // fresh promise that cannot equal the constructor's.
      'ctx',
      'sessionGeneration',
      'sessionStartedScaleSeconds',
      'ae01Chain',
      // Keyed by reading object; an earlier session's reading is never handed
      // back, so there is nothing to clear (#331).
      'provisionalReadings',
      // What a later session's stored records and result blocks are compared
      // with: the newest stored weigh-in reported and the recent live results
      // (#331).
      'storedMark',
      'recentLiveResults',
      // Keyed by reading, like provisionalReadings.
      'scaleComposition',
    ]);
    vi.useFakeTimers();
    try {
      const fresh = new QnScaleAdapter() as unknown as Record<string, unknown>;
      const used = new QnScaleAdapter() as unknown as Record<string, unknown>;
      const perSession = Object.keys(fresh).filter((k) => !SURVIVES.has(k));
      // Guards the filter itself: if these vanished, the loop below would
      // silently check nothing.
      expect(perSession).toEqual(
        expect.arrayContaining([
          'seenProtocolType',
          'weightScaleFactor',
          'isExtendedLongFrame',
          'extendedResultEmitted',
          'historyResponseSent',
          'timeSyncSent',
          'firstStableNoImpedanceAt',
          'fallbackTimer',
          'storedRetryTimer',
        ]),
      );

      // Dirty every per-session field with a value its constructor never has.
      for (const key of perSession) {
        const v = fresh[key];
        if (key.endsWith('Timer')) used[key] = setTimeout(() => {}, 60_000);
        else if (typeof v === 'boolean') used[key] = !v;
        else if (typeof v === 'number') used[key] = v + 7;
        else if (v === null) used[key] = key === 'ae02Subscribe' ? Promise.resolve(true) : 12345;
        else if (v instanceof Set) used[key] = new Set([7]);
        else if (Array.isArray(v)) used[key] = [7];
        else throw new Error(`no dirty value for field ${key} (${typeof v}); extend this test`);
      }

      (used as unknown as QnScaleAdapter).onSessionStart();

      for (const key of perSession) {
        expect({ [key]: used[key] }).toEqual({ [key]: fresh[key] });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildUserProfileFrame (#331)', () => {
  // Both vendor-app captures, different apps and scales (#331, #235).
  it('reproduces the GE and Arboleaf app profile frames', () => {
    expect(buildUserProfileFrame(51, 182)).toEqual([
      0xa0, 0x0d, 0x02, 0x01, 0x03, 0xe8, 0x00, 0x33, 0x07, 0x1c, 0x04, 0x02, 0xf7,
    ]);
    expect(buildUserProfileFrame(26, 193)).toEqual([
      0xa0, 0x0d, 0x02, 0x01, 0x03, 0xe8, 0x00, 0x1a, 0x07, 0x8a, 0x04, 0x02, 0x4c,
    ]);
  });

  // [6] is the sex per the vendor's published SDK (0 male, 1 female). Both
  // captures are of men; before #331 every profile went out as male.
  it('sends the sex at [6], 0 for male and 1 for female', () => {
    const male = buildUserProfileFrame(51, 182, 'male');
    expect(male).toEqual(buildUserProfileFrame(51, 182));
    const female = buildUserProfileFrame(51, 182, 'female');
    expect(female[6]).toBe(0x01);
    expect(female.slice(0, 6)).toEqual(male.slice(0, 6));
    expect(female.slice(7, 12)).toEqual(male.slice(7, 12));
    expect(female[12]).toBe((male[12] + 1) & 0xff);
  });

  it('rounds the height to whole millimetres and clamps the age to a byte', () => {
    const f = buildUserProfileFrame(300, 182.04);
    expect(f[7]).toBe(0xff);
    expect([f[8], f[9]]).toEqual([0x07, 0x1c]);
  });

  it("falls back to openScale's age and height for a non-finite input", () => {
    const f = buildUserProfileFrame(Number.NaN, Number.POSITIVE_INFINITY);
    expect(f[7]).toBe(33);
    expect((f[8] << 8) | f[9]).toBe(1720);
  });

  // [4..5] is the user key (#463). openScale's constant frame is this builder
  // with key 8 and openScale's own profile, byte for byte.
  it("builds openScale's constant frame from key 8 and its profile", () => {
    expect(buildUserProfileFrame(33, 172, 'male', { key: 0x0008 })).toEqual([
      0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 0x21, 0x06, 0xb8, 0x04, 0x02, 0x9d,
    ]);
    expect(buildUserProfileFrame(51, 182, 'male', { key: 1234 }).slice(4, 6)).toEqual([0x04, 0xd2]);
  });

  // Derived from the GE capture, not captured: the vendor's published SDK adds
  // 10 to the algorithm byte for an athlete (4 -> 14), and that is the only
  // byte that moves besides the checksum.
  it('adds 10 to the algorithm byte for an athlete', () => {
    const ge = [0xa0, 0x0d, 0x02, 0x01, 0x03, 0xe8, 0x00, 0x1a, 0x07, 0x8a, 0x04, 0x02, 0x4c];
    expect(buildUserProfileFrame(26, 193, 'male', { athlete: false })).toEqual(ge);
    expect(buildUserProfileFrame(26, 193, 'male', { athlete: true })).toEqual([
      0xa0, 0x0d, 0x02, 0x01, 0x03, 0xe8, 0x00, 0x1a, 0x07, 0x8a, 0x0e, 0x02, 0x56,
    ]);
  });
});

// #461: a Physiq (QN-Scale, 18-byte es26m) that delivered its weigh-in as a
// 0x23 stored record. Every frame below is byte for byte from the reporter's
// public DEBUG log (node-ble); the address is the one the log shows.
describe('QN stored record and impedance (#461)', () => {
  const RECORD_461 = Buffer.from([
    0x23, 0x14, 0xff, 0x01, 0x01, 0xf0, 0x87, 0xc0, 0x5c, 0x32, 0x1b, 0xfd, 0x10, 0xcf, 0x10, 0xcd,
    0x00, 0x00, 0x00, 0xd1,
  ]);
  const EMPTY_461 = Buffer.from([0x23, 0x14, 0xff, ...new Array<number>(16).fill(0), 0x36]);
  /** Connect time in the log; the record is stamped 09:23:19. */
  const CONNECTED_461 = '2026-10-10T09:23:02.077Z';

  /** #283, the 0x23 its classic scale (INFO_283) answered with. */
  const RECORD_283 = Buffer.from([
    0x23, 0x13, 0xff, 0x04, 0x01, 0x09, 0x11, 0xef, 0x31, 0x18, 0x1a, 0x01, 0xfc, 0x01, 0xf8, 0x00,
    0x00, 0x00, 0x9c,
  ]);

  interface SessionOptions {
    now: string;
    deviceAddress?: string;
    manufacturerData?: { id: number; data: Buffer };
  }

  /**
   * One session in transport order (onSessionStart, onConnected, frames), with
   * every write collected. Returns the last reading the frames produced.
   */
  async function runSession(
    adapter: QnScaleAdapter,
    frames: Buffer[],
    opts: SessionOptions,
    writes: number[][] = [],
  ) {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(opts.now));
      const ctx = {
        write: async (_uuid: string, data: Buffer | number[]) => {
          writes.push([...data]);
        },
        read: async () => Buffer.alloc(0),
        subscribe: async () => {},
        profile: defaultProfile(),
        deviceAddress: opts.deviceAddress ?? '',
        availableChars: new Set<string>(),
        ...(opts.manufacturerData ? { manufacturerData: opts.manufacturerData } : {}),
      } as unknown as ConnectionContext;
      adapter.onSessionStart?.();
      await adapter.onConnected(ctx);
      let reading = null;
      for (const frame of frames) {
        reading = adapter.parseNotification(frame) ?? reading;
        await vi.advanceTimersByTimeAsync(100);
      }
      return reading;
    } finally {
      vi.useRealTimers();
    }
  }

  describe('decodeStoredRecord', () => {
    it('reads both resistances big-endian at [12..13] and [14..15]', () => {
      expect(decodeStoredRecord(RECORD_461)).toEqual({
        weight: 71.65,
        recordSeconds: 844939399,
        r50: 4303,
        r500: 4301,
      });
    });

    it('needs at least 16 bytes', () => {
      expect(decodeStoredRecord(RECORD_461.subarray(0, 15))).toBeNull();
    });
  });

  it('reads the #461 record without an advertisement as the raw R50', async () => {
    const reading = await runSession(makeAdapter(), [INFO_461, RECORD_461], {
      now: CONNECTED_461,
    });
    expect(reading).toEqual({ weight: 71.65, impedance: 4303 });
  });

  it('still re-queries after the empty record #461 sent first', async () => {
    const writes: number[][] = [];
    const adapter = makeAdapter();
    await runSession(adapter, [INFO_461], { now: CONNECTED_461 }, writes);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-10T09:23:05.302Z'));
      writes.length = 0;
      expect(adapter.parseNotification(EMPTY_461)).toBeNull();
      await vi.advanceTimersByTimeAsync(3000);
      expect(writes.filter((w) => w[0] === 0x22)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A classic scale's 0x23 has its own layout; the session that saw its short
  // 0x12 keeps reading it exactly as before, which drops this one as stale.
  it('leaves a classic session alone (#283)', async () => {
    const reading = await runSession(makeAdapter(), [INFO_283, RECORD_283], {
      now: '2026-07-19T04:37:40Z',
    });
    expect(reading).toBeNull();
  });

  // The scrambled impedance. The #461 advertisement sets the flag; the #75
  // Renpho Elis 1 advertisement (bluetoothctl dump in #75) is the same model
  // family with it clear, and that unit sends ~505 ohm as it is.
  const ADVERT_461 = {
    id: 0xffff,
    data: Buffer.from([
      0x08, 0x14, 0x01, 0x00, 0x00, 0x25, 0xe0, 0x16, 0x00, 0x05, 0xff, 0x61, 0x08, 0x01, 0x00,
      0x15,
    ]),
  };
  const ADDRESS_461 = 'FF050016E025';
  const ADVERT_ELIS1 = {
    id: 0xffff,
    data: Buffer.from([
      0x09, 0x5b, 0x01, 0x00, 0x00, 0x1a, 0x9a, 0x0e, 0x00, 0x04, 0xff, 0x60, 0x08, 0x00, 0x00,
      0x01,
    ]),
  };
  const ADDRESS_ELIS1 = 'FF04000E9A1A';
  /** The maintainer's classic unit: 11 bytes, no marker at [11]. */
  const ADVERT_CLASSIC = {
    id: 0xffff,
    data: Buffer.from([0x05, 0x5d, 0x00, 0x00, 0x00, 0x04, 0xa1, 0x13, 0x00, 0x03, 0xff]),
  };

  describe('decryptQnResistance', () => {
    it('unscrambles the #461 values to a body resistance', () => {
      expect(decryptQnResistance(0x10cf)).toBe(502); // 4303, the record's R50
      expect(decryptQnResistance(0x10cd)).toBe(500); // 4301, its R500
      expect(decryptQnResistance(0x10dd)).toBe(501); // 4317, the reporter's earlier reading
    });

    it('is its own inverse for every byte', () => {
      for (let b = 0; b < 256; b++) {
        const v = (b << 8) | b;
        expect(decryptQnResistance(decryptQnResistance(v))).toBe(v);
      }
    });
  });

  describe('qnAdvertTraits', () => {
    it('reads model 129 with the scrambled flag from the #461 advertisement', () => {
      expect(qnAdvertTraits(ADVERT_461, ADDRESS_461)).toEqual({ category: 129, scrambled: true });
    });

    it('reads model 128 without the flag from the #75 Elis 1 advertisement', () => {
      expect(qnAdvertTraits(ADVERT_ELIS1, ADDRESS_ELIS1)).toEqual({
        category: 128,
        scrambled: false,
      });
    });

    it('finds no marker in the 11-byte classic advertisement', () => {
      expect(qnAdvertTraits(ADVERT_CLASSIC, 'FF030013A104')).toEqual({
        category: null,
        scrambled: false,
      });
    });

    it('ignores an advertisement whose MAC is not the connected device', () => {
      expect(qnAdvertTraits(ADVERT_461, ADDRESS_ELIS1)).toBeNull();
    });

    it('skips the MAC check when the transport has no address', () => {
      expect(qnAdvertTraits(ADVERT_461, '')).toEqual({ category: 129, scrambled: true });
    });

    it('ignores a company id the vendor SDK does not use', () => {
      expect(qnAdvertTraits({ ...ADVERT_461, id: 0x1a10 }, ADDRESS_461)).toBeNull();
      expect(qnAdvertTraits({ ...ADVERT_461, id: 0x01a8 }, ADDRESS_461)).toEqual({
        category: 129,
        scrambled: true,
      });
    });

    it('needs manufacturer data', () => {
      expect(qnAdvertTraits(undefined, ADDRESS_461)).toBeNull();
    });
  });

  it('unscrambles the #461 record when its advertisement says so', async () => {
    const reading = await runSession(makeAdapter(), [INFO_461, RECORD_461], {
      now: CONNECTED_461,
      deviceAddress: ADDRESS_461,
      manufacturerData: ADVERT_461,
    });
    expect(reading).toEqual({ weight: 71.65, impedance: 502 });
  });

  it('does not carry the flag into the next session', async () => {
    const adapter = makeAdapter();
    await runSession(adapter, [INFO_461], {
      now: CONNECTED_461,
      deviceAddress: ADDRESS_461,
      manufacturerData: ADVERT_461,
    });
    const reading = await runSession(adapter, [INFO_461, RECORD_461], { now: CONNECTED_461 });
    expect(reading).toEqual({ weight: 71.65, impedance: 4303 });
  });

  it('leaves the record as sent when the advertisement belongs to another device', async () => {
    const reading = await runSession(makeAdapter(), [INFO_461, RECORD_461], {
      now: CONNECTED_461,
      deviceAddress: ADDRESS_ELIS1,
      manufacturerData: ADVERT_461,
    });
    expect(reading).toEqual({ weight: 71.65, impedance: 4303 });
  });

  it('leaves a classic session alone with its 11-byte advertisement too', async () => {
    const reading = await runSession(makeAdapter(), [INFO_283, RECORD_283], {
      now: '2026-07-19T04:37:40Z',
      deviceAddress: 'FF030013A104',
      manufacturerData: ADVERT_CLASSIC,
    });
    expect(reading).toBeNull();
  });

  // Live 0x10 path. No live frame from the #461 unit exists, so this pairs its
  // advertisement (address check skipped) with a real live frame from another
  // unit (#253, R 501 sent as is): it checks the wiring and the refutation
  // warning, not a value.
  describe('live frame', () => {
    const INFO_253 = Buffer.from([
      0x12, 0x12, 0xff, 0xcb, 0x89, 0x04, 0x00, 0x04, 0xff, 0x01, 0x17, 0x09, 0x00, 0x00, 0x05,
      0x9f, 0x30, 0x73,
    ]);
    const LIVE_253 = Buffer.from([
      0x10, 0x0e, 0xff, 0x01, 0x02, 0x21, 0x20, 0x01, 0xf5, 0x01, 0xf3, 0x00, 0xf1, 0x3c,
    ]);

    it('reads it as sent without the flag', async () => {
      const reading = await runSession(makeAdapter(), [INFO_253, LIVE_253], {
        now: '2026-07-10T13:28:40Z',
      });
      expect(reading).toEqual({ weight: 84.8, impedance: 501 });
    });

    it('unscrambles it with the flag, and warns once that the result is not a body', async () => {
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      try {
        const reading = await runSession(makeAdapter(), [INFO_253, LIVE_253, LIVE_253], {
          now: '2026-07-10T13:28:40Z',
          manufacturerData: ADVERT_461,
        });
        expect(reading).toEqual({ weight: 84.8, impedance: 4317 });
        const notABody = warn.mock.calls.filter((c) => String(c[0]).includes('not a body'));
        expect(notABody).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('treats an unscrambled 0xffff as no contact', async () => {
      // Synthetic: the #253 frame with R50 overwritten (checksum left stale,
      // this branch does not check it). No scale in our logs sent 0xffff; the
      // 60000 cut-off is the vendor SDK's.
      const noContact = Buffer.from(LIVE_253);
      noContact.writeUInt16BE(0xffff, 7);
      const reading = await runSession(makeAdapter(), [INFO_253, noContact], {
        now: '2026-07-10T13:28:40Z',
        manufacturerData: ADVERT_461,
      });
      // R1 reads as 0 (no contact) after unscrambling.
      expect(reading).toEqual({ weight: 84.8, impedance: 0 });
    });
  });

  // #463: the Physiq's first connection after step 3 of the reporter's test,
  // from the public DEBUG log of 2026-10-16. The record in it is a weigh-in
  // the scale kept from 259 s before the session (2026-10-13T17:59:38Z, user
  // slot 1). Frames are from that log; where a frame carries the scale's own
  // body fat (0x23 [16..17], live 0x10 [11..12]) those two bytes are zeroed
  // and the checksum recomputed. Nothing here reads them.
  describe('18-byte stored weigh-in from before the session (#463)', () => {
    const INFO_463 = Buffer.from([
      0x12, 0x12, 0xff, 0x25, 0xe0, 0x16, 0x00, 0x05, 0xff, 0x13, 0x07, 0x16, 0x00, 0x01, 0x05,
      0x9f, 0x32, 0x49,
    ]);
    const VISIT_OK_463 = Buffer.from([0xa1, 0x06, 0x02, 0x01, 0x01, 0xab]);
    const MEASURING_463 = Buffer.from([
      0x10, 0x0f, 0xff, 0x01, 0x01, 0x1b, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x33,
    ]);
    /** 71.55 kg at 2026-10-13T17:59:38Z, slot 1; [16..17] zeroed, [19] recomputed. */
    const RECORD_463 = Buffer.from([
      0x23, 0x14, 0xff, 0x01, 0x01, 0x01, 0x0a, 0x2e, 0x61, 0x32, 0x1b, 0xf3, 0x10, 0xd9, 0x10,
      0xfe, 0x00, 0x00, 0x00, 0x09,
    ]);
    /** The live result after it, 71.60 kg / 507 Ohm; [11..12] zeroed, [14] recomputed. */
    const LIVE_463 = Buffer.from([
      0x10, 0x0f, 0xff, 0x01, 0x02, 0x1b, 0xf8, 0x10, 0xfb, 0x10, 0xf9, 0x00, 0x00, 0x00, 0x48,
    ]);
    const ADVERT_463 = {
      id: 0xffff,
      data: Buffer.from([
        0x08, 0x14, 0x01, 0x00, 0x01, 0x25, 0xe0, 0x16, 0x00, 0x05, 0xff, 0x61, 0x08, 0x01, 0x00,
        0x15,
      ]),
    };
    /** Session start in the log (onSessionStart), 259 s after the record. */
    const STARTED_463 = '2026-10-13T18:03:57.411Z';
    /** Real 20-byte 0x12 from a GE CS 10 G (#235), as makeExtendedScaleInfo. */
    const INFO_235 = Buffer.from([
      0x12, 0x14, 0xff, 0x4e, 0xc7, 0x0e, 0x00, 0x07, 0xff, 0x14, 0x0f, 0x42, 0x00, 0x08, 0x05,
      0x03, 0xe0, 0x6f, 0x2b, 0x3d,
    ]);

    /** A frame to feed, or a number of milliseconds to let pass. */
    type Step = Buffer | number;

    /**
     * One session in transport order, frames 100 ms apart unless a number
     * says otherwise, ended with onSessionEnd. Collects every reading, every
     * write and every debug and info line.
     */
    async function session(
      adapter: QnScaleAdapter,
      steps: Step[],
      now: string,
      advert: { id: number; data: Buffer } | null = ADVERT_463,
    ) {
      const writes: number[][] = [];
      const readings: ScaleReading[] = [];
      const lines: string[] = [];
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation((m) => void lines.push(m));
      const info = vi.spyOn(bleLog, 'info').mockImplementation((m) => void lines.push(m));
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(now));
        const ctx = {
          write: async (_uuid: string, data: Buffer | number[]) => {
            writes.push([...data]);
          },
          read: async () => Buffer.alloc(0),
          subscribe: async () => {},
          profile: defaultProfile(),
          deviceAddress: ADDRESS_461,
          availableChars: new Set<string>(),
          ...(advert ? { manufacturerData: advert } : {}),
        } as unknown as ConnectionContext;
        adapter.onSessionStart?.();
        await adapter.onConnected(ctx);
        for (const step of steps) {
          if (typeof step === 'number') {
            await vi.advanceTimersByTimeAsync(step);
            continue;
          }
          const reading = adapter.parseNotification(step);
          if (reading) readings.push(reading);
          await vi.advanceTimersByTimeAsync(100);
        }
        adapter.onSessionEnd?.();
        return { readings, writes, lines };
      } finally {
        vi.useRealTimers();
        debug.mockRestore();
        info.mockRestore();
      }
    }

    // The other dialects keep dropping such a record; the line says why. The
    // 20-byte case pairs the GE CS 10 G's 0x12 with the #463 record, which no
    // log shows together: it checks the wiring of the line, not a decode.
    it.each([
      [
        'classic (#283)',
        [INFO_283, RECORD_283],
        '2026-07-19T04:37:40Z',
        '0x23 on the classic dialect is not decoded (#461 S3), not read: [23 13 ff 04',
      ],
      [
        'without a scale-info frame (#461)',
        [RECORD_461],
        '2026-10-10T09:30:00Z',
        '0x23 in a session without a scale-info frame, not read: [23 14 ff 01 01 f0',
      ],
      [
        '20-byte extended',
        [INFO_235, RECORD_463],
        '2026-10-13T18:09:00Z',
        'stored weigh-in 71.55 kg at 2026-10-13T17:59:38.000Z, user slot 1, is 562 s older ' +
          'than this session (window 90 s), not read',
      ],
    ])(
      'logs why it does not read an old record on the %s dialect',
      async (_label, frames, now, needle) => {
        const { readings, lines } = await session(makeAdapter(), frames, now, null);
        expect(readings).toEqual([]);
        const line = lines.find((l) => l.startsWith('QN: 0x23') || l.startsWith('QN: stored'));
        expect(line ?? '(no line)').toContain(needle);
      },
    );

    it('does not read VA values into the classic line', async () => {
      const { lines } = await session(
        makeAdapter(),
        [INFO_283, RECORD_283],
        '2026-07-19T04:37:40Z',
        null,
      );
      const line = lines.find((l) => l.includes('classic dialect is not decoded'));
      expect(line).toBeDefined();
      expect(line).not.toContain('kg');
    });

    it('names the reason, not an age, for an out-of-range record without a 0x12 (#461)', async () => {
      // The empty record #461 sent first, here without its 0x12 before it.
      const { lines } = await session(makeAdapter(), [EMPTY_461], '2026-10-10T09:23:05.302Z', null);
      const line = lines.find((l) => l.includes('without a scale-info frame')) ?? '(no line)';
      expect(line).toContain(
        'read as the VA layout it is 0 kg at 2000-01-01T00:00:00.000Z, out of range',
      );
      expect(line).not.toContain('before the session');
    });

    it('says the scale holds no stored weigh-ins when the 0x23 count is 0 (#461)', async () => {
      // The empty record #461 sent first, after its own 0x12.
      const { lines } = await session(
        makeAdapter(),
        [INFO_461, EMPTY_461],
        '2026-10-10T09:23:05.302Z',
      );
      expect(lines).toContain('QN: 0x23 says the scale holds no stored weigh-ins (#463)');
    });

    describe('with ble.qn_user_key (D065)', () => {
      /** The #463 handshake up to and past our 0x22, as in the log. */
      const HANDSHAKE: Step[] = [INFO_463, READY_461, CONFIG_REQ_461, VISIT_OK_463, 1000];
      /** The record as the reading it must become. */
      const STORED: ScaleReading = {
        weight: 71.55,
        impedance: 497,
        timestamp: new Date('2026-10-13T17:59:38.000Z'),
        fromMemory: true,
      };
      const keyed = (): QnScaleAdapter => {
        const adapter = makeAdapter();
        adapter.configure({ qnUserKey: 1000 });
        return adapter;
      };

      // The session time is chosen (562 s after the record); the frames are real.
      it('reports a record from minutes before the session as history with its own time', async () => {
        const { readings, lines } = await session(
          keyed(),
          [...HANDSHAKE, MEASURING_463, RECORD_463],
          '2026-10-13T18:09:00Z',
        );
        expect(readings).toEqual([STORED]);
        expect(lines).toContain(
          'QN: stored weigh-in 71.55 kg at 2026-10-13T17:59:38.000Z, user slot 1, record 1 of 1, ' +
            'reported as history (#463)',
        );
      });

      it('reports the #463 record from 259 s before the session as history, too', async () => {
        const { readings } = await session(
          keyed(),
          [...HANDSHAKE, MEASURING_463, RECORD_463],
          STARTED_463,
        );
        expect(readings).toEqual([STORED]);
      });

      it('reports it once: not in the next session, nor after a restart that kept the mark', async () => {
        const adapter = keyed();
        await session(adapter, [...HANDSHAKE, RECORD_463], '2026-10-13T18:09:00Z');
        expect(adapter.dedupMark()).toBe(845229578);

        const next = await session(adapter, [...HANDSHAKE, RECORD_463], '2026-10-13T18:20:00Z');
        expect(next.readings).toEqual([]);
        expect(next.lines).toContain(
          'QN: stored weigh-in 71.55 kg at 2026-10-13T17:59:38.000Z was already reported (#463)',
        );

        const restarted = keyed();
        restarted.restoreDedupMark(845229578);
        const after = await session(restarted, [...HANDSHAKE, RECORD_463], '2026-10-13T18:20:00Z');
        expect(after.lines).toContain(
          'QN: stored weigh-in 71.55 kg at 2026-10-13T17:59:38.000Z was already reported (#463)',
        );
        expect(after.readings).toEqual([]);
      });

      it('does not export a record the scale assigned to no user, and says so', async () => {
        // #461's record (slot 0xf0, 09:23:19Z) after its own 0x12, 401 s later.
        const { readings, lines } = await session(
          keyed(),
          [INFO_461, RECORD_461],
          '2026-10-10T09:30:00Z',
        );
        expect(readings).toEqual([]);
        expect(lines).toContain(
          'QN: a stored weigh-in (71.65 kg at 2026-10-10T09:23:19.000Z) is not exported: the ' +
            'scale did not assign it to a user (#463)',
        );
      });

      it('gives a record with no user the same reason without ble.qn_user_key', async () => {
        // Not "without ble.qn_user_key": the option would not export it either.
        const { lines } = await session(
          makeAdapter(),
          [INFO_461, RECORD_461],
          '2026-10-10T09:30:00Z',
        );
        expect(lines).toContain(
          'QN: a stored weigh-in (71.65 kg at 2026-10-10T09:23:19.000Z) is not exported: the ' +
            'scale did not assign it to a user (#463)',
        );
        expect(lines.some((l) => l.includes('without ble.qn_user_key'))).toBe(false);
      });

      it('does not export a record of another user slot', async () => {
        // RECORD_463 with its slot [5] set to 2 and the checksum [19]
        // recomputed: no real record of slot 2 exists, the 0x22 mask asks for
        // slot 1 and unassigned records only.
        const slot2 = Buffer.from(RECORD_463);
        slot2[5] = 2;
        slot2[19] = [...slot2.subarray(0, 19)].reduce((a, b) => a + b, 0) & 0xff;
        const { readings, lines } = await session(
          keyed(),
          [...HANDSHAKE, slot2],
          '2026-10-13T18:09:00Z',
        );
        expect(readings).toEqual([]);
        expect(lines).toContain(
          'QN: a stored weigh-in (71.55 kg at 2026-10-13T17:59:38.000Z) is not exported: the ' +
            'scale assigned it to its user slot 2, and ble-scale-sync sends the profile of ' +
            'slot 1 (#463)',
        );
      });

      it('does not export it when the scale refused the profile in this session', async () => {
        // Refused, `a1 06 02 01 00 aa`, from the #461 log, in place of the
        // accepted answer of the #463 session.
        const REFUSED = Buffer.from([0xa1, 0x06, 0x02, 0x01, 0x00, 0xaa]);
        const { readings, lines } = await session(
          keyed(),
          [INFO_463, READY_461, CONFIG_REQ_461, REFUSED, 1000, RECORD_463],
          '2026-10-13T18:09:00Z',
        );
        expect(readings).toEqual([]);
        expect(lines).toContain(
          'QN: a stored weigh-in (71.55 kg at 2026-10-13T17:59:38.000Z) is not exported: the ' +
            'scale did not accept the profile for user slot 1 in this session, so it is not ' +
            'known whose it is (#463)',
        );
      });

      it("does not export it when the scale accepted openScale's profile, not the first user's", async () => {
        // The #463 frames with the ready frame before the 0x12: the ready step
        // has already chosen openScale's frames, so the accepted visit is
        // openScale's constant (key 8), and slot 1 need not be users[0].
        const { readings, writes, lines } = await session(
          keyed(),
          [READY_461, INFO_463, CONFIG_REQ_461, VISIT_OK_463, 1000, RECORD_463],
          '2026-10-13T18:09:00Z',
        );
        const visit = writes.find((w) => w[0] === 0xa0 && w[1] === 0x0d && w[2] === 0x02);
        expect(visit).toEqual([
          0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 0x21, 0x06, 0xb8, 0x04, 0x02, 0x9d,
        ]);
        expect(readings).toEqual([]);
        expect(lines).toContain(
          'QN: a stored weigh-in (71.55 kg at 2026-10-13T17:59:38.000Z) is not exported: this ' +
            "session sent openScale's profile, not the first user with ble.qn_user_key (the " +
            '18-byte 0x12 came after the handshake), so it is not known whose it is (#463)',
        );
      });

      it("does not take a record stamped hours after its receipt as this session's weigh-in", async () => {
        // The session time is chosen: 13:00Z, five hours before the record's
        // stamp, as a scale whose clock a vendor app set with a UTC+8 base
        // would show a 09:59Z weigh-in (R-6). Read as fresh it ended the
        // session as a live 71.55 kg without a time, before the real weigh-in.
        const adapter = keyed();
        const { readings, lines } = await session(
          adapter,
          [INFO_463, RECORD_463],
          '2026-10-13T13:00:00Z',
        );
        expect(readings).toEqual([]);
        expect(lines).toContain(
          'QN: stored weigh-in 71.55 kg at 2026-10-13T17:59:38.000Z, user slot 1, is stamped ' +
            "17978 s ahead of this host's clock, so it is not the weigh-in of this session, not " +
            'read (#463)',
        );
      });

      it('still takes a record stamped up to a minute ahead as the weigh-in of this session', async () => {
        const { readings } = await session(keyed(), [INFO_463, RECORD_463], '2026-10-13T17:58:38Z');
        expect(readings).toEqual([{ weight: 71.55, impedance: 497 }]);
      });

      it('without ble.qn_user_key only logs it, once per session', async () => {
        const { readings, lines } = await session(
          makeAdapter(),
          [INFO_463, RECORD_463, 3000, RECORD_463],
          '2026-10-13T18:09:00Z',
        );
        expect(readings).toEqual([]);
        const line =
          'QN: a stored weigh-in (71.55 kg at 2026-10-13T17:59:38.000Z, user slot 1) is not ' +
          'exported: without ble.qn_user_key ble-scale-sync cannot tell whose it is (#463)';
        expect(lines.filter((l) => l === line)).toHaveLength(1);
      });

      // Real frames in a made-up order of events: the live result 10 s after
      // the record, and the record handed over again in the next session.
      it('drops a stored record that is the live weigh-in reported just before', async () => {
        const LIVE_463B = Buffer.from([
          // 2026-10-13T18:39Z comment, 71.55 kg; [11..12] zeroed, [14] recomputed.
          0x10, 0x0f, 0xff, 0x01, 0x02, 0x1b, 0xf3, 0x10, 0xfd, 0x10, 0xfb, 0x00, 0x00, 0x00, 0x47,
        ]);
        const adapter = keyed();
        const first = await session(adapter, [INFO_463, LIVE_463B], '2026-10-13T17:59:48Z');
        expect(first.readings).toHaveLength(1);
        const { readings, lines } = await session(
          adapter,
          [...HANDSHAKE, RECORD_463],
          '2026-10-13T18:09:00Z',
        );
        expect(readings).toEqual([]);
        expect(lines.some((l) => l.includes('is the live result reported at'))).toBe(true);
      });

      it('drops a stored record it already reported as the weigh-in of an earlier session', async () => {
        // The record taken 42 s after it was stored, as this session's
        // weigh-in, and the scale handing it over again in the next session.
        const adapter = keyed();
        const first = await session(adapter, [INFO_463, RECORD_463], '2026-10-13T18:00:20Z');
        expect(first.readings).toEqual([{ weight: 71.55, impedance: 497 }]);
        const { readings, lines } = await session(
          adapter,
          [...HANDSHAKE, RECORD_463],
          '2026-10-13T18:09:00Z',
        );
        expect(readings).toEqual([]);
        expect(lines.some((l) => l.includes('is the live result reported at'))).toBe(true);
      });

      it('does not read a record from more than a year ago', async () => {
        const { readings, lines } = await session(
          keyed(),
          [...HANDSHAKE, RECORD_463],
          '2027-10-14T00:00:00Z',
        );
        expect(readings).toEqual([]);
        expect(lines).toContain(
          'QN: stored weigh-in 71.55 kg at 2026-10-13T17:59:38.000Z is not from the past year, ' +
            'dropped (#463)',
        );
      });

      it('keeps the re-query after a stored weigh-in', async () => {
        const { writes } = await session(
          keyed(),
          [INFO_463, RECORD_463, 3000],
          '2026-10-13T18:09:00Z',
        );
        expect(writes.filter((w) => w[0] === 0x22)).toHaveLength(1);
      });

      it('still ends the session on the live weigh-in after it, without a hold', async () => {
        const adapter = keyed();
        const { readings } = await session(
          adapter,
          [...HANDSHAKE, RECORD_463, LIVE_463],
          STARTED_463,
        );
        expect(readings).toEqual([STORED, { weight: 71.6, impedance: 507 }]);
        expect(adapter.isComplete(readings[1])).toBe(true);
        expect(adapter.isFinal(readings[1])).toBe(true);
        expect(adapter.completionHoldMs).toBeUndefined();
      });

      it('counts a stored weigh-in as complete whatever its impedance', async () => {
        // RECORD_463 with R50 and R500 overwritten to 150 Ohm (no real record
        // has one that low), read without the advertisement, so as sent.
        const lowR = Buffer.from(RECORD_463);
        lowR.writeUInt16BE(150, 12);
        lowR.writeUInt16BE(150, 14);
        const adapter = keyed();
        const { readings } = await session(
          adapter,
          [...HANDSHAKE, lowR],
          '2026-10-13T18:09:00Z',
          null,
        );
        expect(readings).toEqual([{ ...STORED, impedance: 150 }]);
        expect(adapter.isComplete(readings[0])).toBe(true);
        // A live reading with the same impedance still does not complete.
        expect(adapter.isComplete({ weight: 71.55, impedance: 150 })).toBe(false);
      });
    });

    describe('the weigh-in ending the session before the stored-record answer', () => {
      const RACE =
        'QN: the weigh-in ends the session before the scale answered the stored-record query; ' +
        'a stored weigh-in it sends after this is not read (#463)';

      // Real frames of the #463 session. The order of the first case, our 0x22
      // written and the final live frame before any 0x23, is in no log: the
      // 18-byte scale answered 0x22 within a second in both samples we have.
      it('says so when the final live frame comes first', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnUserKey: 1000 });
        const { readings, writes, lines } = await session(
          adapter,
          [INFO_463, READY_461, CONFIG_REQ_461, VISIT_OK_463, 1000, MEASURING_463, LIVE_463],
          STARTED_463,
        );
        expect(writes.some((w) => w[0] === 0x22)).toBe(true);
        expect(readings).toEqual([{ weight: 71.6, impedance: 507 }]);
        expect(lines).toContain(RACE);
      });

      it('says nothing when the scale answered first', async () => {
        const adapter = makeAdapter();
        adapter.configure({ qnUserKey: 1000 });
        const { lines } = await session(
          adapter,
          [
            INFO_463,
            READY_461,
            CONFIG_REQ_461,
            VISIT_OK_463,
            1000,
            MEASURING_463,
            RECORD_463,
            LIVE_463,
          ],
          STARTED_463,
        );
        expect(lines).not.toContain(RACE);
      });

      it('says nothing before our 0x22 went out', async () => {
        const { lines } = await session(makeAdapter(), [INFO_463, LIVE_463], STARTED_463);
        expect(lines).not.toContain(RACE);
      });

      it('says nothing on the classic dialect', async () => {
        // The 17-byte 0x12 (classic dialect, factor 10) and the stable 11-byte
        // 0x10 of one weigh-in, byte for byte from the owner's classic unit's
        // DEBUG log of 2026-10-19 (84.15 kg / 510 Ohm there too; raw 8415 is
        // out of band at the named factor 10, so resolveWeight takes /100).
        // That log's ready and config-request frames are not in hand, so the
        // #461 ones drive the handshake to our 0x22, which the line needs.
        const INFO_CLASSIC = Buffer.from([
          0x12, 0x11, 0xff, 0x04, 0xa1, 0x13, 0x00, 0x03, 0xff, 0x02, 0x03, 0x05, 0x00, 0x00, 0x05,
          0x07, 0xf2,
        ]);
        const STABLE_CLASSIC = Buffer.from([
          0x10, 0x0b, 0xff, 0x20, 0xdf, 0x01, 0x01, 0xfe, 0x01, 0xfc, 0x16,
        ]);
        const { readings, writes, lines } = await session(
          makeAdapter(),
          [INFO_CLASSIC, READY_461, CONFIG_REQ_461, 1000, STABLE_CLASSIC],
          STARTED_463,
          null,
        );
        expect(lines).toContain('QN: scale info (17B, dialect=classic), factor=10, proto=0xff');
        expect(writes.some((w) => w[0] === 0x22)).toBe(true);
        expect(readings).toEqual([{ weight: 84.15, impedance: 510 }]);
        expect(lines).not.toContain(RACE);
      });
    });
  });
});
