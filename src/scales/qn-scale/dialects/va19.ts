import { bleLog } from '../../../ble/types.js';
import type {
  BodyComposition,
  ScaleReading,
  UserProfile,
} from '../../../interfaces/scale-adapter.js';
import { isHistoricalReading } from '../../../interfaces/reading-time.js';
import {
  buildPayload,
  compositionRejection,
  r2,
  type ScaleBodyComp,
} from '../../body-comp-helpers.js';
import {
  BMI_MATCH_TOLERANCE,
  EIGHT_CHANNEL_ORDER,
  LIVE20_FRAME_LEN,
  LIVE20_STATUS_MEASURING,
  LIVE20_STATUS_RESULT,
  LIVE20_STATUS_STABLE,
  MEASURED_ANSWER_MIN_MS,
  NINETEEN_BYTE_RESULT_HOLD_MS,
  RESULT16_FRAME_LEN,
  RESULT16_OPCODE_COMPOSITION,
  RESULT16_OPCODE_DONE,
  RESULT_MAX_WEIGHT_KG,
  RESULT_MIN_WEIGHT_KG,
  SCALE_EPOCH_OFFSET,
  STORED_FUTURE_TOLERANCE_MS,
  STORED_MAX_AGE_MS,
  STORED_OPCODE_COMPOSITION,
  STORED_OPCODE_DONE,
  STORED_UNASSIGNED_SLOT,
} from '../constants.js';
import { hex, type QnDialectHandler } from '../dialect.js';
import {
  buildResultAck,
  buildUserProfileFrame,
  decodeEightResult,
  decodeEightStoredRecord,
  decodeVaComposition,
  hasValidSumChecksum,
  type EightResult,
  type VaComposition,
} from '../frames.js';
import type { QnScaleAdapter } from '../index.js';

/** Milliseconds as seconds with one decimal for the log, or "unknown". */
const seconds = (ms: number | null): string =>
  ms === null ? 'unknown' : `${(ms / 1000).toFixed(1)} s`;

/**
 * The scale's own results for one 19-byte weigh-in, and what this session sent
 * it and heard back, pinned to the reading they belong to (#331).
 */
