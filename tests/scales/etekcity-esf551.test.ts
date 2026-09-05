import { describe, it, expect } from 'vitest';
import { EtekcityEsf551Adapter } from '../../src/scales/etekcity-esf551.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

/**
 * Frames byte-for-byte from the #385 debug log: an Etekcity Smart Fitness
 * Scale at D0:4D:00:43:40:BD, one weigh-in from first contact to settled.
 */
const SETTLING = 'a5029d1000d80161a100e81601000 00dc0986a000101'.replace(/ /g, '');
/** The settled frame: 0x011b52 = 72530 g, impedance 0x0213 = 531 ohm. */
const SETTLED = 'a502bb10002f0161a100521b011302 13c0986a010101'.replace(/ /g, '');
/** The short status frame the scale sends when the session ends. */
const SHORT = 'a502bc0500f30101a00002';

function makeAdapter(): EtekcityEsf551Adapter {
  return new EtekcityEsf551Adapter();
}

function device(overrides: Partial<BleDeviceInfo> = {}): BleDeviceInfo {
  return {
    localName: 'Etekcity Smart Fitness Scale',
    serviceUuids: ['0000fff0-0000-1000-8000-00805f9b34fb'],
    characteristicUuids: [],
    ...overrides,
  };
}

describe('EtekcityEsf551Adapter (#385)', () => {
  describe('matches() and registry resolution', () => {
    it('matches the advertised name', () => {
      expect(makeAdapter().matches(device())).toBe(true);
    });

    it('does not claim a bare FFF0 device, which belongs to Inlife or 1byone', () => {
      expect(makeAdapter().matches(device({ localName: '' }))).toBe(false);
      expect(makeAdapter().matches(device({ localName: '000fatscale01' }))).toBe(false);
    });

    // The whole defect in #385: post-discovery the ESF-551 satisfies Inlife's
    // "has FFF2, no FFF4" rule, so priority is what keeps it here.
    it('wins over Inlife once the characteristics are known', () => {
      const discovered = device({
        characteristicUuids: [
          '0000fff1-0000-1000-8000-00805f9b34fb',
          '0000fff2-0000-1000-8000-00805f9b34fb',
        ],
      });
      const resolved = resolveAdapter(discovered, adapters);
      expect(resolved?.name).toBe('Etekcity ESF-551');
    });

    it('resolves pre-connect too, before any characteristic is known', () => {
      expect(resolveAdapter(device(), adapters)?.name).toBe('Etekcity ESF-551');
    });
  });

  describe('parseNotification()', () => {
    it('reads the settled frame as 72.53 kg and 531 ohm', () => {
      const reading = makeAdapter().parseNotification(Buffer.from(SETTLED, 'hex'));
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(72.53, 2);
      expect(reading!.impedance).toBe(531);
    });

    // Reading bytes [10-11] alone divides into a plausible 69.94 kg, which is
    // what the capture looks like it says until the third byte is included.
    it('reads the weight as a 24-bit field, not the plausible 16-bit misread', () => {
      const reading = makeAdapter().parseNotification(Buffer.from(SETTLED, 'hex'));
      expect(reading!.weight).not.toBeCloseTo(69.94, 2);
    });

    it('ignores the settling stream, which the scale has not committed to', () => {
      expect(makeAdapter().parseNotification(Buffer.from(SETTLING, 'hex'))).toBeNull();
    });

    it('ignores the short end-of-session status frame', () => {
      expect(makeAdapter().parseNotification(Buffer.from(SHORT, 'hex'))).toBeNull();
    });

    it('rejects a frame that is the right length but not this protocol', () => {
      const wrong = Buffer.from(SETTLED, 'hex');
      wrong[7] = 0x62; // one signature byte off
      expect(makeAdapter().parseNotification(wrong)).toBeNull();
    });

    it('drops the impedance when the scale marks the field as meaningless', () => {
      const noImpedance = Buffer.from(SETTLED, 'hex');
      noImpedance[20] = 0;
      const reading = makeAdapter().parseNotification(noImpedance);
      expect(reading!.weight).toBeCloseTo(72.53, 2);
      expect(reading!.impedance).toBe(0);
    });
  });

  describe('isComplete() and computeMetrics()', () => {
    it('completes on the settled weight', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(Buffer.from(SETTLED, 'hex'))!;
      expect(adapter.isComplete(reading)).toBe(true);
    });

    // #386: passing impedance to buildPayload without computing a fat
    // percentage first silently falls back to the BMI estimate.
    it('computes body fat from the impedance, not from BMI', () => {
      const adapter = makeAdapter();
      const withImpedance = adapter.computeMetrics(
        { weight: 72.53, impedance: 531 },
        defaultProfile(),
      );
      const without = adapter.computeMetrics({ weight: 72.53, impedance: 0 }, defaultProfile());
      expect(withImpedance.bodyFatPercent).not.toBe(without.bodyFatPercent);
    });

    it('produces a body-composition payload in valid ranges', () => {
      const comp = makeAdapter().computeMetrics(
        { weight: 72.53, impedance: 531 },
        defaultProfile(),
      );
      expect(comp.weight).toBeCloseTo(72.53, 2);
      expect(comp.bodyFatPercent).toBeGreaterThan(3);
      expect(comp.bodyFatPercent).toBeLessThan(60);
      expect(comp.bmi).toBeGreaterThan(10);
    });
  });
});
