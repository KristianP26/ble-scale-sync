import type { ScaleReading } from '../../interfaces/scale-adapter.js';
import type { QnDialectKind } from './dialect.js';

/**
 * Everything one QN session knows, created whole when the session starts
 * (D075), so no field can outlive it through a forgotten reset (#394, #406).
 * What has to outlive a session (options, the ledger, the readings' pins, the
 * context and the session counter) stays on the adapter.
 */
export class QnSession {
  constructor(
    /** Protocol type byte captured from the scale's 0x12 frame, echoed in config commands. */
    public seenProtocolType = 0x00,
    /** The ledger's mark when this session started (see QnLedger.mark). */
    readonly storedMarkAtSessionStart = 0,
    /**
     * Scale-epoch seconds (2000-epoch) captured when the connection opened, used
     * as the freshness reference for 0x23 stored records. Falls back to the
     * current time when a record arrives before onConnected ran.
     */
    public sessionStartedScaleSeconds: number | null = null,
  ) {}

  /**
   * Weight divisor, 100 or 10, named by bit 0 of the 0x12 flags byte [10]
   * (INFO_DIVISOR_BIT, D068); 100 until a 0x12 arrives.
   */
  weightScaleFactor = 100;

  /**
   * The dialect this session's 0x12 named; `unknown` until one arrives, so
   * `weightScaleFactor` is then the default, a guess (C-06).
   */
  kind: QnDialectKind = 'unknown';

  /** One "divisor in doubt, reading dropped" warning per session (C-06). */
  divisorDoubtWarned = false;

  /** Whether the AE00 service is available (newer firmware). */
  hasAe00 = false;

  /**
   * In-flight AE02 subscribe, shared by onConnected and the 0x12 state machine.
   * Both used to fire because `hasAe00` is only set after the await, and every
   * subscribe adds another notification listener, so each AE02 frame was
   * dispatched four times (#75).
   */
  ae02Subscribe: Promise<boolean> | null = null;

  /** Whether an AE00 challenge frame has already been reported this session. */
  ae00ChallengeSeen = false;

  /** Serialises every AE01 write within one session (see writeAe01). */
  ae01Chain: Promise<void> = Promise.resolve();

  /**
   * AE00 challenges answered this session. The captured vendor exchange has
   * exactly one scale-issued challenge, so a scale that keeps challenging is
   * rejecting our response; answering it forever would be a write storm on a
   * link that is already failing.
   */
  ae00ResponsesSent = 0;

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
  appProfileSequence: boolean | null = null;

  /** One "refused the profile sent with ble.qn_user_key" line per session (#463). */
  visitRefusedLogged = false;

  /** One anchor-fallback warning per session, reset in onConnected. */
  anchorFallbackWarned = false;

  /** One "20-byte live frame" debug line per session, on either 20-byte path (#331). */
  twentyByteFrameLogged = false;

  /**
   * The 19-byte dialect's streamed weigh-in (#331, D037). `live20Seen`: a
   * well-formed 20-byte 0x10 arrived this session, which is what makes later
   * 0x15/0x16 frames part of the same weigh-in.
   * `live20Weight`: the stable weight, held until 0x16 (`live20ResultSeen`)
   * closes the weigh-in.
   */
  live20Seen = false;
  live20Weight: number | null = null;
  live20ResultSeen = false;

  /**
   * What the scale's own composition for this session's weigh-in is judged by
   * (#331): the result block's parts and its 0x15, the profile frame sent and
   * the scale's answer, whether the scale reports percentages (ready frame),
   * whether it measured after accepting the profile, and whether the
   * `qn_a4_prelude` frames went out.
   */
  live20Block: Buffer[] = [];
  live20C15: Buffer | null = null;
  visitSent: { slot: number; frame: readonly number[] } | null = null;
  visitReply: { slot: number; ok: boolean } | null = null;
  readyValueType: number | null = null;
  measuredAfterVisit = false;
  a4PreludeSent = false;

  /**
   * The scale answers this session's 0x22 only once it has finished measuring
   * (#331), so when that answer comes says whether it measured after the link
   * came up, even for a weight that settled before the scale accepted the
   * profile and was followed by no live frame. `visitAcceptedAtMs`: when the
   * scale accepted the profile; `storedQuerySentAtMs`: when our 0x22 went out;
   * `queryAnswered`: the first answer (a 0x23, or the result block) has come;
   * `answerAfterVisitMs`: how long after the acceptance it came.
   */
  visitAcceptedAtMs: number | null = null;
  storedQuerySentAtMs: number | null = null;
  queryAnswered = false;
  answerAfterVisitMs: number | null = null;

