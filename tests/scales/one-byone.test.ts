import { describe, it, expect, vi } from 'vitest';
import { OneByoneAdapter, OneByoneNewAdapter } from '../../src/scales/one-byone.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';

// ─── OneByoneAdapter ─────────────────────────────────────────────────────────

describe('OneByoneAdapter', () => {
  function makeAdapter() {
    return new OneByoneAdapter();
  }

  describe('matches()', () => {
    it.each(['t9146', 't9147', 't9120', 'health scale'])('matches "%s"', (name) => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    });

    it('matches name containing known substring', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('My T9146 Scale'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('T9146'))).toBe(true);
      expect(adapter.matches(mockPeripheral('Health Scale'))).toBe(true);
    });

    it('does not match Eufy T9148/T9149 (different protocol)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('eufy T9149'))).toBe(false);
      expect(adapter.matches(mockPeripheral('eufy T9148'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });

    it('matches post-discovery by 0xFFF4 characteristic when name absent (#177)', () => {
      const adapter = makeAdapter();
      const info = mockPeripheral('', [uuid16(0xfff0)], undefined, [
        uuid16(0xfff1),
        uuid16(0xfff4),
      ]);
      expect(adapter.matches(info)).toBe(true);
    });

    it('does not match nameless device with only 0xFFF0 service and no chars (#177)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('', [uuid16(0xfff0)]))).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('sends FD 37 mode/unit command then clock sync', async () => {
      const adapter = makeAdapter();
      const writeFn = vi.fn().mockResolvedValue(undefined);

      const ctx: ConnectionContext = {
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile: defaultProfile(),
      };

      await adapter.onConnected!(ctx);

      expect(writeFn).toHaveBeenCalledTimes(2);

      // Call 1: FD 37 mode/unit command with XOR checksum
      const [charUuid1, data1, withResponse1] = writeFn.mock.calls[0];
      expect(charUuid1).toBe(adapter.charWriteUuid);
      expect(withResponse1).toBe(false);
      expect(data1[0]).toBe(0xfd);
      expect(data1[1]).toBe(0x37);
      expect(data1.length).toBe(12); // 11 bytes + XOR checksum
      // Verify XOR checksum
      let xor = 0;
      for (let i = 0; i < 11; i++) xor ^= data1[i];
      expect(data1[11]).toBe(xor & 0xff);

      // Call 2: clock sync
      const [charUuid2, data2, withResponse2] = writeFn.mock.calls[1];
      expect(charUuid2).toBe(adapter.charWriteUuid);
      expect(withResponse2).toBe(false);
      expect(data2[0]).toBe(0xf1);
      expect(data2.length).toBe(8);
      // Year should be current year
      const year = (data2[1] << 8) | data2[2];
      expect(year).toBe(new Date().getFullYear());
    });
  });

  describe('parseNotification()', () => {
    it('parses 0xCF frame with weight and impedance', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0xcf;
      // impedance raw: (data[2]<<8) + data[1] = (0x01<<8) + 0xF4 = 500 → * 0.1 = 50.0
      buf[1] = 0xf4;
      buf[2] = 0x01;
      buf.writeUInt16LE(8000, 3); // weight = 8000 / 100 = 80.0 kg
      buf[9] = 0; // not invalid

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBeCloseTo(50, 1);
    });

    it('impedance is 0 when byte[9] = 1', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0xcf;
      buf[1] = 0xf4;
      buf[2] = 0x01;
      buf.writeUInt16LE(8000, 3);
      buf[9] = 1; // impedance invalid

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(0);
    });

    it('impedance is 0 when raw value is 0', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0xcf;
      buf[1] = 0x00;
      buf[2] = 0x00;
      buf.writeUInt16LE(8000, 3);
      buf[9] = 0;

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(0);
    });

    it('returns null for wrong header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(10);
      buf[0] = 0xce; // wrong
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(4))).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
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

// ─── OneByoneNewAdapter ──────────────────────────────────────────────────────

describe('OneByoneNewAdapter', () => {
  function makeAdapter() {
    return new OneByoneNewAdapter();
  }

  describe('matches()', () => {
    it('matches "1byone scale" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('1byone scale'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('1BYONE SCALE'))).toBe(true);
    });

    it('does not match "1byone" without " scale"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('1byone'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses type 0x80 weight frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf[0] = 0xab;
      buf[1] = 0x2a;
      buf[2] = 0x80; // weight type
      // 24-bit BE at [3-5], mask 0x03FFFF / 1000
      // 80000 & 0x03FFFF = 80000, / 1000 = 80.0 kg
      const raw = 80000;
      buf[3] = (raw >> 16) & 0xff;
      buf[4] = (raw >> 8) & 0xff;
      buf[5] = raw & 0xff;

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
    });

    it('parses type 0x01 impedance frame after weight', () => {
      const adapter = makeAdapter();

      // Weight first
      const wBuf = Buffer.alloc(6);
      wBuf[0] = 0xab;
      wBuf[1] = 0x2a;
      wBuf[2] = 0x80;
      const raw = 80000;
      wBuf[3] = (raw >> 16) & 0xff;
      wBuf[4] = (raw >> 8) & 0xff;
      wBuf[5] = raw & 0xff;
      adapter.parseNotification(wBuf);

      // Then impedance
      const iBuf = Buffer.alloc(6);
      iBuf[0] = 0xab;
      iBuf[1] = 0x2a;
      iBuf[2] = 0x01;
      iBuf.writeUInt16BE(500, 4); // impedance = 500

      const reading = adapter.parseNotification(iBuf);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(500);
    });

    it('returns null for type 0x00 history frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(8);
      buf[0] = 0xab;
      buf[1] = 0x2a;
      buf[2] = 0x00;
      buf[7] = 0x80; // history marker
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for wrong header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf[0] = 0xab;
      buf[1] = 0x2b; // wrong
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(2))).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and impedance > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 500 })).toBe(false);
    });

    it('returns false when impedance is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
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
