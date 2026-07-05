import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  MultiCharNotify,
  HoldForComposition,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, computeBiaFat, type ScaleBodyComp } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';

/**
 * Handler for RENPHO ES-WBE28 / "Renpho-Scale" (Elis 1 family).
 *
 * Reverse-engineered from an Android btsnoop HCI capture of the physical device
 * and verified against it. Despite openScale's older RenphoHandler.kt treating
 * this as a proprietary weight-only device, the ES-WBE28 speaks pure Bluetooth
 * SIG GATT:
 *
 *   Weight Scale       0x181D → Weight Measurement       0x2A9D (notify)
 *   Body Composition   0x181B → Body Comp. Measurement    0x2A9C (indicate)
 *   User Data          0x181C → User Control Point        0x2A9F (consent)
 *
 * The scale stays completely SILENT until a registered user "consents" through
 * the User Data Service. Merely subscribing to 0x2A9D and poking the vendor
 * channel (the previous implementation) never unlocks it, so the scale connects
 * and then disconnects without ever streaming. We must replay the app's init:
 *
 *   1. Subscribe to the vendor (0xFFE1) + User Control Point (0x2A9F) channels.
 *   2. Vendor handshake — three writes to 0xFFE2 (opaque config query).
 *   3. UCP consent — write 02 AA 0F 27 to 0x2A9F (user 0xAA=170, code 9999).
 *   4. Profile writes (gender/height/DOB/age + vendor 0x2AFF) to satisfy the
 *      scale's on-device maths.
 *   5. Enable the weight + body-composition notifications LAST (order matters —
 *      the app enables these CCCDs only after consent + profile).
 *
 * The consent user index (170) and code (9999) are the returning-user values
 * captured from the RENPHO app's own registration; they are fixed for this
 * device family. Body composition is recomputed on the host from raw impedance
 * (BIA) rather than trusting the scale's per-profile derived numbers, which are
 * only correct for the single profile the scale was registered with.
 *
 * Mutual exclusion with QnScaleAdapter: RenphoScaleAdapter claims "renpho"
 * devices that do NOT advertise the QN vendor services (0xFFE0 / 0xFFF0).
 */

// Standard SIG characteristics.
const CHR_WEIGHT = uuid16(0x2a9d); // notify   — Weight Measurement
const CHR_BODYCOMP = uuid16(0x2a9c); // indicate — Body Composition Measurement
const CHR_UCP = uuid16(0x2a9f); // User Control Point (consent + response)

// Vendor 0xFFE0 service used for the opaque config handshake.
const CHR_VENDOR_NOTIFY = uuid16(0xffe1);
const CHR_VENDOR_WRITE = uuid16(0xffe2);

// User Data Service profile characteristics.
const CHR_GENDER = uuid16(0x2a8c);
const CHR_AGE = uuid16(0x2a80);
const CHR_DOB = uuid16(0x2a85);
const CHR_HEIGHT = uuid16(0x2a8e);
const CHR_VENDOR_2AFF = uuid16(0x2aff);

// QN vendor service UUIDs (used for exclusion).
const SVC_QN_T1 = 'ffe0';
const SVC_QN_T2 = 'fff0';

// Vendor handshake, replayed verbatim from the app capture (writes to 0xFFE2).
const HANDSHAKE: number[][] = [
  [0x10, 0x01, 0x00, 0x11],
  [0x03, 0x00, 0x01, 0x04],
  [0x19, 0x00, 0x19],
];

// User Control Point consent (returning-user values captured from the app).
const UCP_CONSENT = 0x02;
const UCP_RESPONSE = 0x20;
const UCP_RESULT_SUCCESS = 0x01;
const CONSENT_USER_INDEX = 0xaa; // 170
const CONSENT_CODE = 9999; // 0x270F → wire bytes 0F 27 (LE)

// RENPHO deviates from the SIG standard: mass fields use a 0.05 kg resolution
// (10× the spec's 0.005), confirmed against the physical scale and internally
// consistent with fat% and fat-free mass (raw 1900 → 95.0 kg).
const KG_PER_UNIT = 0.05;
const LB_PER_UNIT = 0.1;
const LB_TO_KG = 0.45359237;

