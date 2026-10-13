import { describe, it, expect, vi, afterEach } from 'vitest';
import { EtekcityFit8sAdapter } from '../../src/scales/etekcity-fit8s.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { applyForcedAdapter } from '../../src/scales/force.js';
import { buildPayload } from '../../src/scales/body-comp-helpers.js';
import { evaluateAdvertisement } from '../../src/ble/advertisement.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';
import { bleLog } from '../../src/ble/types.js';

/**
 * Real frames only: the manufacturer data of real advertisements, company id
 * 0x06D0 stripped as every transport delivers it. Nothing here is built from
 * our own reading of the format; the only altered frames are single-byte
 * changes to these, used only to show a refusal, and each says which byte
 * changed.
 */

/*
 * oliexdev/openScale#1472 (basjam), attachment scale-capture-72.zip: two
 * filtered pcapng captures of one Fit 8S, A8:89:57:8C:A1:CE, named after the
 * weight the scale showed, scale-capture-72.25kg-filtered.pcapng and
 * scale-capture-72.55kg-filtered.pcapng. Frame numbers are Wireshark frame
 * numbers of the file named. Every advert in both files is ADV_NONCONN_IND
 * with flags 0x04, service 0xFFD0 and this frame, and no name.
 */
const BASJAM_MAC = 'A8:89:57:8C:A1:CE';
/** 72.55kg file #1, idle at 0 kg. */
const BASJAM_IDLE = '01cea18c5789a8c0a80100000000000000020300';
/** 72.55kg file #3, settling at 52.73 kg. */
const BASJAM_SETTLING_52_73 = '01cea18c5789a8c0a801facd0000000000020300';
/** 72.25kg file #9, settling on the final 72.27 kg, before the impedance. */
const BASJAM_SETTLING_72_27 = '01cea18c5789a8c0a8014e1a0100000000020300';
/** 72.25kg file #27, the first stable frame: 72.27 kg, [13..14] = 526. */
const BASJAM_STABLE_72_27 = '01cea18c5789a8c0a8014e1a010e020100020300';
/** 72.55kg file #19, settling on the final 72.55 kg. */
const BASJAM_SETTLING_72_55 = '01cea18c5789a8c0a801661b0100000000020300';
/** 72.55kg file #36, the first stable frame: 72.55 kg, [13..14] = 524. */
const BASJAM_STABLE_72_55 = '01cea18c5789a8c0a801661b010c020100020300';

/*
 * ronnnnnnnnnnnnn/etekcity_esf551_ble (MIT) @494a085,
 * tests/unit/test_fit8s_protocol.py, frames of a second unit,
 * A9:89:5D:ED:A0:63, contributed by Flautz in ronnnnnnnnnnnnn/etekcity_esf551_ble#6.
 * The weights are only what the frames decode to; no display value was given.
 */
const FLAUTZ_MAC = 'A9:89:5D:ED:A0:63';
/** SAMPLE_KG ("Wireshark sample"): stable 80.47 kg without impedance. */
const FLAUTZ_STABLE_80_47_NO_IMP = '0163a0ed5d89a9c0a901563a0100000100020300';
/** SAMPLE_KG_WITH_IMPEDANCE ("Live capture"): stable 81.02 kg, [13..14] = 537. */
const FLAUTZ_STABLE_81_02 = '0163a0ed5d89a9c0a9017c3c0119020100020300';

/*
 * Other devices on company id 0x06D0, which the adapter must not claim.
 */
/**
 * #385 (DEBUG log, 2026-08-02): the Etekcity ESF-551 named "Etekcity Smart
 * Fitness Scale", D0:4D:00:43:40:BD, `Advert: ... manufacturerData={0x06d0:
 * 01bd4043004dd00001}` (node-ble, so no services).
 */
const ESF551_385 = '01bd4043004dd00001';
const ESF551_MAC = 'D0:4D:00:43:40:BD';
/**
 * A Levoit air purifier named Core200s, 40:91:51:E5:31:8E: VeSync's platform
 * id is not Etekcity scales' alone. ronnnnnnnnnnnnn/etekcity_esf551_ble (MIT)
 * @494a085, tests/unit/test_detection.py, PURIFIER_PAYLOAD under "Real
 * captures".
 */
const VESYNC_PURIFIER = '018e31e5519140c623020202';
const PURIFIER_MAC = '40:91:51:E5:31:8E';

const FIT8S = 'Etekcity Fit 8S';

