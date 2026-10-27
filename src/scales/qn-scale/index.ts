import { isPlausibleImpedance, biaPayload } from '../body-comp-helpers.js';
import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  BroadcastSource,
  ScaleReading,
  UserProfile,
  BodyComposition,
  AdapterRuntimeConfig,
  MultiCharNotify,
  UserWeightHint,
  HoldForComposition,
} from '../../interfaces/scale-adapter.js';
import { bleLog, errMsg, normalizeUuid } from '../../ble/types.js';
import type { MatchDescriptor } from '../match-descriptor.js';
import {
  jieliAuthResponseFrame,
  JIELI_CHALLENGE_FRAME_LEN,
  JIELI_CHALLENGE_HEADER,
} from './jieli-auth.js';
import type { ScaleDisplayUnit } from '../../config/schema.js';
import type { AdapterOptions } from '../../config/resolve.js';
import type { QN_BLE_OPTIONS } from './options.js';
import {
  A4_PRELUDE,
  A4_PRELUDE_GAP_MS,
  CHR_AE01,
  CHR_AE02,
  CHR_NOTIFY,
  CHR_NOTIFY_T1,
  CHR_WRITE,
  CHR_WRITE_T1,
  ES30M_MIN_FRAME_LEN,
  IMPEDANCE_GRACE_MS,
  INFO_DIVISOR_BIT,
  LAST_KNOWN_WEIGHT_TOLERANCE,
  LEGACY_PROTO_TYPE,
  LIVE_MATCH_WEIGHT_KG,
  MAX_AE00_RESPONSES,
  MAX_STORED_QUERY_ATTEMPTS,
  MAX_STORED_RECORD_AGE_SEC,
  NO_CONTACT_RESISTANCE,
  POST_START_ANCHOR_DELAY_MS,
  RESULT_MAX_WEIGHT_KG,
  RESULT_MIN_WEIGHT_KG,
  SCALE_EPOCH_OFFSET,
  STORED_FUTURE_TOLERANCE_MS,
  STORED_QUERY_RETRY_MS,
  TRIGGER_GAP_MS,
  TRIGGER_REPEATS,
  TRIGGER_WEIGHT_FALLBACK_KG,
  VENDOR_APP_USER_KEY,
  VISIT_ATHLETE_MIN_AGE,
  WEIGHT_CERTAIN_MAX_KG,
  WEIGHT_CERTAIN_MIN_KG,
} from './constants.js';
import {
  buildA2Frame,
  buildConfig,
  buildMeasurementTrigger,
  buildOpenScaleA2,
  buildStoredDataQuery,
  buildTimeSync,
  buildUserDelete,
  buildUserProfileFrame,
  decodeStoredRecord,
  decryptQnResistance,
  hasValidSumChecksum,
  timeZoneByte,
  withChecksum,
  type StoredRecord,
} from './frames.js';
import { QN_NAMES, qnAdvertTraits, qnMatches, warnOnOneByoneShape } from './matching.js';
import { parseQnBroadcast } from './broadcast.js';
import {
  classifyInfoFrame,
  hex,
  storedSlotLabel,
  type QnDialectHandler,
  type QnDialectKind,
} from './dialect.js';
import { classic } from './dialects/classic.js';
import { ext20 } from './dialects/ext20.js';
import { unknown } from './dialects/unknown.js';
import * as va18 from './dialects/va18.js';
import * as va19 from './dialects/va19.js';
import { QnLedger } from './stored-ledger.js';
import { QnSession } from './session.js';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Each dialect's handler (see QnDialectHandler). */
const DIALECTS: Record<QnDialectKind, QnDialectHandler> = {
  unknown,
  classic,
  va18: va18.dialect,
  va19: va19.dialect,
  ext20,
};

type QnRuntimeOptions = AdapterOptions<typeof QN_BLE_OPTIONS>;

/**
 * The `ble.qn_*` options as configure() resolves them; QN_BLE_OPTIONS
 * documents each. The protocol byte applies to every protocol-bearing write of
 * a session, the pre-0x12 unlock config, the classic dialect and the no-0x12
 * fallback handshake included: a scale whose 0x12 is lost in transit must still
 * open with the byte its firmware accepts (#75, #331).
 */
function qnOptions(o: QnRuntimeOptions) {
  return {
    protocolByte: o.qnProtocolByte ?? null,
    reportByte: o.qnReportByte ?? null,
    weightAck: o.qnWeightAck ?? null,
    userKey: o.qnUserKey ?? null,
    a4Prelude: o.qnA4Prelude === true,
    configLong: o.qnConfigLong === true,
    timeSyncLong: o.qnTimeSyncLong === true,
    resultAck: o.qnResultAck === true,
  };
}

