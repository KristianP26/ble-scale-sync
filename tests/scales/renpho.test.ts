import { describe, it, expect, vi } from 'vitest';
import { RenphoScaleAdapter } from '../../src/scales/renpho.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import { isHistoricalReading } from '../../src/interfaces/reading-time.js';
import { QnScaleAdapter } from '../../src/scales/qn-scale/index.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';
import {
  AR003_ADVERT,
  AR003_ADVERT_NODE_BLE,
  AR003_CHARS,
  AR003_COMPOSITION,
  AR003_LIVE,
  AR003_MSD,
  AR003_SERVICES,
  AR003_WEIGH_IN,
  AR003_WEIGH_IN_NOW,
  ar003CharsWithout,
} from '../helpers/renpho-a-r003.js';
import { ADVERT_501 } from '../fixtures/qn/cs10g-501.js';
import { session as ar003 } from '../fixtures/renpho/a-r003.js';
import { replaySession } from '../helpers/replay/session.js';

const CHR_WEIGHT = uuid16(0x2a9d);
const CHR_BODYCOMP = uuid16(0x2a9c);
const CHR_UCP = uuid16(0x2a9f);
const CHR_VENDOR_NOTIFY = uuid16(0xffe1);
const CHR_VENDOR_WRITE = uuid16(0xffe2);
const CHR_GENDER = uuid16(0x2a8c);
const CHR_HEIGHT = uuid16(0x2a8e);
const CHR_DOB = uuid16(0x2a85);
const CHR_AGE = uuid16(0x2a80);
const CHR_VENDOR_2AFF = uuid16(0x2aff);

// Live frames decoded from the physical-device btsnoop capture.
// Weight frame 1374: flags 0x4E, raw 0x076A = 1898 → 94.9 kg (×0.05).
const WSS_FRAME = Buffer.from('4e6a07ea0707040c1a06aa00000000', 'hex');
// Body-comp packet 2 (frame 1477), in Renpho's own layout, not SIG (#507): its
// first two bytes are the body water. Read as flags 0x020C they put an
// "impedance" at [7..8], 0x0D00 → 332.8 Ω, from the wrong offset.
const BCS_PACKET2 = Buffer.from('0c02f901f70144000dec00a500290091020600', 'hex');
// Frame 1374 without its flags' time bit: 94.9 kg, no SIG Date Time.
const WSS_NO_TIME = Buffer.from('006a07', 'hex');
// Made up: a single SIG packet (flags 0x0202, no bit 12) whose fields fill it,
// Time Stamp 2026-07-04 12:26:08 and impedance 0x0D00 (tests/fixtures/renpho/es-wbe28.ts).
const BCS_SINGLE_SIG = Buffer.from('0202f901ea0707040c1a08000d', 'hex');

const hex = (h: string): Buffer => Buffer.from(h, 'hex');

function makeAdapter() {
  return new RenphoScaleAdapter();
}

function atClock(now: Date | number, fn: () => void): void {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    fn();
  } finally {
    vi.useRealTimers();
  }
}

/** Run at the time the capture's weight frame is stamped, so it reads as live. */
const atCaptureTime = (fn: () => void): void => atClock(new Date(2026, 6, 4, 12, 26, 10), fn);
/** Run just after the A-R003 weigh-in (tests/helpers/renpho-a-r003.ts), so it reads as live. */
const atAr003Time = (fn: () => void): void => atClock(AR003_WEIGH_IN_NOW, fn);

const ALL_CHARS = new Set([
  CHR_WEIGHT,
  CHR_BODYCOMP,
  CHR_UCP,
  CHR_VENDOR_NOTIFY,
  CHR_VENDOR_WRITE,
  CHR_GENDER,
  CHR_HEIGHT,
  CHR_DOB,
  CHR_AGE,
  CHR_VENDOR_2AFF,
]);

function makeCtx(over: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    profile: defaultProfile(),
    deviceAddress: '',
    availableChars: ALL_CHARS,
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    subscribe: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as ConnectionContext;
}

