import { describe, it, expect } from 'vitest';
import type { Peripheral } from '@abandonware/noble';
import { YunmaiScaleAdapter } from '../../src/scales/yunmai.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new YunmaiScaleAdapter();
}

function makeFrame(opts: {
  protocolVer?: number;
  respType?: number;
  weightRaw?: number;
  impedanceRaw?: number;
  fatRaw?: number;
  length?: number;
}): Buffer {
  const len = opts.length ?? 19;
  const buf = Buffer.alloc(len);
  buf[0] = 0x0d; // marker
  buf[1] = opts.protocolVer ?? 0x1e; // protocol version
  buf[2] = 0x00;
  buf[3] = opts.respType ?? 0x02; // final frame
  // bytes 4: padding
  // bytes 5-8: timestamp (zeroed)
  // bytes 9-12: user id (zeroed)
  buf.writeUInt16BE(opts.weightRaw ?? 8000, 13); // 8000/100=80 kg
  if (len >= 17) {
    buf.writeUInt16BE(opts.impedanceRaw ?? 500, 15);
  }
  if (len >= 19) {
    buf.writeUInt16BE(opts.fatRaw ?? 2200, 17); // 2200/100=22%
  }
  return buf;
}

describe('YunmaiScaleAdapter', () => {
  describe('matches()', () => {
    it('matches "Yunmai" name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai Standard', []);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('matches case-insensitively', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('YUNMAI', []);
      expect(adapter.matches(p as Peripheral)).toBe(true);
    });

    it('detects Mini variant via ISM in name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai ISM', []);
      adapter.matches(p as Peripheral);
      // isMini should be set — we test this via isComplete behavior
    });

    it('detects SE variant via ISSE in name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai ISSE', []);
      adapter.matches(p as Peripheral);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('QN-Scale', []);
      expect(adapter.matches(p as Peripheral)).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses final frame with weight', () => {
      const adapter = makeAdapter();
      // Standard variant (no ISM in name) — match first
      adapter.matches(mockPeripheral('Yunmai Standard', []) as Peripheral);

      const buf = makeFrame({ weightRaw: 8000 });
      const reading = adapter.parseNotification(buf);

      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(0); // standard variant: no impedance
    });

    it('parses Mini variant with impedance', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []) as Peripheral);

      const buf = makeFrame({ weightRaw: 8000, impedanceRaw: 480 });
      const reading = adapter.parseNotification(buf);

      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(480);
    });

    it('parses embedded fat percent for protocol >= 0x1E', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []) as Peripheral);

      const buf = makeFrame({ protocolVer: 0x1e, fatRaw: 2500 }); // 25%
      adapter.parseNotification(buf);
      // The embedded fat is used in computeMetrics, not returned in reading
    });

    it('returns null for non-final frame (respType != 0x02)', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []) as Peripheral);

      const buf = makeFrame({ respType: 0x01 }); // measuring, not final
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(10))).toBeNull();
    });

    it('returns null for zero weight', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []) as Peripheral);
      const buf = makeFrame({ weightRaw: 0 });
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('Standard variant: complete when weight > 0', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []) as Peripheral);
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('Standard variant: incomplete when weight = 0', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []) as Peripheral);
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });

    it('Mini variant: requires impedance > 0', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []) as Peripheral);
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid payload for standard variant (no impedance)', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []) as Peripheral);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 0 }, profile);

      expect(payload.weight).toBe(80);
      assertPayloadRanges(payload);
    });

    it('returns valid payload for Mini variant with impedance', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []) as Peripheral);

      // Parse a frame to set embedded fat
      const buf = makeFrame({ protocolVer: 0x1e, fatRaw: 2200, impedanceRaw: 500 });
      adapter.parseNotification(buf);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);

      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(500);
      assertPayloadRanges(payload);
    });

    it('uses embedded fat percent when available', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []) as Peripheral);

      // Parse with embedded fat = 22%
      const buf = makeFrame({ protocolVer: 0x1e, fatRaw: 2200, impedanceRaw: 500 });
      adapter.parseNotification(buf);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);

      // The embedded fat (22%) should be used
      expect(payload.bodyFatPercent).toBeCloseTo(22, 0);
    });
  });
});
