import type { ScaleReading } from './scale-adapter.js';

/**
 * How far before its receipt a reading may be stamped and still count as the
 * weigh-in happening now (ADR D027).
 *
 * A reading whose `timestamp` is older than this is HISTORY: a record the scale
 * kept in its memory and replays later. History goes only to exporters that can
 * record a past measurement, does not end the live session, and does not move
 * `last_known_weight`.
 *
 * Five minutes, because the two things it has to separate are far apart on
 * either side of it. A live weigh-in (step on, settle, impedance, the scale's
 * clock stamping the frame) is over well inside a minute, and a scale clock that
 * has drifted a minute or two over months without a sync must not turn every
 * live weigh-in into history. A stored record, on the other hand, is a weigh-in
 * the app was not around for, which in practice is hours or days old. A record
 * from four minutes ago is treated as live, which is what it effectively is.
 *
 * Shared by the BLE session (whether a frame ends it) and the processor (where
 * the reading goes), so the two can never disagree about the same frame.
 */
export const HISTORY_WINDOW_MS = 5 * 60 * 1000;

/** True when the reading is a stored record from the scale's memory (D027). */
export function isHistoricalReading(
  reading: ScaleReading,
  nowMs: number = Date.now(),
): reading is ScaleReading & { timestamp: Date } {
  const ts = reading.timestamp;
  if (!ts) return false;
  const t = ts.getTime();
  // An unreadable stamp says nothing about age; the reading is treated as
  // live rather than routed away from half the exporters on a parse error.
  if (Number.isNaN(t)) return false;
  return nowMs - t > HISTORY_WINDOW_MS;
}

/**
 * The time a reading was MEASURED, decided once when it is received (D027).
 *
 * The frame's own stamp when it carries one, because that is when the scale
 * measured it. The receipt time otherwise, and also when the stamp lies in the
 * future: a scale clock running ahead cannot have measured anything yet, and an
 * export dated tomorrow would sort above every real weigh-in.
 *
 * Every export of the reading, and every retry of it from the queue, carries
 * this one value, so a redelivery is the same measurement to the target rather
 * than a second one a few seconds later (F-04, F-06).
 */
export function measurementTime(reading: ScaleReading, receivedAt: Date): Date {
  const ts = reading.timestamp;
  if (!ts || Number.isNaN(ts.getTime()) || ts.getTime() > receivedAt.getTime()) return receivedAt;
  return ts;
}
