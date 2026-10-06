/**
 * QN-family constants, and the decode narrative that goes with them.
 *
 * Most of this file is evidence rather than code: which capture a value came
 * from, which unit it was hardware-confirmed on, and what was ruled out. It is
 * the only record of several of those findings, and `.claude/docs/PROTOCOLS.md`
 * cites it. Do not tidy a comment away here without checking what it is the
 * proof of.
 *
 * One wart carried over from the single-file version: the 0xB1/0xB4 narrative
 * below is attached to RESULT_RECORD_CLOCK_TOLERANCE_SEC, while what it
 * actually documents is RESULT_OPCODE_B4 and RESULT_OPCODE_B1 a few lines down.
 */

import { uuid16 } from '../body-comp-helpers.js';

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
 *                        (no A2 on the 19-byte dialect with ble.qn_weight_ack)
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
 * 0x10 frame (19-byte dialect, 20 bytes, weight at [5..6] /100): see
 *   LIVE20_FRAME_LEN below.
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
 *   0x20 are each one byte longer than ours. The 0x20 delta is one trailing
 *   0x08 before the checksum and is reproducible behind `ble.qn_time_sync_long`
 *   (see TIME_SYNC_TRAILER). The 0x13 delta IS in the #235 captures: bytes
 *   `[0..6]` match ours and the whole difference is a pair at `[7..8]` where we
 *   send one byte. What that pair means is not decoded; it is reproducible
 *   behind `ble.qn_config_long` (see CONFIG_TRAILER in frames.ts).
 */

// Type 2 UUIDs (most common variant)
export const CHR_NOTIFY = uuid16(0xfff1);
export const CHR_WRITE = uuid16(0xfff2);

// Type 1 UUIDs (alternate variant, service 0xFFE0)
export const CHR_NOTIFY_T1 = uuid16(0xffe1);
export const CHR_WRITE_T1 = uuid16(0xffe3);

/**
 * The two frames the Arboleaf vendor app sends between START (0x22) and the
 * first live 0x10 weight frame, replayed verbatim from the HCI capture in #331
 * (Arboleaf CS10E, iOS PacketLogger, identifying data stripped by the
 * reporter). The scale answers each with `a5 04 <sub-index> <checksum>` and
 * only then starts streaming.
 *
 *   a4 0f 01 21 0a 48 08 f1 0a 33 08 da 08 80 c7
 *   a4 0f 01 22 06 78 09 f3 07 db 01 c1 01 a5 9a
 *
 * Opcode 0xA4, length 0x0F, then 0x01, a sub-index (0x21 then 0x22), ten
 * payload bytes, and the family's usual sum-of-preceding-bytes checksum, which
 * both frames satisfy.
 *
 * THE PAYLOAD IS NOT DECODED. The five uint16 pairs in each frame look like
 * per-user calibration or a previous measurement handed back, the same shape as
 * the 0xA2 weight anchor, so replaying one person's bytes on another person's
 * scale may or may not be right. That is exactly why this is opt-in
 * (`ble.qn_a4_prelude`) and off by default: the reporter's own log shows the
 * add-on going silent precisely where these two frames belong, so it is worth
 * being able to try, but it is not something to hand the rest of the QN family
 * on spec. If it works for more than one unit, the payload deserves decoding
 * before this becomes a dialect default.
 *
 * Two Android captures of another reporter's Arboleaf (#75, #331) back that
 * caution. The app sends the same two frames there with DIFFERENT payload
 * bytes (`a4 0f 01 21 0a 5b 09 53 0a e9 09 d5 0c a1 14`), so the payload is per
 * user or per session, not a constant. Both send them only after the two
 * weight-anchor A2 frames, and in the later capture the first live 0x10
 * arrives before them, so on that unit they are not what opens the stream.
 * With `ble.qn_weight_ack` set on any dialect but the 20-byte extended one
 * they therefore go out after that A2 pair; the extended order is unchanged.
 *
 * The values in the #75 frames are of the same size and spread as the
 * 19-byte dialect's result block (see LIVE20_FRAME_LEN) from that same unit,
 * so the payload looks like a previous measurement record of the person who
 * captured it, handed back to the scale. Hypothesis only: one value lines up
 * exactly, the rest are 3 to 10 percent apart. Replaying it on another
 * person's scale is one more reason this stays off by default.
 */
export const A4_PRELUDE: readonly (readonly number[])[] = [
  [0xa4, 0x0f, 0x01, 0x21, 0x0a, 0x48, 0x08, 0xf1, 0x0a, 0x33, 0x08, 0xda, 0x08, 0x80, 0xc7],
  [0xa4, 0x0f, 0x01, 0x22, 0x06, 0x78, 0x09, 0xf3, 0x07, 0xdb, 0x01, 0xc1, 0x01, 0xa5, 0x9a],
];

