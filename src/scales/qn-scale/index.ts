import { biaFatIfPlausible, buildPayload } from '../body-comp-helpers.js';
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
} from '../../interfaces/scale-adapter.js';
import { bleLog, errMsg, normalizeUuid } from '../../ble/types.js';
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
  CHR_AE01,
  CHR_AE02,
  CHR_NOTIFY,
  CHR_NOTIFY_T1,
  CHR_WRITE,
  CHR_WRITE_T1,
  EXTENDED_INFO_FRAME_LEN,
  IMPEDANCE_GRACE_MS,
  LAST_KNOWN_WEIGHT_TOLERANCE,
  LEGACY_PROTO_TYPE,
  MAX_AE00_RESPONSES,
  MAX_STORED_QUERY_ATTEMPTS,
  MAX_STORED_RECORD_AGE_SEC,
  POST_START_ANCHOR_DELAY_MS,
  PROTO_ECHO_MIN_INFO_FRAME_LEN,
  REPORT_BYTE_DEFAULT,
  REPORT_BYTE_LONG_FRAME,
  RESULT_MAX_WEIGHT_KG,
  RESULT_MIN_WEIGHT_KG,
  RESULT_OPCODE_B1,
  RESULT_OPCODE_B4,
  RESULT_RECORD_CLOCK_TOLERANCE_SEC,
  SCALE_EPOCH_OFFSET,
  STORED_QUERY_RETRY_MS,
  TRIGGER_GAP_MS,
  TRIGGER_REPEATS,
  TRIGGER_WEIGHT_FALLBACK_KG,
  WEIGHT_CERTAIN_MAX_KG,
  WEIGHT_CERTAIN_MIN_KG,
} from './constants.js';
import {
  buildA2Frame,
  buildConfig,
  buildMeasurementTrigger,
  buildTimeSync,
  buildUserProfileFrame,
  hasValidSumChecksum,
} from './frames.js';
import { qnMatches, warnOnOneByoneShape } from './matching.js';
import { parseQnBroadcast } from './broadcast.js';

// Re-exported so importers keep the paths they had before the split.
export {
  buildA2Frame,
  buildConfig,
  buildMeasurementTrigger,
  buildTimeSync,
  buildUserProfileFrame,
} from './frames.js';

/** Format bytes as hex string for debug logging. */
const hex = (data: number[] | Buffer): string =>
  [...data].map((b) => b.toString(16).padStart(2, '0')).join(' ');

