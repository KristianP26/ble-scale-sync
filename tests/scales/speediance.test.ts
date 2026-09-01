import { describe, it, expect, vi } from 'vitest';
import { SpeedianceAdapter } from '../../src/scales/speediance.js';
import { adapters } from '../../src/scales/index.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { mockPeripheral, defaultProfile } from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new SpeedianceAdapter();
}

describe('SpeedianceAdapter', () => {
  describe('matches() and registry resolution', () => {
    it('matches a "SPEED_S_*" advertised name', () => {
      expect(makeAdapter().matches(mockPeripheral('SPEED_S_E60EJE'))).toBe(true);
    });

    it('resolves "SPEED_S_*" to Speediance, not Robi (priority 45 > 40)', () => {
      const matched = adapters.find((a) => a.matches(mockPeripheral('SPEED_S_E60EJE')));
      expect(matched?.name).toBe('Speediance');
    });

    it('does not claim a plain "Robi S9" device', () => {
      expect(makeAdapter().matches(mockPeripheral('Robi S9'))).toBe(false);
    });
  });

  describe('onConnected() handshake', () => {
    it('replays the captured FFB1 handshake in order (16 frames, seq 00..06)', async () => {
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

      expect(writes).toHaveLength(16);
      // First frame is the B0 hello; the b8 identity + b4 frames that follow are
      // what arm the impedance phase (the Robi handshake omits them).
      expect(writes[0].toString('hex')).toBe('000300b000000000000000000000000000000010');
      expect(writes.some((w) => w[3] === 0xb8)).toBe(true); // timestamped identity
      expect(writes.some((w) => w[3] === 0xb4)).toBe(true);
    });
  });

  describe('parseCharNotification()', () => {
    it('extracts weight and whole-body impedance from the real A7 part-00 frame', () => {
      const adapter = makeAdapter();
      // PacketLogger capture of the Speediance app, full weigh-in (barefoot +
      // handles). A7 part-00: weight u24 BE grams @ off 9 (01 2a 3e = 76.350 kg),
      // whole-body impedance u16 LE @ off 15 (ce 0b = 3022).
      const a7 = Buffer.from('4d2300a76a96d1ff25012a3e000a00ce0b970b2a', 'hex');
      const reading = adapter.parseCharNotification(uuid16(0xffb3), a7);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(76.35, 2);
      expect(reading!.impedance).toBe(3022);
      expect(adapter.isComplete(reading!)).toBe(true);
    });

    it('ignores A2 live frames (weight still settling, no final result)', () => {
      const adapter = makeAdapter();
      const a2 = Buffer.from('071000a2012501252a0000000000000000000038', 'hex');
      expect(adapter.parseCharNotification(uuid16(0xffb2), a2)).toBeNull();
    });
  });
});
