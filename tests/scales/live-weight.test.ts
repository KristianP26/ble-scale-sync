import { describe, it, expect } from 'vitest';
import { Silvergear108Adapter } from '../../src/scales/silvergear-108.js';
import { evaluateAdvertisement } from '../../src/ble/advertisement.js';
import type {
  BleDeviceInfo,
  LiveWeight,
  ScaleReading,
} from '../../src/interfaces/scale-adapter.js';

// Frames lifted verbatim from the #297 PacketLogger captures, same fixtures the
// Silvergear suite uses. MAC A0:85:61:91:E9:4F reversed into the first six bytes.
const MAC_REVERSED = '4fe9916185a0';
const mfg = (payloadHex: string): Buffer => Buffer.from(MAC_REVERSED + payloadHex, 'hex');

/** Settled 108.480 kg; the scale displayed 108.5. */
const SETTLED = mfg('202d07600da1');
/** The same weight one frame earlier, still settling (bit 7 clear). */
const SETTLING = mfg('a02d07600da1');

const adapter = new Silvergear108Adapter();

describe('provisional settling weights (#356)', () => {
  it('reports a settling frame as a live weight and NOT as a reading', () => {
    expect(adapter.parseBroadcast(SETTLING)).toBeNull();
    expect(adapter.parseLiveBroadcast(SETTLING)?.weight).toBeCloseTo(108.48, 2);
  });

  // The two channels must partition the frames. One frame reported through both
  // would show a display the same number twice and blur the line this type
  // exists to draw.
  it('reports a settled frame as a reading and NOT as a live weight', () => {
    expect(adapter.parseBroadcast(SETTLED)?.weight).toBeCloseTo(108.48, 2);
    expect(adapter.parseLiveBroadcast(SETTLED)).toBeNull();
  });

  it('drops an implausible settling weight rather than putting it on a display', () => {
    // 0xffffff grams with the settled bit clear: checksum recomputed so the
    // frame is well formed and only the plausibility bound can reject it.
    const p = [0xa0, 0xff, 0xff, 0xff, 0x0d, 0x00];
    p[5] = 0xa0 | ((p[0] + p[1] + p[2] + p[3] + p[4]) & 0x1f);
    const absurd = Buffer.concat([Buffer.from(MAC_REVERSED, 'hex'), Buffer.from(p)]);
    expect(adapter.parseLiveBroadcast(absurd)).toBeNull();
  });

  it('carries the live weight on the wait decision, which is not a reading', () => {
    const info: BleDeviceInfo = {
      localName: '108',
      serviceUuids: ['ffb0'],
      manufacturerData: { id: 0xa0ac, data: SETTLING },
    };
    const decision = evaluateAdvertisement(adapter, info);
    expect(decision.kind).toBe('wait');
    if (decision.kind !== 'wait') throw new Error('unreachable');
    expect(decision.live?.weight).toBeCloseTo(108.48, 2);
  });

  it('leaves the wait decision bare for a frame with no settling weight', () => {
    const info: BleDeviceInfo = {
      localName: '108',
      serviceUuids: ['ffb0'],
      // Post-weigh-in body frame: parsed by neither channel.
      manufacturerData: { id: 0xa0ac, data: mfg('a2b1a0a206bb') },
    };
    const decision = evaluateAdvertisement(adapter, info);
    expect(decision.kind).toBe('wait');
    if (decision.kind !== 'wait') throw new Error('unreachable');
    expect(decision.live).toBeUndefined();
  });

  // The structural guarantee the issue asks for. LiveWeight has no `impedance`,
  // which ScaleReading requires, so it cannot be passed anywhere a reading is
  // expected. If this ever compiles without the error, the barrier is gone.
  it('cannot be used where a ScaleReading is required', () => {
    const live: LiveWeight = { weight: 80 };
    // @ts-expect-error a provisional weight must never satisfy ScaleReading
    const asReading: ScaleReading = live;
    expect(asReading.weight).toBe(80);
  });
});
