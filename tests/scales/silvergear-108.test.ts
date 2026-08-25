import { describe, it, expect } from 'vitest';
import { Silvergear108Adapter } from '../../src/scales/silvergear-108.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { buildPayload } from '../../src/scales/body-comp-helpers.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

/**
 * Every frame below is lifted verbatim from the two iOS PacketLogger captures
 * attached to #297. The reporter recorded the outcome of each session, so the
 * settled frames have known ground truth: 108.5 kg and 5.6 kg as displayed.
 *
 * MAC A0:85:61:91:E9:4F, reversed into the first six bytes of every frame.
 */
const MAC_REVERSED = '4fe9916185a0';

/** Manufacturer data as BlueZ and Noble deliver it: company id already stripped. */
function mfg(payloadHex: string): Buffer {
  return Buffer.from(MAC_REVERSED + payloadHex, 'hex');
}

/** The idle frame. Present in BOTH captures, so it is a real zero-load reading. */
const IDLE = 'a02ca0a00db9';
/** Settled 108.480 kg. The scale displayed 108.5. */
const SETTLED_108 = '202d07600da1';
/** The same weight one frame earlier, still settling (bit 7 clear). */
const SETTLING_108 = 'a02d07600da1';
/** Settled 5.610 kg. The scale displayed 5.6. */
const SETTLED_5_6 = '202cb54a0db8';
/** Post-weigh-in body frame from the 108.5 kg session (type 0x06). */
const BODY_108 = 'a2b1a0a206bb';
/** Post-weigh-in body frame from the 5.6 kg session: an object, not a body. */
const BODY_5_6 = 'a0a0a0a206a8';

function advert(payloadHex = SETTLED_108, uuids: string[] = ['ffb0']): BleDeviceInfo {
  return {
    localName: '108',
    serviceUuids: uuids,
    manufacturerData: { id: 0xa0ac, data: mfg(payloadHex) },
  };
}

