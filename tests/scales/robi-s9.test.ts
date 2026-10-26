import { describe, it, expect, vi } from 'vitest';
import { RobiS9Adapter } from '../../src/scales/robi-s9.js';
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
    it('replays the captured FFB1 handshake in order (seq 00..0a)', async () => {
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

      expect(writes).toHaveLength(11);
      // First frame is the B0 hello, last is B0 sub-code 02; seq increments 00..0a.
      expect(writes[0].toString('hex')).toBe('000300b000000000000000000000000000000010');
      writes.forEach((w, i) => expect(w[0]).toBe(i));
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
      // Impedance offset is not yet decoded; emitted as 0 -> BIA fallback.
      expect(reading!.impedance).toBe(0);
      expect(adapter.isComplete(reading!)).toBe(true);
    });

    it('extracts the weight from the Healthkeep S11 A7 result record', () => {
      const adapter = makeAdapter();
      // Shape of a real HEALTHKEEP-S11 capture (v1.37.0, DEBUG) with the
      // timestamp and weight replaced: [seq][23][00][a7][ts u32][1 byte]
      // [weight u24 BE grams][...]; 01 24 f8 = 75000 g = 75.00 kg.
      const a7 = Buffer.from('412300a76a000000250124f8000a002201560119', 'hex');
      const reading = adapter.parseCharNotification(uuid16(0xffb3), a7);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(75.0, 2);
      expect(reading!.impedance).toBe(0);
      expect(adapter.isComplete(reading!)).toBe(true);
    });

    it('does not export the same S11 A7 record twice across sessions', () => {
      const adapter = makeAdapter();
      const a7 = Buffer.from('412300a76a000000250124f8000a002201560119', 'hex');
      adapter.onSessionStart();
      expect(adapter.parseCharNotification(uuid16(0xffb3), a7)).not.toBeNull();
      // Next connection: the unacknowledged record is offered again.
      adapter.onSessionStart();
      const resend = Buffer.from(a7);
      resend[0] = 0x42;
      expect(adapter.parseCharNotification(uuid16(0xffb3), resend)).toBeNull();
      // A new weigh-in has a new timestamp.
      adapter.onSessionStart();
      const next = Buffer.from(a7);
      next.writeUInt32BE(0x6a000100, 4);
      expect(adapter.parseCharNotification(uuid16(0xffb3), next)).not.toBeNull();
    });

    it('ignores the follow-up packets of the S11 A7 record', () => {
      const adapter = makeAdapter();
      const p1 = Buffer.from('4123013c012c0122001d012b0114010700ff1203', 'hex');
      const p2 = Buffer.from('41230213725d0000000000000000000000000002', 'hex');
      expect(adapter.parseCharNotification(uuid16(0xffb3), p1)).toBeNull();
      expect(adapter.parseCharNotification(uuid16(0xffb3), p2)).toBeNull();
    });

    it('ignores S11 A2 live frames', () => {
      const adapter = makeAdapter();
      const a2 = Buffer.from('250700a2010001244c0000000000000000000017', 'hex');
      expect(adapter.parseCharNotification(uuid16(0xffb2), a2)).toBeNull();
    });

    it('ignores A2 live frames (no final result yet)', () => {
      const adapter = makeAdapter();
      const a2 = Buffer.from('1d0700a20400012c000000000000000000000013', 'hex');
      expect(adapter.parseCharNotification(uuid16(0xffb2), a2)).toBeNull();
    });
  });
});
