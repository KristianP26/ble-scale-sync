import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import {
  uuid16,
  buildPayload,
  computeBiaFat,
  IMPEDANCE_MIN_OHM,
  IMPEDANCE_MAX_OHM,
} from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import { isHutbitOemAdvert, LEFU_COMPANY_ID } from './lefu-signature.js';
import type { MatchDescriptor } from './match-descriptor.js';

// ─── Hutbit Smart Scale (Lefu / Fitdays FFB0 "AC02" 8-byte protocol) ─────────

const CHR_FFB1 = uuid16(0xffb1); // write (handshake, phone→scale)
const CHR_FFB2 = uuid16(0xffb2); // notify (weight stream, scale→phone)

/**
 * Handshake replayed on FFB1 (write-without-response) after enabling FFB2
 * notifications. Fixed 8-byte AC02 frames decoded from two Fitdays HCI snoops
 * (#254). Unlike the Robi S9's 20-byte protocol, every frame is a fixed
 * `AC 02 | D0 D1 D2 D3 | STATUS | CKSUM` with a plain additive checksum and NO
 * app-identity token, so the frames are stable and safe to replay verbatim.
 * `ac02fe060000ccd0` is the poll/keepalive the app repeats through the session.
 */
const HANDSHAKE: string[] = [
  'ac02fa010000ccc7',
  'ac02fb021fa5cc8d',
  'ac02fde20101ccad',
  'ac02fc010000ccc9',
  'ac02fe060000ccd0',
];

const FRAME_LEN = 8;
const FRAME_HEADER0 = 0xac;
const FRAME_HEADER1 = 0x02;
const STATUS_STABLE = 0xca; // final/stable reading (0xCE = measuring/unstable)
const WEIGHT_DIV = 10; // weight = u16 BE / 10 → kg

/**
 * Raw impedance frame: `AC 02 | FD 01 | <ohm u16 BE> | CB | CKSUM` (#322).
 *
 * It arrives after the stable weight frame, so the link has to stay open past
 * the weight to see it at all. The scale runs a measurement phase first and
 * repeats `FD 00` frames through it; `FD FF` is the no-contact sentinel, where
 * the scale reports that it could not measure rather than reporting a value. A
 * failed contact must never reach the BIA estimator.
 *
 * All three of the opcode, the subcommand and the 0xCB status are checked,
 * because the FD family is a real command family on this hardware: this file's
 * own handshake contains `ac02fde20101ccad`, a valid 8-byte AC02 frame whose
 * checksum passes, which keyed on the opcode alone would decode as a plausible
 * 257 ohm.
 */
const IMPEDANCE_OPCODE = 0xfd;
const IMPEDANCE_SUBCMD = 0x01;
const IMPEDANCE_MEASURING = 0x00;
const IMPEDANCE_NO_CONTACT = 0xff;
const IMPEDANCE_STATUS = 0xcb;

/*
 * The accepted whole-body impedance range is IMPEDANCE_MIN_OHM to
 * IMPEDANCE_MAX_OHM, imported above so this adapter and the shared BIA guard
 * cannot drift apart. This range started here, in #322, after a unit began
 * publishing nonsense.
 *
 * What this adapter does with an out-of-range value is NOT what the shared
 * guard does, and that difference is deliberate: here the impedance is dropped
 * at parse time and never published, so a reading looks the same as one from a
 * scale that sends no impedance at all. The shared guard publishes the number
 * and refuses it only as a BIA input. See ADR D011. A rejected value is logged
 * either way, so the first unit that falls outside the range is diagnosable
 * from its log.
 */

/**
 * How long the link is held open after the stable weight for the impedance
 * frame. The delay between the two has never been measured (no timestamped log
 * of a full weigh-in exists yet), so this is generous rather than tuned. It
 * costs a unit that never sends impedance nothing in the common case: the scale
 * drops the link after a weigh-in, and a disconnect resolves the held reading
 * immediately instead of waiting the window out.
 */
const COMPOSITION_HOLD_MS = 8000;

/**
 * How long after the settled weight an impedance frame may still be paired with
 * it. Slightly wider than the hold window, so a frame that arrives just as the
 * window closes is not thrown away, and narrow enough that two units weighing
 * at once through one proxy cannot lend each other a weight: this adapter is a
 * shared singleton and holds one weight, not one per device.
 */
const IMPEDANCE_PAIRING_WINDOW_MS = 10_000;

