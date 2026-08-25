import { computeBiaFat, buildPayload } from './body-comp-helpers.js';
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
} from '../interfaces/scale-adapter.js';
import { uuid16 } from './body-comp-helpers.js';
import { bleLog, errMsg, normalizeUuid } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';
import {
  jieliAuthResponseFrame,
  JIELI_CHALLENGE_FRAME_LEN,
  JIELI_CHALLENGE_HEADER,
} from './jieli-auth.js';
import type { WeightUnit } from '../config/schema.js';

/** Format bytes as hex string for debug logging. */
const hex = (data: number[] | Buffer): string =>
  [...data].map((b) => b.toString(16).padStart(2, '0')).join(' ');

/**
 * Ported from openScale's QNHandler.kt
 *
 * QN / FITINDEX ES-26M style scales (vendor protocol on 0xFFE0 / 0xFFF0).
 *
 * Two very similar layouts:
 *   Type 1 (0xFFE0): FFE1 notify, FFE2 indicate, FFE3 write-config, FFE4 write-time
 *   Type 2 (0xFFF0): FFF1 notify, FFF2 write-shared
 *
 * Some newer firmware (e.g. Renpho ES-CS20M / Elis 1) also exposes an AE00
 * service (AE01 write, AE02 notify) that must be initialized before the scale
 * starts sending measurement data on FFF1.
 *
 * The handshake is notification-driven (matching openScale and the official
 * Renpho app): the scale sends 0x12 (scale info) when FFF1 CCCD is written,
 * and each subsequent command is sent in response to a specific frame:
 *
 *   0x12 (scale info) -> AE01 init (if AE00) -> 0x13 config
 *   0x14 (ready ACK)  -> 0x20 time sync + A2 user profile + "pass" auth
 *   0x21 (config req)  -> A00D history responses + 0x22 start measurement
 *   0x10 (weight)      -> parse weight + 0x1F acknowledge stable reading
 *
 * 0x10 frame (original format, 10 bytes):
 *   [3-4]   weight (BE uint16, / weightScaleFactor)
 *   [5]     stability (1 = stable, 0 = measuring)
 *   [6-7]   resistance R1 (BE uint16)
 *   [8-9]   resistance R2 (BE uint16)
 *
 * 0x10 frame (ES-30M format, 14 bytes, weightScaleFactor=10):
 *   [4]     state (0x00=measuring, 0x01=stabilizing, 0x02=stable)
 *   [5-6]   weight (BE uint16, / weightScaleFactor)
 *   [7-8]   resistance R1 (BE uint16)
 *   [9-10]  resistance R2 (BE uint16)
 *
 * 0x12 frame (scale info, classic 11-byte format):
 *   [2]     protocol type (echoed back in all config commands)
 *   [10]    weight scale flag (1 = /100, else /10)
 *
 * 0x12 frame (long format, byte[1] == packet length):
 *   [1]     length (18 on the Renpho ES-26M, 20 on the GE CS 10 G)
 *   [2]     protocol/verify byte (0xff on every captured frame)
 *   [3-8]   MAC address, little endian
 *   Weight scale factor is 10 (ES-30M format with heuristic /100 fallback).
 *
 *   The two dialects agree on the layout and differ in the value the firmware
 *   ACCEPTS BACK. The 18-byte ES-26M was hardware verified rejecting 0xff and
 *   working on 0x00 (45e4d6e); on the 20-byte GE CS 10 G the vendor app echoes
 *   0xff, and its 0x22 start command is then byte identical to ours (#235).
 *   Note that only the 0x22 matches the app byte for byte: the app's 0x13 and
 *   0x20 are each one byte longer than ours, and that delta is still unexplained.
 */

// Type 2 UUIDs (most common variant)
const CHR_NOTIFY = uuid16(0xfff1);
const CHR_WRITE = uuid16(0xfff2);

