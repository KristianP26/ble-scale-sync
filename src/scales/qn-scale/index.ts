import {
  biaFatIfPlausible,
  buildPayload,
  compositionRejection,
  isPlausibleImpedance,
  r2,
  ReadingComposition,
  type ScaleBodyComp,
} from '../body-comp-helpers.js';
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
import { isHistoricalReading } from '../../interfaces/reading-time.js';
import type { MatchDescriptor } from '../match-descriptor.js';
import {
  jieliAuthResponseFrame,
  JIELI_CHALLENGE_FRAME_LEN,
  JIELI_CHALLENGE_HEADER,
} from '../jieli-auth.js';
import type { ScaleDisplayUnit } from '../../config/schema.js';
import {
  A4_PRELUDE,
  A4_PRELUDE_GAP_MS,
  BMI_MATCH_TOLERANCE,
  CHR_AE01,
  CHR_AE02,
  CHR_NOTIFY,
  CHR_NOTIFY_T1,
  CHR_WRITE,
  CHR_WRITE_T1,
  EIGHT_CHANNEL_ORDER,
  EXTENDED_INFO_FRAME_LEN,
  IMPEDANCE_GRACE_MS,
  LAST_KNOWN_WEIGHT_TOLERANCE,
  LEGACY_PROTO_TYPE,
  LIVE20_FRAME_LEN,
  LIVE20_STATUS_MEASURING,
  LIVE20_STATUS_RESULT,
  LIVE20_STATUS_STABLE,
  LIVE_MATCH_AFTER_MS,
  LIVE_MATCH_BEFORE_MS,
  LIVE_MATCH_WEIGHT_KG,
  LIVE_REPLAY_WINDOW_MS,
  MAX_AE00_RESPONSES,
  MAX_STORED_QUERY_ATTEMPTS,
  MAX_STORED_RECORD_AGE_SEC,
  MEASURED_ANSWER_MIN_MS,
  NINETEEN_BYTE_RESULT_HOLD_MS,
  NO_CONTACT_RESISTANCE,
  POST_START_ANCHOR_DELAY_MS,
  PROTO_ECHO_MIN_INFO_FRAME_LEN,
  RECENT_LIVE_RESULTS,
  RESULT16_FRAME_LEN,
  RESULT16_OPCODE_COMPOSITION,
  RESULT16_OPCODE_DONE,
  RESULT_MAX_WEIGHT_KG,
  RESULT_MIN_WEIGHT_KG,
  RESULT_OPCODE_B1,
  RESULT_OPCODE_B4,
  RESULT_RECORD_CLOCK_TOLERANCE_SEC,
  SCALE_EPOCH_OFFSET,
  STORED_FUTURE_TOLERANCE_MS,
  STORED_MAX_AGE_MS,
  STORED_OPCODE_COMPOSITION,
  STORED_OPCODE_DONE,
  STORED_UNASSIGNED_SLOT,
  STORED_QUERY_RETRY_MS,
  TRIGGER_GAP_MS,
  TRIGGER_REPEATS,
  TRIGGER_WEIGHT_FALLBACK_KG,
  USER_DELETE_SUBCOMMAND,
  VENDOR_APP_USER_KEY,
  VISIT_ATHLETE_MIN_AGE,
  WEIGHT_CERTAIN_MAX_KG,
  WEIGHT_CERTAIN_MIN_KG,
} from './constants.js';
import {
  buildA2Frame,
  buildConfig,
  buildMeasurementTrigger,
  buildResultAck,
  buildTimeSync,
  buildUserProfileFrame,
  decodeEightResult,
  decodeEightStoredRecord,
  decodeStoredRecord,
  decodeVaComposition,
  decryptQnResistance,
  hasValidSumChecksum,
  timeZoneByte,
  type EightResult,
  type StoredRecord,
  type VaComposition,
} from './frames.js';
import { qnAdvertTraits, qnMatches, warnOnOneByoneShape } from './matching.js';
import { parseQnBroadcast } from './broadcast.js';

// Re-exported so importers keep the paths they had before the split.
export {
  buildA2Frame,
  buildConfig,
  buildMeasurementTrigger,
  buildTimeSync,
  buildUserProfileFrame,
  timeZoneByte,
} from './frames.js';

/**
 * The scale's own results for one 19-byte weigh-in, and what this session sent
 * it and heard back, pinned to the reading they belong to (#331).
 */
interface ScaleCompositionPin {
  result: EightResult;
  composition: VaComposition;
  /** The profile frame this session sent and its user slot; null if none. */
  visit: { slot: number; frame: readonly number[] } | null;
  /** The scale's answer to it: `a1 06 02 <slot> <1 accepted | 0>`. */
  reply: { slot: number; ok: boolean } | null;
  /** Bit 0 of the ready frame's [3]: 1 when muscle and bone are percentages. */
  valueType: number | null;
  measuredAfterVisit: boolean;
  /**
   * Milliseconds from the scale accepting the profile to its first answer to
   * the 0x22; null without an accepted profile or without an answer.
   */
  answerAfterVisitMs: number | null;
  a4PreludeSent: boolean;
}

/** Format bytes as hex string for debug logging. */
const hex = (data: number[] | Buffer): string =>
  [...data].map((b) => b.toString(16).padStart(2, '0')).join(' ');

/** Milliseconds as seconds with one decimal for the log, or "unknown". */
const seconds = (ms: number | null): string =>
  ms === null ? 'unknown' : `${(ms / 1000).toFixed(1)} s`;

