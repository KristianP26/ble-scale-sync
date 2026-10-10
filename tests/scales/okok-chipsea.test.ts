import { describe, it, expect, vi, afterEach } from 'vitest';
import { OkokChipseaAdapter } from '../../src/scales/okok-chipsea.js';
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
 * stripped as every transport delivers it, each with the id it was sent under.
 * Record numbers are btsnoop record numbers (= Wireshark frame numbers) of the
 * attachment named. Nothing here is built from our own reading of the format;
 * the only altered frames are single-byte changes to these, used only to show
 * a refusal, and each says which byte changed.
 */

// ─── C0 dialect ──────────────────────────────────────────────────────────────

/*
 * openScale #1191, attachments btsnoop.log and the vendor app's CSV export: a
 * nameless NIX Home unit, 08:B8:D0:DE:B5:3A. The four stable frames are the
 * only stable frames in the capture, one per weigh-in, each at the second the
 * CSV records that weigh-in with the same weight.
 */
const NIX_MAC = '08:B8:D0:DE:B5:3A';
/** Record #348, idle, id 0x03C0. */
const NIX_IDLE = '000000000a012408b8d0deb53a';
/** Record #431, settling at 147.00 kg, r1 still 0, id 0x1AC0. */
const NIX_SETTLING_147_00 = '396c00000a012408b8d0deb53a';
/** Record #439, stable 147.00 kg (CSV 13:18:47), id 0x10C0. */
const NIX_STABLE_147_00 = '396c17700a012508b8d0deb53a';
/** Record #957, stable 149.55 kg (CSV 13:19:19), id 0x11C0. */
const NIX_STABLE_149_55 = '3a6b17700a012508b8d0deb53a';
/** Record #1717, stable 148.70 kg (CSV 13:19:51), id 0x12C0. */
const NIX_STABLE_148_70 = '3a1617700a012508b8d0deb53a';
/** Record #1993, stable 147.50 kg (CSV 13:20:14), id 0x13C0. */
const NIX_STABLE_147_50 = '399e17700a012508b8d0deb53a';

/*
 * openScale #950, attachment hci_snoop20230329140200.cfa.zip: a nameless unit
 * (reporter arnelap), 5D:02:49:A6:3D:E8, three weigh-ins with the weights the
 * reporter gave.
 */
const ARN_MAC = '5D:02:49:A6:3D:E8';
/** Record #1039, idle, under id 0x00C0 (which the SIG list assigns to AMICCOM). */
const ARN_ID_00C0 = '000000000a01245d0249a63de8';
/** Record #1212, stable 81.50 kg, id 0xB1C0. */
const ARN_STABLE_81_50 = '1fd617700a01255d0249a63de8';
/** Record #2221, stepping off after the stable 50.75 kg phase: 0x24 with the weight, id 0x08C0. */
const ARN_STEPOFF_50_75 = '13d317700a01245d0249a63de8';

/*
 * openScale #1177, attachment btsnoop_hci.log: a unit named Yoda0,
 * 08:B8:D0:E8:5F:6D, which sends zeros where the others echo their MAC.
 */
const YODA0_MAC = '08:B8:D0:E8:5F:6D';
/** Record #546, idle, id 0x3FC0. */
const YODA0_IDLE = '00000000000024000000000000';
/** Record #614, stable 76.30 kg (the reporter: 76.3), id 0x3FC0. */
const YODA0_STABLE_76_30 = '1dce1388000025000000000000';

/*
 * custom-components/ble_monitor #537, comment by Ernst79 2021-10-27: the
 * reporter's HCI log of a Xiaogui TZC4, 5F:5A:29:E5:E0:94, laid out as a table.
 * The reporter remembered the weight as "63.0kg iirc".
 */
const TZC4_MAC = '5F:5A:29:E5:E0:94';
/** Row "constant weight", id 0xA3C0: 0x0276 with one decimal = 63.0 kg. */
const TZC4_STABLE_63_0 = '0276138b0002215f5a29e5e094';
/** Row "intermediate weight", id 0x8FC0: 63.4 kg while settling. */
const TZC4_SETTLING = '027a00000002205f5a29e5e094';