// Type 1 UUIDs (alternate variant, service 0xFFE0)
const CHR_NOTIFY_T1 = uuid16(0xffe1);
const CHR_WRITE_T1 = uuid16(0xffe3);

// AE00 service UUIDs (newer firmware, e.g. Renpho ES-CS20M)
const CHR_AE01 = uuid16(0xae01);
const CHR_AE02 = uuid16(0xae02);

// Service UUIDs for matching
const SVC_T1 = 'ffe0';
const SVC_T2 = 'fff0';
// AE00 vendor service (newer QN firmware, e.g. Renpho ES-CS20M). Unique to QN
// scales — never shared with the fff0 Inlife/1byone/Eufy cluster (#235).
const SVC_AE00 = 'ae00';

// SIG Body Composition / Weight Scale services. A 'renpho'-named device that
// advertises these but NO QN vendor service is a Renpho ES-WBE28 (#191),
// handled by RenphoScaleAdapter — see matches().
const SVC_SIG_BCS = '181b';
const SVC_SIG_WSS = '181d';

// SIG User Control Point + Weight Measurement. Together these identify a SIG
// consent scale (Beurer BF7xx/BF9xx), which also exposes a vendor 0xFFF0
// service and would otherwise be claimed by the nameless fallback in matches()
// (#229). The User Control Point belongs to the User Data service, which QN
// scales do not implement.
const CHR_SIG_USER_CONTROL_POINT = uuid16(0x2a9f);
const CHR_SIG_WEIGHT_MEASUREMENT = uuid16(0x2a9d);

/** Seconds from Unix epoch to 2000-01-01 00:00:00 UTC. */
const SCALE_EPOCH_OFFSET = 946684800;

/**
 * Payload byte of the A00D history-response frame sent in reply to the scale's
 * 0x21 config request: `a0 0d 04 <byte> 00 ...`.
 *
 * 0xFE comes from openScale's QNHandler, which annotates it only as "Payload"
 * and took it from an ES-30M BLE capture. Two vendor-app captures on other
 * firmware in this family send 0xFC in the same position instead:
 *
 *   #235  GE CS 10 G, 20-byte extended dialect
 *   #75   Arboleaf QN-Scale FW V39, 19-byte es26m dialect
 *
 * Both were taken from sessions where the vendor app completed a weigh-in while
 * this adapter saw the whole handshake acknowledged and then silence, and both
 * reporters reached the same reading of it independently: that the byte selects
 * between a live report stream and the stored-history path.
 *
 * That reading is NOT established, and the default therefore does not move.
 * openScale dispatches live 0x10 weight frames while sending 0xFE, so the byte
 * plainly does not gate the live stream on the firmware it was captured from,
 * and the 0x23 stored-record path this adapter relies on for V10 Renpho and
 * ES-CS20M firmware (#213) hangs off the same exchange. A wrong value here is
 * silent in exactly the way a wrong `qn_protocol_byte` is: every command is
 * acknowledged and no weight ever arrives. So `ble.qn_report_byte` exists to
 * let the reporters test 0xFC on their own hardware, and the default changes
 * only if that produces a reading.
 */
const REPORT_BYTE_DEFAULT = 0xfe;

/**
 * Report byte for the 20-byte extended dialect (#235).
 *
 * Unlike the default above, this one is not an inference. A vendor-app HCI
 * capture of a scale on this dialect writes `a0 0d 04 fc ...` five times across
 * three weigh-ins and never sends 0xFE, the scale acknowledges each one by
 * echoing the byte back as `a1 07 04 fc 01 10 b9`, and 59 live 0x10 weight
 * frames follow. So on this firmware 0xFC is simply what the protocol uses.
 *
 * Gated on the dialect for the reason this file already applies to the
 * measurement trigger a few lines below: the capture covers this firmware and
 * no other, every other QN variant in the registry reads today on 0xFE, and an
 * unexplained change is not something to hand them on spec. `ble.qn_report_byte`
 * overrides either value if a unit disagrees.
 */