/** Gap between the two prelude frames, matching the capture's pacing. */
export const A4_PRELUDE_GAP_MS = 200;

// AE00 service UUIDs (newer firmware, e.g. Renpho ES-CS20M)
export const CHR_AE01 = uuid16(0xae01);
export const CHR_AE02 = uuid16(0xae02);

// Service UUIDs for matching
export const SVC_T1 = 'ffe0';
export const SVC_T2 = 'fff0';
// AE00 vendor service (JieLi chip; newer QN firmware, e.g. Renpho Elis 1). Not
// shared with the fff0 Inlife/1byone/Eufy cluster (#235), but not unique to QN
// either: a 0x1A10 / 55AA-family scale carries it too (#436), which
// qnMatches() handles before it trusts AE00.
export const SVC_AE00 = 'ae00';

// SIG Body Composition / Weight Scale services. A 'renpho'-named device that
// advertises these but NO QN vendor service is a Renpho ES-WBE28 (#191),
// handled by RenphoScaleAdapter — see matches().
export const SVC_SIG_BCS = '181b';
export const SVC_SIG_WSS = '181d';

// SIG User Control Point + Weight Measurement. Together these identify a SIG
// consent scale (Beurer BF7xx/BF9xx), which also exposes a vendor 0xFFF0
// service and would otherwise be claimed by the nameless fallback in matches()
// (#229). The User Control Point belongs to the User Data service, which QN
// scales do not implement.
export const CHR_SIG_USER_CONTROL_POINT = uuid16(0x2a9f);
export const CHR_SIG_WEIGHT_MEASUREMENT = uuid16(0x2a9d);

/** Seconds from Unix epoch to 2000-01-01 00:00:00 UTC. */
export const SCALE_EPOCH_OFFSET = 946684800;

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
export const REPORT_BYTE_DEFAULT = 0xfe;

/**
 * Report byte for the LONG-FRAME dialects, es26m (18- or 19-byte) and extended
 * (20-byte). See #235 and #75.
 *
 * Unlike the default above, this one is not an inference. Two vendor-app
 * captures, on two scales, on both long dialects, agree:
 *
 *   extended  a raw HCI capture writes `a0 0d 04 fc ...` five times across
 *             three weigh-ins and never sends 0xFE. The scale acknowledges
 *             each one by echoing the byte back as `a1 07 04 fc 01 10 b9`,
 *             and 59 live 0x10 weight frames follow (#235).
 *   es26m     an Android btsnoop of a successful Arboleaf weigh-in sends the
 *             same frame. The reporter's own log line for that unit reads
 *             `QN: scale info (19B, dialect=es26m)`, so the dialect is not
 *             inferred from the model name (#75).
 *
 * So on the long dialects 0xFC is simply what the protocol uses.
 *
 * The 11-byte classic dialect keeps 0xFE. No capture covers it, and unlike the
 * long variants it reads today, which is exactly the asymmetry that decides it:
 * every scale reported silent after a completed handshake is on a long frame.
 * `ble.qn_report_byte` overrides either value if a unit disagrees.
 */
export const REPORT_BYTE_LONG_FRAME = 0xfc;

/**
 * Grace period (ms) to wait for an impedance frame after the first stable
 * R1=R2=0 frame on long-frame variants (e.g. ES-26M). If an impedance frame
 * arrives within this window, it supersedes the weight-only reading. If not,
 * the weight-only reading is accepted on the next stable frame.
 */
export const IMPEDANCE_GRACE_MS = 1500;

/**
 * Band a live 0x10 weight must fall in for the divisor its 0x12 frame named to
 * be taken as is. Outside it, or with no 0x12 at all, the divisor is in doubt
 * and both readings of the raw value are weighed (review C-06, see
 * `QnScaleAdapter.resolveWeight`). The ES-26M is why the band matters: its
 * 18-byte 0x12 implies /10, its captured frames read 978.5 kg that way and
 * 97.85 kg at /100.
 */
export const WEIGHT_CERTAIN_MIN_KG = 5;
export const WEIGHT_CERTAIN_MAX_KG = 250;

/**
 * How close to a user's `last_known_weight` a candidate weight must be to count
 * as that user's, as a share of it. The two candidates differ tenfold, so this
 * only has to separate a body from a tenth or ten times of one.
 */
export const LAST_KNOWN_WEIGHT_TOLERANCE = 0.15;