/**
 * custom-components/ble_monitor #824, HCI log line 2022-04-11 12:26:49 of a
 * MaxxMee QJ-J, 70:14:F6:07:65:EC, id 0x9EC0 ("The Weight is displayed
 * correctly"): stable 112.85 kg with r1 = 0.
 */
const QJJ_MAC = '70:14:F6:07:65:EC';
const QJJ_STABLE_112_85 = '2c1500000a01257014f60765ec';

// ─── 2.0 dialect ─────────────────────────────────────────────────────────────

/*
 * openScale #410, attachments 01/02/03btsnoop_hci.log: a BL-26L01 named ADV,
 * ED:67:37:26:69:D7, one weigh-in per file, the weights the reporter copied
 * from the vendor app.
 */
const V20_MAC = 'ED:67:37:26:69:D7';
/** 01btsnoop_hci.log record #54, idle. */
const V20_IDLE = '0b41af2f81010400000000006eed67372669d7';
/** 01btsnoop_hci.log record #76, final 68.00 kg. */
const V20_FINAL_68_00 = '0b41af2f810105051a90177087ed67372669d7';
/** 02btsnoop_hci.log record #140, final 71.30 kg. */
const V20_FINAL_71_30 = '0b41af2f810105061bda1770cfed67372669d7';
/** 03btsnoop_hci.log record #65, settling at 68.70 kg. */
const V20_SETTLING_68_70 = '0b41af2f810104011ad60000a3ed67372669d7';
/** 03btsnoop_hci.log record #77, final 68.65 kg. */
const V20_FINAL_68_65 = '0b41af2f810105071ad11770c4ed67372669d7';

/**
 * openScale #496, comment by inzanity 2020-09-09: the vendor app's logcat for
 * an EB8217, one frame (company id CA 20 first) that the app itself parsed to
 * weight=95.0. The log does not carry the address the frame was heard from, so
 * this frame is only ever offered by name, never with an address.
 */
const V20_EB8217_95_0 = '0b000000000101eb03b6138aeced67371b508c';

// ─── Other Chipsea dialects this adapter must not claim ─────────────────────

/** openScale #496, scan record by ag88 2021-06-05: V1.1 (0x11CA), Chipsea-BLE, 08:B2:1E:15:6E:DB. */
const V11_AG88 = '0f000102f25821332e0000000000000041c8b21e156edb';
/** openScale #930, the reporter's dump of a Tristar WG-2440 (0xF0FF, Chipsea-BLE): 98.7 kg. */
const VF0_930 = '0204db03000000000000000050fb19c01c6d';