describe('RenphoScaleAdapter', () => {
  describe('matches()', () => {
    it('matches a real ES-WBE28 advert (renpho + SIG WSS/BCS, no QN UUID)', () => {
      expect(makeAdapter().matches(mockPeripheral('Renpho-Scale', ['181b', '181d']))).toBe(true);
    });
    it('matches case-insensitively without QN services', () => {
      expect(makeAdapter().matches(mockPeripheral('RENPHO', []))).toBe(true);
    });
    it.each(['ffe0', 'fff0', '0000ffe000001000800000805f9b34fb'])(
      'rejects renpho advertising QN service %s',
      (svc) => {
        expect(makeAdapter().matches(mockPeripheral('Renpho Scale', [svc]))).toBe(false);
      },
    );
    it('does not match an unrelated name', () => {
      expect(makeAdapter().matches(mockPeripheral('Yunmai ISM', []))).toBe(false);
    });

    // D-04: after GATT discovery the device carries the 0xFFE0 service that
    // hosts its vendor pair, which the service rule reads as QN. Its
    // characteristics (ALL_CHARS, from the #267 capture) say otherwise: the SIG
    // consent pair, and no QN write characteristic (0xFFF2 / 0xFFE3).
    it('claims the discovered ES-WBE28 on its characteristics, and QN declines it', () => {
      const discovered = {
        localName: 'Renpho-Scale',
        serviceUuids: [0x181b, 0x181d, 0x181c, 0xffe0].map(uuid16),
        characteristicUuids: [...ALL_CHARS],
      };
      expect(makeAdapter().matches(discovered)).toBe(true);
      expect(new QnScaleAdapter().matches(discovered)).toBe(false);
    });

    it('leaves a renpho device with the QN characteristic pair to QN', () => {
      const qn = {
        localName: 'Renpho',
        serviceUuids: [uuid16(0xfff0)],
        characteristicUuids: [0xfff1, 0xfff2, 0x2a9d, 0x2a9f].map(uuid16),
      };
      expect(makeAdapter().matches(qn)).toBe(false);
      expect(new QnScaleAdapter().matches(qn)).toBe(true);
    });

    // #507: the A-R003 advertises no name (tests/helpers/renpho-a-r003.ts).
    describe('nameless (Renpho A-R003, #507)', () => {
      const withMsd = (data: Buffer) => ({
        ...AR003_ADVERT,
        manufacturerData: { id: 0xffff, data },
      });

      it('claims the advertisement, with 0x181D or with no services reported (node-ble)', () => {
        expect(makeAdapter().matches(AR003_ADVERT)).toBe(true);
        expect(makeAdapter().matches(AR003_ADVERT_NODE_BLE)).toBe(true);
        expect(makeAdapter().matches({ ...AR003_ADVERT, serviceUuids: [uuid16(0x181d)] })).toBe(
          true,
        );
      });

      it('claims the characteristics: chars only (proxies) and with the services (noble, node-ble)', () => {
        const a = makeAdapter();
        expect(a.matches({ ...AR003_ADVERT, characteristicUuids: AR003_CHARS })).toBe(true);
        expect(
          a.matches({
            ...AR003_ADVERT,
            serviceUuids: ['181d', ...AR003_SERVICES],
            characteristicUuids: AR003_CHARS,
          }),
        ).toBe(true);
        // mqtt-proxy autonomous connect without a cached advertisement.
        expect(
          a.matches({ localName: '', serviceUuids: [], characteristicUuids: AR003_CHARS }),
        ).toBe(true);
      });

      it('claims a nameless ES-WBE28 on the #267 characteristics', () => {
        expect(
          makeAdapter().matches({
            localName: '',
            serviceUuids: [],
            characteristicUuids: [...ALL_CHARS],
          }),
        ).toBe(true);
      });

      // QN outranks Renpho, so these are what keep the A-R003 here (its
      // hasSigConsent guard); registry-check.ts notes it at the QN > Renpho order.
      it('leaves the A-R003 to Renpho: QN declines its advertisement and every shape after discovery', () => {
        const qn = new QnScaleAdapter();
        expect(qn.matches(AR003_ADVERT)).toBe(false);
        // The proxies: characteristics only.
        expect(qn.matches({ ...AR003_ADVERT, characteristicUuids: AR003_CHARS })).toBe(false);
        // noble: advertised and discovered services together.
        expect(
          qn.matches({
            ...AR003_ADVERT,
            serviceUuids: ['181d', ...AR003_SERVICES],
            characteristicUuids: AR003_CHARS,
          }),
        ).toBe(false);
        // node-ble: discovered services only.
        expect(
          qn.matches({
            ...AR003_ADVERT_NODE_BLE,
            serviceUuids: AR003_SERVICES,
            characteristicUuids: AR003_CHARS,
          }),
        ).toBe(false);
      });

      it.each([
        ['another address', { address: '02:00:00:00:00:02' }],
        ['no address', { address: undefined }],
        ['an address that is not a MAC (macOS)', { address: '<unknown>' }],
        ['services without 0x181D', { serviceUuids: ['181b'] }],
      ])('declines the advertisement heard with %s', (_label, over) => {
        expect(makeAdapter().matches({ ...AR003_ADVERT, ...over })).toBe(false);
      });

      it('declines the payload under another company id, or one byte longer or shorter', () => {
        const a = makeAdapter();
        expect(
          a.matches({ ...AR003_ADVERT, manufacturerData: { id: 0x1a10, data: AR003_MSD } }),
        ).toBe(false);
        expect(a.matches(withMsd(Buffer.concat([AR003_MSD, Buffer.from([0x00])])))).toBe(false);
        expect(a.matches(withMsd(AR003_MSD.subarray(0, 16)))).toBe(false);
        expect(a.matches({ ...AR003_ADVERT, manufacturerData: undefined })).toBe(false);
      });

      it('declines the address echoed in the forward order or at another offset', () => {
        const forward = Buffer.from(AR003_MSD);
        Buffer.from('020000000001', 'hex').copy(forward, 9);
        expect(makeAdapter().matches(withMsd(forward))).toBe(false);
        // The QN layout: the address little-endian at [5..10].
        const qnOffset = Buffer.from(AR003_MSD);
        qnOffset.fill(0, 9, 15);
        Buffer.from('010000000002', 'hex').copy(qnOffset, 5);
        expect(makeAdapter().matches(withMsd(qnOffset))).toBe(false);
      });

      // #501: a QN CS10G advertises 17 bytes under 0xFFFF too, its address at
      // [5..10] (tests/fixtures/qn/cs10g-501.ts).
      it.each([[[]], [['ffe0']], [['181d']]])(
        'declines the 17-byte CS10G advertisement without a name, services %j',
        (serviceUuids) => {
          expect(makeAdapter().matches({ ...ADVERT_501, localName: '', serviceUuids })).toBe(false);
        },
      );

      it.each([0x2a9f, 0x2a9d, 0x2a9c, 0xffe1, 0xffe2, 0x2aff].map((c) => [c.toString(16), c]))(
        'declines the characteristics without 0x%s, even with the A-R003 advertisement',
        (_hex, code) => {
          expect(
            makeAdapter().matches({
              ...AR003_ADVERT,
              characteristicUuids: ar003CharsWithout(code),
            }),
          ).toBe(false);
        },
      );

      // The shapes of false-match-resolution.test.ts: a nameless BF788 (#229) and
      // the BF950 characteristics (#255), both without 0xFFE1 / 0xFFE2 / 0x2AFF.
      it('declines nameless Beurer BF788 and BF950 characteristics', () => {
        const a = makeAdapter();
        expect(
          a.matches({
            localName: '',
            serviceUuids: [0x181b, 0x181d, 0x181c, 0xfff0].map(uuid16),
            characteristicUuids: [0x2a9d, 0x2a9c, 0x2a9f, 0x2a9b].map(uuid16),
          }),
        ).toBe(false);
        expect(
          a.matches({
            localName: '',
            serviceUuids: [0x181b, 0x181d].map(uuid16),
            characteristicUuids: [0x2a9d, 0x2a2f, 0xfaa1, 0xfaa2].map(uuid16),
          }),
        ).toBe(false);
      });

      it('declines an unrelated name with the A-R003 advertisement and characteristics', () => {
        const a = makeAdapter();
        expect(a.matches({ ...AR003_ADVERT, localName: 'Yunmai ISM' })).toBe(false);
        expect(
          a.matches({ ...AR003_ADVERT, localName: 'Yunmai ISM', characteristicUuids: AR003_CHARS }),
        ).toBe(false);
      });

      // The name rule is unchanged: the A-R003 characteristics carry the QN
      // pair 0xFFF1 / 0xFFF2, so a "renpho"-named unit of this shape is not
      // claimed on them (registry-collision.test.ts shows where it lands).
      it('declines a "renpho"-named device with the A-R003 characteristics', () => {
        expect(
          makeAdapter().matches({
            ...AR003_ADVERT,
            localName: 'Renpho-Scale',
            characteristicUuids: AR003_CHARS,
          }),
        ).toBe(false);
      });
    });
  });

  describe('onConnected()', () => {
    it('replays handshake → consent → profile, then enables measurement notifs LAST', async () => {
      const a = makeAdapter();
      const ctx = makeCtx();
      await a.onConnected(ctx);

      const write = ctx.write as ReturnType<typeof vi.fn>;
      const subscribe = ctx.subscribe as ReturnType<typeof vi.fn>;

      // Three vendor handshake writes to 0xFFE2 come first.
      expect(write.mock.calls[0]).toEqual([CHR_VENDOR_WRITE, [0x10, 0x01, 0x00, 0x11], true]);
      expect(write.mock.calls[1]).toEqual([CHR_VENDOR_WRITE, [0x03, 0x00, 0x01, 0x04], true]);
      expect(write.mock.calls[2]).toEqual([CHR_VENDOR_WRITE, [0x19, 0x00, 0x19], true]);

      // Consent: opcode 0x02, user 0xAA (170), code 9999 = 0x270F → LE 0F 27.
      expect(write.mock.calls[3]).toEqual([CHR_UCP, [0x02, 0xaa, 0x0f, 0x27], true]);

      // Profile writes follow (gender/height/dob/age/vendor).
      const writtenChars = write.mock.calls.map((c) => c[0]);
      expect(writtenChars).toContain(CHR_GENDER);
      expect(writtenChars).toContain(CHR_HEIGHT);
      expect(writtenChars).toContain(CHR_AGE);

      // Measurement notifications are enabled ONLY after all init writes.
      expect(subscribe).toHaveBeenCalledWith(CHR_WEIGHT);
      expect(subscribe).toHaveBeenCalledWith(CHR_BODYCOMP);
      expect(subscribe).not.toHaveBeenCalledBefore(write);
    });

    it('throws a clear error when consent/vendor chars are missing', async () => {
      const a = makeAdapter();
      await expect(
        a.onConnected(makeCtx({ availableChars: new Set([CHR_WEIGHT]) })),
      ).rejects.toThrow(/discovery race/);
    });

    it('skips profile writes for characteristics the firmware lacks', async () => {
      const a = makeAdapter();
      // Only the essential consent/vendor chars present — profile chars absent.
      const ctx = makeCtx({ availableChars: new Set([CHR_UCP, CHR_VENDOR_WRITE]) });
      await a.onConnected(ctx);
      const writtenChars = (ctx.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(writtenChars).not.toContain(CHR_GENDER);
      // Handshake + consent still happened.
      expect(writtenChars).toContain(CHR_VENDOR_WRITE);
      expect(writtenChars).toContain(CHR_UCP);
    });

    // #267 review (P1): the vendor 0xFFE2 service is not advertised (the matcher
    // rejects devices advertising 0xFFE0), so a firmware variant may not expose
    // it. Consent alone unlocks the stream, so a missing 0xFFE2 must not abort.
    it('consents without throwing when the vendor write char is absent', async () => {
      const a = makeAdapter();
      const ctx = makeCtx({ availableChars: new Set([CHR_UCP]) });
      await expect(a.onConnected(ctx)).resolves.toBeUndefined();
      const writtenChars = (ctx.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(writtenChars).toContain(CHR_UCP);
      expect(writtenChars).not.toContain(CHR_VENDOR_WRITE);
    });
  });

  describe('parseCharNotification()', () => {
    it('decodes a real SIG weight frame (flags byte, not a 0x2E marker)', () => {
      const a = makeAdapter();
      const reading = a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(94.9, 1);
    });

    // #507: walked as SIG, packet 2 gave 332.8 Ω, and this test confirmed it
    // because the expected value was our own reading of the capture.
    it('reads no impedance from the second body-composition packet, and ends the weigh-in', () => {
      atCaptureTime(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
        const reading = a.parseCharNotification(CHR_BODYCOMP, BCS_PACKET2);
        expect(reading).not.toBeNull();
        expect(reading!.weight).toBeCloseTo(94.9, 1);
        expect(reading!.impedance).toBe(0);
        expect(reading!.timestamp).toEqual(new Date(2026, 6, 4, 12, 26, 6));
        expect(a.isFinal(reading!)).toBe(true);
      });
    });

    it('ends the A-R003 weigh-in on its second body-composition packet, not the first', () => {
      atAr003Time(() => {
        const a = makeAdapter();
        for (let i = 0; i < 6; i++) {
          a.parseCharNotification(CHR_WEIGHT, hex(AR003_WEIGH_IN.progress));
        }
        a.parseCharNotification(CHR_WEIGHT, hex(AR003_WEIGH_IN.final));
        const first = a.parseCharNotification(CHR_BODYCOMP, hex(AR003_WEIGH_IN.bcsPacket1));
        expect(a.isFinal(first!)).toBe(false);
        const reading = a.parseCharNotification(CHR_BODYCOMP, hex(AR003_WEIGH_IN.bcsPacket2));
        expect(reading!.weight).toBeCloseTo(82.3, 2);
        expect(reading!.impedance).toBe(0);
        expect(a.isFinal(reading!)).toBe(true);
      });
    });

    // Packet 1 is SIG (flag bit 12) and its Time Stamp still dates a weight
    // that came without one.
    it('dates a weight without a time by the Time Stamp of the A-R003 packet 1', () => {
      atAr003Time(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, WSS_NO_TIME);
        const reading = a.parseCharNotification(CHR_BODYCOMP, hex(AR003_WEIGH_IN.bcsPacket1));
        expect(reading!.timestamp).toEqual(new Date(2026, 9, 28, 10, 53, 41));
        expect(reading!.impedance).toBe(0);
      });
    });

    // Recognition by body water: in both packets, 42 of the values 25.0-79.9 %
    // give flags whose fields fill 19 bytes and claim a Time Stamp, which the
    // Time Stamp test rejects ([4..5] is a resistance, a year before 1582);
    // every other value fails the length test.
    it.each([
      ['#267 frame 1477', BCS_PACKET2],
      ['the A-R003 packet 2', hex(AR003_WEIGH_IN.bcsPacket2)],
    ])('reads %s as the vendor packet for every body water in [0..1]', (_label, packet) => {
      const misread: number[] = [];
      for (let water = 250; water <= 799; water++) {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, WSS_NO_TIME);
        const p = Buffer.from(packet);
        p.writeUInt16LE(water, 0);
        const reading = a.parseCharNotification(CHR_BODYCOMP, p)!;
        if (reading.impedance !== 0 || !a.isFinal(reading)) misread.push(water);
      }
      expect(misread).toEqual([]);
    });

    it.each([
      ['#267 frame 1477', BCS_PACKET2],
      [
        'frame 1477 with [0] odd (the SIG imperial bit)',
        Buffer.from([0x0d, ...BCS_PACKET2.subarray(1)]),
      ],
      ['the A-R003 packet 2', hex(AR003_WEIGH_IN.bcsPacket2)],
    ])('leaves the weight and its missing time as the 0x2A9D gave them: %s', (_label, packet) => {
      const a = makeAdapter();
      a.parseCharNotification(CHR_WEIGHT, WSS_NO_TIME);
      const reading = a.parseCharNotification(CHR_BODYCOMP, packet);
      expect(reading!.weight).toBeCloseTo(94.9, 2);
      expect(reading!.timestamp).toBeUndefined();
    });

    it('still walks a single SIG packet whose flags describe it', () => {
      atCaptureTime(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, WSS_NO_TIME);
        const reading = a.parseCharNotification(CHR_BODYCOMP, BCS_SINGLE_SIG);
        expect(reading!.impedance).toBeCloseTo(332.8, 1);
        expect(reading!.timestamp).toEqual(new Date(2026, 6, 4, 12, 26, 8));
      });
    });

    // D-11 / D027: the captured live weight frame has flags 0x4E, so it carries
    // a SIG Date Time (2026-07-04 12:26:06) that the adapter used to drop.
    it('carries the time stamp of the weight frame', () => {
      atCaptureTime(() => {
        const reading = makeAdapter().parseCharNotification(CHR_WEIGHT, WSS_FRAME);
        expect(reading!.timestamp).toEqual(new Date(2026, 6, 4, 12, 26, 6));
        expect(isHistoricalReading(reading!)).toBe(false);
      });
    });

    // D-11: the impedance is held across frames ("first impedance seen"), so a
    // weigh-in's impedance completed the NEXT weight's hold too: a stored record
    // replayed after the consent lent its impedance to the live weigh-in.
    it('does not carry one weigh-in impedance onto the next weight', () => {
      atCaptureTime(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
        expect(a.parseCharNotification(CHR_BODYCOMP, BCS_SINGLE_SIG)!.impedance).toBeCloseTo(
          332.8,
          1,
        );
        const next = a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
        expect(next!.impedance).toBe(0);
        expect(a.isFinal(next!)).toBe(false);
      });
    });

    // The same for the second packet. On the A-R003 frames only that packet
    // can make isFinal true; on the ES-WBE28 ones this passed with the 332.8 Ω
    // misread before #507 too.
    it('does not carry one weigh-in second body-composition packet onto the next weight', () => {
      atAr003Time(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, hex(AR003_WEIGH_IN.final));
        a.parseCharNotification(CHR_BODYCOMP, hex(AR003_WEIGH_IN.bcsPacket1));
        const done = a.parseCharNotification(CHR_BODYCOMP, hex(AR003_WEIGH_IN.bcsPacket2));
        expect(a.isFinal(done!)).toBe(true);
        const next = a.parseCharNotification(CHR_WEIGHT, hex(AR003_WEIGH_IN.final));
        expect(a.isFinal(next!)).toBe(false);
      });
    });

    // A stored record is buffered as history the moment it is emitted, so a
    // later 0x2A9C of it joins that reading instead of becoming a second export.
    it('emits a stored record once: its second packet adds nothing, a later impedance joins it', () => {
      // Real clock: the July capture stamp is a stored record by now.
      const a = makeAdapter();
      const stored = a.parseCharNotification(CHR_WEIGHT, WSS_FRAME);
      expect(isHistoricalReading(stored!)).toBe(true);
      expect(a.parseCharNotification(CHR_BODYCOMP, BCS_PACKET2)).toBeNull();
      expect(stored!.impedance).toBe(0);
      expect(a.parseCharNotification(CHR_BODYCOMP, BCS_SINGLE_SIG)).toBeNull();
      expect(stored!.impedance).toBeCloseTo(332.8, 1);
    });

    it('parses imperial (lb) weight frames to kg', () => {
      const a = makeAdapter();
      const buf = Buffer.alloc(3);
      buf[0] = 0x01; // flags: imperial, no optional fields
      buf.writeUInt16LE(2000, 1); // 2000 × 0.1 lb = 200 lb → ~90.72 kg
      const reading = a.parseCharNotification(CHR_WEIGHT, buf);
      expect(reading!.weight).toBeCloseTo(200 * 0.45359237, 1);
    });

    it('ignores User Control Point responses without emitting a reading', () => {
      const a = makeAdapter();
      expect(a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x02, 0x01]))).toBeNull();
      expect(a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x02, 0x05]))).toBeNull();
    });

    it('does not throw on a truncated body-comp frame that over-claims via flags', () => {
      const a = makeAdapter();
      a.parseCharNotification(CHR_WEIGHT, WSS_NO_TIME);
      // flags 0x0300 claim body-water + impedance, but only fat% fits.
      const truncated = Buffer.from([0x00, 0x03, 0x12, 0x01]);
      let reading: ReturnType<typeof a.parseCharNotification> = null;
      expect(() => {
        reading = a.parseCharNotification(CHR_BODYCOMP, truncated);
      }).not.toThrow();
      // Neither SIG nor the 19-byte vendor packet: nothing is read, nothing ends the weigh-in.
      expect(reading!.impedance).toBe(0);
      expect(a.isFinal(reading!)).toBe(false);
    });
  });

  describe('isComplete() / isFinal()', () => {
    it('is complete once weight is positive', () => {
      const a = makeAdapter();
      expect(a.isComplete({ weight: 80, impedance: 0 })).toBe(true);
      expect(a.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
    it('is not final on a weight alone, and final with an impedance', () => {
      const a = makeAdapter();
      expect(a.isFinal({ weight: 80, impedance: 0 })).toBe(false);
      expect(a.isFinal({ weight: 80, impedance: 332.8 })).toBe(true);
    });
  });

  // #507: the hold arms on the first weight above 0. On a step-on long after
  // the connection the scale was still measuring (0x4E) when the 8 s ran out.
  describe('isCompositionPending()', () => {
    it('keeps the link through a step-on after the connection until the second packet', async () => {
      const trace = ar003.traces['ar003-507-step-on-after-connect'];
      const r = await replaySession(makeAdapter(), trace, ar003);
      // t0 = 1000 ms: the hold ran out at t0 + 8.0 s, the second 0x2A9C packet lands at t0 + 8.6 s.
      expect(r.settled).toEqual({ by: 'reading', atMs: 9600 });
    });

    it('is pending while the scale measures or reports final, and not once it is done', () => {
      atAr003Time(() => {
        const a = makeAdapter();
        const send = (uuid: string, h: string) => a.parseCharNotification(uuid, hex(h));
        send(CHR_WEIGHT, AR003_LIVE.settled);
        expect(a.isCompositionPending()).toBe(false);
        send(CHR_WEIGHT, AR003_LIVE.measuring);
        expect(a.isCompositionPending()).toBe(true);
        send(CHR_WEIGHT, AR003_WEIGH_IN.final);
        expect(a.isCompositionPending()).toBe(true);
        send(CHR_BODYCOMP, AR003_COMPOSITION.bcsPacket1);
        expect(a.isCompositionPending()).toBe(true);
        send(CHR_BODYCOMP, AR003_COMPOSITION.bcsPacket2);
        expect(a.isCompositionPending()).toBe(false);
        // The next weigh-in measures, then its weight moves again.
        send(CHR_WEIGHT, AR003_LIVE.measuring);
        expect(a.isCompositionPending()).toBe(true);
        send(CHR_WEIGHT, AR003_LIVE.settled);
        expect(a.isCompositionPending()).toBe(false);
      });
    });

    it('is not pending once the user steps off while the scale measures', () => {
      atAr003Time(() => {
        const a = makeAdapter();
        a.parseCharNotification(CHR_WEIGHT, hex(AR003_LIVE.measuring));
        expect(a.isCompositionPending()).toBe(true);
        a.parseCharNotification(CHR_WEIGHT, hex(AR003_LIVE.empty));
        expect(a.isCompositionPending()).toBe(false);
      });
    });
  });

  describe('computeMetrics()', () => {
    it('uses impedance (BIA) for body fat when present', () => {
      const a = makeAdapter();
      const profile = defaultProfile();
      const withImp = a.computeMetrics({ weight: 80, impedance: 500 }, profile);
      const noImp = a.computeMetrics({ weight: 80, impedance: 0 }, profile);
      assertPayloadRanges(withImp);
      assertPayloadRanges(noImp);
      expect(withImp.impedance).toBe(500);
      // BIA-derived fat should differ from the BMI-only estimate.
      expect(withImp.bodyFatPercent).not.toBe(noImp.bodyFatPercent);
    });
  });
});
