import type { SessionFixture } from '../../helpers/replay/session.js';
import { FAKE_ADDRESS } from '../../helpers/replay/session.js';
import { fromDebugLog } from '../../helpers/replay/trace.js';

/**
 * Medisana BS444 (#511): the reporter's DEBUG log with BLE_RAW_CAPTURE, mailed
 * to security@ on 2026-11-01, from their own build of 1.38.0 that enabled both
 * 0x8A21 and 0x8A22. Two sessions: the first got no frame and the scale ended
 * it after 7.1 s; the second got the scale's whole memory, 30 records as a
 * 0x8A21 weight frame each followed by a 0x8A22 composition frame with the
 * same stamp, in 0.6 s, and the scale ended the link 0.14 s after the last.
 * The last record is the weigh-in of that session, 8 s old.
 *
 * The frames and their receipt times are the log's, byte for byte, rewritten
 * from its RAW lines as Notification lines; the reporter agreed to their use
 * here. The name and address are not the scale's.
 */

export const CAPTURED_511 = `
2026-11-01 06:27:08.817 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 72 29 00 fe 2d af a0 1f 02 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:08.818 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 2d af a0 1f 01 c3 07 2c f1 0f f2 58 f1 23 f0 00 00 00]
2026-11-01 06:27:08.819 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 90 29 00 fe 15 b2 a0 1f e3 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:08.819 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 15 b2 a0 1f 01 c8 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:08.836 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe 4b b4 a0 1f 25 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:08.836 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 4b b4 a0 1f 01 c6 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:08.856 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe a9 b8 a0 1f e3 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:08.857 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f a9 b8 a0 1f 01 c6 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:08.876 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe ff b8 a0 1f cd 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:08.876 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f ff b8 a0 1f 01 c6 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:08.916 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe 4b f4 dd 6a 46 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:08.916 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 4b f4 dd 6a 01 c6 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:08.936 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe 9b b9 a0 1f 52 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:08.936 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 9b b9 a0 1f 01 c6 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:08.956 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe eb b9 a0 1f 02 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:08.956 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f eb b9 a0 1f 01 c6 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:08.976 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe 3c f5 dd 6a 08 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:08.976 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 3c f5 dd 6a 01 c6 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:08.996 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d b8 29 00 fe 35 d3 a0 1f 74 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:08.996 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 35 d3 a0 1f 01 ce 07 30 f1 0c f2 56 f1 23 f0 00 00 00]
2026-11-01 06:27:09.017 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d a4 29 00 fe e7 d5 a0 1f 00 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.017 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f e7 d5 a0 1f 01 cb 07 2e f1 0d f2 56 f1 23 f0 00 00 00]
2026-11-01 06:27:09.036 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d f0 28 00 fe 3d e4 a6 1f 45 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.036 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 3d e4 a6 1f 01 b0 07 27 f1 13 f2 5b f1 23 f0 00 00 00]
2026-11-01 06:27:09.056 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 96 28 00 fe 98 64 a8 1f a1 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.056 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 98 64 a8 1f 01 a3 07 23 f1 16 f2 5d f1 23 f0 00 00 00]
2026-11-01 06:27:09.076 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe 9d ac a8 1f 65 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.076 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 9d ac a8 1f 01 c6 07 2c f1 0f f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:09.096 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 7c 29 00 fe e2 ad a8 1f 64 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.096 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f e2 ad a8 1f 01 c5 07 2c f1 0f f2 58 f1 23 f0 00 00 00]
2026-11-01 06:27:09.116 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe 5f af a8 1f 75 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.116 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 5f af a8 1f 01 c6 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:09.136 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe 49 b1 a8 1f 25 11 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.136 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 49 b1 a8 1f 01 c6 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:09.156 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 86 29 00 fe 47 b4 a8 1f 3f 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.156 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 47 b4 a8 1f 01 c6 07 2c f1 0f f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:09.176 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 90 29 00 fe 48 b9 a8 1f a2 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.176 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 48 b9 a8 1f 01 c8 07 2d f1 0e f2 57 f1 23 f0 00 00 00]
2026-11-01 06:27:09.196 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 72 29 00 fe 8c bc a8 1f c2 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.196 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 8c bc a8 1f 01 c3 07 2c f1 0f f2 58 f1 23 f0 00 00 00]
2026-11-01 06:27:09.216 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 72 29 00 fe f9 bc a8 1f e7 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.216 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f f9 bc a8 1f 01 c3 07 2c f1 0f f2 58 f1 23 f0 00 00 00]
2026-11-01 06:27:09.255 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 72 29 00 fe 24 c1 a8 1f 97 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.256 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 24 c1 a8 1f 01 c3 07 2c f1 0f f2 58 f1 23 f0 00 00 00]
2026-11-01 06:27:09.257 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 68 29 00 fe 58 c2 a8 1f bc 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.257 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 58 c2 a8 1f 01 c2 07 2b f1 0f f2 58 f1 23 f0 00 00 00]
2026-11-01 06:27:09.296 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d e6 28 00 fe 19 9d a9 1f 97 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.296 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 19 9d a9 1f 01 af 07 25 f1 14 f2 5b f1 23 f0 00 00 00]
2026-11-01 06:27:09.316 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d e6 28 00 fe 91 9d a9 1f 66 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.317 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 91 9d a9 1f 01 af 07 25 f1 14 f2 5b f1 23 f0 00 00 00]
2026-11-01 06:27:09.336 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d e6 28 00 fe 5a 9e a9 1f 3d 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.336 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 5a 9e a9 1f 01 af 07 25 f1 14 f2 5b f1 23 f0 00 00 00]
2026-11-01 06:27:09.356 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d e6 28 00 fe c0 9e a9 1f 8f 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.356 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f c0 9e a9 1f 01 af 07 25 f1 14 f2 5b f1 23 f0 00 00 00]
2026-11-01 06:27:09.376 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d e6 28 00 fe 1c a0 a9 1f 66 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.376 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 1c a0 a9 1f 01 af 07 25 f1 14 f2 5b f1 23 f0 00 00 00]
2026-11-01 06:27:09.396 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d e6 28 00 fe 66 a0 a9 1f 60 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.396 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 66 a0 a9 1f 01 af 07 25 f1 14 f2 5b f1 23 f0 00 00 00]
2026-11-01 06:27:09.416 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d e6 28 00 fe b5 a0 a9 1f 83 10 00 ff 01 09 00 00 00 00]
2026-11-01 06:27:09.416 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f b5 a0 a9 1f 01 af 07 25 f1 14 f2 5b f1 23 f0 00 00 00]
`;

/** Every characteristic of the scale's 0x78B2 service, as the log listed them. */
const CHARS = ['8a82', '8a21', '8a22', '8a20', '8a81'];
const advert = { localName: '01319800000000AA', address: FAKE_ADDRESS, serviceUuids: ['78b2'] };

export const session: SessionFixture = {
  adapter: 'Medisana BS44x',
  // The receipt time of the first frame of the second session.
  now: Date.UTC(2026, 10, 1, 6, 27, 8, 817),
  chars: CHARS,
  traces: {
    'bs444-511-no-frames': {
      provenance: 'captured',
      source: '#511 security@ log 2026-11-01, first session: no frame, link ended after 7.1 s',
      advert,
      steps: [],
      disconnectAtMs: 7123,
    },
    'bs444-511-memory-and-weigh-in': {
      provenance: 'captured',
      source: '#511 security@ log 2026-11-01, second session: 30 stored records, the last one live',
      advert,
      steps: fromDebugLog(CAPTURED_511),
      // 0.742 s after the first frame, 0.143 s after the last.
      disconnectAtMs: 742,
    },
  },
};
