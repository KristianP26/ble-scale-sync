import { describe, it, expect, vi } from 'vitest';
import { HutbitAdapter, hasHutbitSignature } from '../../src/scales/hutbit.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo, ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  expectMatches,
  parseOk,
  expectValidMetrics,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new HutbitAdapter();
}

describe('HutbitAdapter (#254)', () => {
  describe('matches() and registry resolution', () => {
    it('matches the advertised "Hutbit Scale" name (case-insensitive)', () => {
      expectMatches(makeAdapter(), {
        yes: ['Hutbit Scale', 'hutbit scale', 'HUTBIT'],
        no: ['Robi S9', 'icomon', 'swan123', 'QN-Scale', ''],
      });
    });

    it('resolves "Hutbit Scale" to the Hutbit adapter, not MGB/Robi', () => {
      const matched = adapters.find((a) => a.matches(mockPeripheral('Hutbit Scale', ['ffb0'])));
      expect(matched?.name).toBe('Hutbit');
    });

    it('does not claim a nameless FFB0 device (left to Robi/MGB)', () => {
      const info = mockPeripheral('', [uuid16(0xffb0)], undefined, [
        uuid16(0xffb1),
        uuid16(0xffb2),
      ]);
      expect(makeAdapter().matches(info)).toBe(false);
    });
  });

  describe('OEM/rebranded advertisement (SWAN, #278)', () => {
    // Real capture: Lefu OEM stock branding. Manufacturer data 0x02AC carries
    // the device's MAC reversed (03:B3:EC:93:B8:7E) + status byte (01 = active).
    // Over the ESPHome proxy the local name arrives empty.
    function swanAdvert(name = 'SWAN', charUuids?: string[]): BleDeviceInfo {
      return {
        localName: name,
        serviceUuids: [uuid16(0xd618), uuid16(0xffb0)],
        manufacturerData: { id: 0x02ac, data: Buffer.from('7eb893ecb30301', 'hex') },
        ...(charUuids ? { characteristicUuids: charUuids } : {}),
      };
    }

    it('claims the SWAN-branded advert via the 0x02AC manufacturer signature', () => {
      expect(makeAdapter().matches(swanAdvert())).toBe(true);
      expect(hasHutbitSignature(swanAdvert())).toBe(true);
    });

    it('claims the same advert with an empty name (ESPHome proxy transport)', () => {
      expect(makeAdapter().matches(swanAdvert(''))).toBe(true);
    });

    it('accepts the idle-status variant (payload ends 0x00)', () => {
      const idle = swanAdvert();
      idle.manufacturerData = { id: 0x02ac, data: Buffer.from('7eb893ecb30300', 'hex') };
      expect(makeAdapter().matches(idle)).toBe(true);
    });

    it('rejects 0x02AC data that does not fit the signature shape', () => {
      const wrongLen = swanAdvert('');
      wrongLen.manufacturerData = { id: 0x02ac, data: Buffer.from('7eb893ecb303', 'hex') };
      expect(makeAdapter().matches(wrongLen)).toBe(false);

      const wrongStatus = swanAdvert('');
      wrongStatus.manufacturerData = { id: 0x02ac, data: Buffer.from('7eb893ecb303ff', 'hex') };
      expect(makeAdapter().matches(wrongStatus)).toBe(false);
    });

    it('registry resolves the SWAN broadcast to Hutbit, not MGB', () => {
      expect(resolveAdapter(swanAdvert(), adapters)?.name).toBe('Hutbit');
      expect(resolveAdapter(swanAdvert(''), adapters)?.name).toBe('Hutbit');
    });

    it('post-discovery re-resolution stays on Hutbit — Robi S9 must not steal FFB3 (#278)', () => {
      // Mirrors the esphome-proxy watcher: after GATT discovery the device info
      // gains characteristicUuids (the Hutbit exposes an unused FFB3) and has no
      // usable name. Without the Robi-side signature guard, Robi S9 (prio 40)
      // would claim this and replay a handshake the Hutbit rejects.
      const postDiscovery = swanAdvert('', [uuid16(0xffb1), uuid16(0xffb2), uuid16(0xffb3)]);
      expect(resolveAdapter(postDiscovery, adapters)?.name).toBe('Hutbit');
    });

    it('does not shadow the Robi S9: nameless FFB0+FFB3 without the signature still resolves to Robi', () => {
      const robiLike: BleDeviceInfo = {
        localName: '',
        serviceUuids: [uuid16(0xffb0)],
        characteristicUuids: [uuid16(0xffb1), uuid16(0xffb2), uuid16(0xffb3)],
      };
      expect(resolveAdapter(robiLike, adapters)?.name).toBe('Robi S9');
    });
  });

  describe('onConnected() handshake', () => {
    it('replays the captured 8-byte FFB1 handshake in order', async () => {
      const writes: Buffer[] = [];
      const ctx = {
        profile: defaultProfile(),
        deviceAddress: 'AA',
        availableChars: new Set<string>(),
        write: vi.fn(async (_uuid: string, data: number[] | Buffer) => {
          writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        }),
        read: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as ConnectionContext;

      await makeAdapter().onConnected(ctx);

      expect(writes).toHaveLength(5);
      expect(writes[0].toString('hex')).toBe('ac02fa010000ccc7');
      expect(writes[4].toString('hex')).toBe('ac02fe060000ccd0');
      // Every handshake frame is a valid 8-byte AC02 frame with a good checksum.
      for (const w of writes) {
        expect(w).toHaveLength(8);
        expect(w[0]).toBe(0xac);
        expect(w[1]).toBe(0x02);
        expect((w[2] + w[3] + w[4] + w[5] + w[6]) & 0xff).toBe(w[7]);
      }
    });
  });

  describe('parseNotification()', () => {
    it('decodes 84.1 kg from the real stable FFB2 frame (#254)', () => {
      const adapter = makeAdapter();
      // ac02 0349 0000 ca 16 → 0x0349 = 841 → 84.1 kg, STATUS 0xCA (stable)
      const reading = parseOk(adapter, Buffer.from('ac0203490000ca16', 'hex'), {
        weight: 84.1,
        impedance: 0,
      });
      expect(adapter.isComplete(reading)).toBe(true);
    });

    it('ignores measuring (0xCE) frames as progress only', () => {
      // ac02 0348 0000 ce 19 → valid checksum, but STATUS 0xCE = unstable
      expect(makeAdapter().parseNotification(Buffer.from('ac0203480000ce19', 'hex'))).toBeNull();
    });

    it('rejects a frame with a bad checksum', () => {
      expect(makeAdapter().parseNotification(Buffer.from('ac0203490000ca00', 'hex'))).toBeNull();
    });

    it('rejects wrong header / wrong length frames', () => {
      const a = makeAdapter();
      expect(a.parseNotification(Buffer.from('bb0203490000ca16', 'hex'))).toBeNull();
      expect(a.parseNotification(Buffer.from('ac0203490000ca', 'hex'))).toBeNull();
    });
  });

  describe('computeMetrics()', () => {
    it('derives a valid body-composition payload (weight-only → BIA/BMI)', () => {
      const adapter = makeAdapter();
      const reading = parseOk(adapter, Buffer.from('ac0203490000ca16', 'hex'));
      const payload = expectValidMetrics(adapter, reading);
      expect(payload.weight).toBeCloseTo(84.1, 2);
      expect(payload.impedance).toBe(0);
    });
  });
});
