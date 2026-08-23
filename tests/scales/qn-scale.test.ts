import { describe, it, expect, vi } from 'vitest';
import { jieliAuthResponseFrame } from '../../src/scales/jieli-auth.js';
import { QnScaleAdapter, buildMeasurementTrigger } from '../../src/scales/qn-scale.js';
import { bleLog } from '../../src/ble/types.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type {
  BleDeviceInfo,
  ConnectionContext,
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

    it('applies weight heuristic when weight <= 5 (factor=100, tries /10)', () => {
      const adapter = makeAdapter();
      // With default scaleFactor=100, rawWeight=300 → 300/100=3.00 → <=5, try /10 → 30.00 kg
      const buf = Buffer.alloc(10);
      buf[0] = 0x10;
      buf[1] = 0x0a;
      buf[2] = 0x01;
      buf.writeUInt16BE(300, 3);
      buf[5] = 1;
      buf.writeUInt16BE(500, 6);
      buf.writeUInt16BE(500, 8);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(30);
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
    // openScale QNHandler parses 0x23: weight=u16be[10,11]/100, r1=u16le[13,14],
    // r2=u16le[15,16], timestamp=u32le[6,9] (2000-epoch seconds).
    it('parses a fresh 0x23 stored measurement as a reading', () => {
      const adapter = makeAdapter();
      const nowScaleSeconds = Math.floor(Date.now() / 1000) - 946684800;
      const buf = Buffer.alloc(19);
      buf[0] = 0x23;
      buf[1] = 0x13;
      buf[2] = 0xff;
      buf.writeUInt32LE(nowScaleSeconds >>> 0, 6);
      buf.writeUInt16BE(8495, 10); // 84.95 kg
      buf.writeUInt16LE(504, 13); // r1
      buf.writeUInt16LE(246, 15); // r2
      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(84.95);
      expect(reading!.impedance).toBe(504);
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
    // flag (0x01 kg, 0x02 lb) and must follow the configured weight_unit.
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

    it('sends the lb unit flag (0x02) when weight_unit is lbs (#269)', async () => {
      const adapter = makeAdapter();
      adapter.configure({ weightUnit: 'lbs' });
      const writes = await captureConfigWrite(adapter);
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config).toBeDefined();
      expect(config![3]).toBe(0x02);
      expect(config![8]).toBe(config!.slice(0, 8).reduce((a, b) => a + b, 0) & 0xff);
    });

    it('honours the unit flag on the older-firmware unlock path too (#269)', async () => {
      // No AE00 (subscribe rejects) so onConnected sends the legacy unlocks.
      const adapter = makeAdapter();
      adapter.configure({ weightUnit: 'lbs' });
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
    // Real 20-byte extended scale-info frame from @hedoric's GE CS 10 G capture.
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

    /**
     * Drive the handshake from a 0x12 scale-info frame all the way to the 0x22
     * START, collecting every write. The 0x14 and 0x21 frames are the ones the
     * GE CS 10 G actually sends (#235).
     */
    async function driveHandshake(
      adapter: QnScaleAdapter,
      info: Buffer,
      profile: UserProfile = defaultProfile(),
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
        await adapter.onConnected(ctx);
        adapter.parseNotification(info);
        adapter.parseNotification(
          Buffer.from([0x14, 0x0c, 0xff, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0xfd, 0x1f]),
        );
        adapter.parseNotification(Buffer.from([0x21, 0x07, 0xff, 0x01, 0x61, 0x2c, 0xb5]));
        await vi.advanceTimersByTimeAsync(2000);
        return writes;
      } finally {
        vi.useRealTimers();
      }
    }

    it('20B 0x12 frame echoes the protocol type into the 0x13 config', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const config = writes.find((w) => w[0] === 0x13 && w[4] === 0x10);
      expect(config).toEqual([0x13, 0x09, 0xff, 0x01, 0x10, 0x00, 0x00, 0x00, 0x2c]);
    });

    // The A00D history-response pair had no coverage at all before #235/#75
    // put its payload byte in question, so these pin both the default and the
    // override.
    // A vendor-app capture of this dialect writes 0xFC five times across three
    // weigh-ins, never 0xFE, the scale echoes it back as `a1 07 04 fc 01 10 b9`,
    // and 59 live 0x10 frames follow (#235).
    // The 19-byte es26m dialect gets the same byte, from the #75 capture. The
    // reporter's own log names the dialect, so this is not inferred from a model.
    it('sends the A00D history response with 0xFC on the es26m dialect', async () => {
      const adapter = makeAdapter();
      // 19-byte 0x12: long-frame variant, not the 20-byte extended one.
      const info = Buffer.alloc(19);
      info[0] = 0x12;
      info[1] = 0x13;
      info[2] = 0xff;
      info[10] = 0;
      const writes = await driveHandshake(adapter, info);
      const msg1 = writes.find((w) => w[0] === 0xa0 && w[2] === 0x04);
      expect(msg1).toBeDefined();
      expect(msg1![3]).toBe(0xfc);
      expect(msg1![12]).toBe(msg1!.slice(0, 12).reduce((a, b) => a + b, 0) & 0xff);
    });

    it('sends the A00D history response with 0xFC on the extended dialect', async () => {
      const adapter = makeAdapter();
      const writes = await driveHandshake(adapter, makeExtendedScaleInfo());
      const msg1 = writes.find((w) => w[0] === 0xa0 && w[2] === 0x04);
      expect(msg1).toBeDefined();
      expect(msg1![3]).toBe(0xfc);
      expect(msg1![12]).toBe(msg1!.slice(0, 12).reduce((a, b) => a + b, 0) & 0xff);
    });

    // Everything that is not the captured firmware keeps the value it reads on
    // today. The capture covers one dialect and says nothing about the others.
    it('leaves the classic dialect on 0xFE', async () => {
      const adapter = makeAdapter();
      const info = Buffer.alloc(11);
      info[0] = 0x12;
      info[2] = 0xab;
      info[10] = 1;
      const writes = await driveHandshake(adapter, info);
      const msg1 = writes.find((w) => w[0] === 0xa0 && w[2] === 0x04);
      expect(msg1![3]).toBe(0xfe);
      expect(msg1![12]).toBe(msg1!.slice(0, 12).reduce((a, b) => a + b, 0) & 0xff);
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

    /** Real 19-byte 0x12 from an Arboleaf, posted in #75 by @roberfernandez. */
    function makeArboleafScaleInfo(): Buffer {
      return Buffer.from([
        0x12, 0x13, 0xff, 0x54, 0x0b, 0x04, 0x00, 0x07, 0xff, 0x15, 0x0f, 0x27, 0x00, 0x02, 0x05,
        0x03, 0xe0, 0x6f, 0x31,
      ]);
    }

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

    // The vendor-app capture answers every live 0x10 with that frame's own
    // weight bytes: `11 1e be` -> `a2 06 01 1e be 85`. Exact for anyone, where
    // the pre-stream anchor can only ever be approximate.
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

    it('swaps the configured anchor into the ready-time A2 when forced on', async () => {
      const adapter = makeAdapter();
      adapter.configure({ qnWeightAck: true });
      const writes = await driveHandshake(
        adapter,
        makeEs26mScaleInfo(),
        defaultProfile({ lastKnownWeight: 76 }),
      );
      const startIndex = writes.findIndex((w) => w[0] === 0x22);
      const beforeStart = writes.slice(0, startIndex).filter((w) => w[0] === 0xa2);
      expect(beforeStart).toHaveLength(1);
      // 7600 = 0x1db0
      expect(beforeStart[0]).toEqual([0xa2, 0x06, 0x01, 0x1d, 0xb0, 0x76]);
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
