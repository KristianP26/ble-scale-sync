import { describe, it, expect } from 'vitest';
import { nativePolicy, proxyScanPolicy, proxyWatcherPolicy } from '../../src/ble/session/runner.js';

/**
 * The session policy of every transport path as data (arch wave 2), the table
 * in BLE-LAYER.md "Status ramce a idle timeout". The transport tests pin what
 * each path does with it; this pins the values, so a change to one is a
 * deliberate edit here too.
 */
describe('session policies', () => {
  it('native: session_timeout_sec, cap 3 x that, moved by a hold', () => {
    expect(nativePolicy()).toEqual({
      idleMs: 120_000,
      idleMessage: 'Timed out waiting for a complete scale reading',
      cap: { ms: 360_000, message: 'GATT session cap exceeded', movedByHold: true },
    });
    expect(nativePolicy(5_000).cap?.ms).toBe(15_000);
  });

  it('proxy watcher: 60 s idle, 90 s cap a hold does not move', () => {
    expect(proxyWatcherPolicy('AA:BB (autonomous)')).toEqual({
      idleMs: 60_000,
      idleMessage: 'GATT reading timeout for AA:BB (autonomous)',
      cap: {
        ms: 90_000,
        message: 'GATT session cap exceeded for AA:BB (autonomous)',
        movedByHold: false,
      },
    });
  });

  it('esphome-proxy single-shot: 60 s idle, no cap', () => {
    expect(proxyScanPolicy('AA:BB')).toEqual({
      idleMs: 60_000,
      idleMessage: 'GATT reading timeout for AA:BB',
    });
  });
});
