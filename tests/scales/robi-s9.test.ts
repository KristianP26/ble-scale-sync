import { describe, it, expect, vi } from 'vitest';
import { RobiS9Adapter } from '../../src/scales/robi-s9.js';
import { adapters } from '../../src/scales/index.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import { bleLog } from '../../src/ble/types.js';
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

    // Healthkeep S11, real frames from a v1.37.0 DEBUG log (byte for byte).
    // Weigh-in 1: A2 settled (state 03) at 00 e8 08 = 59.40 kg, A7 stamped 0x6adf6a46.
    // Weigh-in 2, right after an add-on restart: A2 00 e7 72 = 59.25 kg, A7 0x6adf7986.
    const S11_A2_1_SETTLING = '470700a2010000e8080000000000000000000013'; // state 01
    const S11_A2_1_SETTLED = '6a0700a2030000e8080000000000000000000015'; // state 03
    const S11_A2_1_OFF = '000700a2000000e8080000000000000000000012'; // state 00, stepped off
    const S11_A2_2 = '010700a2030000e772000000000000000000001e'; // state 03
    const S11_A7_1 = '412300a76adf6a462500e808000a002201560119';
    const S11_A7_2 = '472300a76adf79862500e772000a003b01450119';
    const S11_A7_P1 = '4123013c012c0122001d012b0114010700ff1203';
    const S11_A7_P2 = '41230213725d0000000000000000000000000002';
    const feed = (adapter: RobiS9Adapter, uuid: number, hex: string) =>
      adapter.parseCharNotification(uuid16(uuid), Buffer.from(hex, 'hex'));

    it('reads the Healthkeep S11 A7 record when it matches the settled A2 weight', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      expect(feed(adapter, 0xffb2, S11_A2_2)).toBeNull();
      const reading = feed(adapter, 0xffb3, S11_A7_2);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(59.25, 2);
      expect(reading!.impedance).toBe(0);
      expect(adapter.isComplete(reading!)).toBe(true);
      expect(adapter.dedupMark()).toBe(0x6adf7986);
    });

    it('takes the A2 weight only from a settled frame', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      // A state-01 frame with the record's weight is not enough on its own.
      expect(feed(adapter, 0xffb2, S11_A2_1_SETTLING)).toBeNull();
      expect(feed(adapter, 0xffb3, S11_A7_1)).toBeNull();
      // The settled frame is, and a state-00 frame after stepping off does not
      // replace it.
      expect(feed(adapter, 0xffb2, S11_A2_1_SETTLED)).toBeNull();
      expect(feed(adapter, 0xffb2, S11_A2_1_OFF)).toBeNull();
      expect(feed(adapter, 0xffb3, S11_A7_1)!.weight).toBeCloseTo(59.4, 2);
    });

    it('ignores an S11 A7 record that arrives before any A2 frame', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      expect(feed(adapter, 0xffb3, S11_A7_1)).toBeNull();
    });

    it('ignores an S11 A7 record from an earlier weigh-in', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      expect(feed(adapter, 0xffb2, S11_A2_2)).toBeNull();
      expect(feed(adapter, 0xffb3, S11_A7_1)).toBeNull();
      // The record of this weigh-in still completes the session.
      expect(feed(adapter, 0xffb3, S11_A7_2)!.weight).toBeCloseTo(59.25, 2);
    });

    it('does not export the same S11 A7 record twice', () => {
      // Guards a possible replay: the scale still awake at the next connection,
      // offering the same record with its A2 frames still on that weight.
      const adapter = makeAdapter();
      adapter.onSessionStart();
      feed(adapter, 0xffb2, S11_A2_2);
      expect(feed(adapter, 0xffb3, S11_A7_2)).not.toBeNull();
      adapter.onSessionStart();
      expect(feed(adapter, 0xffb2, S11_A2_2)).toBeNull();
      expect(feed(adapter, 0xffb3, S11_A7_2)).toBeNull();
    });

    it('keeps the exported stamp across a restart through the dedup mark', () => {
      const before = makeAdapter();
      before.onSessionStart();
      feed(before, 0xffb2, S11_A2_2);
      feed(before, 0xffb3, S11_A7_2);
      const mark = before.dedupMark();
      expect(mark).toBe(0x6adf7986);

      const after = makeAdapter();
      after.restoreDedupMark(mark!);
      after.onSessionStart();
      feed(after, 0xffb2, S11_A2_2);
      expect(feed(after, 0xffb3, S11_A7_2)).toBeNull();
    });

    it('restores only a mark that can be an A7 stamp', () => {
      const adapter = makeAdapter();
      expect(adapter.dedupMark()).toBeUndefined();
      for (const bad of [0, -1, 1.5, 2 ** 32, Number.NaN]) adapter.restoreDedupMark(bad);
      expect(adapter.dedupMark()).toBeUndefined();
    });

    it('does not carry the A2 weight into the next session', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      feed(adapter, 0xffb2, S11_A2_2);
      adapter.onSessionStart();
      expect(feed(adapter, 0xffb3, S11_A7_2)).toBeNull();
    });

    it('ignores the follow-up packets of the S11 A7 record', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      expect(feed(adapter, 0xffb3, S11_A7_P1)).toBeNull();
      expect(feed(adapter, 0xffb3, S11_A7_P2)).toBeNull();
    });

    it('ignores A2 live frames (no final result yet)', () => {
      const adapter = makeAdapter();
      const a2 = Buffer.from('1d0700a20400012c000000000000000000000013', 'hex');
      expect(adapter.parseCharNotification(uuid16(0xffb2), a2)).toBeNull();
    });
  });

  describe('length-prefixed frames (JEETIF2421, #540)', () => {
    // Reporter-edited frames from the body of #540 (JEETIF2421 over an ESPHome proxy): personal
    // measurement fields replaced and trailers recomputed by the reporter (low 5 bits only: the
    // scale's own A7 trailer may carry bit 5). Length, type, state and weight offsets are as the
    // scale sent them. Replace with the raw frames when they arrive.
    const J_A2 = '66000700a2030001252a0015'; // 12 B, state 03, 75.05 kg
    const J_A7 = 'a6002300a76955b9002501252a000a0000000000000000000000000000000000000000000000001d'; // 40 B
    const S11_A7_PART_1 = '4123013c012c0122001d012b0114010700ff1203';

    it('logs every frame in full before deciding whether it can decode it', () => {
      const spy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      spy.mockClear(); // spyOn returns the existing mock when already spied
      const adapter = makeAdapter();
      adapter.onSessionStart();
      const frames = [
        J_A2,
        J_A7,
        J_A7.slice(0, 40), // the first 20 bytes of the A7
        S11_A7_PART_1,
        '0102030405',
      ];
      for (const hex of frames)
        adapter.parseCharNotification(uuid16(0xffb2), Buffer.from(hex, 'hex'));
      const lines = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith('Robi S9 frame:'));
      expect(lines).toEqual(frames.map((hex) => `Robi S9 frame: ${hex}`));
      spy.mockRestore();
    });

    const J_A2_SETTLING = '66000700a2010001252a0013'; // the reporter's own state-01 variant
    const J_A7_BIT5 = `${J_A7.slice(0, -2)}3d`; // trailer with bit 5 set, as the spec's unit sends
    const S11_A2_SETTLED = '010700a2030000e772000000000000000000001e';
    const feed = (adapter: RobiS9Adapter, uuid: number, hex: string) =>
      adapter.parseCharNotification(uuid16(uuid), Buffer.from(hex, 'hex'));
    const trailerOk = (hex: string, from: number) => {
      const b = Buffer.from(hex, 'hex');
      let sum = 0;
      for (let i = from; i < b.length - 1; i++) sum += b[i];
      return (sum & 0x1f) === (b[b.length - 1] & 0x1f);
    };

    it('reads the A7 of the length-prefixed layout after its settled A2', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      expect(feed(adapter, 0xffb2, J_A2)).toBeNull();
      const reading = feed(adapter, 0xffb3, J_A7);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(75.05, 2);
      expect(reading!.impedance).toBe(0);
      expect(adapter.isComplete(reading!)).toBe(true);
      expect(adapter.dedupMark()).toBe(0x6955b900);
    });

    it('takes the A7 only after a settled A2 of the same weight', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      expect(feed(adapter, 0xffb3, J_A7)).toBeNull();
      expect(feed(adapter, 0xffb2, J_A2_SETTLING)).toBeNull();
      expect(feed(adapter, 0xffb3, J_A7)).toBeNull();
      expect(feed(adapter, 0xffb2, J_A2)).toBeNull();
      expect(feed(adapter, 0xffb3, J_A7)!.weight).toBeCloseTo(75.05, 2);
    });

    it('does not export the same length-prefixed A7 twice', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      feed(adapter, 0xffb2, J_A2);
      expect(feed(adapter, 0xffb3, J_A7)).not.toBeNull();
      adapter.onSessionStart();
      expect(feed(adapter, 0xffb2, J_A2)).toBeNull();
      expect(feed(adapter, 0xffb3, J_A7)).toBeNull();
    });

    it('does not read the A7 when its length field disagrees with its size', () => {
      // Guards a fix that shifts the offsets without checking the length: a cut frame
      // (MTU 23 fragment) must be logged and ignored, never decoded on a guess.
      const adapter = makeAdapter();
      adapter.onSessionStart();
      feed(adapter, 0xffb2, J_A2);
      expect(feed(adapter, 0xffb3, J_A7.slice(0, 40))).toBeNull();
      expect(feed(adapter, 0xffb3, `${J_A7}00`)).toBeNull();
    });

    it('has valid trailers on the edited frames and on a classic frame (fixture check)', () => {
      expect(trailerOk(J_A2, 4)).toBe(true);
      expect(trailerOk(J_A2_SETTLING, 4)).toBe(true);
      expect(trailerOk(J_A7, 4)).toBe(true);
      expect(trailerOk(J_A7_BIT5, 4)).toBe(true);
      expect(trailerOk(S11_A2_SETTLED, 3)).toBe(true);
    });

    it('does not depend on the trailer, including bit 5 set', () => {
      // The trailer variants follow the patch posted in #540.
      const adapter = makeAdapter();
      adapter.onSessionStart();
      feed(adapter, 0xffb2, J_A2);
      expect(feed(adapter, 0xffb3, J_A7_BIT5)!.weight).toBeCloseTo(75.05, 2);
    });

    it('does not decode a length-prefixed A3: no source shows one', () => {
      const adapter = makeAdapter();
      adapter.onSessionStart();
      feed(adapter, 0xffb2, J_A2);
      // Non-zero bytes where the 20-byte A3 keeps its weight.
      expect(feed(adapter, 0xffb3, '66000700a301252a00000013')).toBeNull();
    });

    it('never throws on length-consistent frames that are too short for their type', () => {
      for (const type of [0xa2, 0xa3, 0xa7, 0xaa]) {
        for (let n = 6; n <= 45; n++) {
          const adapter = makeAdapter();
          adapter.onSessionStart();
          const b = Buffer.alloc(n, 0xff);
          b[0] = 0x66;
          b.writeUInt16BE(n - 5, 1);
          b[3] = 0x00;
          b[4] = type;
          if (type === 0xa2) b[5] = 0x03;
          expect(() => adapter.parseCharNotification(uuid16(0xffb2), b)).not.toThrow();
          expect(adapter.parseCharNotification(uuid16(0xffb3), b)).toBeNull();
        }
      }
    });

    it('reports a frame in neither layout once per session', () => {
      const spy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      spy.mockClear(); // spyOn returns the existing mock when already spied
      const notices = () => spy.mock.calls.filter((c) => String(c[0]).includes('not decoding'));
      const adapter = makeAdapter();
      adapter.onSessionStart();
      feed(adapter, 0xffb2, J_A2);
      feed(adapter, 0xffb3, J_A7);
      feed(adapter, 0xffb2, S11_A2_SETTLED);
      expect(notices()).toHaveLength(0);
      feed(adapter, 0xffb3, J_A7.slice(0, 40));
      feed(adapter, 0xffb3, S11_A7_PART_1);
      feed(adapter, 0xffb3, '0102030405');
      expect(notices()).toHaveLength(1);
      adapter.onSessionStart();
      feed(adapter, 0xffb3, '0102030405');
      expect(notices()).toHaveLength(2);
      spy.mockRestore();
    });
  });
});
