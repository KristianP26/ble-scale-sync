import { describe, it, expect, vi } from 'vitest';
import { MgbAdapter } from '../../src/scales/mgb.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new MgbAdapter();
}

describe('MgbAdapter', () => {
  describe('matches()', () => {
    it('matches "swan..." prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('swan123'))).toBe(true);
      expect(adapter.matches(mockPeripheral('Swan ABC'))).toBe(true);
    });

    it('matches "icomon" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('icomon'))).toBe(true);
    });

    it('matches "yg" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('yg'))).toBe(true);
    });

    it('matches by service UUID "ffb0"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Unknown', ['ffb0']))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('SWAN123'))).toBe(true);
      expect(adapter.matches(mockPeripheral('ICOMON'))).toBe(true);
      expect(adapter.matches(mockPeripheral('YG'))).toBe(true);
    });

    it('does not match unrelated name without service UUID', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('sends 6-command init sequence with user profile', async () => {
      const adapter = makeAdapter();
      const writeFn = vi.fn().mockResolvedValue(undefined);

      const ctx: ConnectionContext = {
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile: defaultProfile({ gender: 'male', age: 30, height: 183 }),
      };

      await adapter.onConnected!(ctx);

      expect(writeFn).toHaveBeenCalledTimes(6);

      // Cmd 1: 0xF7 init
      expect(writeFn.mock.calls[0][1]).toEqual([0xf7, 0x00, 0x00, 0x00]);
      // Cmd 2: 0xFA init
      expect(writeFn.mock.calls[1][1]).toEqual([0xfa, 0x00, 0x00, 0x00]);
      // Cmd 3: 0xFB [sex=1, age=30, height=183]
      expect(writeFn.mock.calls[2][1]).toEqual([0xfb, 0x01, 30, 183]);
      // Cmd 4: 0xFD [year%100, month, day]
      const cmd4 = writeFn.mock.calls[3][1];
      expect(cmd4[0]).toBe(0xfd);
      // Cmd 5: 0xFC [hour, minute, second]
      expect(writeFn.mock.calls[4][1][0]).toBe(0xfc);
      // Cmd 6: 0xFE unit
      expect(writeFn.mock.calls[5][1]).toEqual([0xfe, 0x06, 0x00, 0x00]);

      // All calls use charWriteUuid and withResponse=false
      for (const call of writeFn.mock.calls) {
        expect(call[0]).toBe(adapter.charWriteUuid);
        expect(call[2]).toBe(false);
      }
    });

    it('encodes female gender as 0x02', async () => {
      const adapter = makeAdapter();
      const writeFn = vi.fn().mockResolvedValue(undefined);

      const ctx: ConnectionContext = {
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile: defaultProfile({ gender: 'female' }),
      };

      await adapter.onConnected!(ctx);
      expect(writeFn.mock.calls[2][1][1]).toBe(0x02);
    });
  });

  describe('parseNotification()', () => {
    it('parses Frame1 (weight + fat) at corrected offsets', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(20);
      buf[0] = 0xac;
      buf[1] = 0x02;
      buf[2] = 0xff;
      buf.writeUInt16BE(800, 12); // weight = 800 / 10 = 80.0 kg
      buf.writeUInt16BE(225, 16); // fat = 225 / 10 = 22.5%

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('parses Frame1 with 0x03 variant', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(20);
      buf[0] = 0xac;
      buf[1] = 0x03; // variant
      buf[2] = 0xff;
      buf.writeUInt16BE(800, 12);
      buf.writeUInt16BE(225, 16);

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('ignores Frame1 shorter than 18 bytes', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(15);
      buf[0] = 0xac;
      buf[1] = 0x02;
      buf[2] = 0xff;
      // Too short for offsets [12:13] and [16:17]

      const reading = adapter.parseNotification(buf);
      expect(reading).toBeNull(); // no weight cached
    });

    it('parses Frame2 (muscle/bone/water) after Frame1', () => {
      const adapter = makeAdapter();

      // Frame1
      const f1 = Buffer.alloc(20);
      f1[0] = 0xac;
      f1[1] = 0x02;
      f1[2] = 0xff;
      f1.writeUInt16BE(800, 12);
      f1.writeUInt16BE(225, 16);
      adapter.parseNotification(f1);

      // Frame2
      const f2 = Buffer.alloc(10);
      f2[0] = 0x01;
      f2[1] = 0x00;
      f2.writeUInt16LE(400, 2); // muscle = 40.0%
      f2.writeUInt16LE(35, 6); // bone = 3.5 kg
      f2.writeUInt16LE(550, 8); // water = 55.0%

      const reading = adapter.parseNotification(f2);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(5))).toBeNull();
    });

    it('returns null when no weight received yet', () => {
      const adapter = makeAdapter();
      const f2 = Buffer.alloc(10);
      f2[0] = 0x01;
      f2[1] = 0x00;
      f2.writeUInt16LE(400, 2);
      f2.writeUInt16LE(35, 6);
      f2.writeUInt16LE(550, 8);
      expect(adapter.parseNotification(f2)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and cachedFat > 0', () => {
      const adapter = makeAdapter();

      const f1 = Buffer.alloc(20);
      f1[0] = 0xac;
      f1[1] = 0x02;
      f1[2] = 0xff;
      f1.writeUInt16BE(800, 12);
      f1.writeUInt16BE(225, 16);
      adapter.parseNotification(f1);

      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when only Frame2 received (no fat)', () => {
      const adapter = makeAdapter();
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

      const f1 = Buffer.alloc(20);
      f1[0] = 0xac;
      f1[1] = 0x02;
      f1[2] = 0xff;
      f1.writeUInt16BE(800, 12);
      f1.writeUInt16BE(225, 16);
      adapter.parseNotification(f1);

      const f2 = Buffer.alloc(10);
      f2[0] = 0x01;
      f2[1] = 0x00;
      f2.writeUInt16LE(400, 2);
      f2.writeUInt16LE(35, 6);
      f2.writeUInt16LE(550, 8);
      adapter.parseNotification(f2);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 0 }, profile);
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
//
// Every one of these also asserts that computeMetrics still carries the scale's
// own composition, because the first attempt at this fix cleared the caches in
// onSessionEnd - which runs BEFORE computeMetrics - and would have deleted the
// body composition from every reading while these tests stayed green.

describe('MgbAdapter session boundary (#394)', () => {
  function frame1(weightTenths: number, fatTenths: number): Buffer {
    const buf = Buffer.alloc(20);
    buf[0] = 0xac;
    buf[1] = 0x02;
    buf[2] = 0xff;
    buf.writeUInt16BE(weightTenths, 12);
    buf.writeUInt16BE(fatTenths, 16);
    return buf;
  }

  /** Frame2: header [0x01, 0x00], muscle/bone/water LE tenths at [2]/[6]/[8]. */
  function frame2(muscleTenths: number, boneTenths: number, waterTenths: number): Buffer {
    const buf = Buffer.alloc(10);
    buf[0] = 0x01;
    buf[1] = 0x00;
    buf.writeUInt16LE(muscleTenths, 2);
    buf.writeUInt16LE(boneTenths, 6);
    buf.writeUInt16LE(waterTenths, 8);
    return buf;
  }

  it('keeps the completed reading composition when the NEXT session starts first', () => {
    // The ordering this guards is real, not hypothetical: on the mqtt-proxy and
    // esphome-proxy watchers the loop awaits processReading() - computeMetrics
    // plus network exports - while the watcher is free to open the next GATT
    // session. So onSessionStart() for session N+1 can land BEFORE
    // computeMetrics() for session N. Without a per-reading snapshot this
    // exports the Deurenberg BMI estimate instead of the scale's own figure.
    const adapter = makeAdapter();
    const reading = adapter.parseNotification(frame1(800, 225))!;
    expect(adapter.isComplete(reading)).toBe(true);

    adapter.onSessionStart();

    const payload = adapter.computeMetrics(reading, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(22.5, 1);
    assertPayloadRanges(payload);
  });

  it('does not resolve the next session on the previous weigh-in', () => {
    const adapter = makeAdapter();
    adapter.parseNotification(frame1(800, 225));

    adapter.onSessionStart();

    // A frame that updates nothing: right length, neither Frame1 nor Frame2.
    // This used to fall through to the cached weight and complete immediately.
    const stray = Buffer.alloc(20);
    stray[0] = 0xff;
    expect(adapter.parseNotification(stray)).toBeNull();
  });

  it('does not carry the previous composition into a fresh weight', () => {
    // Assert on the fields Frame1 does NOT refresh. Weight and fat come from
    // Frame1 either way, so asserting on those two passes with or without the
    // reset. Muscle, bone and water only ever come from Frame2, so a session
    // where Frame2 never arrives is exactly where the previous person's numbers
    // used to be exported against a fresh weight.
    const adapter = makeAdapter();
    adapter.parseNotification(frame1(800, 225));
    adapter.parseNotification(frame2(400, 35, 550));

    adapter.onSessionStart();

    const next = adapter.parseNotification(frame1(650, 310))!;
    const payload = adapter.computeMetrics(next, defaultProfile());
    expect(payload.weight).toBe(65);
    expect(payload.bodyFatPercent).toBeCloseTo(31, 1);
    // buildPayload always fills these in, so "absent" is not observable. What
    // is observable: they must equal what a virgin adapter produces from the
    // same lone Frame1 (the estimator), not what the previous Frame2 said.
    const virgin = makeAdapter();
    const baseline = virgin.computeMetrics(
      virgin.parseNotification(frame1(650, 310))!,
      defaultProfile(),
    );
    expect(payload.muscleMass).toBeCloseTo(baseline.muscleMass!, 5);
    expect(payload.boneMass).toBeCloseTo(baseline.boneMass!, 5);
    expect(payload.waterPercent).toBeCloseTo(baseline.waterPercent!, 5);
    // 40.0 % of 65 kg is what the leak used to export.
    expect(payload.muscleMass).not.toBeCloseTo(26, 1);
  });
});
