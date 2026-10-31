import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromDebugLog } from '../../helpers/replay/trace.js';

/**
 * Renpho ES-WBE28 weigh-in of #510: the Notification lines of the DEBUG log
 * in issue comment 6544232735 (add-on 1.38.0, 2026-10-31), verbatim. The
 * address is not in those lines and the session does not read it. The log's
 * times are UTC (the logger prints toISOString without the Z), and so is the
 * scale clock: the 0x2A9D stamps run up to a few minutes ahead of the receipt in
 * UTC and close to an hour behind it in Madrid, the zone the add-on ran in.
 *
 * The session runs in that zone at the time of the first Notification line,
 * and the scale ends the link where the log's BlueZ line says. The device
 * exposes the characteristics of the #267 capture (tests/fixtures/renpho/es-wbe28.ts).
 */

const COMMENT_6544232735 = `
2026-10-31 13:46:55.238 [BLE:debug] Notification 0000ffe100001000800000805f9b34fb: [20 10 03 00 00 00 00 06 39]
2026-10-31 13:46:55.327 [BLE:debug] Notification 0000ffe100001000800000805f9b34fb: [20 03 01 24]
2026-10-31 13:46:55.417 [BLE:debug] Notification 0000ffe100001000800000805f9b34fb: [20 19 01 3a]
2026-10-31 13:46:55.507 [BLE:debug] Notification 00002a9f00001000800000805f9b34fb: [20 02 01]
2026-10-31 13:46:56.047 [BLE:debug] Notification 00002a9d00001000800000805f9b34fb: [4e 9c 04 ea 07 0a 1f 0d 33 18 aa 00 00 00 00]
2026-10-31 13:46:56.495 [BLE:debug] Notification 00002a9d00001000800000805f9b34fb: [4e 9c 04 ea 07 0a 1f 0d 33 18 aa 00 00 00 00]
2026-10-31 13:46:56.991 [BLE:debug] Notification 00002a9d00001000800000805f9b34fb: [4e 9c 04 ea 07 0a 1f 0d 33 18 aa 00 00 00 00]
2026-10-31 13:46:57.485 [BLE:debug] Notification 00002a9d00001000800000805f9b34fb: [4e 9c 04 ea 07 0a 1f 0d 33 18 aa 00 00 00 00]
2026-10-31 13:46:57.981 [BLE:debug] Notification 00002a9d00001000800000805f9b34fb: [4e 9c 04 ea 07 0a 1f 0d 33 18 aa 00 00 00 00]
2026-10-31 13:46:58.475 [BLE:debug] Notification 00002a9d00001000800000805f9b34fb: [2e 9c 04 ea 07 0a 1f 0d 2f 13 aa ba 00 b2 00]
2026-10-31 13:46:58.520 [BLE:debug] Notification 00002a9c00001000800000805f9b34fb: [7e 53 5b 00 ea 07 0a 1f 0d 2f 13 aa f8 05 4b 02 fc 03 30 04]
2026-10-31 13:46:58.565 [BLE:debug] Notification 00002a9c00001000800000805f9b34fb: [90 02 f6 01 f4 01 36 00 02 53 00 cf 00 25 00 06 03 05 00]
`;

export const session: SessionFixture = {
  adapter: 'Renpho ES-WBE28',
  timeZone: 'Europe/Madrid',
  now: Date.UTC(2026, 9, 31, 13, 46, 55, 238),
  chars: ['ffe1', 'ffe2', '2a9f', '2a9d', '2a9c', '2a8c', '2a8e', '2a85', '2a80', '2aff'],
  traces: {
    'wbe28-510-weigh-in': {
      provenance: 'captured',
      source: '#510 comment 6544232735, DEBUG log 2026-10-31 13:46:55 .. 13:47:10 UTC',
      // 13:47:10.581, the BlueZ line: the scale ended the link 17 s after connecting.
      disconnectAtMs: 15343,
      steps: fromDebugLog(COMMENT_6544232735),
    },
  },
};