const REPORT_BYTE_EXTENDED = 0xfc;

/**
 * Grace period (ms) to wait for an impedance frame after the first stable
 * R1=R2=0 frame on long-frame variants (e.g. ES-26M). If an impedance frame
 * arrives within this window, it supersedes the weight-only reading. If not,
 * the weight-only reading is accepted on the next stable frame.
 */
const IMPEDANCE_GRACE_MS = 1500;

/**
 * Max age (seconds) of a 0x23 stored record relative to session start before it
 * is treated as stale history and ignored. Mirrors openScale QNHandler's
 * MAX_STORED_RECORD_AGE_BEFORE_SESSION_SECONDS. Prevents importing an old
 * weigh-in saved days before the current connection (#213 / #75).
 */
const MAX_STORED_RECORD_AGE_SEC = 90;

/**
 * Bounded re-query of the 0x22 stored-data command when a 0x23 record is stale
 * or empty. V10 firmware may return an old slot first and only save the fresh
 * weigh-in a moment later, so we re-ask a few times (openScale retries 10x/5s;
 * we use a shorter window to fit the scale's brief connection). #213 / #75.
 */
const MAX_STORED_QUERY_ATTEMPTS = 6;
const STORED_QUERY_RETRY_MS = 3000;

/**
 * Cap on AE00 challenge responses per session. The captured vendor exchange
 * contains exactly one scale-issued challenge; more than a couple means the
 * scale is rejecting the response, and answering forever would be a write storm.
 */
const MAX_AE00_RESPONSES = 3;

/**
 * Smallest 0x12 scale-info frame that carries a usable vendor protocol type at
 * byte[2]. The 18-byte Renpho ES-26M frame does not: that hardware was verified
 * working with proto 0x00 (45e4d6e). The 20-byte GE CS 10 G frame does: the
 * vendor app echoes its byte[2] (0xff) in 0x13/0x20/0x22 on the same scale, and
 * the frame carries two extra fields before the checksum, so it is a later
 * revision of the same layout (#235).
 */
const EXTENDED_INFO_FRAME_LEN = 20;

/**
 * Smallest long 0x12 frame whose byte[2] is echoed back on the first attempt.
 *
 * Separate from EXTENDED_INFO_FRAME_LEN on purpose: that constant decides which
 * dialect the scale speaks (and therefore whether the measurement trigger and
 * the result-frame decode apply), this one decides only which protocol byte to
 * open with. The 18-byte frame opens with 0x00 because a working unit sits
 * behind that value; anything longer opens with the echo.
 */
const PROTO_ECHO_MIN_INFO_FRAME_LEN = 19;

/** Protocol byte for a long frame whose byte[2] is not echoed back. */
const LEGACY_PROTO_TYPE = 0x00;

/**
 * Measurement trigger for the extended dialect (#235).
 *
 * On the GE CS 10 G the vendor app writes this frame twice immediately after the
 * 0x22 START, and the 0x10 weight stream begins straight afterwards. Without it
 * the scale accepts the whole handshake, answers 0x14 and 0x21, and then goes
 * quiet: @hedoric's retest on the proto fix confirmed every other command is now
 * byte identical to the app's and this is the only remaining difference.
 *
 * It is a well formed QN frame (checksum 0xea = sum of the preceding bytes) but
 * a DIFFERENT one from the A2 user profile we already send at ready time, which
 * carries 0x32 and the user's age. Payload bytes 0x1e and 0x23 are constant
 * across every session in the capture and are replayed verbatim: what they mean
 * is not known, so they are not derived from anything.
 */
const EXTENDED_MEASUREMENT_TRIGGER = [0xa2, 0x06, 0x01, 0x1e, 0x23, 0xea];

/** How many times the vendor app repeats the trigger, and the gap it leaves. */
const TRIGGER_REPEATS = 2;
const TRIGGER_GAP_MS = 150;