export class QnScaleAdapter
  implements ScaleAdapterCore, GattWiring, BroadcastSource, MultiCharNotify
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
   * The vendor-app profile sequence for the 19-byte dialect (#331, D033).
   * Decided once, by whichever of the ready step and the config-request step
   * runs first, from the 0x12 seen at that point, so the ready-time A2 and the
   * A00D #2 profile frame always come from the same choice. A 0x12 that
   * arrives later (after a fallback handshake) does not change it. Null until
   * decided.
   */
  private appProfileSequence: boolean | null = null;

  private decideAppProfileSequence(): boolean {
    if (this.appProfileSequence === null) {
      this.appProfileSequence = this.forcedWeightAck === true && this.isNineteenByteInfo;
    }
    return this.appProfileSequence;
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
   * Payload byte of the A00D history-response frame, forced by
   * `ble.qn_report_byte` (#235, #75, #331). Null leaves REPORT_BYTE_DEFAULT.
   */
  private forcedReportByte: number | null = null;

  /**
   * `ble.qn_weight_ack`. Null leaves the dialect gate alone (#75).
   */
  private forcedWeightAck: boolean | null = null;

  /** One anchor-fallback warning per session, reset in onConnected. */
  private anchorFallbackWarned = false;

  /** One "20-byte live frame not decoded" line per session (#331). */
  private twentyByteFrameLogged = false;

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

  /** Number of 0x22 stored-data re-queries sent this session. */
  private storedQueryAttempts = 0;

  /** Timer handle for the pending stored-data re-query. */
  private storedRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Receive the configured display unit from the composition root (#269). */
  configure(opts: AdapterRuntimeConfig): void {
    if (opts.displayUnit) this.displayUnit = opts.displayUnit;
    this.forcedProtocolType = opts.qnProtocolByte ?? null;
    this.forcedReportByte = opts.qnReportByte ?? null;
    this.forcedWeightAck = opts.qnWeightAck ?? null;
    this.a4PreludeEnabled = opts.qnA4Prelude === true;
    this.timeSyncLong = opts.qnTimeSyncLong === true;
    this.configLong = opts.qnConfigLong === true;
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
    this.appProfileSequence = null;
    this.extendedResultEmitted = false;
    this.firstStableNoImpedanceAt = null;
    this.sessionStartedScaleSeconds = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
    this.anchorFallbackWarned = false;
    this.twentyByteFrameLogged = false;
    this.configSent = false;
    this.timeSyncSent = false;
    this.historyResponseSent = false;
    this.storedQueryAttempts = 0;
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
      bleLog.debug('QN: fallback: sending history + start');
      await this.handleConfigRequest();
    }
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
   *                        (no A2 on the 19-byte dialect with ble.qn_weight_ack)
   *   0x21 (config req)  -> A00D history responses + 0x22 start
   *   0x10 (weight)      -> parse weight (original or ES-30M format)
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
        if (
          this.isNineteenByteInfo &&
          this.forcedWeightAck === true &&
          this.appProfileSequence === false
        ) {
          bleLog.debug(
            "QN: 19-byte 0x12 after the handshake already chose openScale's frames; " +
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
      void this.handleReady();
      return null;
    }

    // 0x21: config request, respond with A00D history frames + start measurement
    if (opcode === 0x21) {
      bleLog.debug('QN: config request, sending history response + start');
      void this.handleConfigRequest();
      return null;
    }

    // 0xA1, 0xA3: acknowledgment frames (no action needed)
    if (opcode === 0xa1 || opcode === 0xa3) {
      return null;
    }

    // 0x23: stored measurement record returned after the 0x22 history query.
    // V10 Renpho / ES-CS20M firmware delivers the weigh-in here, not reliably
    // via live 0x10 frames (#213 / #75). Layout from openScale QNHandler:
    //   [6-9]   record timestamp, LE uint32 (2000-epoch seconds)
    //   [10-11] weight, BE uint16, / 100 kg
    //   [13-14] primary resistance R1, LE uint16
    //   [15-16] secondary resistance R2, LE uint16
    if (opcode === 0x23) {
      if (data.length < 17) {
        this.scheduleStoredDataRetry();
        return null;
      }
      const weight = data.readUInt16BE(10) / 100;
      if (weight <= 5 || weight >= 300) {
        this.scheduleStoredDataRetry();
        return null;
      }
      const recordSeconds = data.readUInt32LE(6);
      const sessionSeconds =
        this.sessionStartedScaleSeconds ?? Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
      if (recordSeconds + MAX_STORED_RECORD_AGE_SEC < sessionSeconds) {
        this.scheduleStoredDataRetry();
        return null;
      }
      const r1 = data.readUInt16LE(13);
      const r2 = data.readUInt16LE(15);
      if (this.storedRetryTimer) {
        clearTimeout(this.storedRetryTimer);
        this.storedRetryTimer = null;
      }
      bleLog.debug(`QN: stored 0x23 reading ${weight}kg / ${r1 > 0 ? r1 : r2}Ω`);
      return { weight, impedance: r1 > 0 ? r1 : r2 };
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
    // Neither branch above reads it. [4] is 0x11, so it falls into the original
    // layout, which takes the weight from [3..4] and gets 0x0011. What [4] and
    // the stability flag mean in this layout is not decoded yet, so the frame is
    // logged once per session with the weight where the captures put it.
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
    // i.e. 0.17 kg, on every live frame; that path returns above now. Whether
    // the app echoes this shape at all is not known, so a 20-byte frame on the
    // ES-30M branch is not echoed either. The 14-byte ES-30M and 10-byte classic
    // frames keep it: their offsets are right. Sent before the stability gate,
    // fire and forget, like the 0x1F stable ACK below.
    if (this.weightAckEnabled() && this.ctx && !twentyByteLive) {
      void this.writeCmd(buildA2Frame(rawWeight));
    }

    if (!stable) return null;

    const weight = this.resolveWeight(rawWeight);
    if (weight === null) return null;

    // R1 (primary BIA resistance) and R2 (secondary)
    const impedance = r1 > 0 ? r1 : r2;

    // Reset the impedance grace timer on successful reading
    this.firstStableNoImpedanceAt = null;

    // Acknowledge stable reading (0x1F) so the scale knows we received it
    if (this.ctx) {
      const ackCmd = [0x1f, 0x05, this.seenProtocolType, 0x10, 0x00];
      ackCmd[4] = ackCmd.reduce((a, b) => a + b, 0) & 0xff;
      void this.writeCmd(ackCmd);
    }

    return { weight, impedance };
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

  /** Respond to 0x14 (ready) with 0x20 time sync + A2 user profile + AE01 auth. */
  private async handleReady(): Promise<void> {
    if (this.timeSyncSent) return;
    this.timeSyncSent = true;
    const gen = this.sessionGeneration;
    const appProfile = this.decideAppProfileSequence();
    // 0x20 time sync: seconds since 2000-01-01, little-endian. See
    // TIME_SYNC_TRAILER for the 9-byte form and why it is opt-in.
    const secs = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
    await this.writeCmd(buildTimeSync(this.seenProtocolType, secs, this.timeSyncLong));
    if (gen !== this.sessionGeneration) return;
    if (this.timeSyncLong) {
      bleLog.debug(
        'QN: 0x20 time sync sent in the 9-byte vendor-app form ' +
          '(ble.qn_time_sync_long, trailing byte undecoded, #331)',
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
    // On the 19-byte dialect with `ble.qn_weight_ack` the frame is not sent at
    // all: the Arboleaf app sends no A2 before START, and with the user's age
    // in it this frame reads as an anchor of roughly 128 kg (#331, D033).
    if (appProfile) {
      bleLog.debug(
        'QN: no A2 before START on the 19-byte dialect, as the vendor app ' +
          '(ble.qn_weight_ack, #331)',
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

  /** Respond to 0x21 (config request) with A00D history frames + 0x22 start measurement. */
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

    // A00D response 1 (from openScale QNHandler). byte[3] is the payload byte
    // `ble.qn_report_byte` overrides; see REPORT_BYTE_DEFAULT and
    // REPORT_BYTE_LONG_FRAME.
    const isLongFrame = this.isExtendedLongFrame || this.isLongFrameVariant;
    const dialectDefault = isLongFrame ? REPORT_BYTE_LONG_FRAME : REPORT_BYTE_DEFAULT;
    const msg1 = [
      0xa0,
      0x0d,
      0x04,
      this.forcedReportByte ?? dialectDefault,
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
    msg1[12] = msg1.reduce((a, b) => a + b, 0) & 0xff;
    bleLog.debug(
      `QN: history response byte 0x${msg1[3].toString(16).padStart(2, '0')}` +
        (this.forcedReportByte !== null
          ? ` (forced; dialect default 0x${dialectDefault.toString(16)})`
          : ` (dialect default)`),
    );
    await this.writeCmd(msg1);

    await wait(200);
    if (!live()) return;

    // A00D response 2, the user profile. openScale's constant everywhere except
    // the 19-byte dialect with `ble.qn_weight_ack`, which gets the first user's
    // age and height the way the vendor app sends them (#331, D033).
    let msg2 = [0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 0x21, 0x06, 0xb8, 0x04, 0x02, 0x00];
    msg2[12] = msg2.reduce((a, b) => a + b, 0) & 0xff;
    const profile = this.ctx?.profile;
    if (appProfile && profile) {
      msg2 = buildUserProfileFrame(profile.age, profile.height);
      bleLog.debug(
        `QN: A00D profile frame with age ${msg2[7]}, height ${(msg2[8] << 8) | msg2[9]} mm ` +
          `(ble.qn_weight_ack, 19-byte dialect, #331)`,
      );
    }
    await this.writeCmd(msg2);

    await wait(200);
    if (!live()) return;

    // 0x22 start measurement / stored-data query with echoed protocol type
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
    // Broadcast readings have impedance=0; GATT readings have impedance>200
    if (reading.impedance === 0) return reading.weight > 0;
    return reading.weight > 10 && reading.impedance > 200;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
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
}