/** Additive checksum over D0..STATUS (bytes 2..6), matching the vendor frames. */
function frameChecksum(data: Buffer): number {
  return (data[2] + data[3] + data[4] + data[5] + data[6]) & 0xff;
}

/**
 * Adapter for the Hutbit Smart Scale (model 218008 / WL292, Fitdays app, Lefu
 * OEM). It shares service 0xFFB0 with the Robi S9 and openScale MGB families
 * but speaks a simpler, fixed 8-byte "AC02" protocol: after enabling FFB2
 * notifications the phone replays a short FFB1 handshake, then the scale streams
 * `AC 02 [weight_u16_BE] 00 00 [STATUS] [CKSUM]` frames on FFB2, where
 * STATUS 0xCE = measuring/unstable and 0xCA = stable/final. Weight = u16 / 10 kg.
 *
 * Decoded from two known-weight HCI snoops (#254): `ac0203490000ca16`
 * = 0x0349 = 841 → 84.1 kg. The scale's own DERIVED body-fat frames are useless
 * (they reported 0.4 to 0.7 %), so this stays weight-only and body composition
 * comes from the shared BIA/BMI pipeline, same as the Robi S9 / Renpho adapters.
 *
 * That is not the same thing as the hardware having no usable sensor, and an
 * earlier version of this comment conflated the two. On a Juniper-branded unit
 * in the same family, holding the link open past the stable frame yields
 * `AC 02 FD 01 <impedance_u16_BE> CB <cksum>`, a raw impedance that passes this
 * file's own checksum and moves with the person rather than sitting fixed
 * (518 ohm at 103 kg, 539 and 619 ohm at 58 kg across two sessions). That frame
 * is decoded here (#322) and feeds the normal BIA path.
 *
 * The scale that is measured is not the scale that computes: the vendor's own
 * derived body-fat frames stay ignored, because a raw impedance and a wrong
 * body-fat estimate are separate questions and only the first is settled.
 */