export class QnScaleAdapter
  implements ScaleAdapterCore, GattWiring, BroadcastSource, MultiCharNotify, HoldForComposition
{
  readonly name = 'QN Scale';
  readonly match: MatchDescriptor = {
    priority: 250,
    custom: true,
    names: QN_NAMES,
    serviceUuids: ['ae00', 'ffe0', 'fff0'],
    charUuids: ['ae01', 'ae02'],
    manufacturerId: 0xffff,
  };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly altCharNotifyUuid = CHR_NOTIFY_T1;
  readonly altCharWriteUuid = CHR_WRITE_T1;

  /** Every configured user's weight hints (configure(), C-06). */
  private userWeights: readonly UserWeightHint[] = [];

  /** Stored connection context for notification-driven state machine writes. */
  private ctx: ConnectionContext | null = null;

  /**
   * Bumped on every session boundary (onSessionStart and onSessionEnd). The
   * handshake steps are fire-and-forget coroutines that sleep between writes
   * and write through `this.ctx`, so each one captures this value on entry and
   * stops after any await that crossed a boundary. Without it a step still
   * sleeping when its session ended would write into the NEXT session, and
   * because onSessionStart clears the dedup flags it would also set them there,
   * so the new session's own answer to that frame would be skipped.
   *
   * A generation rather than the context itself, because on the multi-char
   * transports a 0x12 can be parsed after onSessionStart but before
   * onConnected sets `this.ctx`, and that step must keep running once the
   * context appears.
   */
  private sessionGeneration = 0;

  /**
   * Configured display unit. The 0x13 config command tells the scale which unit
   * to show, so hardcoding kg flipped a user's lbs display on every read (#269).
   * Injected via configure() from scale.display_unit; defaults to kg.
   */
  private displayUnit: ScaleDisplayUnit = 'kg';

  private decideAppProfileSequence(): boolean {
    if (this.s.appProfileSequence === null) {
      this.s.appProfileSequence = this.wantsAppProfileSequence();
    }
    return this.s.appProfileSequence;
  }

  /** Whether the 0x12 seen so far and the options call for the vendor-app profile sequence. */
  private wantsAppProfileSequence(): boolean {
    return (
      (this.opts.weightAck === true && this.s.kind === 'va19') ||
      (this.opts.userKey !== null && (this.s.kind === 'va18' || this.s.kind === 'va19'))
    );
  }

  /** Length of the 0x12 the vendor-app profile sequence was chosen for, for the log. */
  private dialectBytes(): number {
    return this.s.kind === 'va18' ? 18 : 19;
  }

  /**
   * Readings that stand in for a weigh-in the scale has not finished yet, or
   * (18-byte, heldForStoredAnswer) one that waits for the scale's stored
   * weigh-ins. Keyed by the reading object, so isFinal
   * answers for the object it is handed rather than for whichever frame was
   * parsed last. Never reset: a reading from an earlier session is never
   * handed back.
   */
  readonly provisionalReadings = new WeakSet<ScaleReading>();

  /** What a later session's stored records and result blocks are compared with. */
  readonly ledger = new QnLedger();

  /** This session's state; replaced whole in onSessionStart. The dialect handlers use it too. */
  s = new QnSession();

  /**
   * The hold of the 19- or the 18-byte dialect while one is armed (see their
   * hold()); undefined otherwise, so nothing else this adapter returns is held.
   */
  get completionHoldMs(): number | undefined {
    return (va19.dialect.hold(this.s) ?? va18.dialect.hold(this.s))?.ms;
  }

  /**
   * Only the 19-byte stable weight, fresh 19-byte stored weigh-ins and the
   * 18-byte weigh-in held for the stored ones are provisional.
   */
  isFinal(reading: ScaleReading): boolean {
    return !this.provisionalReadings.has(reading);
  }

  /** Whether either of those holds still has frames of its weigh-in to come. */
  isCompositionPending(): boolean {
    return (
      va19.dialect.hold(this.s)?.pending === true || va18.dialect.hold(this.s)?.pending === true
    );
  }

  /** The `ble.qn_*` options (qnOptions), replaced whole by configure(). */
  opts = qnOptions({});

  /** Receive the configured display unit and options from the composition root (#269). */
  configure(opts: AdapterRuntimeConfig & QnRuntimeOptions): void {
    if (opts.displayUnit) this.displayUnit = opts.displayUnit;
    this.opts = qnOptions(opts);
    if (this.opts.reportByte !== null) {
      bleLog.warn(
        `QN: ble.qn_report_byte is set (${this.opts.reportByte}), so every QN session sends ` +
          'the frame that deletes the user slots its bits select on the scale. Remove the ' +
          'setting unless your scale stopped reporting without it (#461).',
      );
    }
    this.userWeights = opts.userWeights ?? [];
  }

  /** 0x13 config unit bit: 0x01 kg, 0x02 lb, 0x08 stone (QN protocol). */
  private unitFlag(): number {
    if (this.displayUnit === 'st') return 0x08;
    return this.displayUnit === 'lbs' ? 0x02 : 0x01;
  }

  /** Write to FFF2 (write char), fall back to FFE3 (Type 1). */
  async writeCmd(data: number[]): Promise<void> {
    // Hold the context for both attempts. The 0x1F ack is issued from
    // parseNotification, whose caller ends the session (onSessionEnd nulls
    // this.ctx) in the same tick, so on FFE3-only scales the fallback would
    // otherwise dereference null and the ack would never reach the scale.
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      await ctx.write(CHR_WRITE, data, false);
    } catch (primaryErr: unknown) {
      try {
        await ctx.write(CHR_WRITE_T1, data, false);
      } catch (altErr: unknown) {
        // Both write characteristics rejected. Logging this matters: a silent
        // return here is why a failed handshake looks identical to a scale
        // that simply never answers (#283).
        bleLog.debug(
          `QN write failed on both ${CHR_WRITE} (${errMsg(primaryErr)}) and ${CHR_WRITE_T1} (${errMsg(altErr)}): [${hex(data)}]`,
        );
        return;
      }
    }
    bleLog.debug(`QN write: [${hex(data)}]`);
  }

  /**
   * Write to AE01 (best-effort, not all firmware has AE00 service).
   *
   * Serialised through a per-session chain. Three independent paths write here
   * (the `fe dc ba c0` init from handleScaleInfo, the legacy `pass` frame from
   * handleReady, and the challenge response below), all fire-and-forget from
   * notification handlers, and the captured vendor session sends them strictly
   * in order. Overlapping writes on one characteristic are a transport-level
   * gamble with nothing to gain.
   */
  private async writeAe01(data: number[]): Promise<void> {
    if (!this.ctx) return;
    // Bind the write to the context it was queued for. Links already on the
    // chain when a session dies would otherwise re-read this.ctx at execution
    // time and replay a dead session's frame onto the new link, which for an
    // authentication response means handing the scale a nonce it has forgotten.
    const owner = this.ctx;
    const run = async (): Promise<void> => {
      if (!this.ctx || this.ctx !== owner) return;
      try {
        await this.ctx.write(CHR_AE01, data, false);
        bleLog.debug(`QN AE01 write: [${hex(data)}]`);
      } catch {
        // AE01 not available
      }
    };
    this.s.ae01Chain = this.s.ae01Chain.then(run, run);
    return this.s.ae01Chain;
  }

  /**
   * Start a fresh QnSession BEFORE anything is subscribed (#394, #406), and
   * stop the timers of the one before.
   *
   * The reset used to live in onConnected(), which is too late on this
   * adapter: QN is a MultiCharNotify adapter, and subscribeAndInit enables
   * every notify binding before it awaits init, so a frame can be parsed
   * against the PREVIOUS session's seenProtocolType, weightScaleFactor or
   * configSent. That is the exact ordering the onSessionStart contract exists
   * for.
   *
   * `this.ctx` stays in onConnected: it is the one thing that does not exist
   * until then.
   */
  onSessionStart(): void {
    this.sessionGeneration += 1;
    this.s.dispose();
    this.s = new QnSession(
      this.opts.protocolByte ?? 0x00,
      this.ledger.mark,
      Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET,
    );
  }

  /**
   * Multi-step init called after BLE connection and service discovery.
   *
   * On Linux (node-ble / BlueZ D-Bus), FFF1 CCCD subscription runs in parallel
   * with onConnected(). The scale may send 0x12 BEFORE this method finishes,
   * so the state machine handlers (handleScaleInfo, handleReady, etc.) must
   * not depend on any state set here (especially hasAe00).
   *
   * For older firmware without AE00: sends legacy unlock variants on FFF2.
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.ctx = ctx;
    this.readImpedanceFlag(ctx);
    // The session clock is re-stamped here as well as in onSessionStart, for a
    // caller that drives onConnected directly (a test, or a transport that
    // predates the hook).
    if (this.s.sessionStartedScaleSeconds === null) {
      this.s.sessionStartedScaleSeconds = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
    }

    // #320: the nameless fallback claims any device on a QN vendor service,
    // keyed on serviceUuids, so it can outrank the 1byone/Eufy adapter on a
    // transport that delivers no local name. That adapter's whole signature is
    // notify fff4 with NO fff2, and fff2 is this protocol's write
    // characteristic, so a peer with that shape cannot be a QN scale: the
    // handshake below has nothing to write to and the session ends in a pair of
    // failed writes that name neither the cause nor the fix.
    //
    // Diagnosis only, deliberately. Narrowing the fallback itself needs a real
    // capture of a NAMELESS fff4-without-fff2 device, and nobody has reported
    // one; changing the registry's broadest matcher on a hypothesis is how
    // working installs break. This line is how that capture gets reported.
    warnOnOneByoneShape(ctx);

    // AE02 subscribe (newer firmware), memoised with the 0x12 path so the two
    // cannot subscribe twice (#75).
    const hasAe02 = await this.ensureAe02Subscribed();

    if (!hasAe02) {
      // Older firmware: send legacy unlock variants on FFF2.
      // These work with Renpho, Sencor, and generic QN-Scale devices
      // that don't use the notification-driven handshake.
      // The second unlock is the short 0x13 config, whose byte[3] is the unit
      // flag; honour the configured unit (#269). The first unlock is a different
      // 0x01 subcommand and is left as-is. The protocol byte stays 00 when the
      // override is unset: seenProtocolType can be seeded by a 0x12 that races
      // the AE02 subscribe on native BLE, and this fixed frame must not depend on
      // that timing. The override, when set, is applied before onConnected runs.
      const config = buildConfig(this.opts.protocolByte ?? 0x00, this.unitFlag());
      const unlocks = [[0x13, 0x09, 0x00, 0x01, 0x01, 0x02], config];
      for (const cmd of unlocks) {
        await this.writeCmd(cmd);
      }
    }

    // Fallback timer for both firmware paths. If the state machine fires
    // normally (0x12 received), handleScaleInfo cancels this timer.
    // If 0x12 is lost (Linux BlueZ race) or never sent (older firmware
    // that only responds to unlocks), the fallback runs the full handshake.
    if (!this.s.configSent) {
      this.s.fallbackTimer = setTimeout(() => void this.runFallbackHandshake(), 2000);
    }
  }

  /**
   * Fallback handshake for Linux node-ble where 0x12 may be lost.
   * Sends AE01 init first, then the full handshake sequence.
   */
  private async runFallbackHandshake(): Promise<void> {
    if (!this.ctx) return;
    this.s.fallbackTimer = null;
    const gen = this.sessionGeneration;

    if (!this.s.configSent) {
      this.s.seenProtocolType = this.opts.protocolByte ?? 0xff;
      bleLog.debug(
        `QN: fallback: no 0x12 received, running handshake with ` +
          `proto=0x${this.s.seenProtocolType.toString(16).padStart(2, '0')}`,
      );
      // handleScaleInfo sends AE01 init + 0x13 config
      await this.handleScaleInfo();
      await wait(500);
      if (gen !== this.sessionGeneration) return;
    }

    if (!this.s.timeSyncSent) {
      bleLog.debug('QN: fallback: sending time sync + profile');
      await this.handleReady();
      await wait(500);
      if (gen !== this.sessionGeneration) return;
    }

    if (!this.s.historyResponseSent) {
      bleLog.debug('QN: fallback: sending the profile frame + start');
      await this.handleConfigRequest();
    }
  }

  /**
   * Read the impedance flag from the session's advertisement (#461). A company
   * id without bytes carries no flag, so it counts as no advertisement (#463).
   */
  private readImpedanceFlag(ctx: ConnectionContext): void {
    const md = ctx.manufacturerData?.data.length ? ctx.manufacturerData : undefined;
    const traits = qnAdvertTraits(md, ctx.deviceAddress);
    this.s.resistanceScrambled = traits?.scrambled === true;
    this.s.noAdvertisement = md === undefined;
    if (!md) {
      bleLog.debug(
        'QN: no advertisement for this session, impedance read as sent unless the 18-byte ' +
          'dialect sends one only a scrambled body gives (#461, #463)',
      );
      // A 0x12 parsed before onConnected has told the dialect already.
      va18.logNoAdvertisementOnce(this);
    } else if (!traits) {
      bleLog.debug(
        `QN: advertisement (company 0x${md.id.toString(16).padStart(4, '0')}) ` +
          'is not a QN one for this device, impedance read as sent (#461)',
      );
    } else if (traits.category === null) {
      bleLog.debug(
        'QN: advertisement has no scrambling model marker, impedance read as sent (#461)',
      );
    } else {
      bleLog.debug(
        `QN: advertisement model ${traits.category}, impedance ` +
          (traits.scrambled
            ? 'scrambled: unscrambling it as the vendor SDK does (#461)'
            : 'not scrambled (#461)'),
      );
    }
  }

  /**
   * The resistance a frame carries, unscrambled when the advertisement said so
   * (see SCRAMBLE_FLAG_BIT). Untouched otherwise, so a scale that advertises
   * without the flag gets exactly the bytes it sent. Without any advertisement,
   * an 18-byte value only a scrambled body resistance can be is unscrambled
   * (readsUnscrambledWithoutAdvert, #463).
   */
  resistance(raw: number): number {
    if (raw === 0) return raw;
    if (!this.s.resistanceScrambled) {
      if (!va18.readsUnscrambledWithoutAdvert(this, raw)) return raw;
      const value = decryptQnResistance(raw);
      bleLog.debug(
        `QN: impedance ${raw} read unscrambled as ${value} Ohm without an advertisement (#463)`,
      );
      return value;
    }
    const unscrambled = decryptQnResistance(raw);
    const value = unscrambled >= NO_CONTACT_RESISTANCE ? 0 : unscrambled;
    bleLog.debug(`QN: impedance ${raw} unscrambled to ${value} Ohm (#461)`);
    if (value !== 0 && !isPlausibleImpedance(value) && !this.s.unscrambledImplausibleWarned) {
      this.s.unscrambledImplausibleWarned = true;
      bleLog.warn(
        `QN: this scale advertises a scrambled impedance, and unscrambling ${raw} gives ` +
          `${value} Ohm, which is not a body. Please report this log on #461.`,
      );
    }
    return value;
  }

  /** See matching.ts. Pure over the advertisement, so it lives outside the class. */
  matches(device: BleDeviceInfo): boolean {
    return qnMatches(device);
  }

  /**
   * Subscribe to AE02 at most once per session. Concurrent callers share the
   * same in-flight promise. A rejection clears the memo so a later, sequential
   * caller can still retry, which preserves the second attempt from the state
   * machine without reinstating the concurrent double-subscribe.
   */
  private async ensureAe02Subscribed(): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (this.s.hasAe00) return true;
    if (!this.s.ae02Subscribe) {
      this.s.ae02Subscribe = ctx.subscribe(CHR_AE02).then(
        () => {
          this.s.hasAe00 = true;
          bleLog.debug('QN: subscribed to AE02');
          return true;
        },
        () => {
          this.s.ae02Subscribe = null;
          bleLog.debug('QN: AE02 not available (older firmware)');
          return false;
        },
      );
    }
    return this.s.ae02Subscribe;
  }

  /**
   * Multi-char dispatch. FFF1 (or FFE1 on Type 1) carries the QN vendor
   * protocol. AE02 carries the AE00 challenge, a different frame family with no
   * QN opcode and no QN checksum, which parseNotification logged as `QN RAW` as
   * if it were a vendor frame and then dropped at the `opcode !== 0x10` gate.
   *
   * Only the positively identified challenge shape is intercepted: 17 bytes
   * whose first byte is 0x00. That byte is the one position identical across all
   * three #75 samples while the remaining 16 are high entropy, so it is the AE00
   * header rather than payload. Anything else on AE02 still falls through to the
   * unchanged parser, so no scale that currently gets a reading over AE02 can
   * lose it. #75 / #235.
   */
  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    if (normalizeUuid(charUuid) === CHR_AE02) {
      bleLog.debug(`QN AE02 (${data.length}B): [${hex(data)}]`);
      if (this.isAe00Challenge(data)) {
        this.answerAe00Challenge(data);
        return null;
      }
    }
    return this.parseNotification(data);
  }

  /** Signature of the AE00 challenge as captured in #75: 17 bytes, header 0x00. */
  private isAe00Challenge(data: Buffer): boolean {
    return data.length === JIELI_CHALLENGE_FRAME_LEN && data[0] === JIELI_CHALLENGE_HEADER;
  }

  /**
   * Answer an AE00 challenge on AE01.
   *
   * The gate is JieLi's RcspAuth: the scale sends `0x00 || challenge[16]` and
   * withholds every 0x10 weight frame until it receives
   * `0x01 || E1(linkKey, challenge, addr)`. The transform and its two static
   * constants were established by @hedoric in #235 from an HCI capture of five
   * complete vendor-app weigh-ins, and `jieli-auth.ts` reproduces all ten
   * captured challenge/response pairs plus the Bluetooth specification's own E1
   * sample vectors.
   *
   * Only the scale-issued exchange is answered. The vendor app also issues its
   * own challenge to the scale first, but the capture shows the scale streams
   * weight without it, and generating a nonce whose answer we would then have to
   * validate adds a failure mode for nothing.
   *
   * Kept best-effort on purpose: a scale whose firmware uses a different key
   * simply stays silent exactly as it does today, and the AE00 service is also
   * present on ES-CS20M firmware that already reads fine.
   */
  private answerAe00Challenge(data: Buffer): void {
    if (this.s.ae00ResponsesSent >= MAX_AE00_RESPONSES) {
      if (this.s.ae00ResponsesSent === MAX_AE00_RESPONSES) {
        this.s.ae00ResponsesSent++;
        bleLog.warn(
          `QN: the scale re-issued the AE00 challenge more than ${MAX_AE00_RESPONSES} times, ` +
            'so it is rejecting our response. This firmware likely uses a different ' +
            'authentication key; please attach a DEBUG log to #235.',
        );
      }
      return;
    }

    // Count the attempt before it can fail: a challenge shape this code cannot
    // answer must still consume the budget, or a malformed repeat would be
    // retried for the whole session.
    this.s.ae00ResponsesSent++;
    let frame: Buffer;
    try {
      frame = jieliAuthResponseFrame(data);
    } catch (e: unknown) {
      bleLog.debug(`QN: AE00 challenge response could not be computed: ${errMsg(e)}`);
      return;
    }
    if (!this.s.ae00ChallengeSeen) {
      this.s.ae00ChallengeSeen = true;
      bleLog.debug('QN: AE00 challenge received, answering on AE01 (#235)');
    }
    void this.writeAe01([...frame]);
  }

  /**
   * Parse QN vendor notifications: a notification-driven handshake (0x12 ->
   * AE01 init + 0x13 config, 0x14 -> 0x20 time sync + ready-time A2 + AE01
   * "pass", 0x21 -> A00D profile frame + 0x22 start, 0xA1 -> the scale's answer
   * to the profile), then each dialect's own frames (dialects/) and the live
   * 0x10 weight. The handshake writes are fire-and-forget, so they do not block
   * this synchronous return.
   *
   * A frame that ends the scale's answer while a weigh-in is held for it
   * hands over a copy of that weigh-in, which is final, so the session ends on
   * it (heldForStoredAnswer, #463).
   */
  parseNotification(data: Buffer): ScaleReading | null {
    const reading = this.parseFrame(data);
    if (reading === null && this.s.heldForStoredAnswer !== null && this.s.storedAnswerDone) {
      return va18.releaseHeldWeighIn(this, 'the scale has answered the stored-record query');
    }
    return reading;
  }

  /** One notification through the state machine above. */
  private parseFrame(data: Buffer): ScaleReading | null {
    if (data.length < 3) return null;

    bleLog.debug(`QN RAW (${data.length}B): [${hex(data)}]`);

    const opcode = data[0];

    // 0x12: scale info, update weight scale factor and capture protocol type
    if (opcode === 0x12 && data.length > 10) {
      this.onScaleInfo(data);
      return null;
    }

    // 0x14: ready/config ACK, respond with time sync + user profile
    if (opcode === 0x14) {
      bleLog.debug('QN: ready frame, sending time sync and the ready-time frames');
      // Bit 0 of [3]: the scale reports muscle and bone as percentages (#331).
      if (data.length >= 4 && hasValidSumChecksum(data)) this.s.readyValueType = data[3] & 0x01;
      void this.handleReady();
      return null;
    }

    // 0x21: config request, respond with the A00D profile frame + start measurement
    if (opcode === 0x21) {
      bleLog.debug('QN: config request, sending the profile frame + start');
      void this.handleConfigRequest();
      return null;
    }

    // 0xA1, 0xA3: acknowledgment frames, nothing to answer. The answer to the
    // profile frame, `a1 06 02 <slot> <1 accepted | 0>`, is kept: the scale's
    // own composition is only for a profile it accepted (#331).
    if (opcode === 0xa1 || opcode === 0xa3) {
      this.onProfileAnswer(data);
      return null;
    }

    // Every other frame goes to the session's dialect first.
    const own = DIALECTS[this.s.kind].frame(this, data);
    if (own !== undefined) return own;

    return this.liveFrame(data);
  }

  /** A 0x12 scale-info frame: the dialect, protocol byte and divisor, then the 0x13 config. */
  private onScaleInfo(data: Buffer): void {
    this.s.kind = classifyInfoFrame(data);
    if (this.s.kind !== 'classic') {
      // Only the 0x12 tells the dialect, so the line waits for it.
      va18.logNoAdvertisementOnce(this);
      if (this.wantsAppProfileSequence() && this.s.appProfileSequence === false) {
        bleLog.debug(
          `QN: ${data.length}-byte 0x12 after the handshake already chose openScale's frames; ` +
            'the profile frame stays as sent (#331)',
        );
      }
    }
    // The long frame carries 0xff at byte[2] in every capture whatever its
    // length, and the disagreement is over what the firmware ACCEPTS BACK:
    //   18 bytes (Renpho ES-26M / ES-CS20M): 0x00, which has a working
    //     unit behind it (45e4d6e). The only vendor-app capture of this
    //     length drives the scale end to end on 0xff instead (#84), so the
    //     value is genuinely in doubt for this length and `qn_protocol_byte`
    //     exists to try the other one without a rebuild.
    //   19 bytes (Arboleaf): the echo. 0x00 is what the adapter has always
    //     sent and two reporters get a complete handshake followed by
    //     silence (#75, #331).
    //   20 bytes (GE CS 10 G "Fit Plus"): the echo, hardware confirmed on
    //     the same unit the vendor app was captured from (#235).
    // A classic frame is echoed.
    //
    // The choice cannot be corrected at runtime: a scale on the wrong byte
    // acknowledges everything and stays silent, which is exactly what a
    // scale nobody is standing on does.
    const byLength = this.s.kind === 'va18' ? LEGACY_PROTO_TYPE : data[2];
    this.s.seenProtocolType = this.opts.protocolByte ?? byLength;
    // Bit 0 on every dialect, as the vendor's published SDK reads it.
    // openScale's whole-byte `[10] === 1` read the 17-byte classic frames
    // ([10] 0x03) as /10, and the long frame was set to /10 whatever its
    // flags said, only to reach the ES-30M layout (D068).
    this.s.weightScaleFactor = (data[10] & INFO_DIVISOR_BIT) !== 0 ? 100 : 10;
    const dialect =
      this.s.kind === 'ext20' ? 'extended' : this.s.kind === 'classic' ? 'classic' : 'es26m';
    // The byte the frame actually carried, for triage. Not seenProtocolType:
    // on the 18-byte variant that is forced to 0x00 for the handshake, but the
    // log should still report the 0xff the scale sent.
    const reported = data[2];
    const forcedNote =
      this.opts.protocolByte !== null && this.opts.protocolByte !== reported
        ? ` (forced, scale reported 0x${reported.toString(16).padStart(2, '0')})`
        : '';
    bleLog.debug(
      `QN: scale info (${data.length}B, dialect=${dialect}), ` +
        `factor=${this.s.weightScaleFactor}, ` +
        `proto=0x${this.s.seenProtocolType.toString(16).padStart(2, '0')}${forcedNote}`,
    );
    void this.handleScaleInfo();
  }

  /** The scale's answer to the profile frame, `a1 06 02 <slot> <1 accepted | 0>`. */
  private onProfileAnswer(data: Buffer): void {
    if (data[0] !== 0xa1 || data.length !== 6 || data[1] !== 0x06 || data[2] !== 0x02) return;
    if (!hasValidSumChecksum(data)) return;
    this.s.visitReply = { slot: data[3], ok: data[4] === 0x01 };
    if (this.s.visitReply.ok && this.s.visitAcceptedAtMs === null) {
      this.s.visitAcceptedAtMs = Date.now();
    }
    bleLog.debug(
      `QN: the scale ${this.s.visitReply.ok ? 'accepted' : 'did not accept'} the profile ` +
        `for user slot ${data[3]} (#331)`,
    );
    // The vendor's published SDK asks for the stored weigh-ins as soon as
    // the scale accepts the profile, and the Feelfit capture shows it. The
    // handshake's own 0x22 comes about 125 ms later, and in two logs the
    // final live frame came first (#463). Only for the profile built from
    // the first user with the key, as the export of a stored weigh-in
    // needs it; the handshake then skips its 0x22.
    if (
      this.s.visitReply.ok &&
      this.s.kind === 'va18' &&
      this.opts.userKey !== null &&
      this.s.visitSent !== null &&
      this.s.storedQuerySentAtMs === null
    ) {
      bleLog.debug(
        'QN: the scale accepted the profile, asking it for its stored weigh-ins now, as ' +
          'the vendor app does (#463)',
      );
      this.s.storedQuerySentAtMs = Date.now();
      void this.writeCmd(buildStoredDataQuery(this.s.seenProtocolType));
    }
    // Only a frame sent with the option gets this: an install without it
    // sees the same log as before (#463). Info, not a warning, because the
    // weigh-in can still arrive, from the scale's memory.
    if (
      !this.s.visitReply.ok &&
      this.s.visitSent !== null &&
      this.opts.userKey !== null &&
      !this.s.visitRefusedLogged
    ) {
      this.s.visitRefusedLogged = true;
      // The key is the leading explanation, not a confirmed one, so the
      // line says "most likely".
      const sentKey = (this.s.visitSent.frame[4] << 8) | this.s.visitSent.frame[5];
      bleLog.info(
        `QN: the scale refused the profile frame sent with ble.qn_user_key ${sentKey} ` +
          `for user slot ${data[3]}. Most likely the vendor app set up that slot with ` +
          'another key, or never set it up. Check ble.qn_user_key, and that the first ' +
          'user in config.yaml is the first user in the vendor app (#463).',
      );
    }
  }

  /** A live 0x10 weight frame, original or ES-30M layout; any other frame is logged and dropped. */
  private liveFrame(data: Buffer): ScaleReading | null {
    // Anything else is logged, not dropped in silence: an AE02 frame other than
    // the AE00 challenge still falls through to here, and while such frames
    // vanished without a trace #75 read as a decode bug.
    if (data[0] !== 0x10 || data.length < 10) {
      bleLog.debug(
        `QN: ignoring frame opcode=0x${data[0].toString(16).padStart(2, '0')} ` +
          `len=${data.length} hex=${Buffer.from(data).toString('hex')}`,
      );
      return null;
    }

    let stable: boolean;
    let rawWeight: number;
    let r1: number;
    let r2: number;

    // ES-30M (VA) format: byte[4] is a state flag (0x00/0x01/0x02) instead of
    // the weight's low byte. The layout is picked by the frame's shape, 14
    // bytes or more with its own length at [1], and never after a classic
    // 0x12. It used to be keyed on the divisor 10, so a classic frame whose
    // weight had a low byte of 0x00 to 0x02 went this way (84.50 kg read as
    // 25.7 kg), and a VA frame in a session without a 0x12 went the original
    // way (D068).
    const classicSession = this.s.kind === 'classic';
    const isEs30m =
      !classicSession &&
      data.length >= ES30M_MIN_FRAME_LEN &&
      data[1] === data.length &&
      data[4] <= 0x02;

    if (isEs30m) {
      // ES-30M: [4]=state (0x02=stable), [5-6]=weight, [7-8]=R1, [9-10]=R2
      stable = data[4] === 0x02;
      rawWeight = data.readUInt16BE(5);
      r1 = data.readUInt16BE(7);
      r2 = data.readUInt16BE(9);

      if (stable && r1 === 0 && r2 === 0) {
        if (this.s.kind === 'unknown') {
          // A session without a 0x12 (a classic one never gets here): always
          // skip, an impedance frame follows.
          return null;
        }
        // Long-frame variant (ES-26M): accept after grace period.
        // The first stable R1=R2=0 frame starts a timer. If no impedance
        // frame arrives within IMPEDANCE_GRACE_MS, subsequent R1=R2=0
        // frames are accepted. This prevents losing BIA data if the
        // scale sends a transient R1=R2=0 before the impedance frame.
        const now = Date.now();
        if (this.s.firstStableNoImpedanceAt === null) {
          this.s.firstStableNoImpedanceAt = now;
          return null;
        }
        if (now - this.s.firstStableNoImpedanceAt < IMPEDANCE_GRACE_MS) {
          return null;
        }
        // Grace period elapsed: accept this weight-only reading.
      }
    } else {
      // Original: [3-4]=weight, [5]=stable(1), [6-7]=R1, [8-9]=R2
      stable = data[5] === 1;
      rawWeight = data.readUInt16BE(3);
      r1 = data.readUInt16BE(6);
      r2 = data.readUInt16BE(8);
    }

    // The 20-byte live frame every capture of the long dialects shows has its
    // weight as a big-endian u16 /100 at [5..6] (PROTOCOLS.md, QN family). The
    // 19-byte dialect decodes it in its handler. Elsewhere its [4] 0x11 puts it
    // in the original layout, which reads 0x0011, and whether the GE frame
    // shares the Arboleaf status and part bytes is not known, so it is logged
    // once per session with the weight where the captures put it. On the
    // extended dialect [2] is the user slot, as on the 19-byte one: the CS10G
    // streams `10 14 02 ..` for the user its app registered in slot 2 (#501).
    const twentyByteLive = data.length === 20 && data[1] === 0x14;
    if (twentyByteLive && !this.s.twentyByteFrameLogged) {
      this.s.twentyByteFrameLogged = true;
      bleLog.debug(
        `QN: 20-byte live frame, weight ${data.readUInt16BE(5) / 100} kg at [5..6], ` +
          (this.s.kind === 'ext20' ? `user slot ${data[2]}, ` : '') +
          'not echoed and not yet decoded (#331)',
      );
    }

    // Nothing else the original layout reads is right for this shape either: a
    // step-off ramp read as a stable 1.7 kg, and at exactly 2.56 kg it ended
    // the session. Stop here until the layout is decoded. A 20-byte frame on
    // the ES-30M branch reads its weight from [5..6] and is left as it was.
    if (twentyByteLive && !isEs30m) return null;

    // Per-frame weight echo (`ble.qn_weight_ack`, on by default on the 20-byte
    // extended dialect): one reading of the GE CS 10 G capture has the vendor
    // app answer each live 0x10 with an A2 of that frame's weight bytes, a later
    // reading disagrees, and no hardware run has needed it (#235). Never for a
    // 20-byte frame: through the original layout it handed the scale 0.17 kg on
    // every frame, and the 19-byte dialect writes nothing back (#331). Sent
    // before the stability gate, fire and forget, like the 0x1F stable ACK below.
    if (this.weightAckEnabled() && this.ctx && !twentyByteLive) {
      void this.writeCmd(buildA2Frame(rawWeight));
    }

    if (!stable) return null;

    const weight = this.resolveWeight(rawWeight);
    if (weight === null) return null;

    // R1 (primary BIA resistance) and R2 (secondary)
    const impedance = this.resistance(r1 > 0 ? r1 : r2);

    // Reset the impedance grace timer on successful reading
    this.s.firstStableNoImpedanceAt = null;

    const reading: ScaleReading = { weight, impedance };
    const complete = this.isComplete(reading);
    const held = this.s.heldForStoredAnswer;
    // Another weigh-in while one is held for the stored ones: someone else
    // stepped on. The session ends on the held one, and the new one is not
    // acknowledged, so the scale need not count it as handed over (#463).
    if (held !== null && complete && Math.abs(held.weight - weight) > LIVE_MATCH_WEIGHT_KG) {
      return va18.releaseHeldWeighIn(this, `another weigh-in (${weight} kg) came during the wait`);
    }
    const holds = held === null && complete && va18.waitsForStoredAnswer(this);
    if (holds) va18.holdForStoredAnswer(this, reading);

    // Acknowledge stable reading (0x1F) so the scale knows we received it
    if (this.ctx) {
      void this.writeCmd(withChecksum([0x1f, 0x05, this.s.seenProtocolType, 0x10]));
    }

    if (holds) return reading;
    // The held weigh-in again: acknowledged like every stable frame, and
    // nothing new to hand over.
    if (held !== null && complete) return null;
    // A stored weigh-in the scale sends after the session settled on this one
    // is never parsed (#463). The 18-byte scale answers our 0x22 within a
    // second, so this is rare, and without the line it would be invisible.
    if (
      this.s.kind === 'va18' &&
      this.s.storedQuerySentAtMs !== null &&
      !this.s.queryAnswered &&
      complete
    ) {
      bleLog.debug(
        'QN: the weigh-in ends the session before the scale answered the stored-record ' +
          'query; a stored weigh-in it sends after this is not read (#463)',
      );
    }
    if (this.s.kind === 'va18' && complete) this.ledger.remember(weight);
    return reading;
  }

  /**
   * Kilograms for a live 0x10 raw weight, or null to drop the frame (C-06).
   *
   * The divisor (100 or 10) comes from the 0x12 scale-info frame. It is taken
   * as is when that frame arrived this session and the weight it gives is in
   * the WEIGHT_CERTAIN band. Otherwise the divisor is in doubt: no 0x12 (lost
   * to the BlueZ race, so the default 100 is a guess), or an out-of-band
   * weight. Both readings of the raw value are then candidates:
   *
   * - one that cannot be a body (0 or below, WEIGHT_CERTAIN_MAX_KG or above) is
   *   ruled out, and if only one is left it is the weight. Until D068 this was
   *   the ES-26M case: its long 0x12 was taken as /10, and its captured frames
   *   read 978.5 kg so;
   * - if both are left, the configured users decide: the one candidate inside
   *   some user's `weight_range` or near their `last_known_weight` wins;
   * - if both fit or neither does, the frame is dropped with a warning.
   *
   * The old rule tried the other divisor whenever the weight left the band and
   * otherwise trusted the default, so a /10 scale whose 0x12 was lost exported
   * 83.2 kg as 8.32 kg, and a 4 kg child or parcel on a /100 scale as 40 kg.
   * The owner's decision is to drop rather than guess.
   */
  private resolveWeight(rawWeight: number): number | null {
    const primary = rawWeight / this.s.weightScaleFactor;
    if (
      this.s.kind !== 'unknown' &&
      primary > WEIGHT_CERTAIN_MIN_KG &&
      primary < WEIGHT_CERTAIN_MAX_KG
    ) {
      return primary;
    }

    const candidates = [rawWeight / 100, rawWeight / 10].filter(
      (w) => Number.isFinite(w) && w > 0 && w < WEIGHT_CERTAIN_MAX_KG,
    );
    if (candidates.length <= 1) return candidates[0] ?? null;

    const fitsSomeone = (w: number): boolean =>
      this.userWeights.some(
        (u) =>
          (w >= u.weight_range.min && w <= u.weight_range.max) ||
          (u.last_known_weight !== null &&
            Math.abs(w - u.last_known_weight) <= u.last_known_weight * LAST_KNOWN_WEIGHT_TOLERANCE),
      );
    const fitting = candidates.filter(fitsSomeone);
    if (fitting.length === 1) return fitting[0];

    if (!this.s.divisorDoubtWarned) {
      this.s.divisorDoubtWarned = true;
      const why =
        this.s.kind !== 'unknown'
          ? `the divisor its scale-info frame (0x12) named gives ${primary} kg`
          : 'its scale-info frame (0x12), which names the divisor, never arrived';
      bleLog.warn(
        `QN: dropping a weight that reads ${candidates[0]} kg or ${candidates[1]} kg: ${why}, ` +
          `and ${fitting.length === 0 ? 'neither fits' : 'both fit'} a configured user's ` +
          'weight_range or last_known_weight. Check weight_range in config.yaml; if this ' +
          'repeats with the scale-info frame missing, please report the log.',
      );
    }
    return null;
  }

  /**
   * A 0x23 stored measurement record returned after the 0x22 history query,
   * read in the VA layout on every dialect but the classic and the 19-byte one.
   * V10 Renpho / 18-byte ES-CS20M firmware delivers the weigh-in here, not
   * reliably via live 0x10 frames (#213 / #75). Layout in decodeStoredRecord:
   * R50 and R500 big-endian at [12..13] and [14..15], as the vendor SDK reads
   * them (#461), not openScale's little-endian [13..14] and [15..16].
   *
   * A record from up to MAX_STORED_RECORD_AGE_SEC before the session, and not
   * stamped more than STORED_FUTURE_TOLERANCE_MS after its receipt, is this
   * session's weigh-in and ends it, without a time. An older one is the
   * scale's memory: on the 18-byte dialect it can go out as history
   * (eighteenByteStoredWeighIn, #463), elsewhere it is logged and not read.
   */
  storedRecord(data: Buffer): ScaleReading | null {
    const record = data.length < 17 ? null : decodeStoredRecord(data);
    if (!record) {
      bleLog.debug(
        `QN: 0x23 too short for a stored record (${data.length} bytes): [${hex(data)}] (#463)`,
      );
      this.scheduleStoredDataRetry();
      return null;
    }
    const { weight, recordSeconds } = record;
    const sessionSeconds =
      this.s.sessionStartedScaleSeconds ?? Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
    if (weight <= RESULT_MIN_WEIGHT_KG || weight >= RESULT_MAX_WEIGHT_KG) {
      this.logUnreadStoredRecord(data, record, sessionSeconds, 'out of range');
      this.scheduleStoredDataRetry();
      return null;
    }
    // A record stamped after it arrived was not measured in this session: the
    // scale's clock is ahead (a vendor app that set it with a UTC+8 base,
    // R-6), and taking it as this session's weigh-in would end the session
    // on an old weight without a time, before the real one. The 19-byte
    // dialect drops the same (parseEightStoredPart). The re-query stays. In a
    // session without a 0x12 too: two classic scales in the reports lose
    // theirs (#283, #336), and a classic record read through the long layout
    // can land in the future (D068).
    const recordAtMs = (recordSeconds + SCALE_EPOCH_OFFSET) * 1000;
    const aheadMs = recordAtMs - Date.now();
    if (aheadMs > STORED_FUTURE_TOLERANCE_MS) {
      const at = new Date(recordAtMs).toISOString();
      const ahead = Math.round(aheadMs / 1000);
      bleLog.debug(
        this.s.kind !== 'unknown'
          ? `QN: stored weigh-in ${weight} kg at ${at}, ${storedSlotLabel(data[5])}, is stamped ` +
              `${ahead} s ahead of this host's clock, so it is not the weigh-in of this ` +
              'session, not read (#463)'
          : `QN: 0x23 in a session without a scale-info frame, not read: [${hex(data)}]; ` +
              `read as the VA layout it is ${weight} kg at ${at}, ${ahead} s ahead of this ` +
              "host's clock (#463)",
      );
      this.scheduleStoredDataRetry();
      return null;
    }
    if (recordSeconds + MAX_STORED_RECORD_AGE_SEC < sessionSeconds) {
      // The re-query stays: V10 firmware may save the fresh weigh-in only a
      // moment after handing over an old one (#213 / #75).
      this.scheduleStoredDataRetry();
      if (this.s.kind === 'va18') return va18.eighteenByteStoredWeighIn(this, data, record);
      this.logUnreadStoredRecord(data, record, sessionSeconds, 'old');
      return null;
    }
    // This session's weigh-in is the one held; see recentStoredDuringHold.
    if (this.s.heldForStoredAnswer !== null) return va18.recentStoredDuringHold(this, data, record);
    const r1 = record.r50;
    const r2 = record.r500;
    if (this.s.storedRetryTimer) {
      clearTimeout(this.s.storedRetryTimer);
      this.s.storedRetryTimer = null;
    }
    bleLog.debug(`QN: stored 0x23 reading ${weight}kg, R50 ${r1} / R500 ${r2}`);
    const fresh: ScaleReading = { weight, impedance: this.resistance(r1 > 0 ? r1 : r2) };
    // This session's weigh-in, so a later session that is handed the same
    // record as history knows it went out already (#463).
    if (this.s.kind === 'va18' && this.isComplete(fresh)) this.ledger.remember(weight);
    return fresh;
  }

  /**
   * Say why a 0x23 outside the 19-byte dialect is not read (#463). The record
   * used to vanish without a line, and a frame that arrives after the session
   * settled is not even in the DEBUG log, so nothing showed that a weigh-in the
   * scale kept had been handed over at all.
   *
   * Only the long-frame dialects get the record's values: the VA layout is
   * known there. A session without a 0x12 does not know its dialect, so its
   * line gives the VA reading as one possibility. A classic session never gets
   * here: its 0x23 is logged and dropped before it is decoded (D068).
   */
  private logUnreadStoredRecord(
    data: Buffer,
    record: StoredRecord,
    sessionSeconds: number,
    why: 'out of range' | 'old',
  ): void {
    const bytes = hex(data);
    const at = new Date((record.recordSeconds + SCALE_EPOCH_OFFSET) * 1000).toISOString();
    const age = sessionSeconds - record.recordSeconds;
    if (this.s.kind === 'unknown') {
      bleLog.debug(
        `QN: 0x23 in a session without a scale-info frame, not read: [${bytes}]; read as the ` +
          `VA layout it is ${record.weight} kg at ${at}, ` +
          (why === 'old' ? `${age} s before the session` : 'out of range') +
          ' (#463)',
      );
      return;
    }
    if (why === 'out of range') {
      bleLog.debug(
        data[3] === 0
          ? 'QN: 0x23 says the scale holds no stored weigh-ins (#463)'
          : `QN: stored 0x23 weight ${record.weight} kg is out of range, not read (#463)`,
      );
      return;
    }
    bleLog.debug(
      `QN: stored weigh-in ${record.weight} kg at ${at}, ${storedSlotLabel(data[5])}, is ${age} s ` +
        `older than this session (window ${MAX_STORED_RECORD_AGE_SEC} s), not read (#213 / #75)`,
    );
  }

  /** See QnLedger. */
  dedupMark(): number | undefined {
    return this.ledger.dedupMark();
  }

  restoreDedupMark(mark: number): void {
    this.ledger.restoreDedupMark(mark);
  }

  // ── State machine handlers (fire-and-forget from parseNotification) ─────

  /**
   * Respond to 0x12 (scale info) with AE02 subscribe + AE01 init + 0x13 config.
   *
   * The official Renpho app sequence is: AE02 subscribe -> AE01 init -> 0x13.
   * On Linux, 0x12 can arrive before onConnected() subscribes AE02, so this
   * method must ensure AE02 is subscribed before sending AE01 init.
   *
   * AE01/AE02 writes fail silently on older firmware without AE00 service.
   */
  private async handleScaleInfo(): Promise<void> {
    if (this.s.configSent) return;
    this.s.configSent = true;

    // Cancel the fallback timer since the state machine is running normally
    if (this.s.fallbackTimer) {
      clearTimeout(this.s.fallbackTimer);
      this.s.fallbackTimer = null;
    }

    // See sessionGeneration: every await below can outlive this session.
    const gen = this.sessionGeneration;

    // Step 1: subscribe AE02 if it has not happened yet. On Linux 0x12 can
    // arrive before onConnected finishes, so both paths call the same memoised
    // helper instead of racing two independent subscribes (#75).
    await this.ensureAe02Subscribed();
    if (gen !== this.sessionGeneration) return;

    // Step 2: AE01 init. Fails silently on firmware without AE00.
    await this.writeAe01([0xfe, 0xdc, 0xba, 0xc0, 0x06, 0x00, 0x02, 0x01, 0x01, 0xef]);
    await wait(200);
    if (gen !== this.sessionGeneration) return;

    // Step 3: 0x13 config. See buildConfig for the 9 vs 10 byte forms and why
    // the longer one is opt-in.
    await this.writeCmd(
      buildConfig(this.s.seenProtocolType, this.unitFlag(), this.opts.configLong),
    );
    if (this.opts.configLong) {
      bleLog.debug(
        'QN: 0x13 config sent in the 10-byte vendor-app form ' +
          '(ble.qn_config_long, trailing pair undecoded, #331)',
      );
    }
  }

  /**
   * Respond to 0x14 (ready) with 0x20 time sync + A2 user profile + AE01 auth.
   * No A2 under the vendor-app profile sequence (see appProfileSequence).
   */
  private async handleReady(): Promise<void> {
    if (this.s.timeSyncSent) return;
    this.s.timeSyncSent = true;
    const gen = this.sessionGeneration;
    const appProfile = this.decideAppProfileSequence();
    // 0x20 time sync: seconds since 2000-01-01, little-endian. See
    // TIME_SYNC_TRAILER for the 9-byte form and why it is opt-in. Its extra
    // byte is the host's UTC offset now, daylight saving included.
    const secs = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
    const offsetMin = -new Date().getTimezoneOffset();
    const tz = timeZoneByte(offsetMin);
    await this.writeCmd(buildTimeSync(this.s.seenProtocolType, secs, this.opts.timeSyncLong, tz));
    if (gen !== this.sessionGeneration) return;
    if (this.opts.timeSyncLong) {
      bleLog.debug(
        `QN: 0x20 time sync sent in the 9-byte vendor-app form with UTC offset ` +
          `${offsetMin >= 0 ? '+' : '-'}${Math.abs(offsetMin)} min ` +
          `(0x${tz.toString(16).padStart(2, '0')}, ble.qn_time_sync_long, #331)`,
      );
    }

    // A2, which openScale fills with 0x32 plus the user's age as a "user
    // profile". Per the vendor's SDK it sets the slot's identify weight, and
    // `0x32 <age>` puts that at over 128 kg (#331, #75). Kept by default: every
    // QN scale in the registry reads with it today. Not sent at all under the
    // vendor-app profile sequence: neither the Arboleaf nor the Feelfit app
    // sends an A2 before START (D033, #463).
    if (appProfile) {
      bleLog.debug(
        this.opts.userKey === null
          ? 'QN: no A2 before START on the 19-byte dialect, as the vendor app ' +
              '(ble.qn_weight_ack, #331)'
          : `QN: no A2 before START on the ${this.dialectBytes()}-byte dialect, as the ` +
              'vendor app (ble.qn_user_key, #463)',
      );
    } else if (this.ctx) {
      // The anchor goes here ONLY on the 20-byte extended dialect. Everywhere
      // else `handleConfigRequest` sends it twice right after START instead,
      // which is where both Android captures of the Arboleaf app put it (#331,
      // #75), and sending it in both places would mean one switch moves two
      // things and the reporter's experiment stops being readable.
      const anchorAtReady = this.opts.weightAck === true && this.s.kind === 'ext20';
      const anchorKg = anchorAtReady ? this.resolveAnchorKg() : 0;
      const profileCmd = anchorAtReady
        ? buildMeasurementTrigger(anchorKg)
        : buildOpenScaleA2(this.ctx!.profile.age);
      if (anchorAtReady) {
        bleLog.debug(
          `QN: ready-time A2 carries the configured weight anchor ` +
            `${anchorKg.toFixed(2)} kg instead of openScale's placeholder (#75)`,
        );
      }
      await this.writeCmd(profileCmd);
      if (gen !== this.sessionGeneration) return;
    }

    // "pass" authentication on AE01. Always attempted; fails silently without AE00.
    await this.writeAe01([0x02, 0x70, 0x61, 0x73, 0x73]);
  }

  /** Respond to 0x21 (config request) with the A00D profile frame + 0x22 start measurement. */
  private async handleConfigRequest(): Promise<void> {
    if (this.s.historyResponseSent) return;
    this.s.historyResponseSent = true;
    const appProfile = this.decideAppProfileSequence();
    // See sessionGeneration. The whole sequence spans several timers, and
    // writeCmd reads this.ctx at write time, so a session that ends and
    // reconnects inside it must not be handed this one's A00D, START, anchor,
    // prelude or trigger.
    const gen = this.sessionGeneration;
    const live = (): boolean => gen === this.sessionGeneration;

    // The A00D user-delete frame (openScale's "history response") goes out only
    // when `ble.qn_report_byte` asks for it, with that byte as the slot mask;
    // see USER_DELETE_SUBCOMMAND (#461). The 200 ms that followed it stays, so
    // nothing else in the sequence moves in time.
    if (this.opts.reportByte !== null) {
      bleLog.debug(
        `QN: sending the A00D user-delete frame with mask ` +
          `0x${this.opts.reportByte.toString(16).padStart(2, '0')} (ble.qn_report_byte, #461)`,
      );
      await this.writeCmd(buildUserDelete(this.opts.reportByte));
    } else {
      bleLog.debug('QN: A00D user-delete frame not sent (ble.qn_report_byte unset, #461)');
    }

    await wait(200);
    if (!live()) return;

    // A00D response 2, the user profile ("visit"). openScale's constant (key 8,
    // age 33, 1720 mm) everywhere except the vendor-app profile sequence, which
    // gets the first user's age, height and sex the way the vendor apps send
    // them: the 19-byte dialect with `ble.qn_weight_ack` (#331, D033), and the
    // 18- and 19-byte ones with `ble.qn_user_key`, which also sets the user key
    // at [4..5] (#463, D055). The athlete step in [10] is the Feelfit app's on
    // the 18-byte dialect only; see VISIT_ALGORITHM.
    let msg2 = withChecksum([
      0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 0x21, 0x06, 0xb8, 0x04, 0x02,
    ]);
    const profile = this.ctx?.profile;
    if (appProfile && profile) {
      const key = this.opts.userKey ?? VENDOR_APP_USER_KEY;
      const athlete =
        this.s.kind === 'va18' && profile.isAthlete && profile.age >= VISIT_ATHLETE_MIN_AGE;
      msg2 = buildUserProfileFrame(profile.age, profile.height, profile.gender, { key, athlete });
      this.s.visitSent = { slot: msg2[3], frame: msg2 };
      const sent =
        `age ${msg2[7]}, height ${(msg2[8] << 8) | msg2[9]} mm, ` +
        `sex ${msg2[6] === 0x01 ? 'female' : 'male'}`;
      bleLog.debug(
        this.opts.userKey === null
          ? `QN: A00D profile frame with ${sent} (ble.qn_weight_ack, 19-byte dialect, #331)`
          : `QN: A00D profile frame with key ${key}, ${sent}, athlete ${athlete ? 'yes' : 'no'} ` +
              `(ble.qn_user_key, ${this.dialectBytes()}-byte dialect, #463)`,
      );
    } else if (!appProfile && this.opts.userKey !== null && !this.wantsAppProfileSequence()) {
      // An 18- or 19-byte 0x12 that came after the decision has its own line
      // in parseNotification, so this one is only for a dialect without it.
      bleLog.debug(
        "QN: ble.qn_user_key is not used on this dialect, sending openScale's profile frame " +
          '(18- and 19-byte scale-info frames only, #463)',
      );
    }
    await this.writeCmd(msg2);

    await wait(200);
    if (!live()) return;

    // 0x22 start measurement / stored-data query with echoed protocol type.
    // Its send time is what the scale's first answer is measured against. On
    // the 18-byte dialect with ble.qn_user_key it may have gone out already,
    // on the scale's acceptance of the profile (#463). The anchor and prelude
    // below still go out when they did before, after it, also while a
    // weigh-in is held for the answer.
    if (this.s.storedQuerySentAtMs === null) {
      this.s.storedQuerySentAtMs = Date.now();
      await this.writeCmd(buildStoredDataQuery(this.s.seenProtocolType));
      if (!live()) return;
    }

    // Weight anchor, twice, right after START, where two Android btsnoops of the
    // Arboleaf app completing a weigh-in put it (#331, #75; PROTOCOLS.md,
    // "Arboleaf 19 B: A2 dvakrat po START"); replaying an iOS transcript that
    // had it before START never produced a weight. Every dialect but the
    // extended one, which has its own burst below, and only with
    // `ble.qn_weight_ack` true, so no other install sees a new frame.
    // POST_START_ANCHOR_DELAY_MS is the capture's 75 ms, the second copy follows
    // after TRIGGER_GAP_MS, unconditionally rather than on the a3, which a proxy
    // transport may deliver late or not at all. Bound to the session (`live()`).
    if (this.opts.weightAck === true && this.s.kind !== 'ext20') {
      const anchorKg = this.resolveAnchorKg();
      const anchor = buildMeasurementTrigger(anchorKg);
      for (let i = 0; i < TRIGGER_REPEATS; i++) {
        await wait(i === 0 ? POST_START_ANCHOR_DELAY_MS : TRIGGER_GAP_MS);
        if (!live()) return;
        await this.writeCmd([...anchor]);
      }
      bleLog.debug(
        `QN: weight anchor ${anchorKg.toFixed(2)} kg sent twice after START ` +
          `(ble.qn_weight_ack, sequence from the #331/#75 Android captures)`,
      );
    }

    // Opt-in only. See A4_PRELUDE for why these bytes are a replay rather than
    // something built from this user's profile, and why that keeps it off by
    // default.
    if (this.opts.a4Prelude) {
      this.s.a4PreludeSent = true;
      for (let i = 0; i < A4_PRELUDE.length; i++) {
        if (i > 0) await wait(A4_PRELUDE_GAP_MS);
        if (!live()) return;
        await this.writeCmd([...A4_PRELUDE[i]]);
      }
      bleLog.debug(
        'QN: sent the two 0xA4 0x0F prelude frames after START ' +
          '(ble.qn_a4_prelude, replayed from the #331 capture, payload undecoded)',
      );
    }

    // Extended dialect only: the scale needs an explicit trigger after START
    // before it will stream 0x10 frames (#235). Gated on the dialect because
    // that is the only firmware the capture covers; every other QN scale in the
    // registry reads today without it, and an unexplained extra write is not
    // something to hand them on spec.
    //
    // Deliberately NOT gated on weightAckEnabled(): this is the measurement
    // trigger, not the weight acknowledgement, and a GE CS 10 G owner who turns
    // the echo off must not lose the frame that makes their scale stream at all.
    if (this.s.kind !== 'ext20') return;
    const anchorKg = this.resolveAnchorKg();
    const trigger = buildMeasurementTrigger(anchorKg);
    for (let i = 0; i < TRIGGER_REPEATS; i++) {
      if (i > 0) await wait(TRIGGER_GAP_MS);
      if (!live()) return;
      await this.writeCmd([...trigger]);
    }
    bleLog.debug(
      `QN: extended-dialect measurement trigger sent, weight anchor ` +
        `${anchorKg.toFixed(2)} kg (#235, #75)`,
    );
  }

  /**
   * Drop timers and the connection context when the session ends.
   *
   * Both timers write through `this.ctx`. The adapter instance is shared across
   * sessions, so one left armed past a disconnect fires against a dead link, or
   * worse against the next session's context. Same class of defect as #138.
   */
  onSessionEnd(): void {
    this.sessionGeneration += 1;
    this.s.dispose();
    va18.logHeldAtSessionEnd(this);
    this.s.sessionStartedScaleSeconds = null;
    this.ctx = null;
  }

  /**
   * The weight anchor to hand the scale, in kg, warning once when config has
   * nothing usable.
   *
   * The fallback is the value from the capture this was decoded in, so it is
   * right for one person and wrong for everyone else, which is the whole defect
   * being fixed (#75). It is reached silently by a config that looks complete:
   * the Home Assistant add-on defaults to a 40 to 150 kg weight range, whose
   * span locates nobody and is rejected as a hint, so a reporter can turn
   * `qn_weight_ack` on, change nothing else, and get the same 77.15 kg that was
   * already failing. That is a false negative on the one experiment that
   * matters, so say it out loud.
   */
  private resolveAnchorKg(): number {
    const anchor = this.ctx?.profile.lastKnownWeight;
    if (anchor !== undefined) return anchor;
    if (!this.s.anchorFallbackWarned) {
      this.s.anchorFallbackWarned = true;
      bleLog.warn(
        `QN: no usable weight anchor in config, falling back to ` +
          `${TRIGGER_WEIGHT_FALLBACK_KG} kg, which is a value from a capture and not ` +
          `yours. This scale can refuse to finish a weigh-in when that number is far ` +
          `from the real weight. Set users[].last_known_weight, or narrow ` +
          `users[].weight_range so its midpoint is close to you (a range wider than ` +
          `100 kg is ignored because it locates nobody).`,
      );
    }
    return TRIGGER_WEIGHT_FALLBACK_KG;
  }

  /**
   * Whether to answer each live 0x10 frame with its own weight.
   *
   * The dialect gate is the default because the 20-byte extended firmware is
   * the only one a vendor-app capture covers, and every other QN scale in the
   * registry reads today without the echo. `ble.qn_weight_ack` overrides
   * it in both directions for a reporter chasing a scale that completes the
   * handshake and then streams nothing (#75).
   */
  private weightAckEnabled(): boolean {
    return this.opts.weightAck ?? this.s.kind === 'ext20';
  }

  /**
   * Re-send the 0x22 stored-data query after a stale, empty, or short 0x23,
   * bounded by MAX_STORED_QUERY_ATTEMPTS. Gives V10 firmware a moment to save
   * the fresh weigh-in before the scale disconnects (#213 / #75).
   */
  scheduleStoredDataRetry(): void {
    if (!this.ctx || this.s.storedQueryAttempts >= MAX_STORED_QUERY_ATTEMPTS) return;
    if (this.s.storedRetryTimer) clearTimeout(this.s.storedRetryTimer);
    this.s.storedRetryTimer = setTimeout(() => {
      this.s.storedRetryTimer = null;
      if (!this.ctx || this.s.storedQueryAttempts >= MAX_STORED_QUERY_ATTEMPTS) return;
      this.s.storedQueryAttempts += 1;
      bleLog.debug(
        `QN: stored-data re-query ${this.s.storedQueryAttempts}/${MAX_STORED_QUERY_ATTEMPTS}`,
      );
      void this.writeCmd(buildStoredDataQuery(this.s.seenProtocolType));
    }, STORED_QUERY_RETRY_MS);
  }

  /** See broadcast.ts. The AABB path, pure over the advertisement buffer. */
  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    return parseQnBroadcast(manufacturerData);
  }

  isComplete(reading: ScaleReading): boolean {
    // A stored weigh-in is complete as it is: the processor judges its
    // impedance (D028). Gated on impedance like a live frame, one with 1-200
    // Ohm would be dropped by the session after the mark had already counted
    // it as reported (#463).
    if (reading.fromMemory === true) return reading.weight > 0;
    // Broadcast readings have impedance=0; GATT readings have impedance>200
    if (reading.impedance === 0) return reading.weight > 0;
    return reading.weight > 10 && reading.impedance > 200;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // The 19-byte dialect's own results, when they belong to this user (#331).
    const pin = reading.scaleComposition as va19.ScaleCompositionPin | undefined;
    if (pin) {
      const payload = va19.scaleCompositionPayload(pin, reading, profile);
      if (payload) return payload;
    }

    // In broadcast mode impedance is 0, and biaFatIfPlausible returns undefined
    // for it, so buildPayload uses the Deurenberg fallback.
    //
    // isComplete gates GATT readings on impedance > 200 with no ceiling. The
    // gate is deliberately left alone (ADR D011 decides the guard belongs at
    // computation, not at parsing, and raising a completion floor would change
    // WHEN a session ends), so an r1 far above the whole-body range still
    // completes a reading - it just no longer produces a pinned 60 % as if it
    // had been measured (#405).
    return biaPayload(reading, profile);
  }
}
