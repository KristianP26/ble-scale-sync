import { describe, it, expect } from 'vitest';
import { POST_DISCONNECT_GRACE_MS, RSSI_UNAVAILABLE } from '../../src/ble/types.js';

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
