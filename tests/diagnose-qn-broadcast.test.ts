import { describe, it, expect } from 'vitest';
import { parseMfgData } from '../src/ble/handler-noble-shared/peripheral.js';
import { parseQnBroadcast } from '../src/scales/qn-scale/broadcast.js';

/**
 * #406. `npm run diagnose` had its own copy of this decode and it was wrong by
 * two bytes: the production path receives manufacturer data with the 2-byte
 * company id stripped, and the copy read the raw buffer while using the
 * stripped offsets for the status byte and the weight. This pins the pairing
 * the tool now uses, so the two cannot drift apart again.
 */
describe('diagnose QN broadcast decode', () => {
  /** A raw advertisement: company id, then the AABB payload. */
  function rawAdvert(weightKg: number, stable: boolean): Buffer {
    const payload = Buffer.alloc(19);
    payload[0] = 0xaa;
    payload[1] = 0xbb;
    payload[15] = stable ? 0x20 : 0x00;
    payload.writeUInt16LE(Math.round(weightKg * 100), 17);
    return Buffer.concat([Buffer.from([0x11, 0x22]), payload]);
  }

  it('decodes the weight the read path would decode', () => {
    const parsed = parseMfgData(rawAdvert(81.25, true))!;
    expect(parseQnBroadcast(parsed.data)).toEqual({ weight: 81.25, impedance: 0 });
  });

  it('returns nothing while the scale is still settling', () => {
    const parsed = parseMfgData(rawAdvert(81.25, false))!;
    expect(parseQnBroadcast(parsed.data)).toBeNull();
  });

  it('reading the raw buffer at the stripped offsets is what produced the wrong number', () => {
    // The old copy: magic shifted to [2..3], everything else not shifted.
    const raw = rawAdvert(81.25, true);
    const oldWeight = raw.readUInt16LE(17) / 100;
    expect(oldWeight).not.toBeCloseTo(81.25, 2);
  });
});
