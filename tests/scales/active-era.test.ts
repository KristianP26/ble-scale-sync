import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ActiveEraAdapter, isAc27Frame, ac27ImpedanceOhm } from '../../src/scales/active-era.js';
import type { ScaleReading } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  expectMatches,
  parseOk,
  expectValidMetrics,
} from '../helpers/scale-test-utils.js';
import {
  ALPHA_LOCK_D6,
  ALPHA_LOCK_D6_NO_IMPEDANCE,
  ALPHA_HANDSHAKE,
  ALPHA_NO_WRITE,
  ALPHA_PLATEAU_THEN_LOCK,
  ALPHA_STORED,
  ISSUE_458_DUMP_1,
  ISSUE_458_DUMP_2,
  ISSUE_462_D6,
  ISSUE_466_RAMP,
  ISSUE_466_REPEAT_1,
  ISSUE_466_REPEAT_2,
  OPENSCALE_1358,
  TAYLOR_LB_LOCKED,
  hex,
  parseDump,
  received,
} from '../helpers/ac27-captures.js';

describe('ActiveEraAdapter', () => {
  let adapter: ActiveEraAdapter;
  beforeEach(() => {
    adapter = new ActiveEraAdapter();
  });

  describe('matches()', () => {
    it('matches "ae bs-06" name (case-insensitive), not unrelated', () => {
      expectMatches(adapter, {
        yes: ['ae bs-06', 'AE BS-06 Pro', 'AE BS-06'],
        no: ['Random Scale'],
      });
    });

    it('does not match by service UUID alone (removed to avoid MGB collision)', () => {
      expect(adapter.matches(mockPeripheral('Unknown', ['ffb0']))).toBe(false);
    });

    // ALPHA Smart Scale PRO 3, openScale PR #1534, attachment
    // hci_snoop20260920232857_btsnoop.log (sha256 3e512091...), capture 1 at
    // 23:30:30.015. ADV_IND raw `0201060303b0ff10ffac273891018ed3e001010030000001`
    // from public address E0:D3:8E:01:91:38; the scan response carries the name
    // `MY_SCALE` (`09094d595f5343414c45`). The manufacturer payload starts with
    // the device's own MAC, reversed.
    describe('AC 27 advertisement (#458, #462, #466)', () => {
      const ALPHA_MAC = 'E0:D3:8E:01:91:38';
      const ALPHA_MSD = { id: 0x27ac, data: Buffer.from('3891018ed3e001010030000001', 'hex') };

      it('claims the ALPHA in every shape a transport hands over', () => {
        expectMatches(adapter, {
          yes: [
            // noble / proxies: ADV_IND and scan response merged
            {
              localName: 'MY_SCALE',
              address: ALPHA_MAC,
              serviceUuids: ['ffb0'],
              manufacturerData: ALPHA_MSD,
            },
            // ESPHome proxy: the ADV_IND alone, no name
            {
              localName: '',
              address: ALPHA_MAC,
              serviceUuids: ['ffb0'],
              manufacturerData: ALPHA_MSD,
            },
            // node-ble before connecting: name, MSD and address, no services
            {
              localName: 'MY_SCALE',
              address: ALPHA_MAC,
              serviceUuids: [],
              manufacturerData: ALPHA_MSD,
            },
            // noble on macOS: no address, so the FFB0 service carries it
            { localName: 'MY_SCALE', serviceUuids: ['ffb0'], manufacturerData: ALPHA_MSD },
          ],
        });
      });

      it('needs the company id and then the MAC echo or FFB0', () => {
        expectMatches(adapter, {
          no: [
            // the scan response alone: a generic name and nothing else
            { localName: 'MY_SCALE', address: ALPHA_MAC, serviceUuids: [] },
            // the ALPHA's payload heard from another address, without FFB0:
            // the echo does not hold and nothing else vouches for it
            {
              localName: '',
              address: '98:F6:7A:00:22:64',
              serviceUuids: [],
              manufacturerData: ALPHA_MSD,
            },
            // the same, with no address at all
            { localName: 'MY_SCALE', serviceUuids: [], manufacturerData: ALPHA_MSD },
            // FFB0 without the company id (#278 Lefu SWAN, 0x02AC)
            {
              localName: 'SWAN',
              serviceUuids: ['ffb0', 'd618'],
              manufacturerData: { id: 0x02ac, data: Buffer.from('7eb893ecb30301', 'hex') },
            },
            // Silvergear 108, company id 0xA0AC and FFB0 (registry fixture)
            {
              localName: '108',
              serviceUuids: ['ffb0'],
              manufacturerData: {
                id: 0xa0ac,
                data: Buffer.from('4fe9916185a0202d07600da1', 'hex'),
              },
            },
          ],
        });
      });
    });
  });

  describe('frame gate (T4)', () => {
    it('accepts every frame posted in #458, #462 and #466', () => {
      const frames = [
        ...parseDump(ISSUE_458_DUMP_1).map((f) => f.frame),
        ...parseDump(ISSUE_458_DUMP_2).map((f) => f.frame),
        ISSUE_462_D6,
        ...ISSUE_466_RAMP,
        ISSUE_466_REPEAT_1,
        ISSUE_466_REPEAT_2,
      ];
      expect(frames).toHaveLength(152 + 1 + 6);
      for (const f of frames) expect(isAc27Frame(f), f.toString('hex')).toBe(true);
    });

    it('accepts every ALPHA notification and the openScale #1358 frames', () => {
      const frames = [
        ALPHA_NO_WRITE,
        ALPHA_PLATEAU_THEN_LOCK,
        ALPHA_LOCK_D6_NO_IMPEDANCE,
        ALPHA_LOCK_D6,
        ALPHA_HANDSHAKE,
        ALPHA_STORED,
        OPENSCALE_1358,
      ].flatMap((l) => received(l).map((f) => f.frame));
      for (const f of frames) expect(isAc27Frame(f), f.toString('hex')).toBe(true);
    });

    // [19] of the Taylor lb frame is 0x3B: checksum 0x1B plus 0x20 in the top
    // bits, which a strict compare would refuse (and with it every frame of a
    // scale whose display is set to lb).
    it('compares only the low 5 bits of the checksum byte', () => {
      expect(isAc27Frame(TAYLOR_LB_LOCKED)).toBe(true);
      expect(parseOk(adapter, TAYLOR_LB_LOCKED).weight).toBeCloseTo(78.4, 3);
    });

    it('refuses a wrong checksum, another header, a short frame and an AC 02 frame', () => {
      const lock = parseDump(ISSUE_458_DUMP_1)[9].frame; // 86 8D 55 2C, cks 0x10
      const badSum = Buffer.from(lock);
      badSum[19] = 0x11; // [19] changed 0x10 -> 0x11
      const otherHeader = Buffer.from(lock);
      otherHeader[1] = 0x02; // [1] changed 0x27 -> 0x02
      const short = lock.subarray(0, 19); // [19] dropped
      // openScale #1358: the MGB init openScale wrote, an 8-byte AC 02 frame
      const ac02 = hex('AC 02 F7 00 00 00 CC C3');
      for (const f of [badSum, otherHeader, short, ac02]) {
        expect(isAc27Frame(f), f.toString('hex')).toBe(false);
        expect(adapter.parseNotification(f)).toBeNull();
      }
    });
  });

  describe('weight and result frames', () => {
    it('reads the locked weight of #458 dump 1 as 87.34 kg, not the unlocked 87.40', () => {
      const dump = parseDump(ISSUE_458_DUMP_1);
      expect(parseOk(adapter, dump[2].frame).weight).toBeCloseTo(87.4, 3); // 06 8D 55 68
      expect(parseOk(adapter, dump[9].frame).weight).toBeCloseTo(87.34, 3); // 86 8D 55 2C
    });

    // T5: the D6 frames of #458 carry no weight, so they take the lock.
    it.each([
      ['dump 1', ISSUE_458_DUMP_1, 87.34, 438.94],
      ['dump 2', ISSUE_458_DUMP_2, 87.62, 434.92],
    ])('pairs the #458 %s impedance with that session lock', (_l, dump, kg, ohm) => {
      let result: ScaleReading | null = null;
      for (const { frame } of parseDump(dump)) {
        const r = adapter.parseNotification(frame);
        if (frame[18] === 0xd6) result = r;
      }
      expect(result!.weight).toBeCloseTo(kg, 3);
      expect(result!.impedance).toBeCloseTo(ohm, 2);
    });

    it('takes the ALPHA D6 weight from the frame itself, without any D5 before it', () => {
      const d6 = received(ALPHA_LOCK_D6).at(-1)!.frame; // 01 00 01 d5 01 80 69 5b 8a
      expect(parseOk(adapter, d6)).toEqual({ weight: 88.97, impedance: 469 });
    });

    it('returns nothing for a D6 that has no weight to pair with', () => {
      const d6 = parseDump(ISSUE_458_DUMP_1).find((f) => f.frame[18] === 0xd6)!.frame;
      expect(adapter.parseNotification(d6)).toBeNull();
    });

    // T8: balance, heart rate and stored records are logged, never returned.
    it('returns nothing for D0, D7 and D8, and they leave the lock alone', () => {
      const dump = parseDump(ISSUE_458_DUMP_2);
      for (const { frame } of dump) {
        const r = adapter.parseNotification(frame);
        if ([0xd0, 0xd7, 0xd8].includes(frame[18])) expect(r, frame.toString('hex')).toBeNull();
      }
      for (const { frame } of received(ALPHA_STORED)) {
        if (frame[18] === 0xd8) expect(adapter.parseNotification(frame)).toBeNull();
      }
      // Still the 87.62 lock of dump 2: D8 records carry 87.34 and 87.56.
      const d6 = dump.find((f) => f.frame[18] === 0xd6)!.frame;
      expect(adapter.parseNotification(d6)!.weight).toBeCloseTo(87.62, 3);
    });
  });

  // T6
  describe('ac27ImpedanceOhm()', () => {
    it('converts the raw value from 1500 up, with the weight it was measured at', () => {
      expect(ac27ImpedanceOhm(3960, 87.62)).toBeCloseTo(434.92, 2); // #458 dump 2
      expect(ac27ImpedanceOhm(3983, 87.34)).toBeCloseTo(438.94, 2); // #458 dump 1
    });

    it('passes a value below 1500 through as ohms', () => {
      expect(ac27ImpedanceOhm(533, 124.22)).toBe(533); // #462
      expect(ac27ImpedanceOhm(469, 88.97)).toBe(469); // ALPHA
      expect(ac27ImpedanceOhm(1499, 80)).toBe(1499);
    });

    // Just over the gate at a heavy weight the formula goes negative:
    // (1500 - 1000 - 0.4 * 1300) / 6 = -3.3, which no resistance can be.
    it('never yields a negative impedance', () => {
      expect(ac27ImpedanceOhm(1500, 130)).toBe(0);
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and impedance > 0', () => {
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      expect(adapter.isComplete({ weight: 0, impedance: 500 })).toBe(false);
    });

    it('returns false when impedance is 0', () => {
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition', () => {
      const payload = expectValidMetrics(adapter, { weight: 80, impedance: 500 });
      expect(payload.impedance).toBe(500);
    });

    it('returns zero weight in payload for zero weight input', () => {
      const payload = adapter.computeMetrics({ weight: 0, impedance: 0 }, defaultProfile());
      expect(payload.weight).toBe(0);
    });
  });
});

