import { bleLog } from '../../../ble/types.js';
import type { ScaleReading } from '../../../interfaces/scale-adapter.js';
import {
  RESULT_MAX_WEIGHT_KG,
  RESULT_MIN_WEIGHT_KG,
  RESULT_OPCODE_B1,
  RESULT_OPCODE_B4,
  RESULT_RECORD_CLOCK_TOLERANCE_SEC,
  SCALE_EPOCH_OFFSET,
} from '../constants.js';
import { storedSlotLabel, type QnDialectHandler } from '../dialect.js';
import { hasValidSumChecksum } from '../frames.js';
import type { QnSession } from '../session.js';

/**
 * The 20-byte extended dialect (GE CS 10 G, #235). The scale never streams
 * 0x10 after a full body-composition weigh-in, it sends these 0xB4/0xB1
 * result frames instead. The burst's non-weight parts (repeated 0xB4s, the
 * 0xB1 03 02/03 records) come back null, so they are not logged as ignored.
 */
export const ext20: QnDialectHandler = {
  frame(q, data) {
    const opcode = data[0];
    if (opcode === 0x23) return q.storedRecord(data);
    if (opcode === RESULT_OPCODE_B4 || opcode === RESULT_OPCODE_B1) return resultFrame(q.s, data);
    return undefined;
  },
};

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
function resultFrame(s: QnSession, data: Buffer): ScaleReading | null {
  if (s.extendedResultEmitted) return null;

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
  // [4] is the user slot the scale took the weigh-in for, 0xf0 for none: the
  // CS10G sends 0xB1 with [4] 02 for the user its app registered in slot 2
  // (#501). Logged only, so a reporter can find the slot to set.
  bleLog.debug(
    `QN: extended result 0x${data[0].toString(16)} decoded ${weight}kg, ` +
      `${storedSlotLabel(data[4])} (impedance sweep not yet calibrated, emitting weight-only) #235`,
  );
  return { weight, impedance: 0 };
}
