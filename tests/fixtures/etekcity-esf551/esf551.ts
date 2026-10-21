import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromDebugLog, type Trace } from '../../helpers/replay/trace.js';

/**
 * Etekcity ESF-551 (#385): no handshake, settling frames on FFF1 until the
 * settled one ([19] = 1), which is the reading.
 *
 * The captured trace is the Notification lines of the #385 DEBUG log
 * (node-ble, 2026-09-02, issue body), verbatim: one weigh-in from first
 * contact to the short end-of-session frame. The log's address is not in
 * those lines and the session does not read it. The derived traces edit the
 * settled frame the way tests/scales/etekcity-esf551.test.ts does, with the
 * checksum [5] recomputed unless the checksum is the point.
 */

const ISSUE_385 = `
2026-09-02 08:45:17.316 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 9d 10 00 d8 01 61 a1 00 e8 16 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:17.318 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 9e 10 00 9a 01 61 a1 00 24 17 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:17.652 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 9f 10 00 b2 01 61 a1 00 0a 18 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:17.655 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 a0 10 00 89 01 61 a1 00 30 1a 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:17.656 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 a1 10 00 51 01 61 a1 00 66 1b 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:17.657 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 a2 10 00 ce 01 61 a1 00 e8 1b 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:17.945 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 a3 10 00 81 01 61 a1 00 32 1d 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:17.947 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 a4 10 00 76 01 61 a1 00 3c 1d 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:17.949 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 a5 10 00 48 01 61 a1 00 6a 1c 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:18.030 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 a6 10 00 6f 01 61 a1 00 42 1c 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:18.032 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 a7 10 00 55 01 61 a1 00 5c 1b 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:18.034 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 a8 10 00 31 01 61 a1 00 80 1a 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:18.035 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 a9 10 00 26 01 61 a1 00 8a 1a 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:18.128 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 aa 10 00 07 01 61 a1 00 a8 1a 01 00 00 0d c0 98 6a 00 01 01]
2026-09-02 08:45:18.371 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 ab 10 00 e7 01 61 a1 00 c6 1a 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:18.373 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 ac 10 00 be 01 61 a1 00 ee 1a 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:18.377 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 ad 10 00 94 01 61 a1 00 16 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:18.379 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 ae 10 00 7f 01 61 a1 00 2a 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:18.469 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 af 10 00 6a 01 61 a1 00 3e 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:18.712 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 b0 10 00 69 01 61 a1 00 3e 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:18.714 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 b1 10 00 5e 01 61 a1 00 48 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:18.809 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 b2 10 00 5d 01 61 a1 00 48 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:18.811 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 b3 10 00 52 01 61 a1 00 52 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:19.005 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 b4 10 00 51 01 61 a1 00 52 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:19.007 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 b5 10 00 50 01 61 a1 00 52 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:19.053 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 b6 10 00 4f 01 61 a1 00 52 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:19.150 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 b7 10 00 4e 01 61 a1 00 52 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:19.152 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 b8 10 00 4d 01 61 a1 00 52 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:19.154 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 b9 10 00 4c 01 61 a1 00 52 1b 01 00 00 0e c0 98 6a 00 01 01]
2026-09-02 08:45:19.200 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 ba 10 00 4a 01 61 a1 00 52 1b 01 00 00 0f c0 98 6a 00 01 01]
2026-09-02 08:45:23.297 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 bb 10 00 2f 01 61 a1 00 52 1b 01 13 02 13 c0 98 6a 01 01 01]
2026-09-02 08:45:40.357 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [a5 02 bc 05 00 f3 01 01 a0 00 02]
`;

const SETTLING = 'a5029d1000d80161a100e8160100000dc0986a000101';
const SHORT = 'a502bc0500f30101a00002';

const traces: Record<string, Trace> = {
  '385-weigh-in': {
    provenance: 'captured',
    source: '#385 issue body, DEBUG log 2026-09-02 08:45:17 .. 08:45:40',
    steps: fromDebugLog(ISSUE_385),
  },
  // [20] = 0: the scale says the impedance field means nothing (socks).
  '385-impedance-not-valid': {
    provenance: 'derived',
    source: '#385 settling and settled frames, the settled [20] set to 0',
    steps: [
      { atMs: 0, dir: 'rx', hex: SETTLING },
      { atMs: 2000, dir: 'rx', hex: 'a502bb1000300161a100521b01130213c0986a010001' },
    ],
  },
  // A settled frame with a flipped weight bit (checksum as captured) and one
  // with a signature byte off (checksum recomputed) are both dropped.
  '385-dropped-settled': {
    provenance: 'derived',
    source: '#385 settled frame edited twice, then the short end-of-session frame',
    steps: [
      { atMs: 0, dir: 'rx', hex: SETTLING },
      { atMs: 2000, dir: 'rx', hex: 'a502bb10002f0161a100521a01130213c0986a010101' },
      { atMs: 2100, dir: 'rx', hex: 'a502bb10002e0162a100521b01130213c0986a010101' },
      { atMs: 19000, dir: 'rx', hex: SHORT },
    ],
  },
};

export const session: SessionFixture = {
  adapter: 'Etekcity ESF-551',
  traces,
};