/**
 * Completed-weigh-in result frames on the extended dialect (#235).
 *
 * The 20-byte GE CS 10 G / "Fit Plus" does NOT stream 0x10 live frames after a
 * full body-composition weigh-in. Once the impedance sweep finishes it sends a
 * burst of result frames the adapter had been dropping at the ignore branch, so
 * the handshake succeeded end to end yet nothing ever reached the exporters:
 *
 *   0xB1 .. 03 01 : live sweep record, 44 bytes. THE weight source.
 *       [5-6]   weight, LE uint16, /100 kg
 *       [7..]   impedance channels
 *   0xB4 .. 04 01 : stored history record, 44 bytes. Weight only when fresh.
 *       [7-10]  record timestamp, LE uint32 (scale 2000-epoch)
 *       [11-12] recorded weight, LE uint16, /100 kg
 *       [13..]  impedance channels, all zero on a record the scale has not
 *               finished computing
 *
 * The 0xB4 was originally read as the authoritative final weight. It is not: it
 * is a HISTORY record, and the timestamp at [7] proves it. In @hedoric's own
 * three-connect log the first connect's 0xB4 carries 67.10 kg stamped six days
 * earlier with an all-zero impedance body, while the 0xB1 in the same burst
 * carries the live 75.25 kg; the third connect's 0xB4 is stamped 178 seconds
 * before the session began, which is the PREVIOUS connect's weigh-in. Preferring
 * 0xB4 therefore publishes a stale weight, and on that first connect it would
 * have exported 67.10 kg to Garmin for a 75 kg user. The middle connect sends no
 * 0xB4 at all, so 0xB1 is not a fallback in any case: it is the live value.
 *
 * The 0xB4 is still accepted when its timestamp is inside the same freshness
 * window the 0x23 stored records use, since a genuinely current record is the
 * scale's own averaged figure. Anything older is left to the stored-record path,
 * which exists for exactly that.
 *
 * @hedoric hardware-verified the live values against the scale's own display:
 * 75.20 kg, BMI 20.2 in the 0xB1 03 03 tail, cross-checked as
 * 75.20 / 1.93^2 = 20.19. Every frame carries the standard QN trailing sum.
 *
 * Impedance is deliberately NOT forwarded to the BIA estimator yet. The channels
 * are a proprietary multi-frequency segmental sweep in raw units (~2,300-3,050),
 * not the single ~500 ohm whole-body value computeBiaFat expects (it divides
 * height^2 / impedance), and feeding one in raw yields a ~57% fat nonsense.
 * Until the channels are calibrated the reading is emitted weight-only, so body
 * composition falls back to the same profile-based estimate broadcast-only
 * scales already use. Weight and BMI are the parts this decode is sure of.
 */
/**
 * How far before the session's start a 0xB4 record may be stamped and still
 * count as this weigh-in. Covers clock offset between the scale and the host,
 * nothing more: anything genuinely earlier is a previous measurement.
 */
const RESULT_RECORD_CLOCK_TOLERANCE_SEC = 10;

const RESULT_OPCODE_B4 = 0xb4;
const RESULT_OPCODE_B1 = 0xb1;
const RESULT_MIN_WEIGHT_KG = 5;
const RESULT_MAX_WEIGHT_KG = 300;

