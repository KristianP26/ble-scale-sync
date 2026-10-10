import type {
  BleDeviceInfo,
  BodyComposition,
  BroadcastSource,
  LiveWeight,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import { ownAddressBytes, type MatchDescriptor } from './match-descriptor.js';

// ─── OKOK / Chipsea broadcast (C0 and 2.0 dialects) ─────────────────────────
//
// Frame layouts, the 2.0 checksum and the address echo below were re-derived
// from the public captures cited in tests/scales/okok-chipsea.test.ts. The same
// frames are decoded by openScale's OkOkHandler (GPL-3.0,
// github.com/oliexdev/openScale: 2.0 by inzanity, the nameless C0 dialect by
// Florin9doi, Yoda1 by hyx0329) and, for C0, by ble_monitor's Xiaogui parser
// (MIT, github.com/custom-components/ble_monitor). No code was copied from
// either. Where a capture and either project disagree, the capture wins.

/**
 * C0 dialect: 13 bytes under a company id whose LOW byte is 0xC0. The high
 * byte is not a company at all but a counter (constant through one stable
 * phase, +1 per weigh-in, changing on almost every advert while the scale
 * settles), so the id cannot be matched exactly.
 *
 *   [0..1]   weight, uint16 big-endian
 *   [2..3]   "r1", uint16 big-endian; NOT published, see the class comment
 *   [4..5]   constant per unit (0a01, 0a11, 0002, 0000 seen), meaning unknown
 *   [6]      properties, see C0_PROPS
 *   [7..12]  the unit's own address, forward; all zeros on Yoda0/Yoda1 units
 */
const C0_ID_LOW = 0xc0;
const C0_LEN = 13;
const C0_PROPS_OFFSET = 6;
const C0_MAC_OFFSET = 7;

/**
 * 2.0 dialect: 19 bytes under company id 0x20CA, advertised with the name ADV.
 *
 *   [0]       0x0B on both units seen
 *   [1..4]    constant per unit (00000000, 41af2f81 seen)
 *   [5]       0x01 on both units seen
 *   [6]       properties, see V20_PROPS
 *   [7]       counter: +1 per weigh-in on final frames, random while idle
 *   [8..9]    weight, uint16 big-endian
 *   [10..11]  "r1", uint16 big-endian; NOT published
 *   [12]      checksum: 0x20 XOR [0..11] (0x20 is the second byte of the id)
 *   [13..18]  the unit's own address, forward
 */
const V20_ID = 0x20ca;
const V20_LEN = 19;
const V20_PROPS_OFFSET = 6;
const V20_COUNTER_OFFSET = 7;
const V20_WEIGHT_OFFSET = 8;
const V20_R1_OFFSET = 10;
const V20_CHECKSUM_OFFSET = 12;
const V20_MAC_OFFSET = 13;
const V20_CHECKSUM_SEED = 0x20;

const ADV_NAME = 'adv';
const YODA_PREFIXES = ['yoda0', 'yoda1'] as const;

interface Props {
  final: boolean;
  divisor: number;
}

/**
 * The C0 properties byte, as a whitelist of exact values rather than decoded
 * bit fields: by analogy with Chipsea's V1.1 spec bit 0 is "stable", bits 1-2
 * the decimals and bits 3-4 the unit, but a reading of the vendor app decodes
 * the same byte with other masks, and the two agree only on these four values.
 * All four are captured on several units, all in kg: 0x24/0x25 with 2 decimals
 * (NIX Home, arnelap, Yoda0, MaxxMee QJ-J), 0x20/0x21 with 1 (Xiaogui TZC4).
 * Every other value is refused: lb, st:lb and the other decimals are known only
 * from descriptions, never from a frame with the display value next to it.
 */
const C0_PROPS: ReadonlyMap<number, Props> = new Map([
  [0x20, { final: false, divisor: 10 }],
  [0x21, { final: true, divisor: 10 }],
  [0x24, { final: false, divisor: 100 }],
  [0x25, { final: true, divisor: 100 }],
]);

/**
 * The 2.0 properties byte, only the captured values: 0x05 final with 2
 * decimals and 0x04 settling (BL-26L01, openScale #410), 0x01 final with 1
 * decimal (EB8217, openScale #496).
 */
const V20_PROPS: ReadonlyMap<number, Props> = new Map([
  [0x01, { final: true, divisor: 10 }],
  [0x04, { final: false, divisor: 100 }],
  [0x05, { final: true, divisor: 100 }],
]);

/**
 * 0x00 would be "settling, 1 decimal" by the same reading, but it is only
 * described in an issue, never captured. Expected traffic rather than an
 * unknown unit, so it is refused with one debug line instead of a warning.
 */
const V20_PROPS_SETTLING_ONE_DECIMAL = 0x00;

const WEIGHT_MIN_KG = 2;
const WEIGHT_MAX_KG = 300;

/** See SenssunIfB7Adapter: same expiry, same reason. */
const LOG_KEY_TTL_MS = 3_000;

type Dialect = 'C0' | '2.0';

interface Frame {
  dialect: Dialect;
  props: number;
  /** Null when the properties byte is not on the whitelist. */
  decoded: Props | null;
  weight: number;
}

/** Bit 5 set, bits 6-7 clear: true of every C0 properties byte ever seen. */
function c0Shaped(d: Buffer): boolean {
  return d.length === C0_LEN && (d[C0_PROPS_OFFSET] & 0xe0) === 0x20;
}

function v20ChecksumOk(d: Buffer): boolean {
  if (d.length !== V20_LEN) return false;
  let x = V20_CHECKSUM_SEED;
  for (let i = 0; i < V20_CHECKSUM_OFFSET; i++) x ^= d[i];
  return x === d[V20_CHECKSUM_OFFSET];
}

/** Frame grammar by length; the parse path never sees the company id. */
function decode(d: Buffer): Frame | null {
  if (c0Shaped(d)) {
    const props = d[C0_PROPS_OFFSET];
    const decoded = C0_PROPS.get(props) ?? null;
    return {
      dialect: 'C0',
      props,
      decoded,
      weight: decoded ? d.readUInt16BE(0) / decoded.divisor : 0,
    };
  }
  if (v20ChecksumOk(d)) {
    const props = d[V20_PROPS_OFFSET];
    const decoded = V20_PROPS.get(props) ?? null;
    return {
      dialect: '2.0',
      props,
      decoded,
      weight: decoded ? d.readUInt16BE(V20_WEIGHT_OFFSET) / decoded.divisor : 0,
    };
  }
  return null;
}

function inRange(kg: number): boolean {
  return kg >= WEIGHT_MIN_KG && kg <= WEIGHT_MAX_KG;
}

function embeddedAddress(d: Buffer, offset: number): string {
  return d
    .subarray(offset, offset + 6)
    .toString('hex')
    .toUpperCase();
}

/**
 * Everything the frame says that is the same on every advert of one stable
 * phase. C0 carries its counter in the company id, so the whole payload is
 * the key; 2.0 carries it at [7], and [12] follows from it.
 */
function payloadKey(f: Frame, d: Buffer): string {
  if (f.dialect === 'C0') return d.toString('hex');
  return Buffer.concat([
    d.subarray(0, V20_COUNTER_OFFSET),
    d.subarray(V20_COUNTER_OFFSET + 1, V20_CHECKSUM_OFFSET),
    d.subarray(V20_CHECKSUM_OFFSET + 1),
  ]).toString('hex');
}

interface LogKey {
  key: string | null;
  seenAt: number;
}

/**
 * Adapter for the broadcast-only Chipsea scales sold under many brands with
 * the OKOK app (#408): the C0 dialect (nameless units such as NIX Home, Xiaogui
 * TZC4, MaxxMee QJ-J, and units named Yoda0 / Yoda1) and the 2.0 dialect
 * (company id 0x20CA, name ADV, e.g. BL-26L01).
 *
 * Weight only. Both dialects carry an "r1" field that other projects publish as
 * impedance, but it is a constant (6000, i.e. 600.0 ohm, or 5000) on every unit
 * captured, and on two of them the vendor app's body fat follows the weight
 * while r1 stays put. 600 ohm lies inside the plausible band the processor
 * accepts, so passing it on would turn a constant into a body-fat figure; it is
 * logged in debug mode instead.
 */
export class OkokChipseaAdapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'OKOK (Chipsea broadcast)';
  /**
   * Custom because the claim is the address echo (or the 2.0 checksum plus the
   * name ADV, or a Yoda name), which a descriptor cannot express. No
   * manufacturerId: the C0 id changes all the time, and node-ble's broadcast
   * poll would skip every C0 entry that does not carry the declared id.
   */
  readonly match: MatchDescriptor = {
    priority: 214,
    custom: true,
    names: { exact: [ADV_NAME], startsWith: [...YODA_PREFIXES] },
  };
  readonly normalizesWeight = true;
  readonly preferPassive = true;

  /** Logging state only; nothing here feeds a reading. */
  private lastSettlingKg: number | null = null;
  private readonly lastFinal: LogKey = { key: null, seenAt: -Infinity };
  /** Properties values already reported, as `dialect:value`. */
  private readonly propsReported = new Set<string>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * C0: the frame must carry the transmitting address at [7..12]. Units named
   * Yoda0 / Yoda1 put zeros there instead, so for them the name stands in, but
   * only when the frame does not name some other address. Without an address
   * (noble on macOS) only the Yoda name can claim a C0 frame.
   *
   * 2.0: the checksum must close and the frame must carry the transmitting
   * address at [13..18]; without an address the exact name ADV stands in.
   */
  matches(device: BleDeviceInfo): boolean {
    const m = device.manufacturerData;
    if (!m) return false;
    const own = ownAddressBytes(device.address);
    const name = (device.localName ?? '').trim().toLowerCase();

    if ((m.id & 0xff) === C0_ID_LOW && c0Shaped(m.data)) {
      const echoed = embeddedAddress(m.data, C0_MAC_OFFSET);
      if (own !== null && echoed === own) return true;
      if (!YODA_PREFIXES.some((p) => name.startsWith(p))) return false;
      return own === null || echoed === '000000000000';
    }
    if (m.id === V20_ID && v20ChecksumOk(m.data)) {
      if (own !== null) return embeddedAddress(m.data, V20_MAC_OFFSET) === own;
      return name === ADV_NAME;
    }
    return false;
  }

  parseNotification(): ScaleReading | null {
    return null;
  }

  /** A frame with a whitelisted properties byte, or null (reported once per other value). */
  private knownFrame(d: Buffer): Frame | null {
    const f = decode(d);
    if (!f) return null;
    if (f.decoded) return f;
    // Once per value, not per advert (#372): a unit that sends one of these
    // sends it on every frame in that state, through both parsers.
    if (!this.firstReport(f)) return null;
    if (f.dialect === '2.0' && f.props === V20_PROPS_SETTLING_ONE_DECIMAL) {
      bleLog.debug(
        `OKOK 2.0: properties 0x00 is not decoded, such frames are ignored. First one: ` +
          d.toString('hex'),
      );
      return null;
    }
    this.warnProps(f);
    return null;
  }

  private firstReport(f: Frame): boolean {
    const key = `${f.dialect}:${f.props}`;
    if (this.propsReported.has(key)) return false;
    this.propsReported.add(key);
    return true;
  }

  private warnProps(f: Frame): void {
    bleLog.warn(
      `OKOK scale (${f.dialect} frame) sent properties byte 0x${f.props.toString(16)}, a ` +
        `display unit or precision that is not decoded. Only kg is decoded, so its readings ` +
        `are ignored. Switch the scale to kg, or report a weigh-in in this mode on #408.`,
    );
  }

  /** True when this frame's payload should be logged (see SenssunIfB7Adapter). */
  private firstSighting(slot: LogKey, key: string): boolean {
    const at = this.now();
    const first = key !== slot.key || at - slot.seenAt > LOG_KEY_TTL_MS;
    slot.key = key;
    slot.seenAt = at;
    return first;
  }

  /**
   * The settling stream, for a display that follows the scale (#356). The C0
   * scale also sends settling frames with the weight while the user steps off
   * after the stable phase, so the display can show a live weight for a moment
   * after the export.
   */
  parseLiveBroadcast(manufacturerData: Buffer): LiveWeight | null {
    const f = this.knownFrame(manufacturerData);
    if (!f?.decoded || f.decoded.final || !inRange(f.weight)) return null;
    return { weight: f.weight };
  }

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    const f = this.knownFrame(manufacturerData);
    if (!f?.decoded) return null;

    if (!f.decoded.final) {
      // One line per value, not per advert (#372). A new weigh-in may end on
      // the payload of the last one, so the final key must not outlive it.
      this.lastFinal.key = null;
      if (f.weight !== this.lastSettlingKg) {
        this.lastSettlingKg = f.weight;
        bleLog.debug(`OKOK ${f.dialect} settling: ${f.weight.toFixed(2)} kg`);
      }
      return null;
    }
    this.lastSettlingKg = null;
    if (!inRange(f.weight)) return null;

    if (this.firstSighting(this.lastFinal, payloadKey(f, manufacturerData))) {
      const d = manufacturerData;
      const undecoded =
        f.dialect === 'C0'
          ? `r1=${d.readUInt16BE(2)} [4..5]=${d.subarray(4, 6).toString('hex')}`
          : `r1=${d.readUInt16BE(V20_R1_OFFSET)} [0..5]=${d.subarray(0, 6).toString('hex')} ` +
            `[7]=0x${d[V20_COUNTER_OFFSET].toString(16)}`;
      bleLog.debug(
        `OKOK ${f.dialect} stable: ${f.weight.toFixed(2)} kg ` +
          `(undecoded: ${undecoded} props=0x${f.props.toString(16)}) frame=${d.toString('hex')}`,
      );
    }
    return { weight: f.weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return inRange(reading.weight);
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(reading.weight, 0, {}, profile);
  }
}
