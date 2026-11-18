import { bleLog } from '../../../ble/types.js';
import type { ScaleReading } from '../../../interfaces/scale-adapter.js';
import {
  EIGHT_CHANNEL_ORDER,
  EXTENDED_RESULT_PARTS_HOLD_MS,
  EXTENDED_RESULT_RECORD_LEN,
  LIVE20_FRAME_LEN,
  LIVE20_STATUS_MEASURING,
  LIVE20_STATUS_RESULT,
  LIVE20_STATUS_STABLE,
  RESULT_MAX_WEIGHT_KG,
  RESULT_MIN_WEIGHT_KG,
  RESULT_OPCODE_B1,
  RESULT_OPCODE_B4,
  RESULT_RECORD_CLOCK_TOLERANCE_SEC,
  SCALE_EPOCH_OFFSET,
} from '../constants.js';
import { hex, storedSlotLabel, type QnDialectHandler } from '../dialect.js';
import { compositionRejection, r2 } from '../../body-comp-helpers.js';
import {
  decodeExtendedResult,
  extendedResultChecks,
  hasValidSumChecksum,
  joinExtendedResultParts,
  type ExtendedResult,
} from '../frames.js';
import type { QnScaleAdapter } from '../index.js';
import { scaleCompositionRejection, type ScaleCompositionPin } from '../own-composition.js';
import type { QnSession } from '../session.js';
import { dialect as va19 } from './va19.js';

/**
 * The 20-byte extended dialect (GE CS 10 G #235, Arboleaf CS10G #501 and a
 * 20-byte CS10E #331). The 20-byte live 0x10 reached this adapter from the
 * CS10E but never from the GE or the CS10G. It gives no reading: noteLiveFrame
 * reads only its slot, status and weight, to judge the scale's own
 * composition. The reading comes from these 0xB1/0xB4 result frames. The
 * burst's non-weight parts (repeated 0xB4s, the 0xB1 parts after the first)
 * come back null, so they are not logged as ignored; only a 0xB1 part that
 * comes with no first part before it gets one line (noteResultPart). A 0xB1
 * in one part also carries the scale's own results (decodeExtendedResult),
 * pinned to the reading for computeMetrics to judge (#331, D096).
 *
 * A 0xB1 in several parts (CS10G #501) is put together when a configured
 * user's profile frame went out: the first part's weight is held for the other
 * parts (hold, EXTENDED_RESULT_PARTS_HOLD_MS), the record is joined and decoded
 * and its results are logged with a dry-run of the D096 verdict, but not
 * exported yet (D103). Every failure gives the first part's weight at once.
 *
 * The Arboleaf CS10K also sends a 20-byte 0x12, but without the dynamic-package
 * bit, and weighs in with the 19-byte dialect's frames: frame() offers each one
 * to va19 first (#530). Only the bit sends a scale that way. The CS10E, CS10G
 * and GE keep this path, because va19 would turn their stable live frame into
 * a provisional reading and skip noteLiveFrame, which D096 relies on.
 * liveWeightAfterVisit stays null on the CS10K for the same reason.
 */
export const ext20 = {
  frame(q, data) {
    if (q.s.dynamicPackage === false) {
      const own = va19.frame(q, data);
      if (own !== undefined) return own;
    }
    const opcode = data[0];
    if (opcode === 0x23) {
      // A stored record is a reading of its own and would end the session on
      // another weight while the first part's one waits for its parts.
      if (q.s.resultAssembly !== null) {
        bleLog.debug('QN: 0x23 ignored while a 0xb1 waits for its parts (#501)');
        return null;
      }
      return q.storedRecord(data);
    }
    if (opcode === RESULT_OPCODE_B4 || opcode === RESULT_OPCODE_B1) return resultFrame(q, data);
    if (opcode === 0x10) {
      noteLiveFrame(q.s, data);
      noteResultBlockOnDynamicPackage(q.s, data);
    }
    return undefined;
  },

  /**
   * While a split 0xB1 waits for its other parts (D103). Not pending: the parts
   * arrive back to back, so a lost one is not worth the extension steps.
   */
  hold(s) {
    if (s.resultAssembly === null) return undefined;
    return { ms: EXTENDED_RESULT_PARTS_HOLD_MS, pending: false };
  },
} satisfies QnDialectHandler;

