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
import {
  uuid16,
  buildPayload,
  biaFatIfPlausible,
  type ScaleBodyComp,
} from './body-comp-helpers.js';
import { bleLog, normalizeUuid } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';
import { parseSigDateTime, trustedScaleTime } from './sig-wss.js';
import { isHistoricalReading } from '../interfaces/reading-time.js';

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
 * devices whose characteristics show the SIG consent pair and no QN pair, and,
 * before discovery, those that do NOT advertise the QN vendor services
 * (0xFFE0 / 0xFFF0). See matches().
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
  /** Time the current weigh-in's frames carry (D027), when the clock is set. */
  private cachedTimestamp: Date | undefined;
  /** The current weigh-in's reading when it is a stored record (see buildReading). */
  private storedRecord: ScaleReading | null = null;

  /**
   * Match "renpho" devices that are not QN-protocol scales.
   *
   * Once the characteristics are known they decide (D-04). The ES-WBE28 hosts
   * its vendor 0xFFE1/0xFFE2 pair in a 0xFFE0 GATT service, so on any path that
   * merges discovered services into `serviceUuids` the service rule below read
   * it as a QN scale and declined it, and QN took it on the shared name: always
   * on node-ble, where the pre-connect record has no services and QN wins on
   * priority. Its characteristics tell the two apart: the SIG consent pair
   * (0x2A9F User Control Point and 0x2A9D) and no QN pair (notify 0xFFF1 or
   * 0xFFE1 AND write 0xFFF2 or 0xFFE3), whose write half it lacks (#267
   * capture). `qn-scale/matching.ts` applies the mirror rule.
   *
   * Before discovery, "renpho" devices that advertise a QN vendor service
   * (0xFFE0 / 0xFFF0) are left to QnScaleAdapter, as before.
   */
  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (!name.includes('renpho')) return false;

    const chars = (device.characteristicUuids || []).map((u) => normalizeUuid(u));
    if (chars.length > 0) {
      const has = (code: number) => chars.includes(uuid16(code));
      const qnCanRun = (has(0xfff1) || has(0xffe1)) && (has(0xfff2) || has(0xffe3));
      if (qnCanRun) return false;
      if (has(0x2a9f) && has(0x2a9d)) return true;
    }

    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    const hasQn = uuids.some(
      (u) => u === SVC_QN_T1 || u === SVC_QN_T2 || u === uuid16(0xffe0) || u === uuid16(0xfff0),
    );
    return !hasQn;
  }

  /**
   * Clear the previous weigh-in before anything is subscribed (#394).
   *
   * This used to live in `onConnected`, which is too late for a multi-char
   * adapter: `subscribeAndInit` enables EVERY notify binding and only then
   * awaits `startInit()`, so frames can already be arriving - through several
   * D-Bus round trips for the second and third binding - while the reset has
   * not run. `onSessionStart` runs before the first subscribe.
   */
  onSessionStart(): void {
    this.cachedWeight = 0;
    this.cachedImpedance = 0;
    this.cachedTimestamp = undefined;
    this.storedRecord = null;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    // Consent on the SIG User Control Point is what unlocks the stream, so it is
    // the only hard requirement. The vendor 0xFFE2 service is not advertised (the
    // matcher rejects devices that advertise 0xFFE0), so a firmware variant may
    // not expose it; guard its writes rather than hard-requiring it (#267 review).
    if (!ctx.availableChars.has(CHR_UCP)) {
      throw new Error(
        `Renpho ES-WBE28: User Control Point (${CHR_UCP}) not discovered. ` +
          'Likely a transient GATT discovery race. Try again.',
      );
    }

    // 1. Vendor handshake — three opaque config writes to 0xFFE2, when present.
    if (ctx.availableChars.has(CHR_VENDOR_WRITE)) {
      for (const cmd of HANDSHAKE) {
        await ctx.write(CHR_VENDOR_WRITE, cmd, true);
      }
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
   *
   * A real weight opens a new weigh-in (D-11). Its SIG Date Time (bit 1, the
   * captured live frame carries one) becomes the reading's time, so a record
   * the scale stored while nobody was connected is told apart from today's by
   * the runtime (D027) instead of being exported as today's. And the impedance
   * kept from the previous weigh-in is dropped: it was held ("first impedance
   * seen") across frames, so a stored record's impedance completed the hold of
   * the next weight with a value measured on another day.
   */
  private parseWeightMeasurement(data: Buffer): void {
    if (data.length < 3) return;
    const flags = data[0];
    const imperial = (flags & 0x01) !== 0;
    const raw = data.readUInt16LE(1);
    let weight = raw * (imperial ? LB_PER_UNIT : KG_PER_UNIT);
    if (imperial) weight *= LB_TO_KG;
    if (!(weight > 0) || !Number.isFinite(weight)) return;
    this.cachedWeight = weight;
    this.cachedImpedance = 0;
    this.storedRecord = null;
    this.cachedTimestamp = flags & 0x02 ? trustedScaleTime(parseSigDateTime(data, 3)) : undefined;
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
      if (flag === 0x0002 && !this.cachedTimestamp) {
        // A weigh-in whose 0x2A9D carried no time can still be dated by this.
        this.cachedTimestamp = trustedScaleTime(parseSigDateTime(data, off));
      }
      if (field === 'impedance' && this.cachedImpedance <= 0) {
        this.cachedImpedance = data.readUInt16LE(off) * 0.1;
      } else if (field === 'weight' && this.cachedWeight <= 0) {
        const w = data.readUInt16LE(off) * step;
        if (w > 0 && Number.isFinite(w)) this.cachedWeight = w;
      }
      off += size;
    }
  }

  /**
   * The current weigh-in. The frames' user ID is deliberately not passed on as
   * `userIndex`: it is 170, the fixed index this adapter consents as, the same
   * for every person, so it says nothing about whose weigh-in it is.
   *
   * A stored record is emitted once. The session buffers it as history the
   * moment it is emitted, so a later frame of the same record (its impedance)
   * updates that buffered reading in place instead of adding a second copy,
   * which would be exported as a second weigh-in.
   */
  private buildReading(): ScaleReading | null {
    if (this.cachedWeight <= 0) return null;
    const stored = this.storedRecord;
    if (stored) {
      stored.impedance = this.cachedImpedance;
      return null;
    }
    const reading: ScaleReading = { weight: this.cachedWeight, impedance: this.cachedImpedance };
    if (this.cachedTimestamp) reading.timestamp = this.cachedTimestamp;
    if (isHistoricalReading(reading)) this.storedRecord = reading;
    return reading;
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
    // Recompute body fat from raw impedance (BIA) when the impedance is inside
    // the plausible whole-body band; otherwise buildPayload falls back to BMI
    // estimation, which is better than a pinned floor or ceiling published as a
    // measurement (#405).
    comp.fat = biaFatIfPlausible(reading.weight, reading.impedance, profile);
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
