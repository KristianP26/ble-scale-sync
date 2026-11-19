import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMBEDDED_BROKER_LIMITS } from '../../src/ble/embedded-broker.js';

const MAIN_PY = fileURLToPath(new URL('../../firmware/main.py', import.meta.url));
const SIZE_TEST_PY = fileURLToPath(
  new URL('../../firmware/tests/test_scan_payload_size.py', import.meta.url),
);

describe('embedded broker limits against the ESP32 firmware', () => {
  // The broker refuses a keep alive of 0 or over `maxKeepaliveSec`. A Python
  // side edit of the firmware's keep alive must not lock the ESP32 out unseen.
  it('accepts the keep alive the firmware connects with', () => {
    const source = readFileSync(MAIN_PY, 'utf8');
    const match = /mqtt_config\["keepalive"\]\s*=\s*(\d+)/.exec(source);
    expect(match, 'keepalive assignment not found in firmware/main.py').not.toBeNull();
    const keepalive = Number(match![1]);
    expect(keepalive).toBeGreaterThan(0);
    expect(keepalive).toBeLessThanOrEqual(EMBEDDED_BROKER_LIMITS.maxKeepaliveSec);
  });

  // The firmware size test checks a worst scan batch against its own copy of the
  // packet limit; the copy has to be the broker's.
  it('keeps the packet limit of the firmware size test equal to the broker limit', () => {
    const source = readFileSync(SIZE_TEST_PY, 'utf8');
    const match = /^_BROKER_PACKET_LIMIT\s*=\s*([\d_]+)/m.exec(source);
    expect(match, '_BROKER_PACKET_LIMIT not found in test_scan_payload_size.py').not.toBeNull();
    expect(Number(match![1].replaceAll('_', ''))).toBe(EMBEDDED_BROKER_LIMITS.maxPacketBytes);
  });
});