export class QnScaleAdapter
  implements ScaleAdapterCore, GattWiring, BroadcastSource, MultiCharNotify
{
  readonly name = 'QN Scale';
  readonly match: MatchDescriptor = {
    priority: 250,
    custom: true,
    names: { includes: ['qn-scale', 'renpho', 'senssun', 'sencor'] },
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

  /** Stored connection context for notification-driven state machine writes. */
  private ctx: ConnectionContext | null = null;

  /** Protocol type byte captured from the scale's 0x12 frame, echoed in config commands. */
  private seenProtocolType = 0x00;

  /**
   * Configured display unit. The 0x13 config command tells the scale which unit
   * to show, so hardcoding kg flipped a user's lbs display on every read (#269).
   * Injected via configure() from scale.weight_unit; defaults to kg.
   */
  private displayUnit: WeightUnit = 'kg';

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

  /** Number of 0x22 stored-data re-queries sent this session. */
  private storedQueryAttempts = 0;

  /** Timer handle for the pending stored-data re-query. */
  private storedRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Receive the configured display unit from the composition root (#269). */
  configure(opts: AdapterRuntimeConfig): void {
    if (opts.weightUnit) this.displayUnit = opts.weightUnit;
    this.forcedProtocolType = opts.qnProtocolByte ?? null;
    this.forcedReportByte = opts.qnReportByte ?? null;
  }

  /** 0x13 config unit flag: 0x01 kg, 0x02 lb (openScale QNHandler). */
  private unitFlag(): number {
    return this.displayUnit === 'lbs' ? 0x02 : 0x01;
  }

  /** Write to FFF2 (write char), fall back to FFE3 (Type 1). */
  private async writeCmd(data: number[]): Promise<void> {
    if (!this.ctx) return;
    try {
      await this.ctx.write(CHR_WRITE, data, false);
    } catch (primaryErr: unknown) {
      try {
        await this.ctx.write(CHR_WRITE_T1, data, false);
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
    // Reset state for new connection
    this.ctx = ctx;
    this.seenProtocolType = this.forcedProtocolType ?? 0x00;
    this.weightScaleFactor = 100;
    this.hasAe00 = false;
    this.ae02Subscribe = null;
    this.ae00ChallengeSeen = false;
    this.ae01Chain = Promise.resolve();
    this.ae00ResponsesSent = 0;
    this.isLongFrameVariant = false;
    this.isExtendedLongFrame = false;
    this.extendedResultEmitted = false;
    this.firstStableNoImpedanceAt = null;
    this.sessionStartedScaleSeconds = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
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

    if (!this.configSent) {
      this.seenProtocolType = this.forcedProtocolType ?? 0xff;
      bleLog.debug(
        `QN: fallback: no 0x12 received, running handshake with ` +
          `proto=0x${this.seenProtocolType.toString(16).padStart(2, '0')}`,
      );
      // handleScaleInfo sends AE01 init + 0x13 config
      await this.handleScaleInfo();
      await wait(500);
    }

    if (!this.timeSyncSent) {
      bleLog.debug('QN: fallback: sending time sync + profile');
      await this.handleReady();
      await wait(500);
    }

    if (!this.historyResponseSent) {
      bleLog.debug('QN: fallback: sending history + start');
      await this.handleConfigRequest();
    }
  }

  /**
   * Name match is sufficient (brand names are unambiguous).
   * UUID fallback covers unnamed devices advertising QN vendor services.
   *
   * Note: openScale requires BOTH name AND UUID, but on Linux (node-ble / BlueZ
   * D-Bus) advertised service UUIDs are not available before connection, so
   * name-only matching is needed for auto-discovery without SCALE_MAC.
   */
  matches(device: BleDeviceInfo): boolean {
    // AABB broadcast protocol (0xFFFF company ID + 0xAABB magic header)
    if (device.manufacturerData) {
      const { id, data } = device.manufacturerData;
      if (id === 0xffff && data.length >= 19 && data[0] === 0xaa && data[1] === 0xbb) {
        return true;
      }
    }

    const name = (device.localName || '').toLowerCase();
    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());

    // AE00 is a QN-only service (Renpho ES-CS20M / newer firmware), never shared
    // with the fff0 Inlife/1byone/Eufy cluster. It positively identifies a QN
    // scale even when the device also carries a non-QN name and advertises fff0
    // (e.g. GE CS 10 G "Fit Plus", #235), so check it before name/fallback logic.
    // Compare both short 16-bit and full 128-bit forms, mirroring hasQnVendor.
    const chars = (device.characteristicUuids || []).map((u) => u.toLowerCase());
    const hasAe00 =
      uuids.some((u) => u === SVC_AE00 || u === uuid16(0xae00)) ||
      chars.some((u) => u === 'ae01' || u === 'ae02' || u === CHR_AE01 || u === CHR_AE02);
    if (hasAe00) return true;

    const hasQnVendor = uuids.some(
      (u) => u === SVC_T1 || u === SVC_T2 || u === uuid16(0xffe0) || u === uuid16(0xfff0),
    );

    const nameMatch =
      name.includes('qn-scale') ||
      name.includes('renpho') ||
      name.includes('senssun') ||
      name.includes('sencor');
    if (nameMatch) {
      // #191: a device named only via 'renpho' (not the QN-specific names)
      // that advertises a SIG Weight Scale / Body Composition service but NO
      // QN vendor service is a Renpho ES-WBE28 (proprietary 0x2A9D payload),
      // handled by RenphoScaleAdapter. Mirror its mutual-exclusion
      // symmetrically so this (registry-earlier) adapter does not shadow it.
      // QN-protocol Renpho scales advertise 0xFFE0/0xFFF0, or no SIG service
      // (e.g. Linux scans with empty UUIDs), so they are unaffected.
      const onlyRenpho =
        name.includes('renpho') &&
        !name.includes('qn-scale') &&
        !name.includes('senssun') &&
        !name.includes('sencor');
      const looksLikeWbe28 =
        !hasQnVendor &&
        uuids.some(
          (u) =>
            u === SVC_SIG_BCS || u === SVC_SIG_WSS || u === uuid16(0x181b) || u === uuid16(0x181d),
        );
      if (onlyRenpho && looksLikeWbe28) return false;
      return true;
    }

    // QN Type-1 structural signature: notify 0xFFE1 + write 0xFFE3. The ESP32
    // autonomous-connect path resolves an adapter from characteristics alone
    // (no advertised name, no service UUIDs), so a Type-1 QN otherwise falls
    // through to the proxy's notify-only fallback and is mis-picked as Yunmai
    // on the shared 0xFFE4 char, then hangs on the missing 0xFFE9 (#272). 0xFFE3
    // as a write char is unique to QN; 0xFFE1 alone is shared with Beurer, so
    // require BOTH. Compare short and dashless-128-bit forms like hasAe00 above.
    const hasQnType1Chars =
      chars.some((u) => u === 'ffe1' || u === CHR_NOTIFY_T1) &&
      chars.some((u) => u === 'ffe3' || u === CHR_WRITE_T1);

    // #229: the Beurer BF7xx/BF9xx diagnostic scales expose a vendor 0xFFF0
    // service alongside their SIG stack (confirmed in the BF788 HCI snoop:
    // services 0x181B, 0x181D, 0x181C AND 0xFFF0), so hasQnVendor is true for
    // them. With no advertised name, which is the norm on the MAC-pinned
    // post-connect path, this fallback claimed the scale at priority 250 and the
    // reporter saw it alternate between QN Scale and Standard GATT, reading
    // nothing either way. The SIG User Control Point is the discriminator: it
    // belongs to the User Data service, which a QN scale does not implement.
    // Mirrors the looksLikeWbe28 mutual exclusion above.
    const hasSigConsent =
      chars.some((u) => u === '2a9f' || u === CHR_SIG_USER_CONTROL_POINT) &&
      chars.some((u) => u === '2a9d' || u === CHR_SIG_WEIGHT_MEASUREMENT);

    // Fallback: match by QN vendor service UUID or the Type-1 char pair, but
    // only for unnamed devices. Named devices (e.g. "eufy T9149") should match
    // their own specific adapter rather than being caught by these generic
    // structural checks.
    if (!name && !hasSigConsent && (hasQnVendor || hasQnType1Chars)) return true;

    return false;
  }

  /**
   * Parse QN vendor notifications.
   *
   * Implements a notification-driven state machine for the handshake:
   *   0x12 (scale info) -> AE01 init + 0x13 config with echoed protocol type
   *   0x14 (ready ACK)  -> 0x20 time sync + A2 user profile + "pass" auth
   *   0x21 (config req)  -> A00D history responses + 0x22 start
   *   0x10 (weight)      -> parse weight (original or ES-30M format)
   *
   * State machine writes are fire-and-forget (async, not awaited) so they
   * don't block the synchronous parseNotification return.
   */
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
        const byLength = data.length >= PROTO_ECHO_MIN_INFO_FRAME_LEN ? data[2] : LEGACY_PROTO_TYPE;
        this.seenProtocolType = this.forcedProtocolType ?? byLength;
        this.weightScaleFactor = 10;
      } else {
        // Classic short frame
        this.isLongFrameVariant = false;
        this.isExtendedLongFrame = false;
        this.seenProtocolType = this.forcedProtocolType ?? data[2];
        this.weightScaleFactor = data[10] === 1 ? 100 : 10;
      }
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
      bleLog.debug('QN: ready frame, sending time sync + profile');
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
    // reach this parser (we declare no parseCharNotification, so shared.ts feeds
    // every characteristic through the same UUID-blind path) and vanished without
    // a trace. Log the frame so the next reporter log carries the evidence.
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

    if (!stable) return null;

    let weight = rawWeight / this.weightScaleFactor;

    // Heuristic fallback (from QNHandler): if weight looks unreasonable, try alternate factor
    if (weight <= 5 || weight >= 250) {
      const altFactor = this.weightScaleFactor === 100 ? 10 : 100;
      const altWeight = rawWeight / altFactor;
      if (altWeight > 5 && altWeight < 250) {
        weight = altWeight;
      }
    }

    if (weight <= 0 || !Number.isFinite(weight)) return null;

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

    // Standard QN trailing checksum: sum of every byte but the last, mod 256.
    // Verified against every captured 0xB4/0xB1 frame; a cheap guard against a
    // truncated or mis-framed notification being read as a weight.
    let sum = 0;
    for (let i = 0; i < data.length - 1; i++) sum = (sum + data[i]) & 0xff;
    if (sum !== data[data.length - 1]) return null;

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

    // Step 1: subscribe AE02 if it has not happened yet. On Linux 0x12 can
    // arrive before onConnected finishes, so both paths call the same memoised
    // helper instead of racing two independent subscribes (#75).
    await this.ensureAe02Subscribed();

    // Step 2: AE01 init. Fails silently on firmware without AE00.
    await this.writeAe01([0xfe, 0xdc, 0xba, 0xc0, 0x06, 0x00, 0x02, 0x01, 0x01, 0xef]);
    await wait(200);

    // Step 3: 0x13 config
    // byte[3] = unit flag: 0x01 (kg) or 0x02 (lb) per openScale QNHandler. Honour
    // the configured unit so a read does not flip the scale's display (#269).
    // The Renpho app uses 0x08 which also works but switches the scale display to lb.
    const cmd = [0x13, 0x09, this.seenProtocolType, this.unitFlag(), 0x10, 0x00, 0x00, 0x00, 0x00];
    cmd[8] = cmd.reduce((a, b) => a + b, 0) & 0xff;
    await this.writeCmd(cmd);
  }

  /** Respond to 0x14 (ready) with 0x20 time sync + A2 user profile + AE01 auth. */
  private async handleReady(): Promise<void> {
    if (this.timeSyncSent) return;
    this.timeSyncSent = true;
    // 0x20 time sync: seconds since 2000-01-01, little-endian
    const secs = Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
    const timeCmd = [
      0x20,
      0x08,
      this.seenProtocolType,
      secs & 0xff,
      (secs >> 8) & 0xff,
      (secs >> 16) & 0xff,
      (secs >> 24) & 0xff,
      0x00,
    ];
    timeCmd[7] = timeCmd.reduce((a, b) => a + b, 0) & 0xff;
    await this.writeCmd(timeCmd);

    // A2 user profile
    if (this.ctx) {
      const age = Math.min(0xff, Math.max(1, this.ctx.profile.age));
      const profileCmd = [0xa2, 0x06, 0x01, 0x32, age, 0x00];
      profileCmd[5] = profileCmd.reduce((a, b) => a + b, 0) & 0xff;
      await this.writeCmd(profileCmd);
    }

    // "pass" authentication on AE01. Always attempted; fails silently without AE00.
    await this.writeAe01([0x02, 0x70, 0x61, 0x73, 0x73]);
  }

  /** Respond to 0x21 (config request) with A00D history frames + 0x22 start measurement. */
  private async handleConfigRequest(): Promise<void> {
    if (this.historyResponseSent) return;
    this.historyResponseSent = true;
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // A00D response 1 (from openScale QNHandler). byte[3] is the payload byte
    // `ble.qn_report_byte` overrides; see REPORT_BYTE_DEFAULT / _EXTENDED.
    const dialectDefault = this.isExtendedLongFrame ? REPORT_BYTE_EXTENDED : REPORT_BYTE_DEFAULT;
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

    // A00D response 2 (from openScale QNHandler)
    const msg2 = [0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 0x21, 0x06, 0xb8, 0x04, 0x02, 0x00];
    msg2[12] = msg2.reduce((a, b) => a + b, 0) & 0xff;
    await this.writeCmd(msg2);

    await wait(200);

    // 0x22 start measurement / stored-data query with echoed protocol type
    await this.writeCmd(this.buildStoredDataQuery());

    // Extended dialect only: the scale needs an explicit trigger after START
    // before it will stream 0x10 frames (#235). Gated on the dialect because
    // that is the only firmware the capture covers; every other QN scale in the
    // registry reads today without it, and an unexplained extra write is not
    // something to hand them on spec.
    if (!this.isExtendedLongFrame) return;
    for (let i = 0; i < TRIGGER_REPEATS; i++) {
      if (i > 0) await wait(TRIGGER_GAP_MS);
      await this.writeCmd([...EXTENDED_MEASUREMENT_TRIGGER]);
    }
    bleLog.debug('QN: extended-dialect measurement trigger sent (#235)');
  }

  /**
   * Drop timers and the connection context when the session ends.
   *
   * Both timers write through `this.ctx`. The adapter instance is shared across
   * sessions, so one left armed past a disconnect fires against a dead link, or
   * worse against the next session's context. Same class of defect as #138.
   */
  onSessionEnd(): void {
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

  /**
   * Parse AABB broadcast protocol (manufacturer data with company ID 0xFFFF).
   *
   * Layout (after company ID bytes):
   *   [0-1]   0xAABB magic header
   *   [2-7]   MAC address of the device
   *   [15]    status flags, bit 5 (0x20) = measurement stable
   *   [17-18] weight: little-endian uint16 / 100 = kg
   *
   * No impedance is available from the broadcast. Body composition is estimated
   * using the Deurenberg formula (BMI + age + gender).
   */
  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    if (manufacturerData.length < 19) return null;
    if (manufacturerData[0] !== 0xaa || manufacturerData[1] !== 0xbb) return null;

    // Only accept stable readings (bit 5 of byte 15 = "measurement settled")
    if ((manufacturerData[15] & 0x20) === 0) return null;

    const weight = manufacturerData.readUInt16LE(17) / 100;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    return { weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    // Broadcast readings have impedance=0; GATT readings have impedance>200
    if (reading.impedance === 0) return reading.weight > 0;
    return reading.weight > 10 && reading.impedance > 200;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // In broadcast mode impedance is 0: skip BIA, let buildPayload use Deurenberg fallback
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