// #394: adapters are shared singletons. Before onSessionStart existed, a second
// weigh-in could resolve on the FIRST frame using the previous person's data.
describe('ActiveEraAdapter session boundary (#394)', () => {
  it('does not pair the next session result with the previous lock', () => {
    const a = new ActiveEraAdapter();
    const dump1 = parseDump(ISSUE_458_DUMP_1);
    a.parseNotification(dump1[9].frame); // lock 87.34
    const d6 = dump1.find((f) => f.frame[18] === 0xd6)!.frame;
    expect(a.parseNotification(d6)!.weight).toBeCloseTo(87.34, 3);

    a.onSessionStart();

    // The same weightless D6 in a new session has nothing to pair with. With
    // the lock kept, it would carry the previous weigh-in's weight, and the
    // >= 1500 conversion multiplies that weight in.
    expect(a.parseNotification(d6)).toBeNull();
  });
});

/**
 * The raw `[4..5]` value is the number that decides the `>= 1500` conversion
 * (#386), so the log shows it next to the corrected value and says which weight
 * it was paired with.
 */
describe('ActiveEraAdapter: raw impedance is observable (#386)', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { bleLog } = await import('../../src/ble/types.js');
    debugSpy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const logged = (): string => debugSpy.mock.calls.map((c) => String(c[0])).join(' | ');

  it('logs the raw value alongside the corrected one when the gate fires', () => {
    const adapter = new ActiveEraAdapter();
    for (const { frame } of parseDump(ISSUE_458_DUMP_1)) adapter.parseNotification(frame);

    expect(logged()).toContain('raw=3983');
    expect(logged()).toMatch(/corrected\s+438\.9 ohm/);
    expect(logged()).toContain('weight 87.34 kg from the lock');
  });

  it('logs the raw value below the gate too, and says the gate did not fire', () => {
    const adapter = new ActiveEraAdapter();
    for (const { frame } of received(ALPHA_LOCK_D6)) adapter.parseNotification(frame);

    expect(logged()).toContain('raw=469');
    expect(logged()).toContain('below the 1500 correction gate');
    expect(logged()).toContain('weight 88.97 kg from the D6');
  });
});
