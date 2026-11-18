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
import { qnCanRun } from './qn-scale/matching.js';
import { ownAddressBytes, uuidClaimHits, type MatchDescriptor } from './match-descriptor.js';
import { parseSigDateTime, trustedScaleTime, type SigClock } from './sig-wss.js';
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
 * device family. Body composition is computed on the host rather than taken
 * from the scale's per-profile derived numbers, which are only correct for the
 * single profile the scale was registered with. Until the impedance in the
 * second 0x2A9C packet is confirmed (#507), that is the BMI estimate.
 *
 * Mutual exclusion with QnScaleAdapter: RenphoScaleAdapter claims "renpho"
 * devices whose characteristics show the SIG consent pair and no QN pair, and,
 * before discovery, those that do NOT advertise the QN vendor services
 * (0xFFE0 / 0xFFF0). A device with no name at all (the Renpho A-R003, #507) is
 * claimed on the characteristics the family shares, or before discovery on its
 * advertisement. See matches().
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

/**
 * What a nameless scale of this family must expose once its characteristics are
 * known: the consent pair, body composition, the vendor pair the handshake
 * writes and the vendor 0x2AFF profile write. The ES-WBE28 (#267 capture) and
 * the A-R003 (#507 log) both have all six. 0xFFF1 / 0xFFF2 are not required
 * because the ES-WBE28 lacks them. An ES-WBE28 firmware without 0xFFE2 and the
 * profile characteristics (tests/fixtures/renpho/es-wbe28-consent-only.ts) is
 * not claimed nameless; the consent pair alone is shared with Beurer.
 */
const NAMELESS_FAMILY_CHARS = [
  CHR_UCP,
  CHR_WEIGHT,
  CHR_BODYCOMP,
  CHR_VENDOR_NOTIFY,
  CHR_VENDOR_WRITE,
  CHR_VENDOR_2AFF,
];

// The A-R003 advertisement (#507 log): company 0xFFFF, 17 bytes, the scale's
// own address little-endian at [9..14]. The other bytes are not decoded.
const AR003_COMPANY_ID = 0xffff;
const AR003_MSD_LENGTH = 17;
const AR003_ADDRESS_OFFSET = 9;

/**
 * Whether a nameless advertisement is the A-R003's. QN scales also use company
 * 0xFFFF, with the address at [5..10] (a 17-byte one in #501) or an 0xAABB
 * header of 19 bytes or more, so the length and the echo offset together keep
 * them out. 0x181D is required whenever the transport reports advertised
 * services; node-ble reports none before connecting.
 */
function isAr003Advertisement(device: BleDeviceInfo): boolean {
  const msd = device.manufacturerData;
  if (msd?.id !== AR003_COMPANY_ID || msd.data.length !== AR003_MSD_LENGTH) return false;
  const services = device.serviceUuids ?? [];
  if (services.length > 0 && !uuidClaimHits(['181d'], services)) return false;
  const own = ownAddressBytes(device.address);
  if (!own) return false;
  const echoed = Buffer.from(msd.data.subarray(AR003_ADDRESS_OFFSET, AR003_ADDRESS_OFFSET + 6))
    .reverse()
    .toString('hex')
    .toUpperCase();
  return echoed === own;
}

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

/**
 * The optional Body Composition Measurement fields after the mandatory body
 * fat, in SIG bit order: (flag, size, field the walk keeps).
 */
const SIG_FIELDS: ReadonlyArray<[number, number, 'impedance' | 'weight' | null]> = [
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

// 0x2A9D flags bits 6 and 5, RFU in the SIG spec. On the A-R003 (#507) the
// scale sets bit 6 while it measures the body composition (0x4E, four to six
// frames 0.5 s apart) and bit 5 on the final frame that echoes the profile
// (0x2E); 0x0E frames come while the weight still moves.
const FLAG_MEASURING = 0x40;
const FLAG_FINAL = 0x20;
// 0x2A9D flags bit 1: a SIG Date Time follows the weight.
const FLAG_TIMESTAMP = 0x02;

/**
 * How far from its receipt a live frame's stamp may lie and still place the
 * scale clock (#510). Wider than HISTORY_WINDOW_MS, because the ES-WBE28
 * stamps its 0x4E frames minutes ahead of the final one. The two readings of
 * one stamp are the host's zone offset apart, at least an hour anywhere off
 * UTC, so with less than half of that they never both fit.
 */
const CLOCK_ZONE_TOLERANCE_MS = 15 * 60 * 1000;

// Body Composition Measurement flag bit 12: the measurement is split across
// two packets, and the spec sets it in both (BCS 1.0, 3.2.1).
const BCS_MULTIPLE_PACKET = 0x1000;
// The second 0x2A9C packet of a weigh-in on the ES-WBE28 (#267) and the A-R003 (#507).
const VENDOR_PACKET_LENGTH = 19;

/**
 * Whether a packet's flags describe it exactly, as a single SIG packet's must:
 * the fields they claim fill it to the byte, and a claimed Time Stamp is a
 * date. parseSigDateTime rejects the year 0 the spec allows for "unknown", so
 * a single packet from a scale whose clock was never set fails here too; a
 * looser check would walk a vendor packet whose second resistance is 0 as SIG.
 */
function describesPacket(data: Buffer, flags: number): boolean {
  let len = 4; // flags + body fat
  for (const [flag, size] of SIG_FIELDS) if (flags & flag) len += size;
  if (len !== data.length) return false;
  return !(flags & 0x0002) || parseSigDateTime(data, 4) !== undefined;
}

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class RenphoSession {
  cachedWeight = 0;
  cachedImpedance = 0;
  /** Time the current weigh-in's frames carry (D027), when the clock is set. */
  cachedTimestamp: Date | undefined;
  /** The current weigh-in's reading when it is a stored record (see buildReading). */
  storedRecord: ScaleReading | null = null;
  /** The weigh-in's second 0x2A9C packet has arrived (parseVendorPacket). */
  compositionDone = false;
  /** The last 0x2A9D said the scale is measuring (bit 6) or final (bit 5); see isCompositionPending. */
  measuring = false;
  /** The last 0x2A9D was a 0x4E with a weight, the only frame a final 0x2E may place the clock after. */
  weighing = false;
  /** How the scale clock reads, once a live frame has placed it (placeScaleClock). */
  clock: SigClock | undefined;
  /** A live frame left the clock unplaced and said so in the debug log. */
  clockUnplacedLogged = false;
}

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

  // Only the channels that must be live BEFORE the handshake are auto-subscribed
  // here. The weight + body-composition CCCDs are enabled LAST, inside
  // onConnected(), to mirror the app's ordering.
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_VENDOR_NOTIFY, type: 'notify' },
    { uuid: CHR_UCP, type: 'notify' },
    { uuid: CHR_VENDOR_WRITE, type: 'write' },
  ];

  // Hold the link open briefly after the weight settles so the two
  // body-composition indications can land; the second ends the hold (isFinal).
  // The hold arms on the first weight above 0, so a scale still measuring when
  // it runs out extends it (isCompositionPending).
  readonly completionHoldMs = 8000;

  private s = new RenphoSession();

  /**
   * Match "renpho" devices that are not QN-protocol scales, and the nameless
   * Renpho A-R003.
   *
   * A device with no name (the A-R003 advertises none, #507) is decided by its
   * characteristics once they are known: all of NAMELESS_FAMILY_CHARS. The QN
   * pair does not count against it there, because the A-R003 has 0xFFF1 /
   * 0xFFF2 next to the SIG stack; QN's nameless fallback declines it on the
   * SIG consent pair. Before discovery only its advertisement can claim it
   * (isAr003Advertisement). Characteristics that miss the set win over a
   * matching advertisement.
   *
   * For a "renpho" name, once the characteristics are known they decide (D-04).
   * The ES-WBE28 hosts its vendor 0xFFE1/0xFFE2 pair in a 0xFFE0 GATT service,
   * so on any path that merges discovered services into `serviceUuids` the
   * service rule below read it as a QN scale and declined it, and QN took it on
   * the shared name: always on node-ble, where the pre-connect record has no
   * services and QN wins on priority. Its characteristics tell the two apart:
   * the SIG consent pair (0x2A9F User Control Point and 0x2A9D) and no QN pair
   * (notify 0xFFF1 or 0xFFE1 AND write 0xFFF2 or 0xFFE3), whose write half it
   * lacks (#267 capture). `qn-scale/matching.ts` applies the mirror rule.
   *
   * Before discovery, "renpho" devices that advertise a QN vendor service
   * (0xFFE0 / 0xFFF0) are left to QnScaleAdapter.
   */
  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    const chars = (device.characteristicUuids || []).map((u) => normalizeUuid(u));
    if (!name) {
      return chars.length > 0
        ? NAMELESS_FAMILY_CHARS.every((c) => chars.includes(c))
        : isAr003Advertisement(device);
    }
    if (!name.includes('renpho')) return false;

    if (chars.length > 0) {
      if (qnCanRun(chars)) return false;
      if (chars.includes(uuid16(0x2a9f)) && chars.includes(uuid16(0x2a9d))) return true;
    }

    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    const hasQn = uuids.some(
      (u) => u === SVC_QN_T1 || u === SVC_QN_T2 || u === uuid16(0xffe0) || u === uuid16(0xfff0),
    );
    return !hasQn;
  }

  onSessionStart(): void {
    this.s = new RenphoSession();
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    // Consent on the SIG User Control Point is what unlocks the stream, so it is
    // the only hard requirement. The vendor 0xFFE2 service is not advertised, so a
    // device picked on its advertisement alone (any "renpho" name, or the nameless
    // A-R003 on a path that never re-resolves) may not expose it; guard its writes
    // rather than hard-requiring it (#267 review).
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
   * the next weight with a value measured on another day. The same goes for
   * the previous weigh-in's second 0x2A9C packet.
   */
  private parseWeightMeasurement(data: Buffer): void {
    if (data.length < 3) return;
    const flags = data[0];
    const imperial = (flags & 0x01) !== 0;
    const raw = data.readUInt16LE(1);
    let weight = raw * (imperial ? LB_PER_UNIT : KG_PER_UNIT);
    if (imperial) weight *= LB_TO_KG;
    // Before `weighing` changes, which the final frame is judged by, and
    // before the return below, so a 0 kg frame can place the clock too.
    this.placeScaleClock(data, flags, raw);
    this.s.weighing = raw > 0 && (flags & FLAG_MEASURING) !== 0;
    // Before the return below: a 0 kg frame is the user stepping off, and the
    // hold must not wait for a composition that will not come.
    this.s.measuring = weight > 0 && (flags & (FLAG_MEASURING | FLAG_FINAL)) !== 0;
    if (!(weight > 0) || !Number.isFinite(weight)) return;
    this.s.cachedWeight = weight;
    this.s.cachedImpedance = 0;
    this.s.compositionDone = false;
    this.s.storedRecord = null;
    this.s.cachedTimestamp =
      flags & FLAG_TIMESTAMP
        ? trustedScaleTime(parseSigDateTime(data, 3, this.clock()))
        : undefined;
  }

  /** The scale clock as placed this session; local time until a live frame says otherwise. */
  private clock(): SigClock {
    return this.s.clock ?? 'local';
  }

  /**
   * Decide from the frames of a live weigh-in whether the scale clock keeps
   * the host's local time or UTC (#510). Read as local time, a clock on UTC
   * made every live weigh-in on a host east of UTC a stored record.
   *
   * Only a frame that is live by its flags counts: a 0x4E with a weight (the
   * scale is measuring), a 0 kg frame (nobody on it yet, A-R003), and a final
   * 0x2E right after a 0x4E with a weight (`weighing`). A 0x0E with a weight
   * or a 0x2E after anything else may be a stored record, and 0x2A9C does not
   * count either. The stamp is read both ways and the clock placed when
   * exactly one reading lies within CLOCK_ZONE_TOLERANCE_MS of now. On a host
   * in UTC the two are the same instant, so nothing is placed and nothing
   * changes. The first frame that decides holds for the session; records
   * before it keep the time they were read with, as the runtime has already
   * routed them (D027).
   */
  private placeScaleClock(data: Buffer, flags: number, raw: number): void {
    if (this.s.clock || !(flags & FLAG_TIMESTAMP)) return;
    const weighing = raw > 0 && (flags & FLAG_MEASURING) !== 0;
    const finalAfterWeighing = (flags & FLAG_FINAL) !== 0 && this.s.weighing;
    if (raw > 0 && !weighing && !finalAfterWeighing) return;

    const now = Date.now();
    const offsetMs = (clock: SigClock): number | undefined => {
      const ts = trustedScaleTime(parseSigDateTime(data, 3, clock));
      return ts && ts.getTime() - now;
    };
    const local = offsetMs('local');
    const utc = offsetMs('utc');
    if (local === undefined || utc === undefined) return;
    const fits = (ms: number): boolean => Math.abs(ms) <= CLOCK_ZONE_TOLERANCE_MS;
    if (fits(local) !== fits(utc)) this.s.clock = fits(utc) ? 'utc' : 'local';

    const secs = (ms: number): string => `${ms >= 0 ? '+' : ''}${Math.round(ms / 1000)} s`;
    const offsets = `${secs(utc)} from now read as UTC, ${secs(local)} as local time`;
    if (this.s.clock) {
      const kept = this.s.clock === 'utc' ? 'UTC' : 'local time';
      bleLog.debug(`Renpho ES-WBE28: the scale clock keeps ${kept} (stamp ${offsets})`);
    } else if (!this.s.clockUnplacedLogged) {
      this.s.clockUnplacedLogged = true;
      bleLog.debug(`Renpho ES-WBE28: scale clock not placed by this frame (stamp ${offsets})`);
    }
  }

  /**
   * Decode a 0x2A9C Body Composition Measurement packet. RENPHO splits the
   * measurement across two indications. The first is SIG (flag bit 12), but
   * its flags advertise fields that don't fit, so we walk fields in SIG bit
   * order and stop the moment the buffer is exhausted. The second is not SIG
   * (#507): it has no bit 12, and its first two bytes are the body water, not
   * flags. Walked as SIG, it gave an "impedance" from an offset that moved with
   * the body water (332.8 ohm on the #267 capture). So a packet without bit 12
   * is walked only when its flags describe it exactly, as a single SIG packet's
   * do. We keep the FIRST impedance seen.
   */
  private parseBodyComposition(data: Buffer): void {
    if (data.length < 4) return;
    const flags = data.readUInt16LE(0);
    if (!(flags & BCS_MULTIPLE_PACKET) && !describesPacket(data, flags)) {
      if (data.length === VENDOR_PACKET_LENGTH) this.parseVendorPacket(data);
      else bleLog.debug(`Renpho ES-WBE28: 0x2A9C packet not decoded: ${data.toString('hex')}`);
      return;
    }
    const imperial = (flags & 0x0001) !== 0;
    const step = imperial ? LB_PER_UNIT : KG_PER_UNIT;
    const n = data.length;

    // After the flags and the mandatory body fat, which is not used (computeMetrics).
    let off = 4;
    for (const [flag, size, field] of SIG_FIELDS) {
      if (!(flags & flag)) continue;
      if (off + size > n) break; // belongs to a later packet
      if (flag === 0x0002 && !this.s.cachedTimestamp) {
        // A weigh-in whose 0x2A9D carried no time can still be dated by this.
        this.s.cachedTimestamp = trustedScaleTime(parseSigDateTime(data, off, this.clock()));
      }
      if (field === 'impedance' && this.s.cachedImpedance <= 0) {
        this.s.cachedImpedance = data.readUInt16LE(off) * 0.1;
      } else if (field === 'weight' && this.s.cachedWeight <= 0) {
        const w = data.readUInt16LE(off) * step;
        if (w > 0 && Number.isFinite(w)) this.s.cachedWeight = w;
      }
      off += size;
    }
  }

  /**
   * The second 0x2A9C packet of a weigh-in, in Renpho's own layout (#507): the
   * body water at [0..1], then most likely two resistances in ohm at [2..3]
   * and [4..5]. Which one is the impedance is not confirmed against the Renpho
   * app, so nothing of the packet goes into the reading. It still completes
   * the weigh-in, as no body composition follows it.
   */
  private parseVendorPacket(data: Buffer): void {
    this.s.compositionDone = true;
    bleLog.debug(
      'Renpho ES-WBE28: second body-composition packet (Renpho layout), resistances ' +
        `${data.readUInt16LE(2)} / ${data.readUInt16LE(4)} ohm not used yet (#507)`,
    );
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
    if (this.s.cachedWeight <= 0) return null;
    const stored = this.s.storedRecord;
    if (stored) {
      stored.impedance = this.s.cachedImpedance;
      return null;
    }
    const reading: ScaleReading = {
      weight: this.s.cachedWeight,
      impedance: this.s.cachedImpedance,
    };
    if (this.s.cachedTimestamp) reading.timestamp = this.s.cachedTimestamp;
    if (isHistoricalReading(reading)) this.s.storedRecord = reading;
    return reading;
  }

  isComplete(reading: ScaleReading): boolean {
    // Weight is enough to resolve; the hold window waits for the body composition (isFinal).
    return reading.weight > 0;
  }

  /** Resolve once the body composition is in: an impedance, or the second 0x2A9C packet. */
  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0 || this.s.compositionDone;
  }

  /**
   * Whether the scale is still measuring when the hold runs out: its last
   * 0x2A9D was a 0x4E or the final 0x2E and the second 0x2A9C packet has not
   * arrived. The hold arms on the first weight above 0 (isComplete), and on a
   * step-on after the connection the 8 s ran out between the sixth 0x4E and
   * the final (#507). A 0x0E (the weight moves again) or a 0 kg frame ends it.
   */
  isCompositionPending(): boolean {
    return this.s.measuring && !this.s.compositionDone;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    // Body fat from the impedance (BIA) when it is inside the plausible
    // whole-body band, though no packet of this family gives one yet
    // (parseVendorPacket); otherwise buildPayload falls back to BMI estimation,
    // which is better than a pinned floor or ceiling published as a measurement
    // (#405).
    comp.fat = biaFatIfPlausible(reading.weight, reading.impedance, profile);
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