/**
 * Max age (seconds) of a 0x23 stored record relative to session start before it
 * is treated as stale history and ignored. Mirrors openScale QNHandler's
 * MAX_STORED_RECORD_AGE_BEFORE_SESSION_SECONDS. Prevents importing an old
 * weigh-in saved days before the current connection (#213 / #75).
 */
export const MAX_STORED_RECORD_AGE_SEC = 90;

/**
 * Bounded re-query of the 0x22 stored-data command when a 0x23 record is stale
 * or empty. V10 firmware may return an old slot first and only save the fresh
 * weigh-in a moment later, so we re-ask a few times (openScale retries 10x/5s;
 * we use a shorter window to fit the scale's brief connection). #213 / #75.
 */
export const MAX_STORED_QUERY_ATTEMPTS = 6;
export const STORED_QUERY_RETRY_MS = 3000;

/**
 * Cap on AE00 challenge responses per session. The captured vendor exchange
 * contains exactly one scale-issued challenge; more than a couple means the
 * scale is rejecting the response, and answering forever would be a write storm.
 */
export const MAX_AE00_RESPONSES = 3;

/**
 * Smallest 0x12 scale-info frame that carries a usable vendor protocol type at
 * byte[2]. The 18-byte Renpho ES-26M frame does not: that hardware was verified
 * working with proto 0x00 (45e4d6e). The 20-byte GE CS 10 G frame does: the
 * vendor app echoes its byte[2] (0xff) in 0x13/0x20/0x22 on the same scale, and
 * the frame carries two extra fields before the checksum, so it is a later
 * revision of the same layout (#235).
 */
export const EXTENDED_INFO_FRAME_LEN = 20;

/**
 * Smallest long 0x12 frame whose byte[2] is echoed back on the first attempt.
 *
 * Separate from EXTENDED_INFO_FRAME_LEN on purpose: that constant decides which
 * dialect the scale speaks (and therefore whether the measurement trigger and
 * the result-frame decode apply), this one decides only which protocol byte to
 * open with. The 18-byte frame opens with 0x00 because a working unit sits
 * behind that value; anything longer opens with the echo.
 */
export const PROTO_ECHO_MIN_INFO_FRAME_LEN = 19;

/** Protocol byte for a long frame whose byte[2] is not echoed back. */
export const LEGACY_PROTO_TYPE = 0x00;

/**
 * Measurement trigger for the extended dialect (#235).
 *
 * On the GE CS 10 G the vendor app writes this frame twice immediately after the
 * 0x22 START, and the 0x10 weight stream begins straight afterwards. Without it
 * the scale accepts the whole handshake, answers 0x14 and 0x21, and then goes
 * quiet: @hedoric's retest on the proto fix confirmed every other command is now
 * byte identical to the app's and this is the only remaining difference.
 *
 * Payload bytes [3..4] are a big-endian u16 of kg*100: the capture's 0x1e23 is
 * 7715, i.e. 77.15 kg, against a subject who weighed about 78. They are the
 * weight the scale last knew for the selected user, and the scale gates the
 * weigh-in on them. @hedoric's A/B on one scale in one session: 76 kg against
 * this hardcoded 77.15 completes every time, 65 kg against it hands over a
 * clean handshake and then silence every time, and the same 65 kg person
 * through the vendor app -- which sends her real last-known weight -- completes.
 * So replaying the constant only ever served people who happen to weigh about
 * 77 kg. `buildMeasurementTrigger` derives it from the configured user instead.
 *
 * It is a well formed QN frame (checksum = sum of the preceding bytes) but a
 * DIFFERENT one from the A2 user profile we already send at ready time, which
 * carries 0x32 and the user's age. That frame is left as openScale has it: it
 * shares this shape, and under the reading above its payload would decode as an
 * implausible ~128 kg, but no capture shows the vendor app sending it and one
 * blind edit per release is enough.
 */
export const TRIGGER_WEIGHT_FALLBACK_KG = 77.15;

/**
 * How many times the vendor app repeats the trigger, and the gap left between
 * the copies.
 *
 * The count is from captures on both long dialects (#235 GE CS 10 G, #331 and
 * #75 Arboleaf). The 150 ms gap is NOT: the #235 work recorded no timing, and
 * the Arboleaf capture's own gap is 71 ms. It is kept for the es26m anchor as
 * well, because in that capture the second copy reaches the scale only after
 * the scale has acked the first (`a3 04 01 a8`, 62 ms after it), and a 71 ms
 * gap at the host can arrive shorter than that through a proxy transport.
 * 150 ms holds the captured order, A2 -> a3 -> A2, with margin.
 */
export const TRIGGER_REPEATS = 2;
export const TRIGGER_GAP_MS = 150;