describe('Silvergear108Adapter (#297)', () => {
  const adapter = new Silvergear108Adapter();

  describe('matches() and registry resolution', () => {
    it('claims the captured advertisement', () => {
      expect(adapter.matches(advert())).toBe(true);
      expect(resolveAdapter(advert(), adapters)?.name).toBe('Silvergear Smart Scale 108');
    });

    it('claims it with no advertised service list, as BlueZ delivers it pre-connect', () => {
      expect(adapter.matches(advert(SETTLED_108, []))).toBe(true);
    });

    it('does not claim the name alone: "108" identifies nothing', () => {
      expect(adapter.matches({ localName: '108', serviceUuids: ['ffb0'] })).toBe(false);
    });

    it('does not claim another vendor on the same service', () => {
      const other = advert();
      other.manufacturerData = { id: 0x02ac, data: mfg(SETTLED_108) };
      expect(adapter.matches(other)).toBe(false);
    });

    it('does not claim a payload whose checksum does not close', () => {
      const broken = advert();
      broken.manufacturerData = { id: 0xa0ac, data: mfg('202d07600d00') };
      expect(adapter.matches(broken)).toBe(false);
    });

    it('does not claim a payload of the wrong length', () => {
      const short = advert();
      short.manufacturerData = { id: 0xa0ac, data: Buffer.from(MAC_REVERSED + 'a02ca0', 'hex') };
      expect(adapter.matches(short)).toBe(false);
    });
  });

  describe('parseBroadcast()', () => {
    it('decodes the settled 108.5 kg frame', () => {
      const reading = adapter.parseBroadcast(mfg(SETTLED_108));
      expect(reading).toEqual({ weight: 108.48, impedance: 0 });
      expect(adapter.isComplete(reading!)).toBe(true);
    });

    it('decodes the settled 5.6 kg frame from the second capture', () => {
      const reading = adapter.parseBroadcast(mfg(SETTLED_5_6));
      expect(reading).toEqual({ weight: 5.61, impedance: 0 });
      expect(adapter.isComplete(reading!)).toBe(true);
    });

    // The two captures share this frame byte for byte, which is what makes the
    // weight bias a measurement rather than a fit to one session.
    it('reads the idle frame shared by both captures as zero, and does not publish it', () => {
      expect(adapter.parseBroadcast(mfg(IDLE))).toBeNull();
    });

    it('drops the settling stream even when it carries the final weight', () => {
      // Same 24-bit weight field as the settled frame, bit 7 of the status byte
      // clear. Publishing this would publish numbers the scale never displayed:
      // the same capture runs 39.60, 55.48, 83.46 and 107.03 kg on the way up.
      expect(adapter.parseBroadcast(mfg(SETTLING_108))).toBeNull();
    });

    it('does not publish the post-weigh-in body frame', () => {
      expect(adapter.parseBroadcast(mfg(BODY_108))).toBeNull();
      expect(adapter.parseBroadcast(mfg(BODY_5_6))).toBeNull();
    });

    it('rejects a frame whose checksum does not close', () => {
      expect(adapter.parseBroadcast(mfg('202d07600d00'))).toBeNull();
    });

    it('rejects manufacturer data of the wrong length', () => {
      expect(adapter.parseBroadcast(Buffer.from(MAC_REVERSED + '202d07600d', 'hex'))).toBeNull();
      expect(adapter.parseBroadcast(Buffer.alloc(0))).toBeNull();
    });

    it('rejects an out-of-range weight that happens to checksum', () => {
      // 0xffffff - 0x8C0000 grams is far past any human load; the checksum is
      // only five bits wide, so the range bound is what stops a mangled frame.
      const p = Buffer.from([0xa0 ^ 0x80, 0xff, 0xff, 0xff, 0x0d, 0x00]);
      p[5] = (0xa0 + ((p[0] + p[1] + p[2] + p[3] + p[4]) & 0x1f)) & 0xff;
      expect(
        adapter.parseBroadcast(Buffer.concat([Buffer.from(MAC_REVERSED, 'hex'), p])),
      ).toBeNull();
    });
  });

  // The display unit lives in the TOP 3 BITS of the last payload byte, and the
  // checksum in the low 5. Reading the whole byte as a checksum made the adapter
  // reject every frame from a scale not set to kilograms (#297). All frames here
  // are verbatim from the reporter's captures at each unit setting.
  describe('display units', () => {
    /** Same weigh-in as SETTLED_ST, with the scale showing 17 st 2 lb. */
    const SETTLED_ST = '202d099c0dff';
    /** A body frame captured with the scale showing 240.0 lb. */
    const BODY_LB = 'a2aea0a20698';
    /** A zero-load weight frame with the scale showing stones. */
    const IDLE_ST = 'a02ca0a00df9';

    it('decodes a weigh-in taken with the scale showing stones', () => {
      // 17 st 2 lb is 108.862 kg, and the app reported 240.0 lb for the same
      // weigh-in, which is the same number. The gram field does not change with
      // the display unit, so nothing is converted.
      const reading = adapter.parseBroadcast(mfg(SETTLED_ST));
      expect(reading).toEqual({ weight: 108.86, impedance: 0 });
      expect(adapter.isComplete(reading!)).toBe(true);
    });

    it('claims and parses frames at every observed unit setting', () => {
      for (const hex of [SETTLED_108, SETTLED_ST, IDLE_ST, BODY_LB]) {
        expect(adapter.matches(advert(hex))).toBe(true);
      }
    });

    it('still rejects a frame whose low five checksum bits do not close', () => {
      // Only the low 5 bits are the checksum, so the corruption has to be there
      // for the frame to be refused; changing the unit bits must not refuse it.
      const p = Buffer.from(SETTLED_ST, 'hex');
      p[5] = (p[5] & 0xe0) | ((p[5] + 1) & 0x1f);
      expect(adapter.parseBroadcast(mfg(p.toString('hex')))).toBeNull();
    });

    it('accepts a unit value it has never seen, rather than refusing the weigh-in', () => {
      // The three observed values are kg, lb and st. An unknown one is logged by
      // name and otherwise ignored: the weight is in grams either way, and
      // refusing a reading over an unrecognised presentation flag would repeat
      // the bug this describe block exists for.
      const p = Buffer.from(SETTLED_ST, 'hex');
      p[5] = (p[5] & 0x1f) | 0x60;
      expect(adapter.parseBroadcast(mfg(p.toString('hex')))?.weight).toBeCloseTo(108.86, 3);
    });
  });

  describe('body composition', () => {
    it('estimates from BMI, since the advertisement carries no decoded impedance', () => {
      const profile = defaultProfile();
      expect(adapter.computeMetrics({ weight: 108.48, impedance: 0 }, profile)).toEqual(
        buildPayload(108.48, 0, {}, profile),
      );
    });
  });
});