function buf(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/** A real frame with byte `index` replaced. */
function withByte(hex: string, index: number, value: number): Buffer {
  const b = buf(hex);
  b[index] = value;
  return b;
}

/**
 * A real 2.0 frame with byte `index` replaced AND the checksum at [12]
 * recomputed. Derived, not captured: only ever used to show a refusal.
 */
function derived20(hex: string, index: number, value: number): Buffer {
  const b = withByte(hex, index, value);
  let x = 0x20;
  for (let i = 0; i < 12; i++) x ^= b[i];
  b[12] = x;
  return b;
}

function advert(
  data: Buffer | string,
  id: number,
  address: string | null,
  localName = '',
): BleDeviceInfo {
  return {
    localName,
    ...(address !== null ? { address } : {}),
    serviceUuids: [],
    manufacturerData: { id, data: typeof data === 'string' ? buf(data) : data },
  };
}

const nix = (data: Buffer | string, id = 0x10c0, address: string | null = NIX_MAC) =>
  advert(data, id, address);
const v20 = (data: Buffer | string, address: string | null = V20_MAC, name = 'ADV') =>
  advert(data, 0x20ca, address, name);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OkokChipseaAdapter (#408)', () => {
  describe('matches() and registry resolution', () => {
    const adapter = new OkokChipseaAdapter();
    const resolved = (d: BleDeviceInfo) => resolveAdapter(d, adapters)?.name;

    it('resolves every captured unit to this adapter', () => {
      expect(resolved(nix(NIX_STABLE_147_00))).toBe('OKOK (Chipsea broadcast)');
      expect(resolved(nix(NIX_IDLE, 0x03c0))).toBe('OKOK (Chipsea broadcast)');
      expect(resolved(advert(ARN_ID_00C0, 0x00c0, ARN_MAC))).toBe('OKOK (Chipsea broadcast)');
      expect(resolved(advert(YODA0_STABLE_76_30, 0x3fc0, YODA0_MAC, 'Yoda0'))).toBe(
        'OKOK (Chipsea broadcast)',
      );
      expect(resolved(advert(TZC4_STABLE_63_0, 0xa3c0, TZC4_MAC))).toBe('OKOK (Chipsea broadcast)');
      expect(resolved(advert(QJJ_STABLE_112_85, 0x9ec0, QJJ_MAC))).toBe('OKOK (Chipsea broadcast)');
      expect(resolved(v20(V20_FINAL_68_00))).toBe('OKOK (Chipsea broadcast)');
      expect(resolved(v20(V20_EB8217_95_0, null))).toBe('OKOK (Chipsea broadcast)');
    });

    it('claims a C0 frame on its own address echo, without any name', () => {
      expect(adapter.matches(nix(NIX_STABLE_147_00))).toBe(true);
      expect(adapter.matches(nix(NIX_IDLE, 0x03c0))).toBe(true);
    });

    it('refuses a real C0 frame heard from a different address', () => {
      expect(adapter.matches(nix(NIX_STABLE_147_00, 0x10c0, ARN_MAC))).toBe(false);
    });

    it('refuses a C0 frame whose echo is the address reversed', () => {
      expect(adapter.matches(nix(NIX_STABLE_147_00, 0x10c0, '3A:B5:DE:D0:B8:08'))).toBe(false);
    });

    it('refuses a C0 frame whose echoed MAC differs in one byte ([12] 0x3a -> 0x3b)', () => {
      expect(adapter.matches(nix(withByte(NIX_STABLE_147_00, 12, 0x3b)))).toBe(false);
    });

    it('refuses the C0 payload under a company id whose low byte is not 0xC0 (0x10C1)', () => {
      expect(adapter.matches(nix(NIX_STABLE_147_00, 0x10c1))).toBe(false);
    });

    it('refuses a C0 frame whose properties byte has the wrong shape ([6] 0x25 -> 0x65)', () => {
      expect(adapter.matches(nix(withByte(NIX_STABLE_147_00, 6, 0x65)))).toBe(false);
    });

    it('refuses a truncated C0 frame (last byte dropped)', () => {
      expect(adapter.matches(nix(buf(NIX_STABLE_147_00).subarray(0, 12)))).toBe(false);
    });

    it('does not claim a nameless C0 frame without an address (noble on macOS)', () => {
      expect(adapter.matches(nix(NIX_STABLE_147_00, 0x10c0, null))).toBe(false);
      expect(adapter.matches(nix(NIX_STABLE_147_00, 0x10c0, '<U:NK:NO:WN'))).toBe(false);
    });

    it('claims a Yoda0 frame with zeros for a MAC by its name, with or without an address', () => {
      expect(adapter.matches(advert(YODA0_STABLE_76_30, 0x3fc0, YODA0_MAC, 'Yoda0'))).toBe(true);
      expect(adapter.matches(advert(YODA0_IDLE, 0x3fc0, null, 'Yoda0'))).toBe(true);
      expect(adapter.matches(advert(YODA0_IDLE, 0x3fc0, YODA0_MAC, ''))).toBe(false);
      expect(adapter.matches(advert(YODA0_IDLE, 0x3fc0, YODA0_MAC, 'Yoda'))).toBe(false);
    });

    it('does not let the Yoda name claim a frame naming another address ([12] 0x00 -> 0x6d)', () => {
      const foreign = withByte(YODA0_STABLE_76_30, 12, 0x6d);
      expect(adapter.matches(advert(foreign, 0x3fc0, YODA0_MAC, 'Yoda0'))).toBe(false);
    });

    it('claims a 2.0 frame on its checksum and address echo', () => {
      expect(adapter.matches(v20(V20_IDLE))).toBe(true);
      expect(adapter.matches(v20(V20_FINAL_68_00, V20_MAC, ''))).toBe(true);
    });

    it('falls back to the exact name ADV for a 2.0 frame only without an address', () => {
      expect(adapter.matches(v20(V20_EB8217_95_0, null))).toBe(true);
      expect(adapter.matches(v20(V20_EB8217_95_0, null, 'ADV2'))).toBe(false);
      expect(adapter.matches(v20(V20_EB8217_95_0, null, ''))).toBe(false);
    });

    it('does not let the name ADV override a known address that does not match', () => {
      expect(adapter.matches(v20(V20_FINAL_68_00, NIX_MAC, 'ADV'))).toBe(false);
    });

    it('refuses a 2.0 frame whose checksum does not close ([12] 0x87 -> 0x86)', () => {
      expect(adapter.matches(v20(withByte(V20_FINAL_68_00, 12, 0x86)))).toBe(false);
      expect(adapter.matches(v20(withByte(V20_EB8217_95_0, 12, 0xed), null))).toBe(false);
    });

    it('refuses the 2.0 payload under another company id (0x20CB)', () => {
      expect(adapter.matches(advert(V20_FINAL_68_00, 0x20cb, V20_MAC, 'ADV'))).toBe(false);
    });

    it('refuses the V1.1 and VF0 Chipsea dialects', () => {
      const v11 = {
        ...advert(V11_AG88, 0x11ca, '08:B2:1E:15:6E:DB', 'Chipsea-BLE'),
        serviceUuids: ['fff0'],
      };
      expect(adapter.matches(v11)).toBe(false);
      expect(adapter.matches(advert(VF0_930, 0xf0ff, null, 'Chipsea-BLE'))).toBe(false);
    });

    it('does not claim a name alone', () => {
      expect(adapter.matches({ localName: 'ADV', serviceUuids: [] })).toBe(false);
      expect(adapter.matches({ localName: 'Yoda0', serviceUuids: [] })).toBe(false);
    });
  });

  describe('decoding', () => {
    it('reads the four NIX Home weigh-ins as the vendor app recorded them', () => {
      const adapter = new OkokChipseaAdapter();
      expect(adapter.parseBroadcast(buf(NIX_STABLE_147_00))).toEqual({ weight: 147, impedance: 0 });
      expect(adapter.parseBroadcast(buf(NIX_STABLE_149_55))).toEqual({
        weight: 149.55,
        impedance: 0,
      });
      expect(adapter.parseBroadcast(buf(NIX_STABLE_148_70))).toEqual({
        weight: 148.7,
        impedance: 0,
      });
      expect(adapter.parseBroadcast(buf(NIX_STABLE_147_50))).toEqual({
        weight: 147.5,
        impedance: 0,
      });
    });

    it('reads the other C0 units', () => {
      const adapter = new OkokChipseaAdapter();
      expect(adapter.parseBroadcast(buf(ARN_STABLE_81_50))).toEqual({ weight: 81.5, impedance: 0 });
      expect(adapter.parseBroadcast(buf(YODA0_STABLE_76_30))).toEqual({
        weight: 76.3,
        impedance: 0,
      });
      expect(adapter.parseBroadcast(buf(QJJ_STABLE_112_85))).toEqual({
        weight: 112.85,
        impedance: 0,
      });
    });

    it('reads a one-decimal C0 frame (TZC4, props 0x21) as 63.0 kg, not 6.30', () => {
      const adapter = new OkokChipseaAdapter();
      expect(adapter.parseBroadcast(buf(TZC4_STABLE_63_0))).toEqual({ weight: 63, impedance: 0 });
    });

    it('reads the 2.0 frames: two decimals (0x05) and one (0x01)', () => {
      const adapter = new OkokChipseaAdapter();
      expect(adapter.parseBroadcast(buf(V20_FINAL_68_00))).toEqual({ weight: 68, impedance: 0 });
      expect(adapter.parseBroadcast(buf(V20_FINAL_71_30))).toEqual({ weight: 71.3, impedance: 0 });
      expect(adapter.parseBroadcast(buf(V20_FINAL_68_65))).toEqual({
        weight: 68.65,
        impedance: 0,
      });
      expect(adapter.parseBroadcast(buf(V20_EB8217_95_0))).toEqual({ weight: 95, impedance: 0 });
    });

    it('reports settling frames as live weights, never as readings', () => {
      const adapter = new OkokChipseaAdapter();
      for (const [hex, kg] of [
        [NIX_SETTLING_147_00, 147],
        [TZC4_SETTLING, 63.4],
        [V20_SETTLING_68_70, 68.7],
      ] as const) {
        expect(adapter.parseBroadcast(buf(hex))).toBeNull();
        expect(adapter.parseLiveBroadcast(buf(hex))?.weight).toBeCloseTo(kg, 2);
      }
    });

    it('reports nothing for idle frames', () => {
      const adapter = new OkokChipseaAdapter();
      for (const hex of [NIX_IDLE, ARN_ID_00C0, YODA0_IDLE, V20_IDLE]) {
        expect(adapter.parseBroadcast(buf(hex))).toBeNull();
        expect(adapter.parseLiveBroadcast(buf(hex))).toBeNull();
      }
    });

    it('does not take the step-off frame after a stable phase for a reading (live only)', () => {
      const adapter = new OkokChipseaAdapter();
      expect(adapter.parseBroadcast(buf(ARN_STEPOFF_50_75))).toBeNull();
      // Deliberate: the display may show this weight for a moment after export.
      expect(adapter.parseLiveBroadcast(buf(ARN_STEPOFF_50_75))).toEqual({ weight: 50.75 });
    });

    it('never publishes r1 (6000 on NIX and BL-26L01, 600.0 ohm, a plausible value)', () => {
      const adapter = new OkokChipseaAdapter();
      expect(adapter.parseBroadcast(buf(NIX_STABLE_147_00))?.impedance).toBe(0);
      expect(adapter.parseBroadcast(buf(V20_FINAL_68_00))?.impedance).toBe(0);
      expect(adapter.parseBroadcast(buf(TZC4_STABLE_63_0))?.impedance).toBe(0);
    });
  });

  describe('properties the adapter does not decode', () => {
    const cases: Array<[string, Buffer, string]> = [
      ['C0 lb, derived [6] 0x25 -> 0x35', withByte(NIX_STABLE_147_00, 6, 0x35), '0x35'],
      ['C0 decimals, derived [6] 0x25 -> 0x23', withByte(NIX_STABLE_147_00, 6, 0x23), '0x23'],
      ['2.0 flags, derived [6] 0x05 -> 0x15', derived20(V20_FINAL_68_00, 6, 0x15), '0x15'],
    ];

    it.each(cases)('refuses %s on both channels and warns once', (_label, frame, hex) => {
      const adapter = new OkokChipseaAdapter();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      expect(adapter.parseBroadcast(frame)).toBeNull();
      expect(adapter.parseBroadcast(frame)).toBeNull();
      expect(adapter.parseLiveBroadcast(frame)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(hex);
      expect(String(warn.mock.calls[0][0])).toContain('Only kg is decoded');
    });

    it('refuses 2.0 properties 0x00 without a warning (derived [6] 0x04 -> 0x00)', () => {
      const adapter = new OkokChipseaAdapter();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const frame = derived20(V20_SETTLING_68_70, 6, 0x00);
      expect(adapter.parseBroadcast(frame)).toBeNull();
      expect(adapter.parseLiveBroadcast(frame)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    });

    it('refuses a 2.0 frame with a broken checksum on both channels ([12] 0x87 -> 0x86)', () => {
      const adapter = new OkokChipseaAdapter();
      const frame = withByte(V20_FINAL_68_00, 12, 0x86);
      expect(adapter.parseBroadcast(frame)).toBeNull();
      expect(adapter.parseLiveBroadcast(frame)).toBeNull();
    });
  });

  describe('advertisement decision', () => {
    it('completes on a stable frame', () => {
      const adapter = new OkokChipseaAdapter();
      expect(evaluateAdvertisement(adapter, nix(NIX_STABLE_147_00))).toEqual({
        kind: 'complete',
        reading: { weight: 147, impedance: 0 },
      });
      expect(evaluateAdvertisement(adapter, v20(V20_FINAL_68_65))).toEqual({
        kind: 'complete',
        reading: { weight: 68.65, impedance: 0 },
      });
    });

    it('waits on a settling frame and carries its live weight', () => {
      const adapter = new OkokChipseaAdapter();
      const decision = evaluateAdvertisement(adapter, nix(NIX_SETTLING_147_00, 0x1ac0));
      expect(decision).toEqual({ kind: 'wait', live: { weight: 147 } });
    });

    it('waits on an idle frame without a live weight', () => {
      const adapter = new OkokChipseaAdapter();
      expect(evaluateAdvertisement(adapter, nix(NIX_IDLE, 0x03c0))).toEqual({ kind: 'wait' });
    });

    it('under ble.force_scale_adapter: completes on a stable frame, does nothing on settling', () => {
      const [forced] = applyForcedAdapter(adapters, 'OKOK (Chipsea broadcast)');
      expect(evaluateAdvertisement(forced, nix(NIX_STABLE_147_00)).kind).toBe('complete');
      expect(evaluateAdvertisement(forced, nix(NIX_SETTLING_147_00, 0x1ac0))).toEqual({
        kind: 'none',
      });
    });
  });

  describe('debug log', () => {
    it('logs r1 and the frame of a stable payload once, and again after the expiry', () => {
      let t = 0;
      const adapter = new OkokChipseaAdapter(() => t);
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const stable = () => debug.mock.calls.filter(([m]) => String(m).includes('stable'));
      adapter.parseBroadcast(buf(NIX_STABLE_147_00));
      t += 400;
      adapter.parseBroadcast(buf(NIX_STABLE_147_00));
      expect(stable()).toHaveLength(1);
      expect(String(stable()[0][0])).toContain('r1=6000');
      expect(String(stable()[0][0])).toContain(NIX_STABLE_147_00);
      t += 5_000;
      adapter.parseBroadcast(buf(NIX_STABLE_147_00));
      expect(stable()).toHaveLength(2);
    });

    it('logs the stable payload of a new weigh-in even when it repeats the last one', () => {
      const adapter = new OkokChipseaAdapter();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const stable = () => debug.mock.calls.filter(([m]) => String(m).includes('stable'));
      adapter.parseBroadcast(buf(NIX_STABLE_147_00));
      adapter.parseBroadcast(buf(NIX_SETTLING_147_00));
      adapter.parseBroadcast(buf(NIX_STABLE_147_00));
      expect(stable()).toHaveLength(2);
    });

    it('logs a settling value once, and again only when it changes', () => {
      const adapter = new OkokChipseaAdapter();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const settling = () => debug.mock.calls.filter(([m]) => String(m).includes('settling'));
      adapter.parseBroadcast(buf(NIX_SETTLING_147_00));
      adapter.parseBroadcast(buf(NIX_SETTLING_147_00));
      expect(settling()).toHaveLength(1);
      adapter.parseBroadcast(buf(NIX_IDLE));
      expect(settling()).toHaveLength(2);
    });
  });

  describe('completion and body composition', () => {
    const adapter = new OkokChipseaAdapter();

    it('completes only inside the plausible range', () => {
      expect(adapter.isComplete({ weight: 68, impedance: 0 })).toBe(true);
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
      expect(adapter.isComplete({ weight: 400, impedance: 0 })).toBe(false);
    });

    it('estimates composition from BMI, ignoring any impedance on the reading', () => {
      const profile = defaultProfile();
      expect(adapter.computeMetrics({ weight: 147, impedance: 600 }, profile)).toEqual(
        buildPayload(147, 0, {}, profile),
      );
    });
  });
});
