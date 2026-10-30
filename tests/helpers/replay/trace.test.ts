import { describe, it, expect } from 'vitest';
import { fromDebugLog } from './trace.js';

describe('fromDebugLog', () => {
  // The line shared.ts logs for every notification, as a reporter pastes it.
  const log = `
2026-10-20 13:34:07.701 [BLE:debug] Notification 0000ffe400001000800000805f9b34fb: [0d 1f 05 05 1f]
2026-10-20 13:34:07.705 [BLE:debug] ACK [0d] written in 3 ms (waited 0 ms)
2026-10-20 13:34:08.952 [BLE:debug] Notification 0000ffe400001000800000805f9b34fb: [0d 1f]`;

  it('times the notifications from the first one and skips other lines', () => {
    const uuid = '0000ffe400001000800000805f9b34fb';
    expect(fromDebugLog(log)).toEqual([
      { atMs: 0, dir: 'rx', uuid, hex: '0d1f05051f' },
      { atMs: 1251, dir: 'rx', uuid, hex: '0d1f' },
    ]);
  });

  it('refuses a frame the log cut at 32 bytes', () => {
    const cut = `2026-10-20 13:34:07.701 [BLE:debug] Notification 2a9d: [${'00 '.repeat(31)}00] (+4 bytes)`;
    expect(() => fromDebugLog(cut)).toThrow(/truncated/);
  });
});