/**
 * Delay from the 0x22 START to the first of the two weight-anchor A2 frames on
 * every dialect except the 20-byte extended one (`ble.qn_weight_ack`, #331).
 *
 * From an Android btsnoop of the Arboleaf app completing a weigh-in on the
 * 19-byte es26m dialect (#331, 2026-09-29): START, then the first A2 75.0 ms
 * later. It is a host-side time, so through a proxy it is a minimum rather
 * than an exact value. The extended dialect does not use it: its burst starts
 * straight after START, which is what was confirmed on that hardware.
 */
export const POST_START_ANCHOR_DELAY_MS = 75;

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
 * The 0xB4 is still accepted when it was written during this session (its
 * timestamp no more than RESULT_RECORD_CLOCK_TOLERANCE_SEC before the session
 * opened), since a genuinely current record is the scale's own averaged figure.
 * That is deliberately stricter than the backward-looking window the 0x23
 * stored records use (MAX_STORED_RECORD_AGE_SEC): see the 0xB4 branch in
 * index.ts for why. Anything older is left to the stored-record path.
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
export const RESULT_RECORD_CLOCK_TOLERANCE_SEC = 10;

export const RESULT_OPCODE_B4 = 0xb4;
export const RESULT_OPCODE_B1 = 0xb1;
export const RESULT_MIN_WEIGHT_KG = 5;
export const RESULT_MAX_WEIGHT_KG = 300;

/**
 * The 19-byte dialect's weigh-in stream (Arboleaf, #331, D037).
 *
 * After START this dialect streams 20-byte 0x10 frames:
 *
 *   [0]     0x10
 *   [1]     total length, 0x14 (0x15/0x16 carry their own, 0x10)
 *   [2]     0x01 on every first part seen; unit or slot, not decoded
 *   [3]     status: 0x00 measuring, 0x01 stable, 0x02 result block
 *   [4]     part: high nibble the part count, low nibble the index (0x11 = 1/1)
 *   [5..6]  weight, BE u16 /100 kg, first part only. /100 whatever
 *           weightScaleFactor says: the long 0x12 sets that to 10
 *   [7..18] zero while measuring
 *   [19]    sum of the preceding bytes
 *
 * One DEBUG log of a complete weigh-in is the whole evidence (#331,
 * 2026-10-06). The scale streams status 0x00 frames, sends one stable frame
 * (`10 14 01 01 11 1e 05 .. 5a`, 76.85 kg), then stays silent for 13.15 s while
 * it runs its BIA, then sends `23 00 .. 00 23`, a three-part result block
 * (`[4]` 0x31, 0x32, 0x33) and two 16-byte frames, `15 10 ff ..` and
 * `16 10 ff ..`. 0x16 is the last frame of the weigh-in, 13.96 s after the
 * stable one. Every one of those frames closes under the sum checksum.
 *
 * Only the weight is decoded. The continuation parts carry payload at [2..3]
 * as well as [5..18], and the reassembled block reads as two ten-value records
 * that look like a segmental, two-frequency impedance sweep (hypothesis). None
 * of its values is a whole-body impedance the BIA formula could take: most sit
 * far outside the 150-1200 ohm band, and the ones inside it differ between the
 * two records, so passing one on would be a silent BIA fat from a guess (the
 * D022 defect). 0x15 and 0x16 look like the scale's own composition results
 * and are not decoded either. The reading is therefore weight-only.
 */
export const LIVE20_FRAME_LEN = 20;
export const LIVE20_FIRST_PART_BYTE2 = 0x01;
export const LIVE20_STATUS_MEASURING = 0x00;
export const LIVE20_STATUS_STABLE = 0x01;
export const LIVE20_STATUS_RESULT = 0x02;
export const RESULT16_FRAME_LEN = 16;
export const RESULT16_OPCODE_COMPOSITION = 0x15;
export const RESULT16_OPCODE_DONE = 0x16;

/**
 * How long the link is held after the 19-byte dialect's stable weight for its
 * 0x16 (#331, D037).
 *
 * The one sample has 0x16 13.96 s after the stable frame; 20 s leaves about
 * 6 s. Ending the session on the stable weight instead cuts the link in the
 * middle of the BIA while the person is still standing on the scale, and a
 * proxy watcher can then reconnect to the still-advertising scale and send
 * START into the running measurement. The adapter reports the composition as
 * pending until 0x16, so a slower BIA gets the HOLD_EXTENSION_* steps on top,
 * and a weigh-in that never sends 0x16 (in socks, say) resolves weight-only
 * after at most 40 s.
 */
export const NINETEEN_BYTE_RESULT_HOLD_MS = 20_000;