/** A line from onSessionEnd when the session ended with a split 0xB1 still waiting (D103). */
export function logAssemblyAtSessionEnd(s: QnSession): void {
  const a = s.resultAssembly;
  if (a === null) return;
  s.resultAssembly = null;
  bleLog.debug(
    `QN: the session ended with a 0xb1 still missing parts: ${a.parts.length} of ` +
      `${a.parts[0][2]} had come, the weight of the first one is all there is (#501)`,
  );
}

/**
 * The 19-byte dialect's result block (status 02, first of three parts) behind
 * a 0x12 that sets the dynamic-package bit: nothing here reads it, so the
 * weigh-in is lost. One debug line per session, so a log from a scale that
 * sets the bit and still sends this block shows it (#530).
 */
function noteResultBlockOnDynamicPackage(s: QnSession, data: Buffer): void {
  if (s.dynamicPackage !== true || s.resultBlockOnDynamicPackageLogged) return;
  if (data.length !== LIVE20_FRAME_LEN || data[1] !== LIVE20_FRAME_LEN) return;
  if (!hasValidSumChecksum(data)) return;
  if (data[3] !== LIVE20_STATUS_RESULT || data[4] !== 0x31) return;
  s.resultBlockOnDynamicPackageLogged = true;
  bleLog.debug(
    'QN: 20-byte result block in a session whose scale-info frame sets the ' +
      'dynamic-package bit, not read; please report this log on #530',
  );
}

/**
 * A live 0x10 for the profile's slot ([2]) with status measuring or stable
 * ([3] 00 or 01, as the CS10G app capture shows them, #501) and a body weight,
 * after the scale accepted the profile: the scale measured after that, so its
 * own composition can be for that profile (#331). Its weight (BE u16 /100 at
 * [5..6]) is kept, so a 0xB1 the scale replays from before, after a reconnect,
 * does not pass for this weigh-in (own-composition.ts). The frame itself goes
 * on to the shared path, which does not read it.
 */
function noteLiveFrame(s: QnSession, data: Buffer): void {
  if (data.length !== LIVE20_FRAME_LEN || data[1] !== LIVE20_FRAME_LEN) return;
  // Accepted for the slot of the profile frame sent, not any acceptance.
  if (!hasValidSumChecksum(data) || !s.visitAccepted || s.visitSent === null) return;
  if (data[2] !== s.visitSent.slot) return;
  if (data[3] !== LIVE20_STATUS_MEASURING && data[3] !== LIVE20_STATUS_STABLE) return;
  const weight = data.readUInt16BE(5) / 100;
  if (weight <= RESULT_MIN_WEIGHT_KG || weight >= RESULT_MAX_WEIGHT_KG) return;
  s.measuredAfterVisit = true;
  // The last one wins: the scale streams its stable frame (status 01) right
  // before the 0xB1, so that is the weight the result must carry (#331).
  s.liveWeightAfterVisit = weight;
}

/**
 * A 0xB1 part after the first with no first part before it in this session:
 * the part with the weight and the slot never reached the host. Over an ESP32
 * proxy that is firmware older than the notification queue, which kept only the
 * last notification of a burst; other transports are not known to do it, so the
 * line names the likely cause and not a certain one. One line per session (#501).
 */
function noteResultPart(s: QnSession, data: Buffer): void {
  if (data[3] === 0x01) {
    s.resultFirstPartSeen = true;
    return;
  }
  if (s.resultFirstPartSeen || s.resultPartHintLogged) return;
  s.resultPartHintLogged = true;
  bleLog.info(
    `QN: 0xb1 part ${data[3]} of ${data[2]} arrived without part 1, which carries the weight. ` +
      'On an ESP32 proxy that is likely firmware that drops notifications of a burst: flash the ' +
      'current firmware, https://blescalesync.dev/guide/esp32-proxy#flashing-the-firmware (#501)',
  );
}