  /**
   * The 18-byte weigh-in that came before the scale's answer to our 0x22,
   * held for that answer with `ble.qn_user_key` (#463, D065), and how far the
   * answer has got: `storedAnswerLast`, its last record (a 0x23 with [4] at
   * [3]) has come; `storedAnswerDone`, it is over, on a 0x23 that says the
   * scale holds no stored weigh-ins or on the 0x25 after the last record,
   * where the vendor's SDK completes a record. `storedAnswerTimer` says so in
   * the log when the hold runs out first, and onSessionEnd when the session
   * ends later with the weigh-in still held; `storedAnswerReasonLogged` keeps
   * it to one line.
   */
  heldForStoredAnswer: ScaleReading | null = null;
  storedAnswerLast = false;
  storedAnswerDone = false;
  storedAnswerTimer: ReturnType<typeof setTimeout> | null = null;
  storedAnswerReasonLogged = false;

  /**
   * A 0x10 first part with status measuring or stable arrived this session, or
   * the scale's first answer to our 0x22 came MEASURED_ANSWER_MIN_MS or more
   * after it, so the scale measured while we were connected. A result block
   * without either is a weigh-in the scale finished before the link came up
   * (#331).
   */
  live20Measured = false;

  /** This session's result block repeated a live result already reported. */
  live20Replayed = false;

  /**
   * The 19-byte dialect's stored weigh-ins (#331): the frames of the record
   * being assembled (three 0x23 parts, 0x24, 0x25), whether a fresh one is
   * held for a live result that may replace it, and the scale-epoch seconds of
   * the records reported this session.
   */
  storedParts: Buffer[] = [];
  storedHoldArmed = false;
  readonly storedEmitted = new Set<number>();

  /**
   * The 18-byte dialect's stored records judged this session, by their
   * scale-epoch seconds, so a record the re-query brings back gets no second
   * line (#463).
   */
  readonly storedJudged = new Set<number>();

  /**
   * The fresh stored weigh-in the session holds right now ("W kg at T"), so the
   * log can say when a later reading takes its place in the hold and it is not
   * exported (#331).
   */
  heldStoredWeighIn: string | null = null;

  /**
   * Whether a completed-weigh-in result frame (0xB4/0xB1) has already produced a
   * reading this session. The scale repeats the 0xB4 frame ~3x and then sends
   * the 0xB1 records, all describing the one weigh-in, so the reading is emitted
   * exactly once and the repeats are suppressed (#235).
   */
  extendedResultEmitted = false;

  /**
   * Timestamp (Date.now()) of the first stable R1=R2=0 frame seen on a
   * long-frame variant. After IMPEDANCE_GRACE_MS without an impedance frame,
   * subsequent R1=R2=0 stable frames are accepted.
   */
  firstStableNoImpedanceAt: number | null = null;

  /** Deduplication guards: prevent duplicate state machine responses. */
  configSent = false;
  timeSyncSent = false;
  historyResponseSent = false;

  /** Fallback timer handle for cancellation when state machine fires normally. */
  fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  /** Number of 0x22 stored-data re-queries sent this session. */
  storedQueryAttempts = 0;

  /** Timer handle for the pending stored-data re-query. */
  storedRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The advertisement this session matched on flags the resistance as
   * scrambled (#461, see SCRAMBLE_FLAG_BIT). Set in onConnected, before
   * anything is written, so it is in place before any frame with a resistance
   * can arrive: the scale sends those only after the handshake.
   */
  resistanceScrambled = false;

  /**
   * No manufacturer data reached this session, or only a company id without
   * bytes (#463), so the flag is unknown: the 18-byte dialect then reads a
   * resistance with high byte 0x10 or 0x12 unscrambled (see
   * SCRAMBLED_ONLY_HIGH_BYTES). Set in onConnected.
   */
  noAdvertisement = false;

  /** One info line per 18-byte session without an advertisement (#463). */
  noAdvertisementLogged = false;

  /** One "unscrambled impedance is not a body" warning per session (#461). */
  unscrambledImplausibleWarned = false;

  /** Stop this session's timers: one left armed would fire into the next session (#138). */
  dispose(): void {
    for (const t of [this.fallbackTimer, this.storedRetryTimer, this.storedAnswerTimer]) {
      if (t) clearTimeout(t);
    }
    this.fallbackTimer = this.storedRetryTimer = this.storedAnswerTimer = null;
  }
}
