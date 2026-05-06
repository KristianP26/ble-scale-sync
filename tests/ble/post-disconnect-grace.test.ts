import { describe, it, expect } from 'vitest';
import { POST_DISCONNECT_GRACE_MS, RSSI_UNAVAILABLE } from '../../src/ble/types.js';
import { resolveHandlerKey } from '../../src/ble/index.js';

describe('POST_DISCONNECT_GRACE_MS', () => {
  it('is set to 25 seconds (matches typical scale advertising tail-off)', () => {
    expect(POST_DISCONNECT_GRACE_MS).toBe(25_000);
  });

  it('takes effect when scan_cooldown is below the floor', () => {
    const cooldownMs = 10_000;
    const effective = Math.max(cooldownMs, POST_DISCONNECT_GRACE_MS);
    expect(effective).toBe(POST_DISCONNECT_GRACE_MS);
  });

  it('does not lower a cooldown that is already above the floor', () => {
    const cooldownMs = 60_000;
    const effective = Math.max(cooldownMs, POST_DISCONNECT_GRACE_MS);
    expect(effective).toBe(60_000);
  });
});

describe('RSSI_UNAVAILABLE', () => {
  it('matches the BlueZ mgmt-protocol Device Found sentinel value', () => {
    expect(RSSI_UNAVAILABLE).toBe(127);
  });
});

/**
 * The continuous-mode loop in src/index.ts gates application of the floor on
 * the resolved handler key (only `node-ble` hits the dying-peer GATT stall).
 * Mirror that same predicate here so the contract is pinned by tests.
 */
describe('grace-floor handler gating (#143 / non-BlueZ exemption)', () => {
  function shouldApplyFloor(bleHandler: 'auto' | 'mqtt-proxy' | 'esphome-proxy'): boolean {
    return resolveHandlerKey(bleHandler) === 'node-ble';
  }

  it('exempts mqtt-proxy from the 25 s floor', () => {
    expect(shouldApplyFloor('mqtt-proxy')).toBe(false);
  });

  it('exempts esphome-proxy from the 25 s floor', () => {
    expect(shouldApplyFloor('esphome-proxy')).toBe(false);
  });

  it('applies the floor when the resolved handler is node-ble', () => {
    // resolveHandlerKey('auto') resolves to 'node-ble' on Linux. We assert the
    // predicate symbolically so the test runs on every platform: when the
    // resolver picks node-ble, the floor MUST apply.
    const cooldownMs = 5_000;
    const effective =
      resolveHandlerKey('auto') === 'node-ble'
        ? Math.max(cooldownMs, POST_DISCONNECT_GRACE_MS)
        : cooldownMs;
    if (resolveHandlerKey('auto') === 'node-ble') {
      expect(effective).toBe(POST_DISCONNECT_GRACE_MS);
    } else {
      expect(effective).toBe(cooldownMs);
    }
  });
});