/**
 * Decode an extended-dialect completed-weigh-in result frame (#235).
 *
 * Accepts the consolidated 0xB4 (weight at [11]) or the first part of the
 * 0xB1, however many parts it came in (weight at [5]). Returns a reading with
 * impedance 0 (the channels are segment impedances, see RESULT_OPCODE_*), with
 * the scale's own results pinned when a one-part 0xB1 carries them, or null
 * when the frame is not a recognised result frame, fails its
 * trailing sum checksum, carries an out-of-range weight, or a reading was
 * already emitted this session.
 *
 * The first part of a split 0xB1 with a profile frame sent gives a provisional
 * reading and opens a wait for the other parts (startsAssembly): while it is
 * open, 0xB1 frames go to nextResultPart and the reading comes back final, as
 * a copy, from the last part or from whatever ends the wait (D103).
 */
function resultFrame(q: QnScaleAdapter, data: Buffer): ScaleReading | null {
  const s = q.s;
  // A split 0xB1 waits for its parts before anything else is judged (D103).
  if (data[0] === RESULT_OPCODE_B1 && s.resultAssembly !== null) return nextResultPart(q, data);
  if (s.extendedResultEmitted) return null;

  // Standard QN trailing checksum, verified against every captured 0xB4/0xB1
  // frame; a cheap guard against a truncated or mis-framed notification being
  // read as a weight.
  if (!hasValidSumChecksum(data)) return null;

  if (data[0] === RESULT_OPCODE_B1) noteResultPart(s, data);

  let rawWeight: number | null = null;
  // [2] is how many parts the scale split the record into and [3] which part
  // this is. The count varies with the connection: three parts on the GE
  // (#235) and on the CS10G over the ESP32 proxy (#501), one 119-byte part on
  // the same CS10G with its iPhone app and on a 20-byte CS10E over an ESPHome
  // proxy (#331). Only the first part carries the slot and the weight: read
  // from [5], the CS10G's third part gives 6.99 kg.
  if (data[0] === RESULT_OPCODE_B1 && data.length >= 7 && data[3] === 0x01) {
    // Live sweep record.
    rawWeight = data.readUInt16LE(5);
  } else if (
    data[0] === RESULT_OPCODE_B4 &&
    data.length >= 13 &&
    data[2] === 0x04 &&
    data[3] === 0x01
  ) {
    // History record: usable only when it was written DURING this session.
    // Read in the GE's split only (04 01, #235). The CS10G's 03 01 (#501) and
    // the CS10E's 01 01 (#331) came with a 0xB1 that holds the weigh-in, and
    // the CS10E's 0xB4 was a record for no user (0xf0) with another weight.
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
      s.sessionStartedScaleSeconds ?? Math.floor(Date.now() / 1000) - SCALE_EPOCH_OFFSET;
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

  s.extendedResultEmitted = true;
  const decoded = data[0] === RESULT_OPCODE_B1 ? decodeExtendedResult(data) : null;
  // Named in the line only where the export can use it: a profile frame sent
  // with ble.qn_algorithm (own-composition.ts).
  const withOwn =
    decoded !== null && s.visitSent?.algorithmFromOption === true && hasMeasurement(decoded);
  // [4] is the user slot the scale took the weigh-in for, 0xf0 for none: the
  // CS10G sends 0xB1 with [4] 02 for the user its app registered in slot 2
  // (#501). Logged only, so a reporter can find the slot to set.
  bleLog.debug(
    `QN: extended result 0x${data[0].toString(16)} decoded ${weight}kg, ` +
      `${storedSlotLabel(data[4])} (no whole-body impedance, ` +
      `${withOwn ? "with the scale's own body composition" : 'emitting weight-only'}) #235`,
  );
  const reading: ScaleReading = { weight, impedance: 0 };
  if (startsAssembly(s, data)) {
    beginAssembly(q, reading, data);
    return reading;
  }
  if (data[0] === RESULT_OPCODE_B1) logExtendedResult(data, decoded);
  // Only for a session that sent a configured user's profile: nothing else
  // could ever use it (#331).
  if (decoded !== null && s.visitSent !== null) pinOwnComposition(s, reading, decoded);
  return reading;
}

/**
 * Whether this first part of a 0xB1 opens a wait for the others (D103): a
 * split record (`[2]` 2 or more) whose first part is whole, with a configured
 * user's profile frame sent, and no later part seen before it (resultPartHintLogged:
 * the burst is out of order, nothing to join). Anything else is the weight as
 * before.
 */
function startsAssembly(s: QnSession, data: Buffer): boolean {
  return (
    data[0] === RESULT_OPCODE_B1 &&
    data[3] === 0x01 &&
    data[2] >= 2 &&
    data[1] === data.length &&
    data.length - 5 < EXTENDED_RESULT_RECORD_LEN &&
    s.visitSent !== null &&
    !s.resultPartHintLogged
  );
}

/**
 * Open the wait: the first part's weight is provisional (the shared session
 * holds it, HoldForComposition) and the 0x22 re-query timer stops, so no
 * stored answer is asked for while the parts come (D103).
 */
function beginAssembly(q: QnScaleAdapter, reading: ScaleReading, data: Buffer): void {
  const s = q.s;
  if (s.storedRetryTimer) {
    clearTimeout(s.storedRetryTimer);
    s.storedRetryTimer = null;
  }
  q.provisionalReadings.add(reading);
  s.resultAssembly = { reading, parts: [Buffer.from(data)], atMs: [Date.now()] };
  bleLog.debug(
    `QN: 0xb1 part 1 of ${data[2]} (${data.length} bytes); waiting up to ` +
      `${EXTENDED_RESULT_PARTS_HOLD_MS / 1000} s for parts 2 to ${data[2]} (#501)`,
  );
}

/** Give the first part's weight back as final and end the wait (D103). */
function releaseAssembly(s: QnSession, why: string): ScaleReading | null {
  const a = s.resultAssembly;
  if (a === null) return null;
  s.resultAssembly = null;
  bleLog.debug(`QN: 0xb1 ${why}; the weight of part 1 goes out as it is (#501)`);
  return { ...a.reading };
}

/**
 * A 0xB1 frame while a split record waits for its parts (D103). A byte-identical
 * repeat of a part held is ignored; the next part in order is kept, and the
 * last one joins the record; anything else (a gap, another order, other bytes
 * for an index held, another count, a bad checksum or length, too many bytes)
 * ends the wait with the first part's weight.
 */
function nextResultPart(q: QnScaleAdapter, data: Buffer): ScaleReading | null {
  const s = q.s;
  const a = s.resultAssembly!;
  if (a.parts.some((p) => p.equals(data))) {
    bleLog.debug(`QN: 0xb1 part ${data[3]} repeated unchanged, ignored (#501)`);
    return null;
  }
  const count = a.parts[0][2];
  const index = a.parts.length + 1;
  const held = a.parts.reduce((n, p) => n + p.length - 5, 0);
  if (data.length < 6 || data[1] !== data.length) {
    return releaseAssembly(s, `part has a length of ${data.length} bytes that is not its own`);
  }
  if (!hasValidSumChecksum(data)) return releaseAssembly(s, 'part has a bad checksum');
  if (data[2] !== count) return releaseAssembly(s, `part says ${data[2]} parts, not ${count}`);
  if (data[3] !== index) {
    return releaseAssembly(s, `part ${data[3]} came where part ${index} was due`);
  }
  if (held + data.length - 5 > EXTENDED_RESULT_RECORD_LEN) {
    return releaseAssembly(s, `parts add up to more than ${EXTENDED_RESULT_RECORD_LEN} bytes`);
  }
  a.parts.push(Buffer.from(data));
  a.atMs.push(Date.now());
  bleLog.debug(
    `QN: 0xb1 part ${index} of ${count} (${data.length} bytes), ` +
      `${a.atMs[index - 1] - a.atMs[0]} ms after part 1 (#501)`,
  );
  if (index < count) return null;
  return completeAssembly(q);
}

/**
 * The last part came: the weight goes out as the first part gave it, and the
 * record put together from the parts is read and logged only (D103). The
 * diagnostics are in a try/catch: parseNotification must not throw, and the
 * weight is not to be lost to a line that could not be built.
 */
function completeAssembly(q: QnScaleAdapter): ScaleReading | null {
  const s = q.s;
  const a = s.resultAssembly!;
  s.resultAssembly = null;
  try {
    logJoinedRecord(q, a.parts, a.atMs, a.reading);
  } catch (e) {
    bleLog.debug(`QN: could not read the 0xb1 put together from its parts: ${String(e)} (#501)`);
  }
  return { ...a.reading };
}

function logJoinedRecord(
  q: QnScaleAdapter,
  parts: readonly Buffer[],
  atMs: readonly number[],
  reading: ScaleReading,
): void {
  const joined = joinExtendedResultParts(parts);
  if (joined === null) {
    bleLog.debug('QN: the 0xb1 parts do not add up to one record, not read (#501)');
    return;
  }
  // Joined parts always make a frame decodeExtendedResult reads: [2] and [3]
  // 1, its own length and a fresh checksum.
  const decoded = decodeExtendedResult(joined)!;
  bleLog.debug(
    `QN: 0xb1 put together from ${parts.length} parts (${parts.map((p) => p.length).join(', ')} ` +
      `bytes, ${atMs.map((t) => t - atMs[0]).join(', ')} ms after part 1): ` +
      `${hex(joined.subarray(4, joined.length - 1))} (#501)`,
  );
  logExtendedResult(joined, decoded);
  const s = q.s;
  const checks = extendedResultChecks(decoded);
  // An assembly is only opened with a profile frame sent.
  const { frame } = s.visitSent!;
  const visitMm = (frame[8] << 8) | frame[9];
  bleLog.debug(
    `QN: extended result checks: lean + fat ${checks.leanPlusFat}, muscle - (lean - bone) ` +
      `${checks.muscleVsLeanLessBone}, BMI - bmiFine ${checks.bmiVsBmiFine}, BMR - ` +
      `Katch-McArdle ${checks.bmrVsKatchMcArdle} kcal, height implied by bmiFine ` +
      `${checks.impliedHeightCm ?? 'unknown'} cm, profile frame ${visitMm} mm (#501)`,
  );
  if (!hasMeasurement(decoded)) {
    bleLog.info('QN: the scale sent no body composition for this weigh-in (#331)');
    return;
  }
  logDryRunVerdict(q, decoded, reading, s);
  bleLog.info(
    `QN: the 0xb1 came in ${parts.length} parts; the scale's own body composition in it is read ` +
      'but not exported yet (#501)',
  );
}

/**
 * What the D096 gate would say about this record, for the debug log only: the
 * verdict as it stands, and with the algorithm check left out, which tells a
 * reporter whether `ble.qn_algorithm` is all that is missing (D103).
 */
function logDryRunVerdict(
  q: QnScaleAdapter,
  decoded: ExtendedResult,
  reading: ScaleReading,
  s: QnSession,
): void {
  const profile = q.connectionProfile;
  if (profile === null) return;
  const pin: ScaleCompositionPin = {
    result: decoded.result,
    composition: decoded.composition,
    visit: s.visitSent,
    reply: s.visitReply,
    valueType: s.readyValueType,
    measuredAfterVisit: s.measuredAfterVisit,
    liveWeightAfterVisit: s.liveWeightAfterVisit,
    a4PreludeSent: s.a4PreludeSent,
    requiresAlgorithmOption: true,
    exportsSkeletalMuscle: true,
  };
  const asSent = scaleCompositionRejection(pin, profile);
  const withOption =
    pin.visit === null
      ? asSent
      : scaleCompositionRejection(
          { ...pin, visit: { ...pin.visit, algorithmFromOption: true } },
          profile,
        );
  const w = reading.weight;
  const implausible = compositionRejection({
    fat: decoded.result.fatPercent,
    water: decoded.composition.water,
    muscle: decoded.composition.muscle,
    bone: (decoded.composition.bone * w) / 100,
  });
  bleLog.debug(
    `QN: dry run of the scale's own composition (not exported): gate says ` +
      `${asSent ?? 'accepted'}; without the ble.qn_algorithm check: ${withOption ?? 'accepted'}; ` +
      `plausibility: ${implausible ?? 'ok'} (#501)`,
  );
}

/** The scale measured something: a body fat and at least one channel (#331). */
function hasMeasurement(decoded: ExtendedResult): boolean {
  const { result } = decoded;
  return result.fatPercent > 0 && [...result.original, ...result.adjusted].some((v) => v > 0);
}

/**
 * Put the scale's own results of a one-part 0xB1 on its reading (#331, D096),
 * with what this session sent and heard back, snapshot now (#394).
 * computeMetrics decides whether they are this user's (own-composition.ts):
 * on this dialect also only with `ble.qn_algorithm` in the profile frame, and
 * the 0xB1's skeletal muscle percentage goes with the set. The 19-byte pin has no
 * 0x22 answer time here: this result is not that answer.
 */
function pinOwnComposition(s: QnSession, reading: ScaleReading, decoded: ExtendedResult): void {
  if (!hasMeasurement(decoded)) {
    bleLog.info('QN: the scale sent no body composition for this weigh-in (#331)');
    return;
  }
  bleLog.info('QN: the scale sent its own body composition for this weigh-in (#331)');
  const { composition } = decoded;
  if (s.readyValueType === 1) {
    const w = reading.weight;
    bleLog.debug(
      'QN: the scale reports muscle and bone as % of body weight: ' +
        `muscle ${composition.muscle} % (${r2((composition.muscle * w) / 100)} kg), ` +
        `bone ${composition.bone} % (${r2((composition.bone * w) / 100)} kg); ` +
        'exported in kg (#331)',
    );
  }
  reading.scaleComposition = {
    result: decoded.result,
    composition,
    visit: s.visitSent,
    reply: s.visitReply,
    valueType: s.readyValueType,
    measuredAfterVisit: s.measuredAfterVisit,
    liveWeightAfterVisit: s.liveWeightAfterVisit,
    a4PreludeSent: s.a4PreludeSent,
    requiresAlgorithmOption: true,
    exportsSkeletalMuscle: true,
  } satisfies ScaleCompositionPin;
}

/** Why decodeExtendedResult read nothing from a 0xB1, for the debug log (#331). */
function notDecodedLine(data: Buffer): string {
  const notRead = "the scale's own results in it are not read (#331)";
  if (data.length !== 119 || data[2] !== 0x01) {
    return `QN: 0xb1 is not one 119-byte part ([2] ${data[2]}, ${data.length} bytes), ${notRead}`;
  }
  return (
    `QN: 119-byte 0xb1 fails its one-part checks ([1] ${data[1]}, [3] ${data[3]}, checksum ` +
    `${hasValidSumChecksum(data) ? 'ok' : 'bad'}), ${notRead}`
  );
}

/**
 * The scale's own results in a one-part 0xB1, for the debug log (#331): the
 * measured and corrected channels and every value, the ones nothing exports
 * included. Any other 0xB1 gets a line that says why it is not read.
 */
function logExtendedResult(data: Buffer, decoded: ExtendedResult | null): void {
  if (!decoded) {
    bleLog.debug(notDecodedLine(data));
    return;
  }
  const { result, composition } = decoded;
  const channels = (values: number[]): string =>
    EIGHT_CHANNEL_ORDER.map((name, i) => `${name} ${values[i]}`).join(', ');
  bleLog.debug(
    `QN: extended result, user slot ${result.slot}, ${result.weight} kg, body fat ` +
      `${result.fatPercent} %; measured Ohm: ${channels(result.original)}; ` +
      `corrected Ohm: ${channels(result.adjusted)} (#331)`,
  );
  bleLog.debug(
    `QN: extended result composition: ${Object.entries(composition)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}, heartRate ${result.heartRate}, handle ${decoded.handle}, ` +
      `bmiFine ${decoded.bmiFine}, biaType ${decoded.biaType} (#331)`,
  );
}
