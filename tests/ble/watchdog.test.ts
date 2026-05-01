import { describe, it, expect, vi } from 'vitest';
import { ConsecutiveFailureWatchdog } from '../../src/ble/watchdog.js';

describe('ConsecutiveFailureWatchdog', () => {
  it('does nothing on failure when maxFailures is 0 (disabled)', () => {
    const onTrip = vi.fn();
    const w = new ConsecutiveFailureWatchdog(0, onTrip);
    w.recordSuccess();
    for (let i = 0; i < 100; i++) w.recordFailure();
    expect(onTrip).not.toHaveBeenCalled();
    expect(w.state.enabled).toBe(false);
  });

  it('does not trip before first success even if many failures occur', () => {
    const onTrip = vi.fn();
    const w = new ConsecutiveFailureWatchdog(3, onTrip);
    for (let i = 0; i < 50; i++) w.recordFailure();
    expect(onTrip).not.toHaveBeenCalled();
    expect(w.state.consecutiveFailures).toBe(0);
    expect(w.state.hasSucceededOnce).toBe(false);
  });

  it('trips on the Nth consecutive failure after first success', () => {
    const onTrip = vi.fn();
    const w = new ConsecutiveFailureWatchdog(3, onTrip);

    w.recordSuccess();
    expect(w.state.hasSucceededOnce).toBe(true);

    w.recordFailure();
    expect(onTrip).not.toHaveBeenCalled();
    w.recordFailure();
    expect(onTrip).not.toHaveBeenCalled();
    w.recordFailure();
    expect(onTrip).toHaveBeenCalledOnce();
    expect(onTrip).toHaveBeenCalledWith({ consecutiveFailures: 3 });
  });

  it('resets the counter on success (cycle of fail/success/fail does not accumulate)', () => {
    const onTrip = vi.fn();
    const w = new ConsecutiveFailureWatchdog(3, onTrip);

    w.recordSuccess();
    w.recordFailure();
    w.recordFailure();
    expect(w.state.consecutiveFailures).toBe(2);

    w.recordSuccess();
    expect(w.state.consecutiveFailures).toBe(0);

    w.recordFailure();
    w.recordFailure();
    expect(onTrip).not.toHaveBeenCalled();
  });

  it('keeps tripping on each failure once threshold is crossed (caller should exit)', () => {
    // The watchdog itself does not stop tripping — exiting/handling is the
    // caller's responsibility (in the real loop, onTrip calls process.exit).
    const onTrip = vi.fn();
    const w = new ConsecutiveFailureWatchdog(2, onTrip);
    w.recordSuccess();
    w.recordFailure();
    w.recordFailure(); // trips at 2
    w.recordFailure(); // trips at 3
    expect(onTrip).toHaveBeenCalledTimes(2);
    expect(onTrip).toHaveBeenLastCalledWith({ consecutiveFailures: 3 });
  });

  it('exposes state for inspection', () => {
    const w = new ConsecutiveFailureWatchdog(5, () => {});
    expect(w.state).toEqual({
      consecutiveFailures: 0,
      hasSucceededOnce: false,
      enabled: true,
    });
    w.recordSuccess();
    w.recordFailure();
    expect(w.state).toEqual({
      consecutiveFailures: 1,
      hasSucceededOnce: true,
      enabled: true,
    });
  });
});
