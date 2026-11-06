import { bleLog } from '../../../ble/types.js';
import type { ScaleReading } from '../../../interfaces/scale-adapter.js';
import {
  EIGHT_CHANNEL_ORDER,
  RESULT_MAX_WEIGHT_KG,
  RESULT_MIN_WEIGHT_KG,
  RESULT_OPCODE_B1,
  RESULT_OPCODE_B4,
  RESULT_RECORD_CLOCK_TOLERANCE_SEC,
  SCALE_EPOCH_OFFSET,
} from '../constants.js';
import { storedSlotLabel, type QnDialectHandler } from '../dialect.js';
import { decodeExtendedResult, hasValidSumChecksum } from '../frames.js';
import type { QnSession } from '../session.js';

/**
 * The 20-byte extended dialect (GE CS 10 G #235, Arboleaf CS10G #501 and a
 * 20-byte CS10E #331). The 20-byte live 0x10 reached this adapter from the
 * CS10E but never from the GE or the CS10G, and stays undecoded either way:
 * the weight comes from these 0xB1/0xB4 result frames. The burst's non-weight
 * parts (repeated 0xB4s, the 0xB1 parts after the first) come back null, so
 * they are not logged as ignored. A 0xB1 in one part also carries the scale's
 * own results, decoded and logged (decodeExtendedResult, #331).
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
 * Accepts the consolidated 0xB4 (weight at [11]) or the first part of the
 * 0xB1, however many parts it came in (weight at [5]). Returns a weight-only
 * reading (impedance 0: the channels are segment impedances, see RESULT_OPCODE_*),
 * or null when the frame is not a recognised result frame, fails its
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
  // [4] is the user slot the scale took the weigh-in for, 0xf0 for none: the
  // CS10G sends 0xB1 with [4] 02 for the user its app registered in slot 2
  // (#501). Logged only, so a reporter can find the slot to set.
  bleLog.debug(
    `QN: extended result 0x${data[0].toString(16)} decoded ${weight}kg, ` +
      `${storedSlotLabel(data[4])} (no whole-body impedance, emitting weight-only) #235`,
  );
  if (data[0] === RESULT_OPCODE_B1) logExtendedResult(data);
  return { weight, impedance: 0 };
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
function logExtendedResult(data: Buffer): void {
  const decoded = decodeExtendedResult(data);
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
