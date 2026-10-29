import { bleLog } from '../../../ble/types.js';
import type { ScaleReading } from '../../../interfaces/scale-adapter.js';
import {
  SCALE_EPOCH_OFFSET,
  SCRAMBLED_ONLY_HIGH_BYTES,
  STORED_ANSWER_HOLD_MS,
  STORED_MAX_AGE_MS,
  STORED_OPCODE_DONE,
  STORED_UNASSIGNED_SLOT,
} from '../constants.js';
import { storedSlotLabel, type QnDialectHandler } from '../dialect.js';
import type { StoredRecord } from '../frames.js';
import type { QnScaleAdapter } from '../index.js';
import { noteStoredQueryAnswer } from './va19.js';

/**
 * The 18-byte dialect (Renpho ES-26M, Physiq, #463). The scale answers our
 * 0x22 while it is still measuring, so the answer is noted here as on the
 * 19-byte dialect; the line it sets off on the live path needs it. [3] is how
 * many records the answer has and [4] which one this is: the vendor's SDK has
 * the answer complete at [4] = [3], and "no stored weigh-ins" is [3] = [4] = 0.
 * The last record still has its 0x24 and 0x25 to come. The 0x25 is not read,
 * but the one after the answer's last record ends the answer
 * (storedAnswerDone).
 */
export const dialect = {
  frame(q, data) {
    if (data[0] === 0x23) {
      noteStoredQueryAnswer(q);
      if (data.length < 5 || data[3] === 0) q.s.storedAnswerDone = true;
      else if (data[4] >= data[3]) q.s.storedAnswerLast = true;
      return q.storedRecord(data);
    }
    if (data[0] === STORED_OPCODE_DONE && q.s.storedAnswerLast) q.s.storedAnswerDone = true;
    return undefined;
  },
  /**
   * A weigh-in that came before the scale's answer to our 0x22, held for that
   * answer (heldForStoredAnswer); pending while the scale has begun its answer
   * but not sent the last record of it.
   */
  hold(s) {
    if (s.heldForStoredAnswer === null) return undefined;
    return { ms: STORED_ANSWER_HOLD_MS, pending: s.queryAnswered && !s.storedAnswerLast };
  },
} satisfies QnDialectHandler;

/**
 * A session that ends with a weigh-in still held for the stored ones was not
 * ended by the answer: the extensions ran out, the last record's 0x25 never
 * came, or the link or the caller went first (#463). Once, and not after the
 * 3 s line, which said so already.
 */
export function logHeldAtSessionEnd(q: QnScaleAdapter): void {
  const held = q.s.heldForStoredAnswer;
  if (held === null || q.s.storedAnswerReasonLogged) return;
  q.s.storedAnswerReasonLogged = true;
  const why = !q.s.queryAnswered
    ? 'the scale had not answered the stored-record query'
    : q.s.storedAnswerLast
      ? 'the scale had not finished its answer to the stored-record query'
      : 'stored weigh-ins were still arriving';
  bleLog.debug(
    `QN: the session ended while the weigh-in (${held.weight} kg) was held for the ` +
      `scale's stored ones: ${why} (#463)`,
  );
}

/**
 * Once per 18-byte session without an advertisement, at info, whether or not
 * a resistance is changed later: a scrambled one that is already in the body
 * range stays wrong without a trace otherwise (#463, D071). Called from the
 * 0x12 and from onConnected, whichever comes second, since it needs both.
 */
export function logNoAdvertisementOnce(q: QnScaleAdapter): void {
  if (q.s.kind !== 'va18' || !q.s.noAdvertisement || q.s.noAdvertisementLogged) return;
  q.s.noAdvertisementLogged = true;
  bleLog.info(
    'QN: no advertisement reached this connection, so whether the scale scrambles its ' +
      'impedance is not known: one of 4096-4351 or 4608-4863 Ohm, which only a scrambled ' +
      'body gives, is read unscrambled, any other as sent, so a scrambled one of 151-255, ' +
      '512-767 or 1024-1200 Ohm can be off by up to 39 Ohm (#463)',
  );
}