export interface ScaleCompositionPin {
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

/**
 * The 19-byte dialect (Arboleaf, 8 electrodes, #331, D037): a 20-byte live
 * stream whose stable weight is held until the result block's 0x16, the
 * scale's own body composition, and 8-electrode stored records in their own
 * layout, never re-queried: the scale answers our one 0x22 once it is done
 * measuring, and a second 0x22 is the same request again. The GE CS 10 G's
 * live frame has the identical 20-byte shape and stays on the shared path,
 * and 0x15/0x16 only count after the stream, so elsewhere they are ignored.
 */
export const dialect = {
  frame(q, data) {
    const opcode = data[0];
    if (opcode === 0x23) return parseEightStoredPart(q, data);
    if (opcode === 0x10 && data.length === LIVE20_FRAME_LEN && data[1] === LIVE20_FRAME_LEN) {
      return parseNineteenByteLiveFrame(q, data);
    }
    if (
      (opcode === STORED_OPCODE_COMPOSITION || opcode === STORED_OPCODE_DONE) &&
      data.length >= RESULT16_FRAME_LEN &&
      data[2] === 0xff
    ) {
      return parseEightStoredTail(q, data);
    }
    if (
      q.s.live20Seen &&
      (opcode === RESULT16_OPCODE_COMPOSITION || opcode === RESULT16_OPCODE_DONE) &&
      data.length === RESULT16_FRAME_LEN &&
      data[1] === RESULT16_FRAME_LEN
    ) {
      return parseNineteenByteResultFrame(q, data);
    }
    return undefined;
  },
  /**
   * From the stable weight until its 0x16 (D037), and on a fresh stored
   * weigh-in, so a live result in the same session replaces it. Pending until
   * the 0x16: HoldTimer asks only when a window ends, so this has to cover the
   * scale's whole BIA, not just the result block: a BIA that outlasts the
   * window then gets the extension steps instead of a cut link and a
   * reconnect that sends START into it.
   */
  hold(s) {
    if (s.live20Weight === null && !s.storedHoldArmed) return undefined;
    return {
      ms: NINETEEN_BYTE_RESULT_HOLD_MS,
      pending: s.live20Weight !== null && !s.live20ResultSeen,
    };
  },
} satisfies QnDialectHandler;

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
function parseNineteenByteLiveFrame(q: QnScaleAdapter, data: Buffer): ScaleReading | null {
  if (!hasValidSumChecksum(data)) {
    bleLog.debug('QN: 20-byte frame with a bad checksum dropped (#331)');
    return null;
  }
  q.s.live20Seen = true;

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
    if (total === 3 && q.s.live20Block.length === index - 1) {
      q.s.live20Block.push(Buffer.from(data));
    } else {
      q.s.live20Block = [];
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
  if (!q.s.twentyByteFrameLogged) {
    q.s.twentyByteFrameLogged = true;
    bleLog.debug(
      `QN: 20-byte live frame, weight ${weight} kg at [5..6], user slot ${slot}, ` +
        `status 0x${status.toString(16).padStart(2, '0')} (19-byte dialect, #331)`,
    );
  }
  if (status === LIVE20_STATUS_MEASURING || status === LIVE20_STATUS_STABLE) {
    q.s.live20Measured = true;
    if (q.s.visitReply?.ok === true) q.s.measuredAfterVisit = true;
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
  if (status === LIVE20_STATUS_RESULT) noteStoredQueryAnswer(q);

  // Collected before the repeat check below, so a repeated block still gets
  // the `ble.qn_result_ack` answer at its 0x16, as the vendor's SDK gives it.
  // Nothing else reads a repeated block: its 0x16 publishes nothing. A 0x15
  // from before this first part belongs to an earlier block (a repeated one
  // leaves the session open), so it is dropped, as the SDK drops it here.
  if (status === LIVE20_STATUS_RESULT) {
    q.s.live20Block = total === 3 ? [Buffer.from(data)] : [];
    q.s.live20C15 = null;
  }

  // A result block with no measurement before it in this session (no live
  // frame, and a first answer to the 0x22 too soon to follow one) is a
  // weigh-in the scale finished before we connected. When it repeats a
  // result already published, it is that weigh-in handed over again after a
  // reconnect, not a second one (#331).
  if (status === LIVE20_STATUS_RESULT && !q.s.live20Measured && q.s.live20Weight === null) {
    const repeated = q.ledger.repeatOf(weight);
    if (repeated) {
      q.s.live20Replayed = true;
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
  q.s.live20Weight = weight;
  replaceHeldStoredWeighIn(q, `the weigh-in in progress (${weight} kg)`);
  const reading: ScaleReading = { weight, impedance: 0 };
  q.provisionalReadings.add(reading);
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
function parseNineteenByteResultFrame(q: QnScaleAdapter, data: Buffer): ScaleReading | null {
  if (!hasValidSumChecksum(data)) {
    bleLog.debug(`QN: 0x${data[0].toString(16)} frame with a bad checksum dropped (#331)`);
    return null;
  }
  if (data[0] === RESULT16_OPCODE_COMPOSITION) {
    q.s.live20C15 = Buffer.from(data);
    return null;
  }
  q.s.live20ResultSeen = true;
  // At once, before anything is decoded and before the session ends on the
  // reading below, as the vendor's published SDK does: for a complete block
  // on any slot, an all-zero one and a repeated one too (#331, D059).
  if (q.opts.resultAck) {
    if (q.s.live20Block.length === 3 && q.s.live20C15 !== null) {
      bleLog.debug(
        'QN: 0x16 completes the result block, sending 0x1F as the vendor app does ' +
          '(ble.qn_result_ack, #331)',
      );
      void q.writeCmd(buildResultAck(q.s.seenProtocolType));
    } else {
      bleLog.debug(
        'QN: 0x16 without a complete result block, no 0x1F sent (ble.qn_result_ack, #331)',
      );
    }
  }
  if (q.s.live20Weight === null) {
    bleLog.debug(
      q.s.live20Replayed
        ? 'QN: 0x16 closes a repeated result block, nothing published (#331)'
        : 'QN: 0x16 closes a 19-byte weigh-in that sent no stable weight (#331)',
    );
    return null;
  }
  bleLog.debug(`QN: 0x16 closes the 19-byte weigh-in, publishing ${q.s.live20Weight} kg (#331)`);
  q.ledger.remember(q.s.live20Weight);
  const reading: ScaleReading = { weight: q.s.live20Weight, impedance: 0 };
  pinScaleComposition(q, reading, data);
  return reading;
}

/**
 * Put the scale's own results for this weigh-in on its reading, when the
 * result block, 0x15 and 0x16 all decode and the block carries a
 * measurement: the scale sends an all-zero block when it has none (#331).
 * Snapshot at emit time (#394).
 */
function pinScaleComposition(q: QnScaleAdapter, reading: ScaleReading, d16: Buffer): void {
  const [p1, p2, p3] = q.s.live20Block;
  const result =
    q.s.live20Block.length === 3 ? decodeEightResult(p1, p2, p3, q.s.resistanceScrambled) : null;
  const composition = q.s.live20C15 ? decodeVaComposition(q.s.live20C15, d16) : null;
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
  if (q.s.readyValueType === 1) {
    const w = reading.weight;
    bleLog.debug(
      'QN: the scale reports muscle and bone as % of body weight: ' +
        `muscle ${composition.muscle} % (${r2((composition.muscle / 100) * w)} kg), ` +
        `bone ${composition.bone} % (${r2((composition.bone * w) / 100)} kg); ` +
        'exported in kg (#331)',
    );
  }
  reading.scaleComposition = {
    result,
    composition,
    visit: q.s.visitSent,
    reply: q.s.visitReply,
    valueType: q.s.readyValueType,
    measuredAfterVisit: q.s.measuredAfterVisit,
    answerAfterVisitMs: q.s.answerAfterVisitMs,
    a4PreludeSent: q.s.a4PreludeSent,
  } satisfies ScaleCompositionPin;
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
export function noteStoredQueryAnswer(q: QnScaleAdapter): void {
  if (q.s.queryAnswered) return;
  q.s.queryAnswered = true;
  const now = Date.now();
  const sinceQuery = q.s.storedQuerySentAtMs === null ? null : now - q.s.storedQuerySentAtMs;
  const sinceVisit = q.s.visitAcceptedAtMs === null ? null : now - q.s.visitAcceptedAtMs;
  q.s.answerAfterVisitMs = sinceVisit;
  if (sinceQuery !== null && sinceQuery >= MEASURED_ANSWER_MIN_MS) q.s.live20Measured = true;
  if (q.s.visitReply?.ok === true && sinceVisit !== null && sinceVisit >= MEASURED_ANSWER_MIN_MS) {
    q.s.measuredAfterVisit = true;
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
function scaleCompositionRejection(pin: ScaleCompositionPin, profile: UserProfile): string | null {
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
function parseEightStoredPart(q: QnScaleAdapter, data: Buffer): null {
  if (data.length !== LIVE20_FRAME_LEN || !hasValidSumChecksum(data)) {
    bleLog.debug(`QN: 0x23 that is not a stored-record part dropped: [${hex(data)}] (#331)`);
    return null;
  }
  // "No stored weigh-ins" is an answer to the 0x22 as much as a record is.
  noteStoredQueryAnswer(q);
  if (data[4] === 0) {
    bleLog.debug('QN: 0x23 with no parts: the scale holds no stored weigh-ins (#331)');
    return null;
  }
  const total = data[4] >> 4;
  const index = data[4] & 0x0f;
  if (total !== 3 || index === 0 || index > total) {
    q.s.storedParts = [];
    bleLog.debug(`QN: 0x23 not read as a stored-record part: [${hex(data)}] (#331)`);
    return null;
  }
  if (index === 1) {
    if (q.s.storedParts.length > 0) {
      bleLog.debug('QN: stored record left incomplete by the next one, dropped (#331)');
    }
    q.s.storedParts = [Buffer.from(data)];
    return null;
  }
  if (q.s.storedParts.length !== index - 1) {
    bleLog.debug(`QN: stored-record part ${index}/3 out of order, record dropped (#331)`);
    q.s.storedParts = [];
    return null;
  }
  q.s.storedParts.push(Buffer.from(data));
  return null;
}

/** 0x24 or 0x25 of an 8-electrode stored record (#331); 0x25 completes it. */
function parseEightStoredTail(q: QnScaleAdapter, data: Buffer): ScaleReading | null {
  const expected = data[0] === STORED_OPCODE_COMPOSITION ? 3 : 4;
  if (q.s.storedParts.length !== expected) {
    bleLog.debug(
      `QN: 0x${data[0].toString(16)} without the stored-record frames before it, dropped (#331)`,
    );
    q.s.storedParts = [];
    return null;
  }
  q.s.storedParts.push(Buffer.from(data));
  if (data[0] === STORED_OPCODE_COMPOSITION) return null;
  const [s1, s2, s3, s24, s25] = q.s.storedParts;
  q.s.storedParts = [];
  return storedWeighIn(q, s1, s2, s3, s24, s25);
}

/**
 * A complete stored record as a reading with the time the scale took it
 * (#331). Its weight only: which profile the scale computed the record's
 * body composition with is not in it. A fresh record is provisional, so a
 * live result of the same session replaces it; an older one is history, which
 * the session keeps apart and the runtime sends only to exporters that can
 * record a past measurement.
 */
function storedWeighIn(
  q: QnScaleAdapter,
  s1: Buffer,
  s2: Buffer,
  s3: Buffer,
  s24: Buffer,
  s25: Buffer,
): ScaleReading | null {
  const rec = decodeEightStoredRecord(s1, s2, s3, s24, s25, q.s.resistanceScrambled);
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
    rec.recordSeconds <= q.s.storedMarkAtSessionStart ||
    q.s.storedEmitted.has(rec.recordSeconds)
  ) {
    bleLog.debug(`QN: stored weigh-in ${what} was already reported (#331)`);
    return null;
  }
  const live = q.ledger.copyOf(rec.weight, atMs);
  if (live) {
    bleLog.debug(
      `QN: stored weigh-in ${what} is the live result reported at ` +
        `${new Date(live.atMs).toISOString()}, dropped (#331)`,
    );
    return null;
  }

  const reading: ScaleReading = { weight: rec.weight, impedance: 0, timestamp: new Date(atMs) };
  const historical = isHistoricalReading(reading, now);
  if (q.s.live20Weight !== null && !historical) {
    bleLog.info(
      `QN: a stored weigh-in (${what}) is superseded by the weigh-in in progress, ` +
        'not exported (#331)',
    );
    return null;
  }
  q.ledger.mark = Math.max(q.ledger.mark, rec.recordSeconds);
  q.s.storedEmitted.add(rec.recordSeconds);
  q.provisionalReadings.add(reading);
  if (!historical) {
    q.s.storedHoldArmed = true;
    replaceHeldStoredWeighIn(q, `a later stored weigh-in (${what})`);
    q.s.heldStoredWeighIn = what;
  }
  bleLog.debug(
    `QN: stored weigh-in ${what}, user slot ${rec.slot}, ` +
      (historical ? 'reported as history' : 'held: a live result in this session replaces it') +
      ' (#331)',
  );
  return reading;
}

/**
 * The session hold keeps one reading, so a fresh stored weigh-in held there
 * is gone once `by` takes its place, and it is already counted in the mark.
 * Said at info with its weight and time, so it can be entered by hand (#331).
 */
function replaceHeldStoredWeighIn(q: QnScaleAdapter, by: string): void {
  if (q.s.heldStoredWeighIn === null) return;
  bleLog.info(
    `QN: a stored weigh-in (${q.s.heldStoredWeighIn}) is replaced by ${by}, ` +
      'not exported (#331)',
  );
  q.s.heldStoredWeighIn = null;
}

/**
 * The scale's own body fat, water, muscle, bone and visceral fat, as one set
 * that stands or falls as a whole, or null with the reason logged when they
 * are not this user's or not plausible (#331). Athlete mode: the scale has none for these scales in
 * the vendor's published SDK, so an athlete gets its values with a note
 * rather than the BMI estimate, which is the worst one for a muscular body.
 */
export function scaleCompositionPayload(
  pin: ScaleCompositionPin,
  reading: ScaleReading,
  profile: UserProfile,
): BodyComposition | null {
  const why = scaleCompositionRejection(pin, profile);
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
