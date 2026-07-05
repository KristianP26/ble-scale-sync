import { describe, it, expect, vi } from 'vitest';
import { HutbitAdapter } from '../../src/scales/hutbit.js';
import { adapters } from '../../src/scales/index.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
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