/**
 * An 18-byte resistance in a session without any advertisement whose high
 * byte only a scrambled body resistance has (SCRAMBLED_ONLY_HIGH_BYTES,
 * #463, D071).
 */
export function readsUnscrambledWithoutAdvert(q: QnScaleAdapter, raw: number): boolean {
  return q.s.noAdvertisement && q.s.kind === 'va18' && SCRAMBLED_ONLY_HIGH_BYTES.includes(raw >> 8);
}

/**
 * An 18-byte 0x23 record from more than MAX_STORED_RECORD_AGE_SEC before the
 * session (#463, D065): a weigh-in the scale kept while nobody fetched it.
 * The window used to drop it without a line, and in #463 the scale did not
 * send it again, not even to the vendor app, so the weigh-in was lost.
 *
 * Reported as history with its own time (`fromMemory`), for the user slot of
 * the profile frame (1, or `ble.qn_user_slot`, #501) and for a record the
 * scale assigned to no user (0xf0), with `ble.qn_user_key`, in a session in
 * which the scale accepted the profile built from the first user with that
 * key (not openScale's fallback one) for that slot. That slot is then the
 * first configured user, as the option documents. A
 * record kept for no user names no slot, so its `userIndex` stays unset and
 * the runtime attributes it by its weight like any stored record without
 * one (D027). Both of the unit's offline weigh-ins of 2026-10-20 were kept
 * for no user (#463, D072). Any other slot, and either kind without those
 * gates, gets an info line with its weight and time, so it can be entered
 * by hand, and the line names the first reason in that order.
 *
 * Each record once per session, and never again once reported: the mark
 * (dedupMark, kept across restarts) and the live results this adapter
 * reported (a record that is a weigh-in already exported live) see to that.
 */