export class QnScaleAdapter
  implements ScaleAdapterCore, GattWiring, BroadcastSource, MultiCharNotify, HoldForComposition
{
  readonly name = 'QN Scale';
  readonly match: MatchDescriptor = {
    priority: 250,
    custom: true,
    // 'seb-scale' and the exact 'fit plus' come from openScale's QN handler,
    // which annotates the latter as a BTSnoop-confirmed GE CS 10 G (#409, and
    // we have GE CS10G history in #235). 'fit plus' is EXACT on purpose: as a
    // substring it would claim any fitness-branded device whose name contains
    // it. Without these two, such a unit was reachable only through the
    // ae00/ffe0/fff0 service claim.
    names: {
      includes: ['qn-scale', 'renpho', 'senssun', 'sencor', 'seb-scale'],
      exact: ['fit plus'],
    },
    serviceUuids: ['ae00', 'ffe0', 'fff0'],
    charUuids: ['ae01', 'ae02'],
    manufacturerId: 0xffff,
  };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly altCharNotifyUuid = CHR_NOTIFY_T1;
  readonly altCharWriteUuid = CHR_WRITE_T1;
  readonly normalizesWeight = true;

  /**
   * Weight divisor: 100 (Type 1 default) or 10 (Type 2).
   * Updated dynamically when a 0x12 scale-info frame arrives.
   */
  private weightScaleFactor = 100;

  /**
   * Whether a 0x12 frame named `weightScaleFactor` this session. Without it the
   * factor is the default, a guess, and a 0x12 lost to the BlueZ race (which
   * `runFallbackHandshake` exists for) is exactly when that happens (C-06).
   */
  private scaleFactorKnown = false;

  /** Every configured user's weight hints (configure(), C-06). */
  private userWeights: readonly UserWeightHint[] = [];

  /** One "divisor in doubt, reading dropped" warning per session (C-06). */
  private divisorDoubtWarned = false;

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

  /** Protocol type byte captured from the scale's 0x12 frame, echoed in config commands. */
  private seenProtocolType = 0x00;

  /**
   * Configured display unit. The 0x13 config command tells the scale which unit
   * to show, so hardcoding kg flipped a user's lbs display on every read (#269).
   * Injected via configure() from scale.display_unit; defaults to kg.
   */
  private displayUnit: ScaleDisplayUnit = 'kg';

  /** Whether the AE00 service is available (newer firmware). */
  private hasAe00 = false;

  /**
   * In-flight AE02 subscribe, shared by onConnected and the 0x12 state machine.
   * Both used to fire because `hasAe00` is only set after the await, and every
   * subscribe adds another notification listener, so each AE02 frame was
   * dispatched four times (#75).
   */
  private ae02Subscribe: Promise<boolean> | null = null;

  /** Whether an AE00 challenge frame has already been reported this session. */
  private ae00ChallengeSeen = false;

  /** Serialises every AE01 write within one session (see writeAe01). */
  private ae01Chain: Promise<void> = Promise.resolve();

  /**
   * AE00 challenges answered this session. The captured vendor exchange has
   * exactly one scale-issued challenge, so a scale that keeps challenging is
   * rejecting our response; answering it forever would be a write storm on a
   * link that is already failing.
   */
  private ae00ResponsesSent = 0;

  /**
   * Whether the scale sent a long-frame (18-byte) 0x12 variant (e.g. ES-26M).
   * These scales may never provide impedance, so stable frames with R1=R2=0
   * must be accepted after a grace period. Classic ES-30M scales always send
   * an impedance frame after the weight-only stable frame, so skipping
   * R1=R2=0 is correct there.
   */
  private isLongFrameVariant = false;

  /**
   * Whether the 0x12 frame was the 20-byte extended dialect (#235). That
   * revision keeps a real protocol type at byte[2] and the vendor app echoes
   * it, unlike the 18-byte ES-26M frame which needs 0x00.
   */
  private isExtendedLongFrame = false;

  /**
   * Whether the 0x12 frame was exactly 19 bytes (Arboleaf). Set only in the
   * long-frame branch: the classic branch accepts other lengths too, and a
   * classic frame must never select the app profile sequence below.
   */
  private isNineteenByteInfo = false;

  /**
   * Whether the 0x12 frame was exactly 18 bytes (Renpho ES-26M, Physiq). Set
   * only in the long-frame branch, like isNineteenByteInfo, so a classic frame
   * of that length never counts (#463).
   */
  private isEighteenByteInfo = false;

  /**
   * The vendor-app profile sequence: no ready-time A2, and the A00D #2 profile
   * frame from the first user's profile. Sent on the 19-byte dialect with
   * `ble.qn_weight_ack` (#331, D033), and on the 18- and 19-byte dialects with
   * `ble.qn_user_key` (#463, D055).
   * Decided once, by whichever of the ready step and the config-request step
   * runs first, from the 0x12 seen at that point, so the ready-time A2 and the
   * A00D #2 profile frame always come from the same choice. A 0x12 that
   * arrives later (after a fallback handshake) does not change it. Null until
   * decided.
   */
  private appProfileSequence: boolean | null = null;

  private decideAppProfileSequence(): boolean {
    if (this.appProfileSequence === null) {
      this.appProfileSequence = this.wantsAppProfileSequence();
    }
    return this.appProfileSequence;
  }

  /** Whether the 0x12 seen so far and the options call for the vendor-app profile sequence. */
  private wantsAppProfileSequence(): boolean {
    return (
      (this.forcedWeightAck === true && this.isNineteenByteInfo) ||
      (this.forcedUserKey !== null && (this.isEighteenByteInfo || this.isNineteenByteInfo))
    );
  }

  /** Length of the 0x12 the vendor-app profile sequence was chosen for, for the log. */
  private dialectBytes(): number {
    return this.isEighteenByteInfo ? 18 : 19;
  }

  /**
   * Protocol byte forced by `ble.qn_protocol_byte`, overriding what the frame
   * length or the scale-info frame implies (#75, #331). Applied to every
   * protocol-bearing write in the session, including the pre-0x12 unlock
   * config, the classic dialect, and the no-0x12 fallback handshake: a scale
   * whose 0x12 is lost in transit must still open with the byte its firmware
   * accepts.
   *
   * There is no way to detect the wrong choice at runtime: a scale on the wrong
   * byte acknowledges 0x14, 0x21 and 0x23 exactly as it does on the right one
   * and simply never streams a weight, which is indistinguishable from nobody
   * standing on it. So this is a setting, not a heuristic.
   */
  private forcedProtocolType: number | null = null;

  /**
   * Slot mask of the A00D user-delete frame, set by `ble.qn_report_byte`. Null
   * (the default) sends no such frame at all; see USER_DELETE_SUBCOMMAND (#461).
   */
  private forcedReportByte: number | null = null;

  /**
   * `ble.qn_weight_ack`. Null leaves the dialect gate alone (#75).
   */
  private forcedWeightAck: boolean | null = null;

  /**
   * `ble.qn_user_key`: the user key the vendor app registered slot 1 with
   * (#463). Null sends openScale's frames on the 18-byte dialect and leaves the
   * 19-byte one to `ble.qn_weight_ack`, as before.
   */
  private forcedUserKey: number | null = null;

  /** One "refused the profile sent with ble.qn_user_key" line per session (#463). */
  private visitRefusedLogged = false;

  /** One anchor-fallback warning per session, reset in onConnected. */
  private anchorFallbackWarned = false;

  /** One "20-byte live frame" debug line per session, on either 20-byte path (#331). */
  private twentyByteFrameLogged = false;

  /**
   * The 19-byte dialect's streamed weigh-in (#331, D037). `live20Seen`: a
   * well-formed 20-byte 0x10 arrived this session, which is what makes later
   * 0x15/0x16 frames part of the same weigh-in.
   * `live20Weight`: the stable weight, held until 0x16 (`live20ResultSeen`)
   * closes the weigh-in.
   */
  private live20Seen = false;
  private live20Weight: number | null = null;
  private live20ResultSeen = false;

  /**
   * What the scale's own composition for this session's weigh-in is judged by
   * (#331): the result block's parts and its 0x15, the profile frame sent and
   * the scale's answer, whether the scale reports percentages (ready frame),
   * whether it measured after accepting the profile, and whether the
   * `qn_a4_prelude` frames went out.
   */
  private live20Block: Buffer[] = [];
  private live20C15: Buffer | null = null;
  private visitSent: { slot: number; frame: readonly number[] } | null = null;
  private visitReply: { slot: number; ok: boolean } | null = null;
  private readyValueType: number | null = null;
  private measuredAfterVisit = false;
  private a4PreludeSent = false;

  /**
   * The scale answers this session's 0x22 only once it has finished measuring
   * (#331), so when that answer comes says whether it measured after the link
   * came up, even for a weight that settled before the scale accepted the
   * profile and was followed by no live frame. `visitAcceptedAtMs`: when the
   * scale accepted the profile; `storedQuerySentAtMs`: when our 0x22 went out;
   * `queryAnswered`: the first answer (a 0x23, or the result block) has come;
   * `answerAfterVisitMs`: how long after the acceptance it came.
   */
  private visitAcceptedAtMs: number | null = null;
  private storedQuerySentAtMs: number | null = null;
  private queryAnswered = false;
  private answerAfterVisitMs: number | null = null;

  /** The scale's own results, by the reading they belong to (#331). */
  private readonly scaleComposition = new ReadingComposition<ScaleCompositionPin | null>();

  /**
   * Readings that stand in for a weigh-in the scale has not finished yet. Keyed
   * by the reading, like ReadingComposition, so isFinal answers for the object
   * it is handed rather than for whichever frame was parsed last. Never reset:
   * a reading from an earlier session is never handed back.
   */
  private readonly provisionalReadings = new WeakSet<ScaleReading>();

  /**
   * A 0x10 first part with status measuring or stable arrived this session, or
   * the scale's first answer to our 0x22 came MEASURED_ANSWER_MIN_MS or more
   * after it, so the scale measured while we were connected. A result block
   * without either is a weigh-in the scale finished before the link came up
   * (#331).
   */
  private live20Measured = false;

  /** This session's result block repeated a live result already reported. */
  private live20Replayed = false;

  /**
   * The 19-byte dialect's stored weigh-ins (#331): the frames of the record
   * being assembled (three 0x23 parts, 0x24, 0x25), whether a fresh one is
   * held for a live result that may replace it, and the scale-epoch seconds of
   * the records reported this session.
   */
  private storedParts: Buffer[] = [];
  private storedHoldArmed = false;
  private readonly storedEmitted = new Set<number>();

  /**
   * The 18-byte dialect's stored records judged this session, by their
   * scale-epoch seconds, so a record the re-query brings back gets no second
   * line (#463).
   */
  private readonly storedJudged = new Set<number>();

  /**
   * The fresh stored weigh-in the session holds right now ("W kg at T"), so the
   * log can say when a later reading takes its place in the hold and it is not
   * exported (#331).
   */
  private heldStoredWeighIn: string | null = null;

  /**
   * High-water mark of the stored weigh-ins reported, in scale-epoch seconds,
   * persisted by the runtime across restarts (dedupMark). Records are judged
   * against the mark as it stood when the session started: a batch need not
   * arrive in time order, and an earlier record behind a later one is still new.
   */
  private storedMark = 0;
  private storedMarkAtSessionStart = 0;

  /**
   * The last few live results this adapter published, by weight and the time
   * of their 0x16. Kept across sessions: they are what a stored record or a
   * repeated result block in a later session is compared with.
   */
  private readonly recentLiveResults: { weight: number; atMs: number }[] = [];

  /**
   * Hold the link from the 19-byte dialect's stable weight until its 0x16
   * (D037), and on a fresh stored weigh-in, so a live result in the same
   * session replaces it. Undefined otherwise and on every other dialect, so
   * nothing else this adapter returns is held.
   */
  get completionHoldMs(): number | undefined {
    return this.live20Weight !== null || this.storedHoldArmed
      ? NINETEEN_BYTE_RESULT_HOLD_MS
      : undefined;
  }

  /** Only the 19-byte stable weight and fresh stored weigh-ins are provisional. */
  isFinal(reading: ScaleReading): boolean {
    return !this.provisionalReadings.has(reading);
  }

  /**
   * True from the 19-byte stable weight until 0x16. HoldTimer asks only when a
   * window ends, so this has to cover the scale's whole BIA, not just the
   * result block: a BIA that outlasts the window then gets the extension steps
   * instead of a cut link and a reconnect that sends START into it.
   */
  isCompositionPending(): boolean {
    return this.live20Weight !== null && !this.live20ResultSeen;
  }

  /**
   * Whether a completed-weigh-in result frame (0xB4/0xB1) has already produced a
   * reading this session. The scale repeats the 0xB4 frame ~3x and then sends
   * the 0xB1 records, all describing the one weigh-in, so the reading is emitted
   * exactly once and the repeats are suppressed (#235).
   */
  private extendedResultEmitted = false;

  /**
   * Timestamp (Date.now()) of the first stable R1=R2=0 frame seen on a
   * long-frame variant. After IMPEDANCE_GRACE_MS without an impedance frame,
   * subsequent R1=R2=0 stable frames are accepted.
   */
  private firstStableNoImpedanceAt: number | null = null;

  /**
   * Scale-epoch seconds (2000-epoch) captured when the connection opened, used
   * as the freshness reference for 0x23 stored records. Falls back to the
   * current time when a record arrives before onConnected ran.
   */
  private sessionStartedScaleSeconds: number | null = null;

  /** Deduplication guards: prevent duplicate state machine responses. */
  private configSent = false;
  private timeSyncSent = false;
  private historyResponseSent = false;

  /** Fallback timer handle for cancellation when state machine fires normally. */
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  /** Send the undecoded 0xA4 prelude after START (`ble.qn_a4_prelude`, #331). */
  private a4PreludeEnabled = false;

  /** Send the 10-byte 0x13 config frame (`ble.qn_config_long`, #331). */
  private configLong = false;

  /** Send the 9-byte 0x20 time sync (`ble.qn_time_sync_long`, #331). */
  private timeSyncLong = false;

  /**
   * Send the end-of-measurement 0x1F after the 0x16 of a complete 19-byte
   * result block, as the vendor's published SDK does (`ble.qn_result_ack`,
   * #331). Off by default: what it changes on the scale is not known yet.
   */
  private forcedResultAck = false;

  /** Number of 0x22 stored-data re-queries sent this session. */
  private storedQueryAttempts = 0;

  /** Timer handle for the pending stored-data re-query. */
  private storedRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The advertisement this session matched on flags the resistance as
   * scrambled (#461, see SCRAMBLE_FLAG_BIT). Set in onConnected, before
   * anything is written, so it is in place before any frame with a resistance
   * can arrive: the scale sends those only after the handshake.
   */
  private resistanceScrambled = false;

  /** One "unscrambled impedance is not a body" warning per session (#461). */
  private unscrambledImplausibleWarned = false;

  /** Receive the configured display unit from the composition root (#269). */
  configure(opts: AdapterRuntimeConfig): void {
    if (opts.displayUnit) this.displayUnit = opts.displayUnit;
    this.forcedProtocolType = opts.qnProtocolByte ?? null;
    this.forcedReportByte = opts.qnReportByte ?? null;
    if (this.forcedReportByte !== null) {
      bleLog.warn(
        `QN: ble.qn_report_byte is set (${this.forcedReportByte}), so every QN session sends ` +
          'the frame that deletes the user slots its bits select on the scale. Remove the ' +
          'setting unless your scale stopped reporting without it (#461).',
      );
    }
    this.forcedWeightAck = opts.qnWeightAck ?? null;
    this.forcedUserKey = opts.qnUserKey ?? null;
    this.a4PreludeEnabled = opts.qnA4Prelude === true;
    this.timeSyncLong = opts.qnTimeSyncLong === true;
    this.configLong = opts.qnConfigLong === true;
    this.forcedResultAck = opts.qnResultAck === true;
    this.userWeights = opts.userWeights ?? [];
  }

  /** 0x13 config unit bit: 0x01 kg, 0x02 lb, 0x08 stone (QN protocol). */
  private unitFlag(): number {
    if (this.displayUnit === 'st') return 0x08;
    return this.displayUnit === 'lbs' ? 0x02 : 0x01;
  }

  /** Write to FFF2 (write char), fall back to FFE3 (Type 1). */
  private async writeCmd(data: number[]): Promise<void> {
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
    this.ae01Chain = this.ae01Chain.then(run, run);
    return this.ae01Chain;
  }

  /**
   * Clear every per-session field BEFORE anything is subscribed (#394, #406).
   *
   * This used to live in onConnected(), which is too late on this adapter: QN
   * is a MultiCharNotify adapter, and subscribeAndInit enables every notify
   * binding before it awaits init, so a frame can be parsed against the
   * PREVIOUS session's seenProtocolType, weightScaleFactor or configSent. That
   * is the exact ordering the onSessionStart contract exists for.
   *
   * `this.ctx` stays in onConnected: it is the one thing that does not exist
   * until then.
   */
  onSessionStart(): void {
    this.sessionGeneration += 1;
    this.seenProtocolType = this.forcedProtocolType ?? 0x00;
    this.weightScaleFactor = 100;
    this.scaleFactorKnown = false;
    this.divisorDoubtWarned = false;
    this.hasAe00 = false;
    this.ae02Subscribe = null;
    this.ae00ChallengeSeen = false;
    this.ae01Chain = Promise.resolve();
    this.ae00ResponsesSent = 0;
    this.isLongFrameVariant = false;
    this.isExtendedLongFrame = false;
    this.isNineteenByteInfo = false;
    this.isEighteenByteInfo = false;
    this.appProfileSequence = null;
    this.visitRefusedLogged = false;
    this.extendedResultEmitted = false;
    this.firstStableNoImpedanceAt = null;
    this.sessionStartedScaleSeconds = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
    this.anchorFallbackWarned = false;
    this.twentyByteFrameLogged = false;
    this.live20Seen = false;
    this.live20Weight = null;
    this.live20ResultSeen = false;
    this.live20Block = [];
    this.live20C15 = null;
    this.visitSent = null;
    this.visitReply = null;
    this.readyValueType = null;
    this.measuredAfterVisit = false;
    this.a4PreludeSent = false;
    this.visitAcceptedAtMs = null;
    this.storedQuerySentAtMs = null;
    this.queryAnswered = false;
    this.answerAfterVisitMs = null;
    this.live20Measured = false;
    this.live20Replayed = false;
    this.storedParts = [];
    this.storedHoldArmed = false;
    this.heldStoredWeighIn = null;
    this.storedEmitted.clear();
    this.storedJudged.clear();
    this.storedMarkAtSessionStart = this.storedMark;
    this.configSent = false;
    this.timeSyncSent = false;
    this.historyResponseSent = false;
    this.storedQueryAttempts = 0;
    this.resistanceScrambled = false;
    this.unscrambledImplausibleWarned = false;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.storedRetryTimer) {
      clearTimeout(this.storedRetryTimer);
      this.storedRetryTimer = null;
    }
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
    if (this.sessionStartedScaleSeconds === null) {
      this.sessionStartedScaleSeconds = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
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

    // Try subscribing to AE02 (newer firmware detection).
    // NOTE: on Linux, 0x12 may arrive before this completes. The state machine
    // handlers do NOT depend on hasAe00; they always attempt AE01 writes
    // (which fail silently on older firmware without AE00). Both paths go
    // through the same memoised helper so they cannot subscribe twice (#75).
    const hasAe02 = await this.ensureAe02Subscribed();

    if (!hasAe02) {
      // Older firmware: send legacy unlock variants on FFF2.
      // These work with Renpho, Sencor, and generic QN-Scale devices
      // that don't use the notification-driven handshake.
      // The second unlock is the 0x10 config variant whose byte[3] is the unit
      // flag; honour the configured unit and recompute its checksum (#269). The
      // first unlock is a different 0x01 subcommand and is left as-is.
      const config = [
        0x13,
        0x09,
        // Stay deterministic when the override is unset: seenProtocolType can be
        // seeded by a 0x12 that races the AE02 subscribe on native BLE, and this
        // fixed frame must not depend on that timing. The override, when set, is
        // applied before onConnected runs, so every targeted case is unchanged.
        this.forcedProtocolType ?? 0x00,
        this.unitFlag(),
        0x10,
        0x00,
        0x00,
        0x00,
        0x00,
      ];
      config[8] = config.reduce((a, b) => a + b, 0) & 0xff;
      const unlocks = [[0x13, 0x09, 0x00, 0x01, 0x01, 0x02], config];
      for (const cmd of unlocks) {
        await this.writeCmd(cmd);
      }
    }

    // Fallback timer for both firmware paths. If the state machine fires
    // normally (0x12 received), handleScaleInfo cancels this timer.
    // If 0x12 is lost (Linux BlueZ race) or never sent (older firmware
    // that only responds to unlocks), the fallback runs the full handshake.
    if (!this.configSent) {
      this.fallbackTimer = setTimeout(() => void this.runFallbackHandshake(), 2000);
    }
  }

  /**
   * Fallback handshake for Linux node-ble where 0x12 may be lost.
   * Sends AE01 init first, then the full handshake sequence.
   */
  private async runFallbackHandshake(): Promise<void> {
    if (!this.ctx) return;
    this.fallbackTimer = null;
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const gen = this.sessionGeneration;

    if (!this.configSent) {
      this.seenProtocolType = this.forcedProtocolType ?? 0xff;
      bleLog.debug(
        `QN: fallback: no 0x12 received, running handshake with ` +
          `proto=0x${this.seenProtocolType.toString(16).padStart(2, '0')}`,
      );
      // handleScaleInfo sends AE01 init + 0x13 config
      await this.handleScaleInfo();
      await wait(500);
      if (gen !== this.sessionGeneration) return;
    }

    if (!this.timeSyncSent) {
      bleLog.debug('QN: fallback: sending time sync + profile');
      await this.handleReady();
      await wait(500);
      if (gen !== this.sessionGeneration) return;
    }

    if (!this.historyResponseSent) {
      bleLog.debug('QN: fallback: sending the profile frame + start');
      await this.handleConfigRequest();
    }
  }

  /** Read the impedance flag from the session's advertisement (#461). */
  private readImpedanceFlag(ctx: ConnectionContext): void {
    const traits = qnAdvertTraits(ctx.manufacturerData, ctx.deviceAddress);
    this.resistanceScrambled = traits?.scrambled === true;
    if (!ctx.manufacturerData) {
      bleLog.debug('QN: no advertisement for this session, impedance read as sent (#461)');
    } else if (!traits) {
      bleLog.debug(
        `QN: advertisement (company 0x${ctx.manufacturerData.id.toString(16).padStart(4, '0')}) ` +
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
   * (see SCRAMBLE_FLAG_BIT). Untouched otherwise, so a scale that does not set
   * the flag gets exactly the bytes it sent.
   */
  private resistance(raw: number): number {
    if (!this.resistanceScrambled || raw === 0) return raw;
    const unscrambled = decryptQnResistance(raw);
    const value = unscrambled >= NO_CONTACT_RESISTANCE ? 0 : unscrambled;
    bleLog.debug(`QN: impedance ${raw} unscrambled to ${value} Ohm (#461)`);
    if (value !== 0 && !isPlausibleImpedance(value) && !this.unscrambledImplausibleWarned) {
      this.unscrambledImplausibleWarned = true;
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
    if (this.hasAe00) return true;
    if (!this.ae02Subscribe) {
      this.ae02Subscribe = ctx.subscribe(CHR_AE02).then(
        () => {
          this.hasAe00 = true;
          bleLog.debug('QN: subscribed to AE02');
          return true;
        },
        () => {
          this.ae02Subscribe = null;
          bleLog.debug('QN: AE02 not available (older firmware)');
          return false;
        },
      );
    }
    return this.ae02Subscribe;
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
    if (this.ae00ResponsesSent >= MAX_AE00_RESPONSES) {
      if (this.ae00ResponsesSent === MAX_AE00_RESPONSES) {
        this.ae00ResponsesSent++;
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
    this.ae00ResponsesSent++;
    let frame: Buffer;
    try {
      frame = jieliAuthResponseFrame(data);
    } catch (e: unknown) {
      bleLog.debug(`QN: AE00 challenge response could not be computed: ${errMsg(e)}`);
      return;
    }
    if (!this.ae00ChallengeSeen) {
      this.ae00ChallengeSeen = true;
      bleLog.debug('QN: AE00 challenge received, answering on AE01 (#235)');
    }
    void this.writeAe01([...frame]);
  }

  /**
   * Parse QN vendor notifications.
   *
   * Implements a notification-driven state machine for the handshake:
   *   0x12 (scale info) -> AE01 init + 0x13 config with echoed protocol type
   *   0x14 (ready ACK)  -> 0x20 time sync + A2 user profile + "pass" auth
   *                        (no A2 on the 19-byte dialect with ble.qn_weight_ack,
   *                        nor on the 18- and 19-byte ones with ble.qn_user_key)
   *   0x21 (config req)  -> A00D profile frame + 0x22 start
   *   0x10 (weight)      -> parse weight (original or ES-30M format)
   *                        (19-byte dialect: 20-byte stream, weight held until
   *                        its 0x16, nothing written back, D037; with
   *                        ble.qn_result_ack a 0x1F after the 0x16, D059)
   *
   * State machine writes are fire-and-forget (async, not awaited) so they
   * don't block the synchronous parseNotification return.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3) return null;

    bleLog.debug(`QN RAW (${data.length}B): [${hex(data)}]`);

    const opcode = data[0];

    // 0x12: scale info, update weight scale factor and capture protocol type
    if (opcode === 0x12 && data.length > 10) {
      // Renpho ES-26M (and similar newer firmware) sends an 18-byte 0x12
      // frame where byte[1] == packet length and bytes [2-7] contain the
      // MAC address. The classic QN format has ~11 bytes with protocol
      // type at [2] and weight scale flag at [10].
      if (data.length >= 18 && data[1] === data.length) {
        // Long frame. Every captured one carries 0xff at byte[2] whatever its
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
        //
        // The choice cannot be corrected at runtime: a scale on the wrong byte
        // acknowledges everything and stays silent, which is exactly what a
        // scale nobody is standing on does.
        this.isLongFrameVariant = true;
        this.isExtendedLongFrame = data.length >= EXTENDED_INFO_FRAME_LEN;
        this.isNineteenByteInfo = data.length === PROTO_ECHO_MIN_INFO_FRAME_LEN;
        this.isEighteenByteInfo = data.length === 18;
        if (this.wantsAppProfileSequence() && this.appProfileSequence === false) {
          bleLog.debug(
            `QN: ${data.length}-byte 0x12 after the handshake already chose openScale's frames; ` +
              'the profile frame stays as sent (#331)',
          );
        }
        const byLength = data.length >= PROTO_ECHO_MIN_INFO_FRAME_LEN ? data[2] : LEGACY_PROTO_TYPE;
        this.seenProtocolType = this.forcedProtocolType ?? byLength;
        this.weightScaleFactor = 10;
      } else {
        // Classic short frame
        this.isLongFrameVariant = false;
        this.isExtendedLongFrame = false;
        this.isNineteenByteInfo = false;
        this.isEighteenByteInfo = false;
        this.seenProtocolType = this.forcedProtocolType ?? data[2];
        this.weightScaleFactor = data[10] === 1 ? 100 : 10;
      }
      this.scaleFactorKnown = true;
      const dialect = this.isExtendedLongFrame
        ? 'extended'
        : this.isLongFrameVariant
          ? 'es26m'
          : 'classic';
      // The byte the frame actually carried, for triage. Not seenProtocolType:
      // on the 18-byte variant that is forced to 0x00 for the handshake, but the
      // log should still report the 0xff the scale sent.
      const reported = data[2];
      const forcedNote =
        this.forcedProtocolType !== null && this.forcedProtocolType !== reported
          ? ` (forced, scale reported 0x${reported.toString(16).padStart(2, '0')})`
          : '';
      bleLog.debug(
        `QN: scale info (${data.length}B, dialect=${dialect}), ` +
          `factor=${this.weightScaleFactor}, ` +
          `proto=0x${this.seenProtocolType.toString(16).padStart(2, '0')}${forcedNote}`,
      );
      void this.handleScaleInfo();
      return null;
    }

    // 0x14: ready/config ACK, respond with time sync + user profile
    if (opcode === 0x14) {
      bleLog.debug('QN: ready frame, sending time sync and the ready-time frames');
      // Bit 0 of [3]: the scale reports muscle and bone as percentages (#331).
      if (data.length >= 4 && hasValidSumChecksum(data)) this.readyValueType = data[3] & 0x01;
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
      if (
        opcode === 0xa1 &&
        data.length === 6 &&
        data[1] === 0x06 &&
        data[2] === 0x02 &&
        hasValidSumChecksum(data)
      ) {
        this.visitReply = { slot: data[3], ok: data[4] === 0x01 };
        if (this.visitReply.ok && this.visitAcceptedAtMs === null) {
          this.visitAcceptedAtMs = Date.now();
        }
        bleLog.debug(
          `QN: the scale ${this.visitReply.ok ? 'accepted' : 'did not accept'} the profile ` +
            `for user slot ${data[3]} (#331)`,
        );
        // Only a frame sent with the option gets this: an install without it
        // sees the same log as before (#463). Info, not a warning, because the
        // weigh-in can still arrive, from the scale's memory.
        if (
          !this.visitReply.ok &&
          this.visitSent !== null &&
          this.forcedUserKey !== null &&
          !this.visitRefusedLogged
        ) {
          this.visitRefusedLogged = true;
          // The key is the leading explanation, not a confirmed one, so the
          // line says "most likely".
          const sentKey = (this.visitSent.frame[4] << 8) | this.visitSent.frame[5];
          bleLog.info(
            `QN: the scale refused the profile frame sent with ble.qn_user_key ${sentKey} ` +
              `for user slot ${data[3]}. Most likely the vendor app set up that slot with ` +
              'another key, or never set it up. Check ble.qn_user_key, and that the first ' +
              'user in config.yaml is the first user in the vendor app (#463).',
          );
        }
      }
      return null;
    }

    // 0x23: stored measurement record returned after the 0x22 history query.
    // V10 Renpho / ES-CS20M firmware delivers the weigh-in here, not reliably
    // via live 0x10 frames (#213 / #75). Layout in decodeStoredRecord: R50 and
    // R500 big-endian at [12..13] and [14..15], as the vendor SDK reads them
    // (#461), not openScale's little-endian [13..14] and [15..16].
    //
    // A session that positively identified a classic scale (a short 0x12)
    // keeps the old offsets. Classic firmware has a different 0x23 layout
    // altogether, the record time included, so its records fail the freshness
    // check below as stale; changing how they are read is a separate change
    // with its own evidence. A session without any 0x12 reads the long layout,
    // which is what every real record we have uses.
    //
    // A record from up to MAX_STORED_RECORD_AGE_SEC before the session is this
    // session's weigh-in and ends it, without a time. An older one is the
    // scale's memory: on the 18-byte dialect it can go out as history
    // (eighteenByteStoredWeighIn, #463), elsewhere it is logged and not read.
    if (opcode === 0x23) {
      // The 19-byte dialect sends 8-electrode records in their own layout and
      // never gets a re-query: the scale answers our one 0x22 once it is done
      // measuring, and a second 0x22 is the same request again (#331).
      if (this.isNineteenByteInfo) return this.parseEightStoredPart(data);
      // The 18-byte scale answers our 0x22 while it is still measuring (#463),
      // so the answer is logged here as on the 19-byte dialect; the line it
      // sets off on the live path below needs it.
      if (this.isEighteenByteInfo) this.noteStoredQueryAnswer();
      const record = data.length < 17 ? null : decodeStoredRecord(data);
      if (!record) {
        bleLog.debug(
          `QN: 0x23 too short for a stored record (${data.length} bytes): [${hex(data)}] (#463)`,
        );
        this.scheduleStoredDataRetry();
        return null;
      }
      const { weight, recordSeconds } = record;
      const classic = this.scaleFactorKnown && !this.isLongFrameVariant;
      const sessionSeconds =
        this.sessionStartedScaleSeconds ?? Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
      if (weight <= 5 || weight >= 300) {
        this.logUnreadStoredRecord(data, record, sessionSeconds, 'out of range');
        this.scheduleStoredDataRetry();
        return null;
      }
      if (recordSeconds + MAX_STORED_RECORD_AGE_SEC < sessionSeconds) {
        // The re-query stays: V10 firmware may save the fresh weigh-in only a
        // moment after handing over an old one (#213 / #75).
        this.scheduleStoredDataRetry();
        if (this.isEighteenByteInfo) return this.eighteenByteStoredWeighIn(data, record);
        this.logUnreadStoredRecord(data, record, sessionSeconds, 'old');
        return null;
      }
      const r1 = classic ? data.readUInt16LE(13) : record.r50;
      const r2 = classic ? data.readUInt16LE(15) : record.r500;
      if (this.storedRetryTimer) {
        clearTimeout(this.storedRetryTimer);
        this.storedRetryTimer = null;
      }
      bleLog.debug(
        `QN: stored 0x23 reading ${weight}kg, R50 ${r1} / R500 ${r2}` +
          (classic ? ' (classic offsets)' : ''),
      );
      const fresh: ScaleReading = { weight, impedance: this.resistance(r1 > 0 ? r1 : r2) };
      // This session's weigh-in, so a later session that is handed the same
      // record as history knows it went out already (#463).
      if (this.isEighteenByteInfo && this.isComplete(fresh)) this.rememberLiveResult(weight);
      return fresh;
    }

    // Extended-dialect completed-weigh-in result frames (#235). Gated to the
    // 20-byte dialect so no other QN variant is touched. On this firmware the
    // scale never streams 0x10 after a full body-composition weigh-in; it sends
    // these 0xB4/0xB1 frames instead, which were dropped at the ignore branch
    // below, so nothing reached MQTT even though the whole handshake succeeded.
    if (this.isExtendedLongFrame && (opcode === RESULT_OPCODE_B4 || opcode === RESULT_OPCODE_B1)) {
      const reading = this.parseExtendedResultFrame(data);
      // Return null (not fall through) for the non-weight parts of the burst —
      // the repeated 0xB4s, the 0xB1 03 02/03 records — so they are consumed
      // quietly instead of re-logged as ignored frames.
      return reading;
    }

    // The 19-byte dialect's weigh-in stream (#331, D037). Gated on the dialect
    // explicitly: the GE CS 10 G's live frame has the identical 20-byte shape
    // and stays on the logged-and-dropped path below. 0x15/0x16 only count
    // after the stream, so elsewhere they still reach the ignore branch.
    if (this.isNineteenByteInfo) {
      if (opcode === 0x10 && data.length === LIVE20_FRAME_LEN && data[1] === LIVE20_FRAME_LEN) {
        return this.parseNineteenByteLiveFrame(data);
      }
      if (
        (opcode === STORED_OPCODE_COMPOSITION || opcode === STORED_OPCODE_DONE) &&
        data.length >= RESULT16_FRAME_LEN &&
        data[2] === 0xff
      ) {
        return this.parseEightStoredTail(data);
      }
      if (
        this.live20Seen &&
        (opcode === RESULT16_OPCODE_COMPOSITION || opcode === RESULT16_OPCODE_DONE) &&
        data.length === RESULT16_FRAME_LEN &&
        data[1] === RESULT16_FRAME_LEN
      ) {
        return this.parseNineteenByteResultFrame(data);
      }
    }

    // 0x10: live weight frame.
    // Anything else lands here and used to be discarded in silence, which is why
    // #75 read as a decode bug: the AE00 challenge frames the scale sends on AE02
    // reached this parser through a UUID-blind path and vanished without a trace.
    // parseCharNotification now intercepts the challenge, but any other AE02
    // frame still falls through to here, so log it and the next reporter log
    // carries the evidence.
    if (opcode !== 0x10 || data.length < 10) {
      bleLog.debug(
        `QN: ignoring frame opcode=0x${opcode.toString(16).padStart(2, '0')} ` +
          `len=${data.length} hex=${Buffer.from(data).toString('hex')}`,
      );
      return null;
    }

    let stable: boolean;
    let rawWeight: number;
    let r1: number;
    let r2: number;

    // ES-30M format: byte[4] is a state flag (0x00/0x01/0x02) instead of weight LSB.
    // Detected when weightScaleFactor=10, byte[4] <= 0x02, and frame has enough bytes.
    // In the original format, byte[4] is the low byte of the 16-bit weight, which is
    // almost always > 0x02 for adult weights (> 25.5 kg raw value with factor 10).
    const isEs30m = data.length >= 11 && data[4] <= 0x02 && this.weightScaleFactor === 10;

    if (isEs30m) {
      // ES-30M: [4]=state (0x02=stable), [5-6]=weight, [7-8]=R1, [9-10]=R2
      stable = data[4] === 0x02;
      rawWeight = data.readUInt16BE(5);
      r1 = data.readUInt16BE(7);
      r2 = data.readUInt16BE(9);

      if (stable && r1 === 0 && r2 === 0) {
        if (!this.isLongFrameVariant) {
          // Classic ES-30M: always skip, impedance frame follows.
          return null;
        }
        // Long-frame variant (ES-26M): accept after grace period.
        // The first stable R1=R2=0 frame starts a timer. If no impedance
        // frame arrives within IMPEDANCE_GRACE_MS, subsequent R1=R2=0
        // frames are accepted. This prevents losing BIA data if the
        // scale sends a transient R1=R2=0 before the impedance frame.
        const now = Date.now();
        if (this.firstStableNoImpedanceAt === null) {
          this.firstStableNoImpedanceAt = now;
          return null;
        }
        if (now - this.firstStableNoImpedanceAt < IMPEDANCE_GRACE_MS) {
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

    // The live 0x10 frame every capture of the long dialects actually shows is
    // 20 bytes, with the weight as a big-endian u16 /100 at [5..6]:
    //
    //   10 14 01 00 11 1d c4 00 .. 00 17   Arboleaf, 76.20 kg (#331)
    //   10 14 01 00 11 22 79 00 .. 00 d1   Arboleaf, 88.25 kg (#331)
    //   10 14 01 00 11 1e be 00 .. 00 12   GE CS 10 G, 78.70 kg (#235)
    //
    // On the 19-byte dialect the frame is decoded above (parseNineteenByteLiveFrame)
    // and never gets here. Elsewhere neither branch above reads it. [4] is 0x11,
    // so it falls into the original layout, which takes the weight from [3..4]
    // and gets 0x0011. Whether the GE frame shares the Arboleaf status and part
    // bytes is not known, so there it is still logged once per session with the
    // weight where the captures put it.
    const twentyByteLive = data.length === 20 && data[1] === 0x14;
    if (twentyByteLive && !this.twentyByteFrameLogged) {
      this.twentyByteFrameLogged = true;
      bleLog.debug(
        `QN: 20-byte live frame, weight ${data.readUInt16BE(5) / 100} kg at [5..6], ` +
          'not echoed and not yet decoded (#331)',
      );
    }

    // Nothing the original layout reads is right for this shape. Its weight is
    // 0x0011, and its stability byte [5] is the real weight's high byte, so a
    // frame between 2.56 and 5.11 kg, which a step-off ramps through, read as a
    // stable 1.7 kg (0.17 at factor 100) and was acknowledged with 0x1F. At
    // exactly 2.56 kg ([6] zero, so no impedance either) it passed isComplete
    // and ended the session, to be exported as the weigh-in. Stop here until
    // the layout is decoded. A 20-byte frame that takes the ES-30M branch reads
    // its weight from [5..6] and is left as it was.
    if (twentyByteLive && !isEs30m) return null;

    // Per-frame weight echo (`ble.qn_weight_ack`, on by default on the 20-byte
    // extended dialect). One reading of the GE CS 10 G capture has the vendor
    // app answering live 0x10 frames with an A2 carrying that frame's own
    // weight bytes (`... 1e be` -> `a2 06 01 1e be 85`); a later reading of the
    // same capture disagrees, so this is unconfirmed. No hardware run has shown
    // a scale needing it either: the completed GE weigh-ins predate the echo and
    // never delivered a 0x10 to this adapter at all, their weight came from
    // 0xB1 (#235).
    //
    // Never sent for the 20-byte layout above. Read through the original layout
    // its rawWeight is 0x0011, so the echo handed the scale `a2 06 01 00 11 ba`,
    // i.e. 0.17 kg, on every live frame; that path returns above now, and the
    // 19-byte dialect's decode echoes nothing, since its complete weigh-ins
    // arrived without an echo; its only write is the 0x1F after the result
    // block's 0x16 with `ble.qn_result_ack` (#331). Whether the app echoes
    // this shape at all is not known, so a 20-byte frame on the ES-30M branch is
    // not echoed either. The 14-byte ES-30M and 10-byte classic frames keep it:
    // their offsets are right. Sent before the stability gate, fire and forget,
    // like the 0x1F stable ACK below.
    if (this.weightAckEnabled() && this.ctx && !twentyByteLive) {
      void this.writeCmd(buildA2Frame(rawWeight));
    }

    if (!stable) return null;

    const weight = this.resolveWeight(rawWeight);
    if (weight === null) return null;

    // R1 (primary BIA resistance) and R2 (secondary)
    const impedance = this.resistance(r1 > 0 ? r1 : r2);

    // Reset the impedance grace timer on successful reading
    this.firstStableNoImpedanceAt = null;

    // Acknowledge stable reading (0x1F) so the scale knows we received it
    if (this.ctx) {
      const ackCmd = [0x1f, 0x05, this.seenProtocolType, 0x10, 0x00];
      ackCmd[4] = ackCmd.reduce((a, b) => a + b, 0) & 0xff;
      void this.writeCmd(ackCmd);
    }

    const reading: ScaleReading = { weight, impedance };
    // A stored weigh-in the scale sends after the session settled on this one
    // is never parsed (#463). The 18-byte scale answers our 0x22 within a
    // second, so this is rare, and without the line it would be invisible.
    if (
      this.isEighteenByteInfo &&
      this.storedQuerySentAtMs !== null &&
      !this.queryAnswered &&
      this.isComplete(reading)
    ) {
      bleLog.debug(
        'QN: the weigh-in ends the session before the scale answered the stored-record ' +
          'query; a stored weigh-in it sends after this is not read (#463)',
      );
    }
    if (this.isEighteenByteInfo && this.isComplete(reading)) this.rememberLiveResult(weight);
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
   *   ruled out, and if only one is left it is the weight. This is the ES-26M
   *   case, whose 0x12 implies /10 and whose captured frames read 978.5 kg so;
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
    const primary = rawWeight / this.weightScaleFactor;
    if (
      this.scaleFactorKnown &&
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

    if (!this.divisorDoubtWarned) {
      this.divisorDoubtWarned = true;
      const why = this.scaleFactorKnown
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
   * Decode an extended-dialect completed-weigh-in result frame (#235).
   *
   * Accepts the consolidated 0xB4 (weight at [11]) or, as a fallback, the first
   * multi-part 0xB1 03 01 record (weight at [5]). Returns a weight-only reading
   * (impedance 0 — see RESULT_OPCODE_* for why the raw channels are not used
   * yet), or null when the frame is not a recognised result frame, fails its
   * trailing sum checksum, carries an out-of-range weight, or a reading was
   * already emitted this session.
   */
  private parseExtendedResultFrame(data: Buffer): ScaleReading | null {
    if (this.extendedResultEmitted) return null;

    // Standard QN trailing checksum, verified against every captured 0xB4/0xB1
    // frame; a cheap guard against a truncated or mis-framed notification being
    // read as a weight.
    if (!hasValidSumChecksum(data)) return null;

    let rawWeight: number | null = null;
    if (data[0] === RESULT_OPCODE_B1 && data.length >= 7 && data[2] === 0x03 && data[3] === 0x01) {
      // Live sweep record.
      rawWeight = data.readUInt16LE(5);
    } else if (
      data[0] === RESULT_OPCODE_B4 &&
      data.length >= 13 &&
      data[2] === 0x04 &&
      data[3] === 0x01
    ) {
      // History record: usable only when it was written DURING this session.
      //
      // Deliberately stricter than the 0x23 stored-record window, which accepts
      // a record from the minute or so before the connect. These scales keep
      // advertising for a while after a weigh-in, so a proxy transport
      // reconnects seconds later and finds the just-finished measurement still
      // sitting in history; a backward-looking window would republish it as a
      // second weigh-in. A record stamped after the session opened can only be
      // the one being taken now. The tolerance absorbs the offset between the
      // scale's clock and ours, which the 0x20 time sync sets each session.
      const recordSeconds = data.readUInt32LE(7);
      const sessionSeconds =
        this.sessionStartedScaleSeconds ?? Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
      if (recordSeconds + RESULT_RECORD_CLOCK_TOLERANCE_SEC < sessionSeconds) {
        bleLog.debug(
          `QN: ignoring 0xB4 history record (${data.readUInt16LE(11) / 100}kg, written ` +
            `${sessionSeconds - recordSeconds}s before this session began); ` +
            'waiting for the live 0xB1 #235',
        );
        return null;
      }
      rawWeight = data.readUInt16LE(11);
    }
    if (rawWeight === null) return null;

    const weight = rawWeight / 100;
    if (weight <= RESULT_MIN_WEIGHT_KG || weight >= RESULT_MAX_WEIGHT_KG) return null;

    this.extendedResultEmitted = true;
    bleLog.debug(
      `QN: extended result 0x${data[0].toString(16)} decoded ${weight}kg ` +
        '(impedance sweep not yet calibrated, emitting weight-only) #235',
    );
    return { weight, impedance: 0 };
  }

  /**
   * One 20-byte 0x10 frame of the 19-byte dialect (#331, D037); layout at
   * LIVE20_FRAME_LEN. The stable weight comes back provisional, so the session
   * holds the link through the scale's BIA (isFinal, completionHoldMs). The
   * result block's three parts are kept for 0x16.
   *
   * Writes nothing: the first logs of a complete weigh-in got there without a
   * 0x1F or an A2 echo. The vendor's published SDK answers only the block's
   * 0x16, which `ble.qn_result_ack` copies (parseNineteenByteResultFrame).
   */
  private parseNineteenByteLiveFrame(data: Buffer): ScaleReading | null {
    if (!hasValidSumChecksum(data)) {
      bleLog.debug('QN: 20-byte frame with a bad checksum dropped (#331)');
      return null;
    }
    this.live20Seen = true;

    const total = data[4] >> 4;
    const index = data[4] & 0x0f;
    if (total === 0 || index === 0 || index > total) {
      bleLog.debug(
        `QN: 20-byte frame with part byte 0x${data[4].toString(16).padStart(2, '0')} dropped (#331)`,
      );
      return null;
    }
    // A continuation part's [2..3] is payload, so the checks below are for the
    // first part only.
    if (index > 1) {
      if (total === 3 && this.live20Block.length === index - 1) {
        this.live20Block.push(Buffer.from(data));
      } else {
        this.live20Block = [];
      }
      bleLog.debug(`QN: 20-byte result part ${index}/${total} (#331)`);
      return null;
    }

    // [2] is the scale's user slot (per the vendor's published SDK), not a
    // unit: the weight is kg x100 whatever it says. Every slot's weight is
    // read; only the slot this session's profile went to can have the scale's
    // own body composition used (computeMetrics).
    const slot = data[2];
    const status = data[3];
    const weight = data.readUInt16BE(5) / 100;
    if (!this.twentyByteFrameLogged) {
      this.twentyByteFrameLogged = true;
      bleLog.debug(
        `QN: 20-byte live frame, weight ${weight} kg at [5..6], user slot ${slot}, ` +
          `status 0x${status.toString(16).padStart(2, '0')} (19-byte dialect, #331)`,
      );
    }
    if (status === LIVE20_STATUS_MEASURING || status === LIVE20_STATUS_STABLE) {
      this.live20Measured = true;
      if (this.visitReply?.ok === true) this.measuredAfterVisit = true;
    }
    if (status === LIVE20_STATUS_MEASURING) return null;
    if (status !== LIVE20_STATUS_STABLE && status !== LIVE20_STATUS_RESULT) {
      bleLog.debug(`QN: 20-byte frame with unknown status 0x${status.toString(16)} dropped (#331)`);
      return null;
    }
    if (weight <= RESULT_MIN_WEIGHT_KG || weight >= RESULT_MAX_WEIGHT_KG) {
      bleLog.debug(`QN: 20-byte stable weight ${weight} kg out of range, dropped (#331)`);
      return null;
    }

    // The result block is the scale's first answer to the 0x22 when no 0x23
    // came before it, so it is timed before the check below reads the result.
    if (status === LIVE20_STATUS_RESULT) this.noteStoredQueryAnswer();

    // Collected before the repeat check below, so a repeated block still gets
    // the `ble.qn_result_ack` answer at its 0x16, as the vendor's SDK gives it.
    // Nothing else reads a repeated block: its 0x16 publishes nothing. A 0x15
    // from before this first part belongs to an earlier block (a repeated one
    // leaves the session open), so it is dropped, as the SDK drops it here.
    if (status === LIVE20_STATUS_RESULT) {
      this.live20Block = total === 3 ? [Buffer.from(data)] : [];
      this.live20C15 = null;
    }

    // A result block with no measurement before it in this session (no live
    // frame, and a first answer to the 0x22 too soon to follow one) is a
    // weigh-in the scale finished before we connected. When it repeats a
    // result already published, it is that weigh-in handed over again after a
    // reconnect, not a second one (#331).
    if (status === LIVE20_STATUS_RESULT && !this.live20Measured && this.live20Weight === null) {
      const repeated = this.recentLiveResults.find(
        (r) =>
          Math.abs(r.weight - weight) <= LIVE_MATCH_WEIGHT_KG &&
          Date.now() - r.atMs <= LIVE_REPLAY_WINDOW_MS,
      );
      if (repeated) {
        this.live20Replayed = true;
        bleLog.debug(
          `QN: result block of ${weight} kg came with no measurement in this session and ` +
            `repeats the one reported at ${new Date(repeated.atMs).toISOString()}, dropped (#331)`,
        );
        return null;
      }
    }

    // The result block's first part (status 0x02) repeats the weight. Returning
    // it too keeps the hold armed if the single stable frame was lost on a proxy
    // link; once armed, a second held reading does not move the window.
    this.live20Weight = weight;
    this.replaceHeldStoredWeighIn(`the weigh-in in progress (${weight} kg)`);
    const reading: ScaleReading = { weight, impedance: 0 };
    this.provisionalReadings.add(reading);
    bleLog.debug(
      `QN: 20-byte stable weight ${weight} kg, holding for the result frames; ` +
        'stay on the scale until its display shows the results (#331)',
    );
    return reading;
  }

  /**
   * 0x15/0x16 after the 19-byte dialect's stream (#331, D037). 0x15 is kept;
   * 0x16 is the last frame of the weigh-in, so it is what publishes the held
   * weight, with the scale's own results pinned to it (computeMetrics decides
   * whether they are used). The reading is a new object and therefore final.
   */
  private parseNineteenByteResultFrame(data: Buffer): ScaleReading | null {
    if (!hasValidSumChecksum(data)) {
      bleLog.debug(`QN: 0x${data[0].toString(16)} frame with a bad checksum dropped (#331)`);
      return null;
    }
    if (data[0] === RESULT16_OPCODE_COMPOSITION) {
      this.live20C15 = Buffer.from(data);
      return null;
    }
    this.live20ResultSeen = true;
    // At once, before anything is decoded and before the session ends on the
    // reading below, as the vendor's published SDK does: for a complete block
    // on any slot, an all-zero one and a repeated one too (#331, D059).
    if (this.forcedResultAck) {
      if (this.live20Block.length === 3 && this.live20C15 !== null) {
        bleLog.debug(
          'QN: 0x16 completes the result block, sending 0x1F as the vendor app does ' +
            '(ble.qn_result_ack, #331)',
        );
        void this.writeCmd(buildResultAck(this.seenProtocolType));
      } else {
        bleLog.debug(
          'QN: 0x16 without a complete result block, no 0x1F sent (ble.qn_result_ack, #331)',
        );
      }
    }
    if (this.live20Weight === null) {
      bleLog.debug(
        this.live20Replayed
          ? 'QN: 0x16 closes a repeated result block, nothing published (#331)'
          : 'QN: 0x16 closes a 19-byte weigh-in that sent no stable weight (#331)',
      );
      return null;
    }
    bleLog.debug(`QN: 0x16 closes the 19-byte weigh-in, publishing ${this.live20Weight} kg (#331)`);
    this.recentLiveResults.push({ weight: this.live20Weight, atMs: Date.now() });
    if (this.recentLiveResults.length > RECENT_LIVE_RESULTS) this.recentLiveResults.shift();
    const reading: ScaleReading = { weight: this.live20Weight, impedance: 0 };
    this.pinScaleComposition(reading, data);
    return reading;
  }

  /**
   * Pin the scale's own results for this weigh-in to its reading, when the
   * result block, 0x15 and 0x16 all decode and the block carries a
   * measurement: the scale sends an all-zero block when it has none (#331).
   * Snapshot at emit time, see ReadingComposition.
   */
  private pinScaleComposition(reading: ScaleReading, d16: Buffer): void {
    const [p1, p2, p3] = this.live20Block;
    const result =
      this.live20Block.length === 3
        ? decodeEightResult(p1, p2, p3, this.resistanceScrambled)
        : null;
    const composition = this.live20C15 ? decodeVaComposition(this.live20C15, d16) : null;
    if (!result || !composition) {
      bleLog.debug('QN: no complete result block for this weigh-in (#331)');
      return;
    }
    const measured =
      result.fatPercent > 0 && [...result.original, ...result.adjusted].some((v) => v > 0);
    if (!measured) {
      bleLog.info('QN: the scale sent no body composition for this weigh-in (#331)');
      return;
    }
    bleLog.info('QN: the scale sent its own body composition for this weigh-in (#331)');
    const channels = (values: number[]): string =>
      EIGHT_CHANNEL_ORDER.map((name, i) => `${name} ${values[i]}`).join(', ');
    bleLog.debug(
      `QN: result block, user slot ${result.slot}, ${result.weight} kg, body fat ` +
        `${result.fatPercent} %; measured Ohm: ${channels(result.original)}; ` +
        `corrected Ohm: ${channels(result.adjusted)} (#331)`,
    );
    bleLog.debug(
      `QN: 0x15/0x16: ${Object.entries(composition)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')} (#331)`,
    );
    // The line above prints muscle and bone as the scale sends them, which the
    // display shows too; the export is in kg, so the log names both (#331).
    if (this.readyValueType === 1) {
      const w = reading.weight;
      bleLog.debug(
        'QN: the scale reports muscle and bone as % of body weight: ' +
          `muscle ${composition.muscle} % (${r2((composition.muscle / 100) * w)} kg), ` +
          `bone ${composition.bone} % (${r2((composition.bone * w) / 100)} kg); ` +
          'exported in kg (#331)',
      );
    }
    this.scaleComposition.pin(reading, {
      result,
      composition,
      visit: this.visitSent,
      reply: this.visitReply,
      valueType: this.readyValueType,
      measuredAfterVisit: this.measuredAfterVisit,
      answerAfterVisitMs: this.answerAfterVisitMs,
      a4PreludeSent: this.a4PreludeSent,
    });
  }

  /**
   * The scale's first answer to this session's 0x22: a 0x23, or the result
   * block when no 0x23 came first (#331). The 19-byte scale sends it once it
   * has finished measuring, so an answer MEASURED_ANSWER_MIN_MS or more after the
   * 0x22 means it measured during this session, and one that long after it
   * accepted the profile means it finished measuring after accepting it, even
   * when its weight settled before and no live frame followed.
   *
   * The 18-byte scale answers while it is still measuring (#463), so there
   * the flags this sets mean nothing; only the 19-byte paths read them. It is
   * called there for the log line and for `queryAnswered`.
   */
  private noteStoredQueryAnswer(): void {
    if (this.queryAnswered) return;
    this.queryAnswered = true;
    const now = Date.now();
    const sinceQuery = this.storedQuerySentAtMs === null ? null : now - this.storedQuerySentAtMs;
    const sinceVisit = this.visitAcceptedAtMs === null ? null : now - this.visitAcceptedAtMs;
    this.answerAfterVisitMs = sinceVisit;
    if (sinceQuery !== null && sinceQuery >= MEASURED_ANSWER_MIN_MS) this.live20Measured = true;
    if (
      this.visitReply?.ok === true &&
      sinceVisit !== null &&
      sinceVisit >= MEASURED_ANSWER_MIN_MS
    ) {
      this.measuredAfterVisit = true;
    }
    bleLog.debug(
      `QN: the scale answered the stored-record query ${seconds(sinceQuery)} after it was sent` +
        (sinceVisit === null ? '' : `, ${seconds(sinceVisit)} after it accepted the profile`) +
        ' (#331)',
    );
  }

  /**
   * Why the scale's own composition pinned to a reading does not belong to the
   * user it was matched to, or null when it does (#331).
   *
   * The scale computes it for the profile in the visit frame we sent (age,
   * height in mm, sex; its BMI in 0x15 fits the height we sent, not the app's),
   * and for nothing else we can check. So it is used only when the scale
   * accepted that profile and measured after accepting it (a live frame after
   * the acceptance, or its first answer to the 0x22 at least
   * MEASURED_ANSWER_MIN_MS after it: the scale sends nothing during its BIA,
   * so a weight that settled just before the acceptance has only that answer
   * to show for it), the weigh-in is on that slot, the matched user has
   * exactly that profile, and the scale's BMI fits the height to within its
   * 0.1 rounding: one centimetre already moves it by more than that. A
   * session that sent the `qn_a4_prelude` frames overwrote the slot's stored
   * segment values with someone else's, which the scale corrects its channels
   * with, so it is never used there.
   */
  private scaleCompositionRejection(pin: ScaleCompositionPin, profile: UserProfile): string | null {
    const { visit, reply, result, composition } = pin;
    if (!visit) return 'this session sent the scale no profile of a configured user';
    if (!reply) return 'the scale did not answer the profile frame';
    if (!reply.ok || reply.slot !== visit.slot) return 'the scale did not accept the profile';
    if (!pin.measuredAfterVisit) {
      return pin.answerAfterVisitMs === null
        ? 'the scale sent no live weight after it accepted the profile'
        : `the scale answered ${seconds(pin.answerAfterVisitMs)} after it accepted the ` +
            'profile, with no live weight in between, so it most likely measured before that';
    }
    if (pin.a4PreludeSent) {
      return "ble.qn_a4_prelude overwrote the scale's segment values in this session";
    }
    if (result.slot !== visit.slot) return 'the weigh-in is on another user slot of the scale';
    if (pin.valueType !== 1) return 'the scale did not report its results as percentages';
    const expected = buildUserProfileFrame(profile.age, profile.height, profile.gender);
    if (expected.slice(6, 10).some((b, i) => b !== visit.frame[6 + i])) {
      return "the matched user's age, height or sex is not the profile sent to the scale";
    }
    const heightM = ((visit.frame[8] << 8) | visit.frame[9]) / 1000;
    if (Math.abs(composition.bmi - result.weight / (heightM * heightM)) > BMI_MATCH_TOLERANCE) {
      return "the scale's BMI does not fit the height sent to it";
    }
    return null;
  }

  /**
   * One 0x23 part of an 8-electrode stored record on the 19-byte dialect
   * (#331, layout at STORED_OPCODE_COMPOSITION). Parts are collected until
   * 0x25 completes the record; nothing is ever re-queried.
   */
  private parseEightStoredPart(data: Buffer): null {
    if (data.length !== LIVE20_FRAME_LEN || !hasValidSumChecksum(data)) {
      bleLog.debug(`QN: 0x23 that is not a stored-record part dropped: [${hex(data)}] (#331)`);
      return null;
    }
    // "No stored weigh-ins" is an answer to the 0x22 as much as a record is.
    this.noteStoredQueryAnswer();
    if (data[4] === 0) {
      bleLog.debug('QN: 0x23 with no parts: the scale holds no stored weigh-ins (#331)');
      return null;
    }
    const total = data[4] >> 4;
    const index = data[4] & 0x0f;
    if (total !== 3 || index === 0 || index > total) {
      this.storedParts = [];
      bleLog.debug(`QN: 0x23 not read as a stored-record part: [${hex(data)}] (#331)`);
      return null;
    }
    if (index === 1) {
      if (this.storedParts.length > 0) {
        bleLog.debug('QN: stored record left incomplete by the next one, dropped (#331)');
      }
      this.storedParts = [Buffer.from(data)];
      return null;
    }
    if (this.storedParts.length !== index - 1) {
      bleLog.debug(`QN: stored-record part ${index}/3 out of order, record dropped (#331)`);
      this.storedParts = [];
      return null;
    }
    this.storedParts.push(Buffer.from(data));
    return null;
  }

  /** 0x24 or 0x25 of an 8-electrode stored record (#331); 0x25 completes it. */
  private parseEightStoredTail(data: Buffer): ScaleReading | null {
    const expected = data[0] === STORED_OPCODE_COMPOSITION ? 3 : 4;
    if (this.storedParts.length !== expected) {
      bleLog.debug(
        `QN: 0x${data[0].toString(16)} without the stored-record frames before it, dropped (#331)`,
      );
      this.storedParts = [];
      return null;
    }
    this.storedParts.push(Buffer.from(data));
    if (data[0] === STORED_OPCODE_COMPOSITION) return null;
    const [s1, s2, s3, s24, s25] = this.storedParts;
    this.storedParts = [];
    return this.storedWeighIn(s1, s2, s3, s24, s25);
  }

  /**
   * A complete stored record as a reading with the time the scale took it
   * (#331). Its weight only: which profile the scale computed the record's
   * body composition with is not in it. A fresh record is provisional, so a
   * live result of the same session replaces it; an older one is history, which
   * the session keeps apart and the runtime sends only to exporters that can
   * record a past measurement.
   */
  private storedWeighIn(
    s1: Buffer,
    s2: Buffer,
    s3: Buffer,
    s24: Buffer,
    s25: Buffer,
  ): ScaleReading | null {
    const rec = decodeEightStoredRecord(s1, s2, s3, s24, s25, this.resistanceScrambled);
    if (!rec) {
      const frames = [s1, s2, s3, s24, s25].map((f) => hex(f)).join(' | ');
      bleLog.debug(`QN: stored record did not decode, dropped: [${frames}] (#331)`);
      return null;
    }
    const atMs = (rec.recordSeconds + SCALE_EPOCH_OFFSET) * 1000;
    const what = `${rec.weight} kg at ${new Date(atMs).toISOString()}`;
    if (rec.slot === STORED_UNASSIGNED_SLOT) {
      bleLog.info(
        `QN: a stored weigh-in (${what}) is not exported: the scale did not assign it to ` +
          'a user (#331)',
      );
      return null;
    }
    const now = Date.now();
    if (atMs > now + STORED_FUTURE_TOLERANCE_MS || now - atMs > STORED_MAX_AGE_MS) {
      bleLog.debug(`QN: stored weigh-in ${what} is not from the past year, dropped (#331)`);
      return null;
    }
    if (rec.weight <= RESULT_MIN_WEIGHT_KG || rec.weight >= RESULT_MAX_WEIGHT_KG) {
      bleLog.debug(`QN: stored weigh-in ${what} is out of range, dropped (#331)`);
      return null;
    }
    if (
      rec.recordSeconds <= this.storedMarkAtSessionStart ||
      this.storedEmitted.has(rec.recordSeconds)
    ) {
      bleLog.debug(`QN: stored weigh-in ${what} was already reported (#331)`);
      return null;
    }
    const live = this.recentLiveResults.find(
      (r) =>
        Math.abs(r.weight - rec.weight) <= LIVE_MATCH_WEIGHT_KG &&
        atMs >= r.atMs - LIVE_MATCH_BEFORE_MS &&
        atMs <= r.atMs + LIVE_MATCH_AFTER_MS,
    );
    if (live) {
      bleLog.debug(
        `QN: stored weigh-in ${what} is the live result reported at ` +
          `${new Date(live.atMs).toISOString()}, dropped (#331)`,
      );
      return null;
    }

    const reading: ScaleReading = { weight: rec.weight, impedance: 0, timestamp: new Date(atMs) };
    const historical = isHistoricalReading(reading, now);
    if (this.live20Weight !== null && !historical) {
      bleLog.info(
        `QN: a stored weigh-in (${what}) is superseded by the weigh-in in progress, ` +
          'not exported (#331)',
      );
      return null;
    }
    this.storedMark = Math.max(this.storedMark, rec.recordSeconds);
    this.storedEmitted.add(rec.recordSeconds);
    this.provisionalReadings.add(reading);
    if (!historical) {
      this.storedHoldArmed = true;
      this.replaceHeldStoredWeighIn(`a later stored weigh-in (${what})`);
      this.heldStoredWeighIn = what;
    }
    bleLog.debug(
      `QN: stored weigh-in ${what}, user slot ${rec.slot}, ` +
        (historical ? 'reported as history' : 'held: a live result in this session replaces it') +
        ' (#331)',
    );
    return reading;
  }

  /**
   * An 18-byte 0x23 record from more than MAX_STORED_RECORD_AGE_SEC before the
   * session (#463, D065): a weigh-in the scale kept while nobody fetched it.
   * The window used to drop it without a line, and in #463 the scale did not
   * send it again, not even to the vendor app, so the weigh-in was lost.
   *
   * Reported as history with its own time (`fromMemory`), but only for user
   * slot 1, with `ble.qn_user_key`, in a session in which the scale accepted
   * the profile built from the first user with that key (not openScale's
   * fallback one): only then is slot 1 the first configured user,
   * as the option documents. Otherwise it gets an info line with its weight
   * and time, so it can be entered by hand, and the line names the first
   * reason in that order: a record the scale gave no user would not go out
   * with the option either, so it does not point at the option.
   *
   * Each record once per session, and never again once reported: the mark
   * (dedupMark, kept across restarts) and the live results this adapter
   * reported (a record that is a weigh-in already exported live) see to that.
   */
  private eighteenByteStoredWeighIn(data: Buffer, record: StoredRecord): ScaleReading | null {
    const { weight, recordSeconds } = record;
    if (this.storedJudged.has(recordSeconds)) return null;
    this.storedJudged.add(recordSeconds);
    const atMs = (recordSeconds + SCALE_EPOCH_OFFSET) * 1000;
    const what = `${weight} kg at ${new Date(atMs).toISOString()}`;
    const slot = data[5];
    if (slot === STORED_UNASSIGNED_SLOT) {
      bleLog.info(
        `QN: a stored weigh-in (${what}) is not exported: the scale did not assign it to ` +
          'a user (#463)',
      );
      return null;
    }
    if (slot !== 1) {
      bleLog.info(
        `QN: a stored weigh-in (${what}) is not exported: the scale assigned it to its user ` +
          `slot ${slot}, and ble-scale-sync sends the profile of slot 1 (#463)`,
      );
      return null;
    }
    if (this.forcedUserKey === null) {
      bleLog.info(
        `QN: a stored weigh-in (${what}, user slot ${slot}) is not exported: without ` +
          'ble.qn_user_key ble-scale-sync cannot tell whose it is (#463)',
      );
      return null;
    }
    // A refused profile means the key or the first user does not match what
    // the vendor app set up, so slot 1 need not be the first configured user.
    // The profile frame always goes to slot 1, so the answer is for slot 1.
    // It has to be the frame built from the first user with the key, too: a
    // 0x12 that came after the handshake leaves the session on openScale's
    // constant profile (key 8), which a scale may accept for a slot 1 that
    // holds someone else (Renpho #213/#253).
    if (this.visitSent === null && this.visitReply?.ok === true) {
      bleLog.info(
        `QN: a stored weigh-in (${what}) is not exported: this session sent openScale's ` +
          'profile, not the first user with ble.qn_user_key (the 18-byte 0x12 came after the ' +
          'handshake), so it is not known whose it is (#463)',
      );
      return null;
    }
    if (this.visitReply?.ok !== true) {
      bleLog.info(
        `QN: a stored weigh-in (${what}) is not exported: the scale did not accept the ` +
          'profile for user slot 1 in this session, so it is not known whose it is (#463)',
      );
      return null;
    }
    // Only a record from the past gets here, so the year is the only bound.
    if (Date.now() - atMs > STORED_MAX_AGE_MS) {
      bleLog.debug(`QN: stored weigh-in ${what} is not from the past year, dropped (#463)`);
      return null;
    }
    if (recordSeconds <= this.storedMarkAtSessionStart || this.storedEmitted.has(recordSeconds)) {
      bleLog.debug(`QN: stored weigh-in ${what} was already reported (#463)`);
      return null;
    }
    const live = this.recentLiveResults.find(
      (r) =>
        Math.abs(r.weight - weight) <= LIVE_MATCH_WEIGHT_KG &&
        atMs >= r.atMs - LIVE_MATCH_BEFORE_MS &&
        atMs <= r.atMs + LIVE_MATCH_AFTER_MS,
    );
    if (live) {
      bleLog.debug(
        `QN: stored weigh-in ${what} is the live result reported at ` +
          `${new Date(live.atMs).toISOString()}, dropped (#463)`,
      );
      return null;
    }
    this.storedMark = Math.max(this.storedMark, recordSeconds);
    this.storedEmitted.add(recordSeconds);
    bleLog.debug(
      `QN: stored weigh-in ${what}, user slot 1, record ${data[4]} of ${data[3]}, ` +
        'reported as history (#463)',
    );
    return {
      weight,
      impedance: this.resistance(record.r50 > 0 ? record.r50 : record.r500),
      timestamp: new Date(atMs),
      fromMemory: true,
    };
  }

  /** Keep a live result for the stored records of later sessions to be compared with. */
  private rememberLiveResult(weight: number): void {
    this.recentLiveResults.push({ weight, atMs: Date.now() });
    if (this.recentLiveResults.length > RECENT_LIVE_RESULTS) this.recentLiveResults.shift();
  }

  /**
   * Say why a 0x23 outside the 19-byte dialect is not read (#463). The record
   * used to vanish without a line, and a frame that arrives after the session
   * settled is not even in the DEBUG log, so nothing showed that a weigh-in the
   * scale kept had been handed over at all.
   *
   * Only the long-frame dialects get the record's values: the VA layout is
   * known there. A classic scale's 0x23 has its own layout, so its line has the
   * bytes only, and a session without a 0x12 does not know its dialect, so its
   * line gives the VA reading as one possibility.
   */
  private logUnreadStoredRecord(
    data: Buffer,
    record: StoredRecord,
    sessionSeconds: number,
    why: 'out of range' | 'old',
  ): void {
    const bytes = hex(data);
    if (this.scaleFactorKnown && !this.isLongFrameVariant) {
      bleLog.debug(
        `QN: 0x23 on the classic dialect is not decoded (#461 S3), not read: [${bytes}] (#463)`,
      );
      return;
    }
    const at = new Date((record.recordSeconds + SCALE_EPOCH_OFFSET) * 1000).toISOString();
    const age = sessionSeconds - record.recordSeconds;
    if (!this.scaleFactorKnown) {
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
      `QN: stored weigh-in ${record.weight} kg at ${at}, user slot ${data[5]}, is ${age} s ` +
        `older than this session (window ${MAX_STORED_RECORD_AGE_SEC} s), not read (#213 / #75)`,
    );
  }

  /**
   * The session hold keeps one reading, so a fresh stored weigh-in held there
   * is gone once `by` takes its place, and it is already counted in the mark.
   * Said at info with its weight and time, so it can be entered by hand (#331).
   */
  private replaceHeldStoredWeighIn(by: string): void {
    if (this.heldStoredWeighIn === null) return;
    bleLog.info(
      `QN: a stored weigh-in (${this.heldStoredWeighIn}) is replaced by ${by}, ` +
        'not exported (#331)',
    );
    this.heldStoredWeighIn = null;
  }

  /** The newest stored weigh-in reported, in scale-epoch seconds (#331). */
  dedupMark(): number | undefined {
    return this.storedMark || undefined;
  }

  /**
   * Take back the mark of an earlier process. Raises only, and ignores anything
   * that is not a whole number of seconds up to a day past now on the scale's
   * clock: the file can be edited by hand.
   */
  restoreDedupMark(mark: number): void {
    const limit = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET + 86_400;
    if (!Number.isInteger(mark) || mark <= 0 || mark > limit) return;
    if (mark > this.storedMark) this.storedMark = mark;
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
    if (this.configSent) return;
    this.configSent = true;

    // Cancel the fallback timer since the state machine is running normally
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }

    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
    await this.writeCmd(buildConfig(this.seenProtocolType, this.unitFlag(), this.configLong));
    if (this.configLong) {
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
    if (this.timeSyncSent) return;
    this.timeSyncSent = true;
    const gen = this.sessionGeneration;
    const appProfile = this.decideAppProfileSequence();
    // 0x20 time sync: seconds since 2000-01-01, little-endian. See
    // TIME_SYNC_TRAILER for the 9-byte form and why it is opt-in. Its extra
    // byte is the host's UTC offset now, daylight saving included.
    const secs = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
    const offsetMin = -new Date().getTimezoneOffset();
    const tz = timeZoneByte(offsetMin);
    await this.writeCmd(buildTimeSync(this.seenProtocolType, secs, this.timeSyncLong, tz));
    if (gen !== this.sessionGeneration) return;
    if (this.timeSyncLong) {
      bleLog.debug(
        `QN: 0x20 time sync sent in the 9-byte vendor-app form with UTC offset ` +
          `${offsetMin >= 0 ? '+' : '-'}${Math.abs(offsetMin)} min ` +
          `(0x${tz.toString(16).padStart(2, '0')}, ble.qn_time_sync_long, #331)`,
      );
    }

    // A2, which openScale labels a user profile and fills with 0x32 plus the
    // user's age. The GE CS 10 G capture shows the vendor app using this exact
    // frame to carry a WEIGHT, so under that reading `0x32 <age>` decodes as a
    // weight nobody has: @chriba2567's log writes `a2 06 01 32 3a 15`, which is
    // 128.58 kg, and his scale then goes silent right after START (#331, #75).
    //
    // Not changed by default. openScale's bytes are what every QN scale in the
    // registry reads with today, and two silent units are not enough to move a
    // default under the whole family. `ble.qn_weight_ack` swaps in the
    // configured anchor for the reporters who can actually test it.
    // With the vendor-app profile sequence (the 19-byte dialect with
    // `ble.qn_weight_ack`, or the 18- and 19-byte ones with `ble.qn_user_key`)
    // the frame is not sent at all: neither the Arboleaf nor the Feelfit app
    // sends an A2 before START, and per the vendor's published SDK this frame
    // sets the slot's identify weight, which `0x32 <age>` puts at over 128 kg
    // (#331, D033, #463).
    if (appProfile) {
      bleLog.debug(
        this.forcedUserKey === null
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
      const anchorAtReady = this.forcedWeightAck === true && this.isExtendedLongFrame;
      const anchorKg = anchorAtReady ? this.resolveAnchorKg() : 0;
      const profileCmd = anchorAtReady
        ? buildMeasurementTrigger(anchorKg)
        : (() => {
            const age = Math.min(0xff, Math.max(1, this.ctx!.profile.age));
            const cmd = [0xa2, 0x06, 0x01, 0x32, age, 0x00];
            cmd[5] = cmd.reduce((a, b) => a + b, 0) & 0xff;
            return cmd;
          })();
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
    if (this.historyResponseSent) return;
    this.historyResponseSent = true;
    const appProfile = this.decideAppProfileSequence();
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
    if (this.forcedReportByte !== null) {
      const deleteUsers = [
        0xa0,
        0x0d,
        USER_DELETE_SUBCOMMAND,
        this.forcedReportByte,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
      ];
      deleteUsers[12] = deleteUsers.reduce((a, b) => a + b, 0) & 0xff;
      bleLog.debug(
        `QN: sending the A00D user-delete frame with mask ` +
          `0x${this.forcedReportByte.toString(16).padStart(2, '0')} (ble.qn_report_byte, #461)`,
      );
      await this.writeCmd(deleteUsers);
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
    let msg2 = [0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 0x21, 0x06, 0xb8, 0x04, 0x02, 0x00];
    msg2[12] = msg2.reduce((a, b) => a + b, 0) & 0xff;
    const profile = this.ctx?.profile;
    if (appProfile && profile) {
      const key = this.forcedUserKey ?? VENDOR_APP_USER_KEY;
      const athlete =
        this.isEighteenByteInfo && profile.isAthlete && profile.age >= VISIT_ATHLETE_MIN_AGE;
      msg2 = buildUserProfileFrame(profile.age, profile.height, profile.gender, { key, athlete });
      this.visitSent = { slot: msg2[3], frame: msg2 };
      const sent =
        `age ${msg2[7]}, height ${(msg2[8] << 8) | msg2[9]} mm, ` +
        `sex ${msg2[6] === 0x01 ? 'female' : 'male'}`;
      bleLog.debug(
        this.forcedUserKey === null
          ? `QN: A00D profile frame with ${sent} (ble.qn_weight_ack, 19-byte dialect, #331)`
          : `QN: A00D profile frame with key ${key}, ${sent}, athlete ${athlete ? 'yes' : 'no'} ` +
              `(ble.qn_user_key, ${this.dialectBytes()}-byte dialect, #463)`,
      );
    } else if (!appProfile && this.forcedUserKey !== null && !this.wantsAppProfileSequence()) {
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
    // Its send time is what the scale's first answer is measured against.
    this.storedQuerySentAtMs ??= Date.now();
    await this.writeCmd(this.buildStoredDataQuery());
    if (!live()) return;

    // Weight anchor, twice, right after START. Every dialect except the 20-byte
    // extended one, which has its own hardware-confirmed burst further down,
    // and only when `ble.qn_weight_ack` is explicitly true, so no install that
    // does not ask for it sees a frame it did not see before.
    //
    // Two Android btsnoops of the Arboleaf app completing a weigh-in on the
    // 19-byte es26m dialect, the same unit a month apart, agree (#331, #75):
    //
    //   APP    22 06 ff 00 03 2a    START
    //   APP    a2 06 01 1c ed b2    75 ms later, 0x1ced = 7405 = 74.05 kg
    //   SCALE  a3 04 01 a8          the scale's ack to that A2
    //   APP    a2 06 01 1c ed b2    the same frame again, 71 ms after the first
    //   SCALE  10 14 ...            the first live frame, 22 ms later
    //
    // Neither sends an A2 before START. The one transcript that has it there is
    // an iOS one without timestamps whose order is in doubt (it labels the a3 a
    // start ack, but every A2 gets an a3), and replaying that order, as this
    // adapter did from v1.28.0, never produced a weight on either reporter's
    // unit.
    //
    // POST_START_ANCHOR_DELAY_MS is the capture's 75 ms. The gap between the
    // copies is TRIGGER_GAP_MS rather than the capture's 71 ms, see there. Sent
    // twice unconditionally rather than on the a3, which a proxy transport may
    // deliver late or not at all.
    //
    // The burst spans two timers, so like the rest of this sequence it is bound
    // to the session that started it (`live()`).
    if (this.forcedWeightAck === true && !this.isExtendedLongFrame) {
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
    if (this.a4PreludeEnabled) {
      this.a4PreludeSent = true;
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
    if (!this.isExtendedLongFrame) return;
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
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.storedRetryTimer) {
      clearTimeout(this.storedRetryTimer);
      this.storedRetryTimer = null;
    }
    this.sessionStartedScaleSeconds = null;
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
    if (!this.anchorFallbackWarned) {
      this.anchorFallbackWarned = true;
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
    return this.forcedWeightAck ?? this.isExtendedLongFrame;
  }

  /** Build the 0x22 stored-data query frame with a trailing checksum. */
  private buildStoredDataQuery(): number[] {
    const cmd = [0x22, 0x06, this.seenProtocolType, 0x00, 0x03, 0x00];
    cmd[5] = cmd.reduce((a, b) => a + b, 0) & 0xff;
    return cmd;
  }

  /**
   * Re-send the 0x22 stored-data query after a stale, empty, or short 0x23,
   * bounded by MAX_STORED_QUERY_ATTEMPTS. Gives V10 firmware a moment to save
   * the fresh weigh-in before the scale disconnects (#213 / #75).
   */
  private scheduleStoredDataRetry(): void {
    if (!this.ctx || this.storedQueryAttempts >= MAX_STORED_QUERY_ATTEMPTS) return;
    if (this.storedRetryTimer) clearTimeout(this.storedRetryTimer);
    this.storedRetryTimer = setTimeout(() => {
      this.storedRetryTimer = null;
      if (!this.ctx || this.storedQueryAttempts >= MAX_STORED_QUERY_ATTEMPTS) return;
      this.storedQueryAttempts += 1;
      bleLog.debug(
        `QN: stored-data re-query ${this.storedQueryAttempts}/${MAX_STORED_QUERY_ATTEMPTS}`,
      );
      void this.writeCmd(this.buildStoredDataQuery());
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
    const pin = this.scaleComposition.of(reading, null);
    if (pin) {
      const payload = this.scaleCompositionPayload(pin, reading, profile);
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
    const fat = biaFatIfPlausible(reading.weight, reading.impedance, profile);
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }

  /**
   * The scale's own body fat, water, muscle, bone and visceral fat, as one set
   * that stands or falls as a whole, or null with the reason logged when they
   * are not this user's or not plausible (#331). Athlete mode: the scale has none for these scales in
   * the vendor's published SDK, so an athlete gets its values with a note
   * rather than the BMI estimate, which is the worst one for a muscular body.
   */
  private scaleCompositionPayload(
    pin: ScaleCompositionPin,
    reading: ScaleReading,
    profile: UserProfile,
  ): BodyComposition | null {
    const why = this.scaleCompositionRejection(pin, profile);
    const w = reading.weight;
    const set: ScaleBodyComp = {
      fat: pin.result.fatPercent,
      water: pin.composition.water,
      muscle: pin.composition.muscle,
      bone: (pin.composition.bone * w) / 100,
    };
    const implausible = why === null ? compositionRejection(set) : null;
    if (why !== null || implausible !== null) {
      bleLog.info(
        `QN: the scale's own body composition is not used for this weigh-in: ` +
          `${why ?? `its values are not plausible (${implausible})`}; estimating instead (#331)`,
      );
      return null;
    }
    const visceral = pin.composition.visceral;
    if (visceral >= 1 && visceral <= 59) set.visceralFat = visceral;
    bleLog.info("QN: using the scale's own body composition for this weigh-in (#331)");
    if (profile.isAthlete) {
      bleLog.info('QN: the scale computed it without an athlete mode (#331)');
    }
    return buildPayload(w, reading.impedance, set, profile);
  }
}
