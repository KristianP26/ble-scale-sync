import { describe, it, expect } from 'vitest';
import type { Peripheral } from '@abandonware/noble';
import { QnScaleAdapter } from '../../src/scales/qn-scale.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new QnScaleAdapter();
}

describe('QnScaleAdapter', () => {
  describe('matches()', () => {
    it('matches "QN-Scale" with FFF0 service UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('QN-Scale', ['fff0']);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches "Renpho" with FFE0 service UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Renpho', ['ffe0']);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches "SENSSUN" with full 128-bit FFF0 UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('SENSSUN', ['0000fff000001000800000805f9b34fb']);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches "sencor" with FFE0', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Sencor Scale', ['ffe0']);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('does not match unknown name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Random Scale', ['fff0']);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });

    it('does not match correct name without service UUID', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('QN-Scale', ['1234']);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });

    it('name matching is case-insensitive', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('qn-scale', ['fff0']);
      expect(adapter.matches(p as Peripheral)).toBe(true);
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
  });

  describe('isComplete()', () => {
    it('returns true for weight > 10 and impedance > 200', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns false when weight <= 10', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 5, impedance: 500 })).toBe(false);
    });

    it('returns false when impedance <= 200', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 100 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns all GarminPayload fields', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);

      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(500);
      assertPayloadRanges(payload);
    });

    it('throws when calculation fails (zero inputs)', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      expect(() => adapter.computeMetrics({ weight: 0, impedance: 500 }, profile)).toThrow();
    });
  });
});