export function eighteenByteStoredWeighIn(
  q: QnScaleAdapter,
  data: Buffer,
  record: StoredRecord,
): ScaleReading | null {
  const { weight, recordSeconds } = record;
  if (q.s.storedJudged.has(recordSeconds)) return null;
  q.s.storedJudged.add(recordSeconds);
  const atMs = (recordSeconds + SCALE_EPOCH_OFFSET) * 1000;
  const what = `${weight} kg at ${new Date(atMs).toISOString()}`;
  const slot = data[5];
  // No user on the scale (0xf0): exported too, under the same gates as the
  // profile's slot (#463, D072). It names no user slot, so userIndex stays
  // unset and the runtime attributes it by its weight like any stored record
  // without one.
  const unassigned = slot === STORED_UNASSIGNED_SLOT;
  const own = q.s.profileSlot;
  if (!unassigned && slot !== own) {
    bleLog.info(
      `QN: a stored weigh-in (${what}) is not exported: the scale assigned it to its user ` +
        `slot ${slot}, and ble-scale-sync sends the profile of slot ${own} (#463)`,
    );
    return null;
  }
  if (q.opts.userKey === null) {
    bleLog.info(
      unassigned
        ? `QN: a stored weigh-in (${what}, assigned to no user) is not exported: without ` +
            'ble.qn_user_key ble-scale-sync does not export a weigh-in this scale kept from ' +
            'before the connection (#463)'
        : `QN: a stored weigh-in (${what}, user slot ${slot}) is not exported: without ` +
            'ble.qn_user_key ble-scale-sync cannot tell whose it is (#463)',
    );
    return null;
  }
  // A refused profile means the key or the first user does not match what
  // the vendor app set up, so the slot need not be the first configured user.
  // The answer has to be for the slot the profile frame went to (#501).
  // It has to be the frame built from the first user with the key, too: a
  // 0x12 that came after the handshake leaves the session on openScale's
  // constant profile (key 8), which a scale may accept for a slot 1 that
  // holds someone else (Renpho #213/#253). A record kept for no user is
  // attributed by its weight, not by these answers, but it takes the same
  // gates: stored weigh-ins stay opt-in, and the export and the hold
  // (waitsForStoredAnswer) agree on when a stored weigh-in can go out.
  if (q.s.visitSent === null && q.s.visitReply?.ok === true) {
    bleLog.info(
      unassigned
        ? `QN: a stored weigh-in (${what}, assigned to no user) is not exported: this ` +
            "session sent openScale's profile, not the first user with ble.qn_user_key (the " +
            '18-byte 0x12 came after the handshake), and a stored weigh-in goes out only in a ' +
            "connection in which the scale accepted the first user's profile (#463)"
        : `QN: a stored weigh-in (${what}) is not exported: this session sent openScale's ` +
            'profile, not the first user with ble.qn_user_key (the 18-byte 0x12 came after ' +
            'the handshake), so it is not known whose it is (#463)',
    );
    return null;
  }
  if (!q.s.visitAccepted) {
    bleLog.info(
      unassigned
        ? `QN: a stored weigh-in (${what}, assigned to no user) is not exported: the scale ` +
            `did not accept the profile for user slot ${own} in this session, and a stored ` +
            'weigh-in goes out only in a connection in which it has (#463)'
        : `QN: a stored weigh-in (${what}) is not exported: the scale did not accept the ` +
            `profile for user slot ${own} in this session, so it is not known whose it is (#463)`,
    );
    return null;
  }
  // Only a record from the past gets here, so the year is the only bound.
  if (Date.now() - atMs > STORED_MAX_AGE_MS) {
    bleLog.debug(`QN: stored weigh-in ${what} is not from the past year, dropped (#463)`);
    return null;
  }
  if (recordSeconds <= q.s.storedMarkAtSessionStart || q.s.storedEmitted.has(recordSeconds)) {
    bleLog.debug(`QN: stored weigh-in ${what} was already reported (#463)`);
    return null;
  }
  const live = q.ledger.copyOf(weight, atMs);
  if (live) {
    bleLog.debug(
      `QN: stored weigh-in ${what} is the live result reported at ` +
        `${new Date(live.atMs).toISOString()}, dropped (#463)`,
    );
    return null;
  }
  q.ledger.mark = Math.max(q.ledger.mark, recordSeconds);
  q.s.storedEmitted.add(recordSeconds);
  bleLog.debug(
    `QN: stored weigh-in ${what}, ${storedSlotLabel(slot)}, record ${data[4]} of ` +
      `${data[3]}, reported as history (#463)`,
  );
  return {
    weight,
    impedance: q.resistance(record.r50 > 0 ? record.r50 : record.r500),
    timestamp: new Date(atMs),
    fromMemory: true,
  };
}

/**
 * Whether a complete 18-byte live weigh-in has to wait for the scale's
 * answer to our 0x22 (#463): with `ble.qn_user_key`, after the scale
 * accepted the profile built from the first user with the key, which is
 * what a stored weigh-in needs to be exported (D065), and before the answer
 * is over. Once its last record has come, nothing is held: that record is
 * in hand.
 */
export function waitsForStoredAnswer(q: QnScaleAdapter): boolean {
  return (
    q.s.kind === 'va18' &&
    q.opts.userKey !== null &&
    q.s.visitAccepted &&
    !q.s.storedAnswerLast &&
    !q.s.storedAnswerDone
  );
}

/**
 * Hold `reading` for the scale's stored weigh-ins (#463). The scale can send
 * its weigh-in before it has answered our 0x22, and the session used to end
 * on it with the answer still to come, so a stored weigh-in was not read.
 * It is a live result at once, so a stored copy of it during the wait or in
 * a later session is known for one. The 0x1F that follows is sent as for
 * every stable frame; a weight anchor or A4 prelude still due after our 0x22
 * goes out during the wait.
 */