export class RenphoScaleAdapter
  implements ScaleAdapterCore, GattWiring, MultiCharNotify, HoldForComposition
{
  readonly name = 'Renpho ES-WBE28';
  readonly match: MatchDescriptor = {
    priority: 240,
    custom: true,
    names: { includes: ['renpho'] },
    serviceUuids: ['181b', '181d'],
  };
  // Legacy single-char fallback (unused in multi-char mode).
  readonly charNotifyUuid = CHR_WEIGHT;
  readonly charWriteUuid = CHR_VENDOR_WRITE;
  readonly normalizesWeight = true;

  // Only the channels that must be live BEFORE the handshake are auto-subscribed
  // here. The weight + body-composition CCCDs are enabled LAST, inside
  // onConnected(), to mirror the app's ordering.
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_VENDOR_NOTIFY, type: 'notify' },
    { uuid: CHR_UCP, type: 'notify' },
    { uuid: CHR_VENDOR_WRITE, type: 'write' },
  ];

  // Hold the link open briefly after the weight settles so the multi-packet
  // body-composition indications (carrying impedance) can land.
  readonly completionHoldMs = 8000;

  private cachedWeight = 0;
  private cachedImpedance = 0;

  /**
   * Match "renpho" devices that do NOT advertise QN vendor service UUIDs
   * (0xFFE0 / 0xFFF0). Those are handled by QnScaleAdapter.
   */
  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (!name.includes('renpho')) return false;

    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    const hasQn = uuids.some(
      (u) => u === SVC_QN_T1 || u === SVC_QN_T2 || u === uuid16(0xffe0) || u === uuid16(0xfff0),
    );
    return !hasQn;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    // Reset per-connection state (adapter instance is shared across sessions).
    this.cachedWeight = 0;
    this.cachedImpedance = 0;

    const required = [CHR_UCP, CHR_VENDOR_WRITE];
    const missing = required.filter((u) => !ctx.availableChars.has(u));
    if (missing.length > 0) {
      throw new Error(
        `Renpho ES-WBE28: required characteristics not discovered (${missing.join(', ')}). ` +
          'Likely a transient GATT discovery race. Try again.',
      );
    }

    // 1. Vendor handshake — three opaque config writes to 0xFFE2.
    for (const cmd of HANDSHAKE) {
      await ctx.write(CHR_VENDOR_WRITE, cmd, true);
    }

    // 2. User Control Point consent (opcode, user index, code LE).
    await ctx.write(
      CHR_UCP,
      [UCP_CONSENT, CONSENT_USER_INDEX & 0xff, CONSENT_CODE & 0xff, (CONSENT_CODE >> 8) & 0xff],
      true,
    );

    // 3. Profile writes — only unlock measurements / feed the scale's ignored
    //    on-device maths. Guarded by availableChars so a firmware variant
    //    missing one does not abort the whole init.
    for (const [uuid, payload] of this.buildProfileWrites(ctx.profile)) {
      if (ctx.availableChars.has(uuid)) await ctx.write(uuid, payload, true);
    }

    // 4. Enable measurement notifications LAST, as the app does.
    await ctx.subscribe(CHR_WEIGHT);
    await ctx.subscribe(CHR_BODYCOMP);
    bleLog.debug('Renpho ES-WBE28: consent + profile sent, measurement notifications enabled');
  }

  /** Ordered (characteristic, bytes) profile writes mirroring the app. */
  private buildProfileWrites(profile: UserProfile): Array<[string, number[]]> {
    const gender = profile.gender === 'female' ? 1 : 0;
    const age = Math.max(1, Math.round(profile.age));
    const heightCm = Math.max(1, Math.round(profile.height));
    const birthYear = new Date().getFullYear() - age;
    return [
      [CHR_GENDER, [gender]],
      [CHR_HEIGHT, [heightCm & 0xff, (heightCm >> 8) & 0xff]],
      [CHR_DOB, [birthYear & 0xff, (birthYear >> 8) & 0xff, 1, 1]],
      [CHR_AGE, [age & 0xff]],
      [CHR_VENDOR_2AFF, [0x04, 0x00]],
    ];
  }

  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    if (charUuid === CHR_UCP) {
      this.handleUcpResponse(data);
      return null;
    }
    if (charUuid === CHR_VENDOR_NOTIFY) {
      return null; // opaque handshake acks — nothing to decode
    }
    if (charUuid === CHR_WEIGHT) {
      this.parseWeightMeasurement(data);
      return this.buildReading();
    }
    if (charUuid === CHR_BODYCOMP) {
      this.parseBodyComposition(data);
      return this.buildReading();
    }
    return null;
  }

  /** Legacy single-char path: weight measurement frames only. */
  parseNotification(data: Buffer): ScaleReading | null {
    this.parseWeightMeasurement(data);
    return this.buildReading();
  }

  private handleUcpResponse(data: Buffer): void {
    if (data.length < 3 || data[0] !== UCP_RESPONSE) return;
    if (data[2] === UCP_RESULT_SUCCESS) {
      bleLog.debug('Renpho ES-WBE28: consent accepted, awaiting measurement');
    } else {
      bleLog.warn(
        `Renpho ES-WBE28: User Control Point result 0x${data[2].toString(16)} ` +
          '(consent not accepted). The scale may need re-registering in the RENPHO app.',
      );
    }
  }

  /**
   * Decode a 0x2A9D Weight Measurement notification. Standard SIG layout with
   * RENPHO's 0.05 kg resolution deviation. data[0] is a FLAGS byte (bit0 = unit,
   * bit1 = timestamp, ...), NOT a fixed frame marker.
   */
  private parseWeightMeasurement(data: Buffer): void {
    if (data.length < 3) return;
    const flags = data[0];
    const imperial = (flags & 0x01) !== 0;
    const raw = data.readUInt16LE(1);
    let weight = raw * (imperial ? LB_PER_UNIT : KG_PER_UNIT);
    if (imperial) weight *= LB_TO_KG;
    if (weight > 0 && Number.isFinite(weight)) this.cachedWeight = weight;
  }

  /**
   * Decode a 0x2A9C Body Composition Measurement packet, extracting impedance
   * (the profile-independent field we need for host-side BIA). RENPHO splits the
   * measurement across two indications and its per-packet flags can advertise
   * fields that don't actually fit; so we walk fields in SIG bit-order and stop
   * the moment the buffer is exhausted. We keep the FIRST impedance seen.
   */
  private parseBodyComposition(data: Buffer): void {
    if (data.length < 4) return;
    const flags = data.readUInt16LE(0);
    const imperial = (flags & 0x0001) !== 0;
    const step = imperial ? LB_PER_UNIT : KG_PER_UNIT;
    const n = data.length;

    // (flag, size, field). null flag = always present. Order is the SIG bit order.
    const plan: Array<[number | null, number, 'impedance' | 'weight' | null]> = [
      [null, 2, null], // body fat % (mandatory) — ignored; we recompute from impedance
      [0x0002, 7, null], // timestamp
      [0x0004, 1, null], // user id
      [0x0008, 2, null], // basal metabolism
      [0x0010, 2, null], // muscle %
      [0x0020, 2, null], // muscle mass
      [0x0040, 2, null], // fat free mass
      [0x0080, 2, null], // soft lean mass
      [0x0100, 2, null], // body water mass
      [0x0200, 2, 'impedance'], // impedance ×0.1 Ω
      [0x0400, 2, 'weight'], // weight ×step
      [0x0800, 2, null], // height
    ];

    let off = 2;
    for (const [flag, size, field] of plan) {
      if (flag !== null && !(flags & flag)) continue;
      if (off + size > n) break; // belongs to a later packet
      if (field === 'impedance' && this.cachedImpedance <= 0) {
        this.cachedImpedance = data.readUInt16LE(off) * 0.1;
      } else if (field === 'weight' && this.cachedWeight <= 0) {
        const w = data.readUInt16LE(off) * step;
        if (w > 0 && Number.isFinite(w)) this.cachedWeight = w;
      }
      off += size;
    }
  }

  private buildReading(): ScaleReading | null {
    if (this.cachedWeight <= 0) return null;
    return { weight: this.cachedWeight, impedance: this.cachedImpedance };
  }

  isComplete(reading: ScaleReading): boolean {
    // Weight is enough to resolve; the hold window waits for impedance.
    return reading.weight > 0;
  }

  /** Resolve immediately once impedance has arrived (the rich reading). */
  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    // Recompute body fat from raw impedance (BIA) when available; otherwise
    // buildPayload falls back to BMI estimation.
    if (reading.impedance > 0) {
      comp.fat = computeBiaFat(reading.weight, reading.impedance, profile);
    }
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