function buf(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/** A real frame with byte `index` replaced. Derived, only ever used to show a refusal. */
function withByte(hex: string, index: number, value: number): Buffer {
  const b = buf(hex);
  b[index] = value;
  return b;
}

/** noble on Linux and Windows, and the proxies: address and services known. */
function advert(
  data: Buffer | string,
  address: string | null = BASJAM_MAC,
  serviceUuids: string[] = ['ffd0'],
  id = 0x06d0,
  localName = '',
): BleDeviceInfo {
  return {
    localName,
    ...(address !== null ? { address } : {}),
    serviceUuids,
    manufacturerData: { id, data: typeof data === 'string' ? buf(data) : data },
  };
}
/** node-ble before connecting: the address, no services. */
const nodeBle = (data: Buffer | string, address = BASJAM_MAC) => advert(data, address, []);
/** noble on macOS: services, no address. */
const macos = (data: Buffer | string, serviceUuids = ['ffd0']) => advert(data, null, serviceUuids);

const resolved = (d: BleDeviceInfo) => resolveAdapter(d, adapters)?.name;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EtekcityFit8sAdapter (#408)', () => {
  describe('matches() and registry resolution', () => {
    it('resolves both units on noble and the proxies (address and 0xFFD0)', () => {
      for (const hex of [BASJAM_STABLE_72_27, BASJAM_SETTLING_52_73, BASJAM_IDLE]) {
        expect(resolved(advert(hex))).toBe(FIT8S);
      }
      expect(resolved(advert(FLAUTZ_STABLE_81_02, FLAUTZ_MAC))).toBe(FIT8S);
      expect(resolved(advert(FLAUTZ_STABLE_80_47_NO_IMP, FLAUTZ_MAC))).toBe(FIT8S);
    });

    it('resolves both units on node-ble, which reports no services before connecting', () => {
      expect(resolved(nodeBle(BASJAM_STABLE_72_55))).toBe(FIT8S);
      expect(resolved(nodeBle(FLAUTZ_STABLE_81_02, FLAUTZ_MAC))).toBe(FIT8S);
    });

    it('resolves both units on macOS by 0xFFD0 and the frame shape', () => {
      expect(resolved(macos(BASJAM_STABLE_72_27))).toBe(FIT8S);
      expect(resolved(macos(BASJAM_SETTLING_72_55))).toBe(FIT8S);
      expect(resolved(macos(FLAUTZ_STABLE_80_47_NO_IMP))).toBe(FIT8S);
    });

    it('refuses a real frame heard from a different address', () => {
      expect(resolved(advert(BASJAM_STABLE_72_27, FLAUTZ_MAC))).toBeUndefined();
      expect(resolved(nodeBle(FLAUTZ_STABLE_81_02, BASJAM_MAC))).toBeUndefined();
    });

    it('refuses a frame whose echo is the address forward instead of reversed', () => {
      const adapter = new EtekcityFit8sAdapter();
      expect(adapter.matches(advert(BASJAM_STABLE_72_27, 'CE:A1:8C:57:89:A8'))).toBe(false);
    });

    it('refuses a frame whose echoed MAC differs in one byte ([1] 0xce -> 0xcf)', () => {
      const adapter = new EtekcityFit8sAdapter();
      expect(adapter.matches(advert(withByte(BASJAM_STABLE_72_27, 1, 0xcf)))).toBe(false);
    });

    it('refuses the frame when the advertised services lack 0xFFD0', () => {
      const adapter = new EtekcityFit8sAdapter();
      expect(adapter.matches(advert(BASJAM_STABLE_72_27, BASJAM_MAC, ['fff0']))).toBe(false);
      expect(resolved(advert(BASJAM_STABLE_72_27, BASJAM_MAC, ['fff0']))).not.toBe(FIT8S);
      expect(adapter.matches(macos(BASJAM_STABLE_72_27, ['fff0']))).toBe(false);
    });

    it('accepts 0xFFD0 in its full 128-bit form', () => {
      const adapter = new EtekcityFit8sAdapter();
      const full = ['0000ffd0-0000-1000-8000-00805f9b34fb'];
      expect(adapter.matches(advert(BASJAM_STABLE_72_27, BASJAM_MAC, full))).toBe(true);
      expect(adapter.matches(macos(BASJAM_STABLE_72_27, full))).toBe(true);
    });

    it('does not claim a frame with neither an address nor services (macOS without 0xFFD0)', () => {
      const adapter = new EtekcityFit8sAdapter();
      expect(adapter.matches(macos(BASJAM_STABLE_72_27, []))).toBe(false);
      expect(resolved(macos(BASJAM_STABLE_72_27, []))).toBeUndefined();
    });

    it('on macOS, refuses frames off the captured shape at [0], [15] and [16]', () => {
      const adapter = new EtekcityFit8sAdapter();
      expect(adapter.matches(macos(withByte(BASJAM_STABLE_72_27, 0, 0x11)))).toBe(false);
      expect(adapter.matches(macos(withByte(BASJAM_STABLE_72_27, 15, 0x02)))).toBe(false);
      expect(adapter.matches(macos(withByte(BASJAM_STABLE_72_27, 16, 0x03)))).toBe(false);
    });

    it('refuses a truncated frame (19 bytes) and the frame under company id 0x06D1', () => {
      const adapter = new EtekcityFit8sAdapter();
      expect(adapter.matches(advert(buf(BASJAM_STABLE_72_27).subarray(0, 19)))).toBe(false);
      expect(adapter.matches(advert(BASJAM_STABLE_72_27, BASJAM_MAC, ['ffd0'], 0x06d1))).toBe(
        false,
      );
    });

    it('leaves the ESF-551 advert from #385 to the ESF-551 adapter', () => {
      const adapter = new EtekcityFit8sAdapter();
      const esf = advert(ESF551_385, ESF551_MAC, [], 0x06d0, 'Etekcity Smart Fitness Scale');
      expect(adapter.matches(esf)).toBe(false);
      expect(resolved(esf)).toBe('Etekcity ESF-551');
      expect(resolved({ ...esf, serviceUuids: ['fff0'] })).toBe('Etekcity ESF-551');
    });

    it('does not claim a VeSync air purifier on the same company id', () => {
      const adapter = new EtekcityFit8sAdapter();
      const purifier = advert(VESYNC_PURIFIER, PURIFIER_MAC, [], 0x06d0, 'Core200s');
      expect(adapter.matches(purifier)).toBe(false);
      expect(adapter.matches({ ...purifier, address: undefined, serviceUuids: ['ffd0'] })).toBe(
        false,
      );
      expect(resolved(purifier)).toBeUndefined();
    });
  });

  describe('decoding', () => {
    it('reads the stable frames of both units', () => {
      const adapter = new EtekcityFit8sAdapter();
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_27))).toEqual({
        weight: 72.27,
        impedance: 0,
      });
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_55))).toEqual({
        weight: 72.55,
        impedance: 0,
      });
      expect(adapter.parseBroadcast(buf(FLAUTZ_STABLE_80_47_NO_IMP))).toEqual({
        weight: 80.47,
        impedance: 0,
      });
      expect(adapter.parseBroadcast(buf(FLAUTZ_STABLE_81_02))).toEqual({
        weight: 81.02,
        impedance: 0,
      });
    });

    it('reports settling frames as live weights, never as readings', () => {
      const adapter = new EtekcityFit8sAdapter();
      for (const [hex, kg] of [
        [BASJAM_SETTLING_52_73, 52.73],
        [BASJAM_SETTLING_72_27, 72.27],
        [BASJAM_SETTLING_72_55, 72.55],
      ] as const) {
        expect(adapter.parseBroadcast(buf(hex))).toBeNull();
        expect(adapter.parseLiveBroadcast(buf(hex))).toEqual({ weight: kg });
      }
    });

    it('reports nothing for the idle frame', () => {
      const adapter = new EtekcityFit8sAdapter();
      expect(adapter.parseBroadcast(buf(BASJAM_IDLE))).toBeNull();
      expect(adapter.parseLiveBroadcast(buf(BASJAM_IDLE))).toBeNull();
    });

    it('never reports a stable frame on the live channel (#356)', () => {
      const adapter = new EtekcityFit8sAdapter();
      expect(adapter.parseLiveBroadcast(buf(BASJAM_STABLE_72_27))).toBeNull();
      expect(adapter.parseLiveBroadcast(buf(FLAUTZ_STABLE_81_02))).toBeNull();
    });

    // The adapter prefers passive reading, so a reading isComplete() refuses
    // is not dropped: the transports hold it as partial and export it weight
    // only once the grace runs out. The frame itself has to be refused.
    it('refuses a stable frame outside the plausible range ([12] 0x01 -> 0x04, 268.88 kg)', () => {
      const adapter = new EtekcityFit8sAdapter();
      const heavy = withByte(BASJAM_STABLE_72_27, 12, 0x04);
      expect(adapter.parseBroadcast(heavy)).toBeNull();
      expect(evaluateAdvertisement(adapter, advert(heavy))).toEqual({ kind: 'wait' });
    });

    it('refuses a frame of the wrong length on both channels', () => {
      const adapter = new EtekcityFit8sAdapter();
      const short = buf(BASJAM_STABLE_72_27).subarray(0, 19);
      expect(adapter.parseBroadcast(short)).toBeNull();
      expect(adapter.parseLiveBroadcast(buf(BASJAM_SETTLING_72_27).subarray(0, 19))).toBeNull();
    });

    it('never publishes [13..14], although 526 ohm would pass as plausible', () => {
      const adapter = new EtekcityFit8sAdapter();
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_27))?.impedance).toBe(0);
      expect(adapter.parseBroadcast(buf(FLAUTZ_STABLE_81_02))?.impedance).toBe(0);
    });
  });

  describe('bytes the adapter does not decode', () => {
    it('refuses an unknown state ([15] 0x01 -> 0x02) on both channels and warns once', () => {
      const adapter = new EtekcityFit8sAdapter();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const frame = withByte(BASJAM_STABLE_72_27, 15, 0x02);
      expect(adapter.parseBroadcast(frame)).toBeNull();
      expect(adapter.parseBroadcast(frame)).toBeNull();
      expect(adapter.parseLiveBroadcast(frame)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('state 0x2');
    });

    it('refuses an unknown format ([0] 0x01 -> 0x11) on both channels and warns once', () => {
      const adapter = new EtekcityFit8sAdapter();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const stable = withByte(BASJAM_STABLE_72_27, 0, 0x11);
      const settling = withByte(BASJAM_SETTLING_72_27, 0, 0x11);
      expect(adapter.parseBroadcast(stable)).toBeNull();
      expect(adapter.parseBroadcast(settling)).toBeNull();
      expect(adapter.parseLiveBroadcast(settling)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('format 0x11');
    });

    it('still reads an unknown display unit ([16] 0x00 -> 0x03) as grams, warning once', () => {
      const adapter = new EtekcityFit8sAdapter();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      expect(adapter.parseBroadcast(withByte(BASJAM_STABLE_72_27, 16, 0x03))).toEqual({
        weight: 72.27,
        impedance: 0,
      });
      expect(adapter.parseLiveBroadcast(withByte(BASJAM_SETTLING_72_55, 16, 0x03))).toEqual({
        weight: 72.55,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('unknown unit 0x3');
    });

    it('does not warn for any captured frame', () => {
      const adapter = new EtekcityFit8sAdapter();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      for (const hex of [
        BASJAM_IDLE,
        BASJAM_SETTLING_52_73,
        BASJAM_STABLE_72_27,
        FLAUTZ_STABLE_80_47_NO_IMP,
        FLAUTZ_STABLE_81_02,
      ]) {
        adapter.parseBroadcast(buf(hex));
        adapter.parseLiveBroadcast(buf(hex));
      }
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('advertisement decision', () => {
    it('completes on a stable frame, with impedance or without', () => {
      expect(
        evaluateAdvertisement(new EtekcityFit8sAdapter(), advert(BASJAM_STABLE_72_27)),
      ).toEqual({ kind: 'complete', reading: { weight: 72.27, impedance: 0 } });
      const noImp = advert(FLAUTZ_STABLE_80_47_NO_IMP, FLAUTZ_MAC);
      expect(evaluateAdvertisement(new EtekcityFit8sAdapter(), noImp)).toEqual({
        kind: 'complete',
        reading: { weight: 80.47, impedance: 0 },
      });
    });

    it('waits on a settling frame and carries its live weight', () => {
      const decision = evaluateAdvertisement(
        new EtekcityFit8sAdapter(),
        advert(BASJAM_SETTLING_52_73),
      );
      expect(decision).toEqual({ kind: 'wait', live: { weight: 52.73 } });
    });

    it('waits on the idle frame without a live weight', () => {
      expect(evaluateAdvertisement(new EtekcityFit8sAdapter(), advert(BASJAM_IDLE))).toEqual({
        kind: 'wait',
      });
    });

    // The forced wrapper drives the registry's own instance. The settling frame
    // last also ends the repeat hold the stable frame leaves on it.
    it('under ble.force_scale_adapter: completes on a stable frame, does nothing on settling', () => {
      const [forced] = applyForcedAdapter(adapters, FIT8S);
      expect(evaluateAdvertisement(forced, advert(BASJAM_STABLE_72_55)).kind).toBe('complete');
      expect(evaluateAdvertisement(forced, advert(BASJAM_SETTLING_72_55))).toEqual({
        kind: 'none',
      });
    });
  });

  // The stable frame repeats unchanged for as long as the scale shows the
  // result (at least 12 s in one capture, up to the 30 s auto-off), longer than
  // a poll transport's minimum scan cooldown of 5 s.
  describe('a stable frame seen again after its export', () => {
    function clocked() {
      const clock = { t: 0 };
      return { clock, adapter: new EtekcityFit8sAdapter(() => clock.t) };
    }

    it('is held back while the same result repeats', () => {
      const { clock, adapter } = clocked();
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_27))?.weight).toBe(72.27);
      clock.t = 400;
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_27))).toBeNull();
      clock.t = 12_000;
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_27))).toBeNull();
      expect(
        evaluateAdvertisement(adapter, advert(BASJAM_STABLE_72_27)).kind,
        'a later scan waits instead of exporting the weigh-in again',
      ).toBe('wait');
    });

    it('is handed out again once the unit sends a settling frame (a new weigh-in)', () => {
      const { clock, adapter } = clocked();
      adapter.parseBroadcast(buf(BASJAM_STABLE_72_27));
      clock.t = 20_000;
      expect(adapter.parseBroadcast(buf(BASJAM_SETTLING_72_27))).toBeNull();
      clock.t = 22_000;
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_27))?.weight).toBe(72.27);
    });

    it('is handed out again after the idle frame, which is a settling frame at 0 kg', () => {
      const { clock, adapter } = clocked();
      adapter.parseBroadcast(buf(BASJAM_STABLE_72_27));
      clock.t = 15_000;
      adapter.parseBroadcast(buf(BASJAM_IDLE));
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_27))?.weight).toBe(72.27);
    });

    it('is handed out again a minute after its export, and not a millisecond sooner', () => {
      const { clock, adapter } = clocked();
      adapter.parseBroadcast(buf(BASJAM_STABLE_72_27));
      clock.t = 30_000;
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_27))).toBeNull();
      clock.t = 60_000;
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_27))).toBeNull();
      clock.t = 60_001;
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_27))?.weight).toBe(72.27);
    });

    it('does not hold back a different result, or another unit', () => {
      const { clock, adapter } = clocked();
      adapter.parseBroadcast(buf(BASJAM_STABLE_72_27));
      clock.t = 1_000;
      expect(adapter.parseBroadcast(buf(FLAUTZ_STABLE_81_02))?.weight).toBe(81.02);
      expect(adapter.parseBroadcast(buf(BASJAM_STABLE_72_55))?.weight).toBe(72.55);
      // Another unit's settling frame does not release this unit's result.
      expect(adapter.parseBroadcast(buf(FLAUTZ_STABLE_81_02))).toBeNull();
      adapter.parseBroadcast(buf(BASJAM_SETTLING_52_73));
      expect(adapter.parseBroadcast(buf(FLAUTZ_STABLE_81_02))).toBeNull();
    });
  });

  describe('debug log', () => {
    it('logs the undecoded fields of a stable payload once, and again after the expiry', () => {
      let t = 0;
      const adapter = new EtekcityFit8sAdapter(() => t);
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const stable = () => debug.mock.calls.filter(([m]) => String(m).includes('stable'));
      adapter.parseBroadcast(buf(BASJAM_STABLE_72_27));
      t += 400;
      adapter.parseBroadcast(buf(BASJAM_STABLE_72_27));
      expect(stable()).toHaveLength(1);
      expect(String(stable()[0][0])).toBe(
        'Etekcity Fit 8S stable: 72.27 kg (undecoded: impedance=526 unit=kg ' +
          `[7..9]=c0a801 [17..19]=020300) frame=${BASJAM_STABLE_72_27}`,
      );
      t += 5_000;
      adapter.parseBroadcast(buf(BASJAM_STABLE_72_27));
      expect(stable()).toHaveLength(2);
      expect(String(stable()[1][0])).toContain('already reported, held back');
    });

    it('logs a settling value once, and again only when it changes', () => {
      const adapter = new EtekcityFit8sAdapter();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const settling = () => debug.mock.calls.filter(([m]) => String(m).includes('settling'));
      adapter.parseBroadcast(buf(BASJAM_SETTLING_72_27));
      adapter.parseBroadcast(buf(BASJAM_SETTLING_72_27));
      expect(settling()).toHaveLength(1);
      adapter.parseBroadcast(buf(BASJAM_SETTLING_52_73));
      expect(settling()).toHaveLength(2);
    });
  });

  describe('completion and body composition', () => {
    const adapter = new EtekcityFit8sAdapter();

    it('completes only inside the plausible range', () => {
      expect(adapter.isComplete({ weight: 72.27, impedance: 0 })).toBe(true);
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
      expect(adapter.isComplete({ weight: 300, impedance: 0 })).toBe(false);
    });

    it('estimates composition from BMI, ignoring any impedance on the reading', () => {
      const profile = defaultProfile();
      expect(adapter.computeMetrics({ weight: 72.27, impedance: 526 }, profile)).toEqual(
        buildPayload(72.27, 0, {}, profile),
      );
    });
  });
});