export function holdForStoredAnswer(q: QnScaleAdapter, reading: ScaleReading): void {
  q.s.heldForStoredAnswer = reading;
  q.provisionalReadings.add(reading);
  q.ledger.remember(reading.weight);
  bleLog.debug(
    `QN: holding the weigh-in (${reading.weight} kg) for the scale's answer to the ` +
      `stored-record query, up to ${STORED_ANSWER_HOLD_MS / 1000} s, longer while stored ` +
      'weigh-ins are still arriving (#463)',
  );
  // HoldTimer ends the wait without a word from the adapter, so the reason
  // goes in the log here. Armed before HoldTimer's own timer of the same
  // length, so it fires first.
  clearStoredAnswerTimer(q);
  q.s.storedAnswerTimer = setTimeout(() => {
    q.s.storedAnswerTimer = null;
    if (q.s.heldForStoredAnswer === null) return;
    const why = !q.s.queryAnswered
      ? 'the scale did not answer the stored-record query'
      : q.s.storedAnswerLast
        ? 'the scale did not finish its answer to the stored-record query'
        : null;
    // Otherwise records are still arriving and the hold goes on.
    if (why === null) return;
    q.s.storedAnswerReasonLogged = true;
    bleLog.debug(
      `QN: ${why} within ${STORED_ANSWER_HOLD_MS / 1000} s; the session ends on the weigh-in ` +
        `held for it (${q.s.heldForStoredAnswer.weight} kg) (#463)`,
    );
  }, STORED_ANSWER_HOLD_MS);
}

/**
 * End the wait: a copy of the held weigh-in, which is final, so the session
 * ends on it. Once only: the hold is gone after this.
 */
export function releaseHeldWeighIn(q: QnScaleAdapter, why: string): ScaleReading | null {
  const held = q.s.heldForStoredAnswer;
  if (held === null) return null;
  q.s.heldForStoredAnswer = null;
  clearStoredAnswerTimer(q);
  bleLog.debug(
    `QN: ${why}; the session ends on the weigh-in held for it (${held.weight} kg) (#463)`,
  );
  return { ...held };
}

function clearStoredAnswerTimer(q: QnScaleAdapter): void {
  if (q.s.storedAnswerTimer) {
    clearTimeout(q.s.storedAnswerTimer);
    q.s.storedAnswerTimer = null;
  }
}

/**
 * An 18-byte record from the last MAX_STORED_RECORD_AGE_SEC that comes while
 * a weigh-in is held for the stored ones (#463). Otherwise it would be this
 * session's weigh-in, but that is the one held: the record is either the
 * same weigh-in again, which the scale may store, or one that cannot be told
 * apart from it. Never exported and never the end of the session; one line,
 * at info unless it is the held weigh-in.
 */
export function recentStoredDuringHold(
  q: QnScaleAdapter,
  data: Buffer,
  record: StoredRecord,
): null {
  const { weight, recordSeconds } = record;
  if (q.s.storedJudged.has(recordSeconds)) return null;
  q.s.storedJudged.add(recordSeconds);
  const atMs = (recordSeconds + SCALE_EPOCH_OFFSET) * 1000;
  const what = `${weight} kg at ${new Date(atMs).toISOString()}`;
  const live = q.ledger.copyOf(weight, atMs);
  if (live) {
    bleLog.debug(
      `QN: stored weigh-in ${what} is the live result reported at ` +
        `${new Date(live.atMs).toISOString()}, dropped (#463)`,
    );
    return null;
  }
  bleLog.info(
    `QN: a stored weigh-in (${what}, ${storedSlotLabel(data[5])}) is not exported: it came ` +
      'while this connection held its own weigh-in for the stored ones, and one from the ' +
      'last 90 seconds may be that weigh-in again (#463)',
  );
  return null;
}
