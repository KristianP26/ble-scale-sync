import { describe, it, expect, vi } from 'vitest';
import { RobiS9Adapter, robiS9Trailer } from '../../src/scales/robi-s9.js';
import { adapters } from '../../src/scales/index.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { mockPeripheral, defaultProfile } from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new RobiS9Adapter();
}

describe('RobiS9Adapter', () => {
  describe('matches() and registry resolution (#228)', () => {
    it('matches a "Robi S9" name', () => {
      expect(makeAdapter().matches(mockPeripheral('Robi S9'))).toBe(true);
    });

    it('resolves "Robi S9" to the Robi adapter, not MGB', () => {
      const matched = adapters.find((a) => a.matches(mockPeripheral('Robi S9')));
      expect(matched?.name).toBe('Robi S9');
    });

    it('matches a nameless device with FFB0 + FFB3 characteristic', () => {
      const info = mockPeripheral('', [uuid16(0xffb0)], undefined, [
        uuid16(0xffb1),
        uuid16(0xffb2),
        uuid16(0xffb3),
      ]);
      expect(makeAdapter().matches(info)).toBe(true);
    });

    it('does not match an MGB scale (Swan/Icomon/YG)', () => {
      expect(makeAdapter().matches(mockPeripheral('swan123'))).toBe(false);
      expect(makeAdapter().matches(mockPeripheral('icomon'))).toBe(false);
      const mgb = adapters.find((a) => a.matches(mockPeripheral('swan123')));
      expect(mgb?.name).toBe('MGB (Swan/Icomon/YG)');
    });

    it('does not steal a nameless FFB0 device without the FFB3 result char', () => {
      const info = mockPeripheral('', [uuid16(0xffb0)], undefined, [
        uuid16(0xffb1),
        uuid16(0xffb2),
      ]);
      expect(makeAdapter().matches(info)).toBe(false);
    });
  });

  describe('onConnected() handshake', () => {
    it('encodes the profile and sequence anchor in the handshake', async () => {
      const writes: Buffer[] = [];
      const ctx = {
        profile: defaultProfile({ height: 180, age: 49, gender: 'female' }),
        deviceAddress: 'AA',
        availableChars: new Set<string>(),
        write: vi.fn(async (_uuid: string, data: number[] | Buffer) => {
          writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        }),
        read: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as ConnectionContext;

      const adapter = makeAdapter();
      adapter.parseCharNotification(
        uuid16(0xffb3),
        Buffer.from('5e0800a180711e5a000705000000000000000016', 'hex'),
      );
      await adapter.onConnected(ctx);

      expect(writes).toHaveLength(5);
      writes.forEach((w) => expect(w).toHaveLength(20));
      writes.forEach((w, i) => expect(w[0]).toBe(i));
      expect(writes[0][3]).toBe(0xb0);
      expect(writes[1][3]).toBe(0xba);
      expect(writes[2][3]).toBe(0xba);
      expect(writes[3][3]).toBe(0xba);
      expect(writes[4][3]).toBe(0xb0);
      expect(writes[0][4]).toBe(0x5e);
      expect(writes[2][14]).toBe(180);
      expect(writes[2][17]).toBe(49);
      writes.forEach((frame) => expect(frame[19]).toBe(robiS9Trailer(frame)));
      expect(writes[4][4]).toBe(0x62);
    });

    it('computes the captured trailer rule', () => {
      const frame = Buffer.from('021000ba6aaec00e007800000000aa00009d2f0e', 'hex');
      expect(robiS9Trailer(frame)).toBe(0x0e);
    });
  });

  describe('parseCharNotification()', () => {
    it('extracts 77.25 kg from the real A3 final frame (#248)', () => {
      const adapter = makeAdapter();
      // Reporter @vanboxel HCI/DEBUG capture, v1.18.0. Weight is 3-byte BE grams
      // at offset 5: 01 2d c2 = 77250 g = 77.25 kg.
      const a3 = Buffer.from('030800a300012dc2000000000000000000000013', 'hex');
      const reading = adapter.parseCharNotification(uuid16(0xffb3), a3);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(77.25, 2);
      expect(reading!.impedance).toBe(0);
      expect(adapter.isComplete(reading!)).toBe(true);
    });

    it('extracts impedance from the A3 final frame', () => {
      const adapter = makeAdapter();
      const a3 = Buffer.from('030800a300012dc24801ed0000000000000013', 'hex');
      const reading = adapter.parseCharNotification(uuid16(0xffb3), a3);

      expect(reading?.impedance).toBe(493);
    });

    it('uses impedance for BIA and falls back to BMI without it', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const withImpedance = adapter.computeMetrics({ weight: 77.25, impedance: 493 }, profile);
      const withoutImpedance = adapter.computeMetrics({ weight: 77.25, impedance: 0 }, profile);

      expect(withImpedance.bodyFatPercent).not.toBe(withoutImpedance.bodyFatPercent);
    });

    it('ignores A2 live frames (no final result yet)', () => {
      const adapter = makeAdapter();
      const a2 = Buffer.from('1d0700a20400012c000000000000000000000013', 'hex');
      expect(adapter.parseCharNotification(uuid16(0xffb2), a2)).toBeNull();
    });

    it('rejects a frame with an invalid trailer', () => {
      const adapter = makeAdapter();
      const a3 = Buffer.from('620800a30000fa325201e6000000000000000008', 'hex');
      a3[19] ^= 0x01;

      expect(adapter.parseCharNotification(uuid16(0xffb3), a3)).toBeNull();
    });
  });
});
