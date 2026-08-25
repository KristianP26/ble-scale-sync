import { describe, expect, it } from 'vitest';
import { evaluateAdvertisement } from '../../src/ble/advertisement.js';
import { buildPayload } from '../../src/scales/body-comp-helpers.js';
import { XiaomiMiScaleLegacyAdapter } from '../../src/scales/xiaomi-mi-scale-legacy.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';

const HUAMI_MANUFACTURER = { id: 0x0157, data: Buffer.from('70879eede5e7', 'hex') };

function legacyFrame(flags: number, rawWeight: number): Buffer {
  const frame = Buffer.alloc(10);
  frame[0] = flags;
  frame.writeUInt16LE(rawWeight, 1);
  // Captured XMTZC04HM timestamp: 2026-08-24 16:57:19.
  frame.set(Buffer.from('ea070818103913', 'hex'), 3);
  return frame;
}

describe('XiaomiMiScaleLegacyAdapter', () => {
  const adapter = new XiaomiMiScaleLegacyAdapter();

  it('matches the Huami 10-byte 0x181D advertisement even after GATT discovery', () => {
    expect(
      adapter.matches({
        localName: '',
        serviceUuids: ['181d'],
        manufacturerData: HUAMI_MANUFACTURER,
        serviceData: [{ uuid: '181d', data: legacyFrame(0x23, 20110) }],
        characteristicUuids: ['00002a9d00001000800000805f9b34fb'],
      }),
    ).toBe(true);
  });

  it('matches on the local name alone, as the node-ble pre-connect path sees it', () => {
    expect(adapter.matches({ localName: 'MI SCALE2', serviceUuids: [] })).toBe(true);
  });

  it('leaves the impedance-bearing Mi Scale 2 names to MiScale2Adapter', () => {
    expect(adapter.matches({ localName: 'MIBFS', serviceUuids: [] })).toBe(false);
    expect(adapter.matches({ localName: 'MI SCALE', serviceUuids: [] })).toBe(false);
  });

  it('does not claim a generic 0x181D scale', () => {
    expect(
      adapter.matches({
        localName: 'Generic Scale',
        serviceUuids: ['181d'],
        manufacturerData: { id: 0x1234, data: Buffer.alloc(0) },
        serviceData: [{ uuid: '181d', data: legacyFrame(0x23, 20110) }],
      }),
    ).toBe(false);
  });

  it('decodes the captured stable pounds frame', () => {
    const reading = adapter.parseServiceData('181d', Buffer.from('238e4eea070818103913', 'hex'));

    expect(reading).toEqual({ weight: 91.217425607, impedance: 0 });
    expect(reading?.timestamp).toBeUndefined();
    expect(adapter.isComplete(reading!)).toBe(true);
  });

  // The kg frame is a real capture; the catty/jin frame is synthetic. Zepp Life
  // offers this model kg and lb only, with no jin option, so a real jin frame
  // cannot be captured. The bit-4 branch follows the openScale / ble_monitor /
  // xiaomi-ble mapping, which all three agree on.
  it('decodes kg by default and catty when bit 4 is set', () => {
    expect(adapter.parseServiceData('181d', legacyFrame(0x22, 18030))).toEqual({
      weight: 90.15,
      impedance: 0,
    });
    expect(adapter.parseServiceData('181d', legacyFrame(0x32, 20080))).toEqual({
      weight: 100.4,
      impedance: 0,
    });
  });

  it('ignores unstable and removed frames', () => {
    expect(adapter.parseServiceData('181d', legacyFrame(0x03, 20110))).toBeNull();
    expect(adapter.parseServiceData('181d', legacyFrame(0xa3, 20110))).toBeNull();
  });

  it('emits a stable frame immediately instead of starting the impedance grace period', () => {
    const info = {
      localName: 'MI SCALE2',
      serviceUuids: ['181d'],
      manufacturerData: HUAMI_MANUFACTURER,
      serviceData: [{ uuid: '181d', data: Buffer.from('238e4eea070818103913', 'hex') }],
    };

    expect(evaluateAdvertisement(adapter, info)).toEqual({
      kind: 'complete',
      reading: { weight: 91.217425607, impedance: 0 },
    });
  });

  it('uses the profile-based body-composition estimate', () => {
    const profile = defaultProfile();
    expect(adapter.computeMetrics({ weight: 91.217425607, impedance: 0 }, profile)).toEqual(
      buildPayload(91.217425607, 0, {}, profile),
    );
  });
});