export class HutbitAdapter implements ScaleAdapterCore, GattWiring, HoldForComposition {
  readonly name = 'Hutbit';
  readonly match: MatchDescriptor = {
    priority: 35,
    custom: true,
    names: { includes: ['hutbit'] },
    serviceUuids: ['ffb0'],
    manufacturerId: LEFU_COMPANY_ID,
  };
  readonly charNotifyUuid = CHR_FFB2;
  readonly charWriteUuid = CHR_FFB1;
  readonly normalizesWeight = true;

  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_FFB1, type: 'write' },
    { uuid: CHR_FFB2, type: 'notify' },
  ];

  private final = false;

  /**
   * Weight from this session's stable frame, kept so the impedance frame that
   * follows it can be paired with the right number.
   *
   * Adapters are shared singletons, so this is cleared on every session
   * boundary. Without that, an impedance frame arriving early in one session
   * could be paired with the previous session's weight, which on a shared scale
   * means one person's impedance against another person's body (#138).
   */
  private lastStableWeight = 0;

  /** When the paired weight was measured, for the pairing window above. */
  private lastStableAt = 0;

  matches(device: BleDeviceInfo): boolean {
    // Branded units advertise "Hutbit Scale". Lefu OEM stock units advertise a
    // generic name instead (observed: "SWAN", #278), and over the ESPHome proxy
    // the local name arrives empty entirely because it lives in the scan
    // response, so the name alone is not enough.
    if ((device.localName || '').toLowerCase().includes('hutbit')) return true;

    // OEM/rebranded units: claim on the advertisement fingerprint instead. This
    // deliberately does NOT claim the broader nameless FFB0 space; without the
    // fingerprint that space still belongs to the Robi S9 (FFB3 result char)
    // and the MGB fallback. RobiS9Adapter.matches() bows out to this exact
    // predicate, so the two must never drift apart (see lefu-signature.ts).
    return isHutbitOemAdvert(device);
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.resetSession();
    for (const hex of HANDSHAKE) {
      // Write without response: FFB1 is the Lefu/Fitdays FFB0 handshake char and
      // the family writes no-response. A char that advertises only
      // WRITE_NO_RESPONSE rejects a with-response write, so this is the safe mode
      // and matches the documented protocol above (#268 review).
      await ctx.write(CHR_FFB1, Buffer.from(hex, 'hex'), false);
      await new Promise((r) => setTimeout(r, 150));
    }
    bleLog.debug('Hutbit: handshake sent');
  }

  parseNotification(data: Buffer): ScaleReading | null {
    // Log every raw frame before any gate so a wrong shape/length is visible
    // (the `Hutbit frame:` line below only fires after the checksum gate). This
    // is what disambiguates "frames arrive but are rejected" from "frames never
    // arrive" on the ESPHome proxy transport (#291); mirrors QN / ADE-A2.
    bleLog.debug(`Hutbit RAW (${data.length}B): ${data.toString('hex')}`);

    // Fixed 8-byte AC02 weight frame: AC 02 [weight u16 BE] 00 00 [STATUS] [CKSUM]
    if (data.length !== FRAME_LEN) return null;
    if (data[0] !== FRAME_HEADER0 || data[1] !== FRAME_HEADER1) return null;
    if (frameChecksum(data) !== data[7]) return null;

    bleLog.debug(`Hutbit frame: ${data.toString('hex')}`);

    // The impedance frames share the weight frame's shape and are separated by
    // the opcode, so they are handled before the stable-status gate a weight
    // frame has to pass.
    if (data[2] === IMPEDANCE_OPCODE) return this.parseImpedanceFrame(data);

    // Only the stable (0xCA) frame is a final reading; 0xCE frames are the live
    // settling stream and are treated as progress only.
    if (data[6] !== STATUS_STABLE) return null;

    const weight = data.readUInt16BE(2) / WEIGHT_DIV;
    if (!(weight > 0) || !Number.isFinite(weight)) return null;

    this.final = true;
    this.lastStableWeight = weight;
    this.lastStableAt = Date.now();
    // Weight first, impedance second: the scale sends it after the weight has
    // settled, so this reading is complete but not final, and the handler holds
    // the link open for COMPOSITION_HOLD_MS to see whether one arrives.
    return { weight, impedance: 0 };
  }

  /**
   * Decode `AC 02 FD 01 <ohm u16 BE> CB <cksum>` into a reading that carries the
   * weight this session already settled on. Returns null for every other frame
   * in the FD family, which is a status stream rather than a value.
   */
  private parseImpedanceFrame(data: Buffer): ScaleReading | null {
    if (data[3] === IMPEDANCE_MEASURING) {
      bleLog.debug('Hutbit: impedance measurement in progress');
      return null;
    }
    if (data[3] === IMPEDANCE_NO_CONTACT) {
      bleLog.debug('Hutbit: the scale reports no skin contact, no impedance this weigh-in');
      return null;
    }
    if (data[3] !== IMPEDANCE_SUBCMD || data[6] !== IMPEDANCE_STATUS) {
      bleLog.debug(`Hutbit: unrecognised FD frame ${data.toString('hex')}, ignoring`);
      return null;
    }

    const impedance = data.readUInt16BE(4);
    if (impedance < IMPEDANCE_MIN_OHM || impedance > IMPEDANCE_MAX_OHM) {
      bleLog.debug(
        `Hutbit: impedance ${impedance} ohm is outside the plausible ` +
          `${IMPEDANCE_MIN_OHM} to ${IMPEDANCE_MAX_OHM} ohm range, ignoring it (#322)`,
      );
      return null;
    }
    if (!this.final || !(this.lastStableWeight > 0)) {
      // An impedance with no weight of its own is not a reading, and pairing it
      // with whatever weight came last would be worse than dropping it.
      bleLog.debug(`Hutbit: impedance ${impedance} ohm arrived before any stable weight, ignoring`);
      return null;
    }
    const age = Date.now() - this.lastStableAt;
    if (age > IMPEDANCE_PAIRING_WINDOW_MS) {
      bleLog.debug(
        `Hutbit: impedance ${impedance} ohm arrived ${Math.round(age / 1000)}s after the ` +
          'weight it would be paired with, ignoring it',
      );
      return null;
    }

    bleLog.debug(`Hutbit: impedance ${impedance} ohm (#322)`);
    return { weight: this.lastStableWeight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.final;
  }

  /**
   * Hold the link open past the settled weight so the impedance frame can land,
   * and resolve as soon as it does.
   */
  readonly completionHoldMs = COMPOSITION_HOLD_MS;

  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }

  onSessionEnd(): void {
    this.resetSession();
  }

  private resetSession(): void {
    this.final = false;
    this.lastStableWeight = 0;
    this.lastStableAt = 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // The vendor's own derived body-fat frames stay ignored; when the raw
    // impedance is present it goes through the same BIA estimator every other
    // adapter uses, and without it body composition falls back to BMI (#322).
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
