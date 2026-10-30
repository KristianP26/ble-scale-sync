import { describe, it, expect, vi, afterEach } from 'vitest';
import { PostReadingWindow } from '../../src/ble/advertisement.js';
import { bleLog } from '../../src/ble/types.js';

const ADDR = 'AA:BB:CC:DD:EE:FF';
const WINDOW_MS = 60_000;

/** A window on a clock the test moves by hand. */
function windowAt(start: number): { win: PostReadingWindow; set: (t: number) => void } {
  let t = start;
  const win = new PostReadingWindow(WINDOW_MS, () => t);
  return { win, set: (next) => (t = next) };
}

/**
 * #466: a proxy watcher reconnects to a scale still on after its reading, and
 * that session ending without a reading is not a failure. The window decides
 * which sessions count as that reconnect; the watcher suites cover the rule.
 */
describe('PostReadingWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('knows nothing about a scale that never gave a reading', () => {
    const { win } = windowAt(1_000_000);
    expect(win.sinceReading(ADDR)).toBeUndefined();
  });

  it('reports the time since the reading up to and including the window edge', () => {
    const t0 = 1_000_000;
    const { win, set } = windowAt(t0);
    win.noteReading(ADDR);

    set(t0 + 1000);
    expect(win.sinceReading(ADDR)).toBe(1000);
    set(t0 + WINDOW_MS);
    expect(win.sinceReading(ADDR)).toBe(WINDOW_MS);
    set(t0 + WINDOW_MS + 1);
    expect(win.sinceReading(ADDR)).toBeUndefined();
  });

  it('matches the address whatever its letter case', () => {
    const t0 = 1_000_000;
    const { win, set } = windowAt(t0);
    win.noteReading(ADDR);
    win.noteReading('11:22:33:44:55:aa');
    set(t0 + 500);
    expect(win.sinceReading(ADDR.toLowerCase())).toBe(500);
    expect(win.sinceReading('11:22:33:44:55:AA')).toBe(500);
  });

  it('logs at info once per reading and at debug after that', () => {
    const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const { win } = windowAt(1_000_000);
    win.noteReading(ADDR);

    win.reportNoWeighIn(ADDR, 'Scale at X', 661, 'first');
    win.reportNoWeighIn(ADDR, 'Scale at X', 2000, 'second');
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toBe(
      'Scale at X: session opened 0.7 s after the last reading, while the scale was still on, ' +
        'ended without a new weigh-in (first).',
    );
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0][0])).toContain('(second)');

    // A new reading is a new weigh-in to tell about.
    win.noteReading(ADDR);
    win.reportNoWeighIn(ADDR, 'Scale at X', 1000, 'third');
    expect(info).toHaveBeenCalledTimes(2);
    expect(String(info.mock.calls[1][0])).toContain('(third)');
  });

  it('forgets the oldest scale beyond 64, and its report goes to debug', () => {
    const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const { win } = windowAt(1_000_000);
    const mac = (i: number) =>
      `AA:BB:CC:DD:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 0xff).toString(16).padStart(2, '0')}`;
    for (let i = 0; i < 65; i++) win.noteReading(mac(i));

    expect(win.sinceReading(mac(0))).toBeUndefined();
    expect(win.sinceReading(mac(1))).toBe(0);
    expect(win.sinceReading(mac(64))).toBe(0);

    win.reportNoWeighIn(mac(0), 'Scale', 100, 'gone');
    expect(info).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  // #474: a Yunmai Mini 2 stays connectable for minutes after a weigh-in and
  // is connected again on every advertisement, each session ending 60 s later.
  it('runs the window from the end of a session after the reading that had no weigh-in', () => {
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const t0 = 1_000_000;
    const { win, set } = windowAt(t0);
    win.noteReading(ADDR);

    set(t0 + 1000);
    expect(win.sinceReading(ADDR)).toBe(1000);
    set(t0 + 61_000);
    win.reportNoWeighIn(ADDR, 'Scale at X', 1000, 'GATT reading timeout');

    // Past the window counted from the reading, inside the one counted from
    // the end of that session; still measured from the reading.
    set(t0 + 63_000);
    expect(win.sinceReading(ADDR)).toBe(63_000);
    set(t0 + 61_000 + WINDOW_MS);
    expect(win.sinceReading(ADDR)).toBe(61_000 + WINDOW_MS);
    set(t0 + 61_000 + WINDOW_MS + 1);
    expect(win.sinceReading(ADDR)).toBeUndefined();
  });

  // The reconnects go on for minutes, so every such session has to move the
  // window, not only the first one, which is the one logged at info.
  it('moves the window again with every later session that had no weigh-in', () => {
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const t0 = 1_000_000;
    const { win, set } = windowAt(t0);
    win.noteReading(ADDR);

    // Each session opens 2 s after the one before it ended and runs 60 s.
    let end = t0;
    for (const session of [1, 2, 3]) {
      set(end + 2000);
      const since = win.sinceReading(ADDR);
      expect(since, `session ${session}`).toBe(end + 2000 - t0);
      end += 2000 + 60_000;
      set(end);
      win.reportNoWeighIn(ADDR, 'Scale at X', since!, 'GATT reading timeout');
    }
    set(end + WINDOW_MS);
    expect(win.sinceReading(ADDR)).toBe(end + WINDOW_MS - t0);
    set(end + WINDOW_MS + 1);
    expect(win.sinceReading(ADDR)).toBeUndefined();
  });

  it('treats a clock that stepped back as outside the window', () => {
    const t0 = 1_000_000;
    const { win, set } = windowAt(t0);
    win.noteReading(ADDR);
    set(t0 - 1000);
    expect(win.sinceReading(ADDR)).toBeUndefined();
  });
});
