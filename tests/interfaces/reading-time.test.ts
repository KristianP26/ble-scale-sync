import { describe, it, expect } from 'vitest';
import {
  HISTORY_WINDOW_MS,
  isHistoricalReading,
  measurementTime,
} from '../../src/interfaces/reading-time.js';

const NOW = Date.parse('2026-10-13T18:03:57Z');
const MIN = 60_000;

describe('isHistoricalReading (D027, D065)', () => {
  it('keeps a stamp from four minutes ago live when the adapter says nothing more', () => {
    expect(
      isHistoricalReading(
        { weight: 71.55, impedance: 497, timestamp: new Date(NOW - 4 * MIN) },
        NOW,
      ),
    ).toBe(false);
  });

  it('takes a reading from the scale memory as history however young its stamp', () => {
    const reading = {
      weight: 71.55,
      impedance: 497,
      timestamp: new Date(NOW - 4 * MIN),
      fromMemory: true,
    };
    expect(isHistoricalReading(reading, NOW)).toBe(true);
  });

  it('takes it as history even without a stamp, the safer side of a misused flag', () => {
    const reading = { weight: 71.55, impedance: 497, fromMemory: true };
    expect(isHistoricalReading(reading, NOW)).toBe(true);
    // Such a reading is then dated by its receipt.
    const receivedAt = new Date(NOW);
    expect(measurementTime(reading, receivedAt)).toBe(receivedAt);
    // The same with a stamp that cannot be read.
    const unreadable = { ...reading, timestamp: new Date(NaN) };
    expect(isHistoricalReading(unreadable, NOW)).toBe(true);
    expect(measurementTime(unreadable, receivedAt)).toBe(receivedAt);
  });

  it('still decides an unflagged reading by age alone', () => {
    const old = new Date(NOW - HISTORY_WINDOW_MS - 1000);
    expect(isHistoricalReading({ weight: 71.55, impedance: 497, timestamp: old }, NOW)).toBe(true);
    expect(
      isHistoricalReading(
        { weight: 71.55, impedance: 497, timestamp: old, fromMemory: false },
        NOW,
      ),
    ).toBe(true);
    expect(isHistoricalReading({ weight: 71.55, impedance: 497 }, NOW)).toBe(false);
  });
});
