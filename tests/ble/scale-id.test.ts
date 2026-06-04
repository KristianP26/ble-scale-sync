import { describe, it, expect } from 'vitest';
import { isValidScaleId, SCALE_ID_HINT } from '../../src/ble/scale-id.js';

describe('isValidScaleId', () => {
  it('accepts a MAC address', () => {
    expect(isValidScaleId('AA:BB:CC:DD:EE:FF')).toBe(true);
    expect(isValidScaleId('ff:03:00:13:a1:04')).toBe(true);
  });

  it('accepts a dashed CoreBluetooth UUID', () => {
    expect(isValidScaleId('12345678-1234-1234-1234-123456789ABC')).toBe(true);
  });

  it('accepts a bare 32-hex CoreBluetooth UUID (macOS peripheral.id, #212)', () => {
    // The exact value the reporter's wizard produced.
    expect(isValidScaleId('360c96baf290475b14ce7c28aa3b8e81')).toBe(true);
    expect(isValidScaleId('360C96BAF290475B14CE7C28AA3B8E81')).toBe(true);
  });

  it('rejects malformed identifiers', () => {
    expect(isValidScaleId('not-a-mac')).toBe(false);
    expect(isValidScaleId('')).toBe(false);
    // 31 hex (too short) and 33 hex (too long)
    expect(isValidScaleId('360c96baf290475b14ce7c28aa3b8e8')).toBe(false);
    expect(isValidScaleId('360c96baf290475b14ce7c28aa3b8e811')).toBe(false);
    // MAC missing a group
    expect(isValidScaleId('AA:BB:CC:DD:EE')).toBe(false);
    // Dashed UUID with wrong group lengths
    expect(isValidScaleId('1234567-1234-1234-1234-123456789ABC')).toBe(false);
    // Non-hex characters
    expect(isValidScaleId('360c96baf290475b14ce7c28aa3b8eZZ')).toBe(false);
  });

  it('exposes a hint that names both accepted forms', () => {
    expect(SCALE_ID_HINT).toContain('MAC address');
    expect(SCALE_ID_HINT).toContain('CoreBluetooth UUID');
  });
});
