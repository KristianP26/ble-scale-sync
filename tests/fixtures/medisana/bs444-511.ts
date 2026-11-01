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
 * Derived, not captured byte for byte: frame lengths, constant bytes, order,
 * receipt spacing, which records share a weight, and the epoch each stamp
 * counts from (28 from 2010-01-01, 2 written while the clock counted Unix
 * seconds) are the log's. Changed: every stamp and receipt time moved by the
 * same offset, and the weight, BMR, body fat, water, muscle and bone values
 * and 0x8A21 [9..10] replaced by invented ones. The name is not the scale's.
 */

export const DERIVED_511 = `
2026-04-11 03:09:27.817 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 30 20 00 fe d8 8e 93 1e 10 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:27.818 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f d8 8e 93 1e 01 72 06 f5 f0 1a f2 92 f1 22 f0 00 00 00]
2026-04-11 03:09:27.819 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 3f 20 00 fe c0 91 93 1e 79 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:27.819 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f c0 91 93 1e 01 75 06 f6 f0 19 f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:27.836 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe f6 93 93 1e ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:27.836 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f f6 93 93 1e 01 78 06 f7 f0 18 f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:27.856 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe 54 98 93 1e ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:27.857 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 54 98 93 1e 01 78 06 f7 f0 18 f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:27.876 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe aa 98 93 1e ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:27.876 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f aa 98 93 1e 01 78 06 f7 f0 18 f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:27.916 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe f6 d3 d0 69 ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:27.916 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f f6 d3 d0 69 01 78 06 f7 f0 18 f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:27.936 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe 46 99 93 1e ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:27.936 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 46 99 93 1e 01 78 06 f7 f0 18 f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:27.956 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe 96 99 93 1e ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:27.956 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 96 99 93 1e 01 78 06 f7 f0 18 f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:27.976 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe e7 d4 d0 69 ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:27.976 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f e7 d4 d0 69 01 78 06 f7 f0 18 f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:27.996 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 4e 20 00 fe e0 b2 93 1e 42 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:27.996 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f e0 b2 93 1e 01 7b 06 f8 f0 17 f2 92 f1 22 f0 00 00 00]
2026-04-11 03:09:28.017 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 35 20 00 fe 92 b5 93 1e 33 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.017 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 92 b5 93 1e 01 7e 06 f9 f0 1a f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:28.036 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d f4 1f 00 fe e8 c3 99 1e 0c 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.036 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f e8 c3 99 1e 01 81 06 f5 f0 19 f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:28.056 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d c7 1f 00 fe 43 44 9b 1e 71 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.056 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 43 44 9b 1e 01 84 06 f6 f0 18 f2 92 f1 22 f0 00 00 00]
2026-04-11 03:09:28.076 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe 48 8c 9b 1e ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.076 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 48 8c 9b 1e 01 87 06 f7 f0 17 f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:28.096 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 44 20 00 fe 8d 8d 9b 1e 9c 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.096 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 8d 8d 9b 1e 01 8a 06 f8 f0 1a f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:28.116 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe 0a 8f 9b 1e ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.116 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 0a 8f 9b 1e 01 78 06 f7 f0 18 f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:28.136 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe f4 90 9b 1e ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.136 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f f4 90 9b 1e 01 78 06 f7 f0 18 f2 94 f1 22 f0 00 00 00]
2026-04-11 03:09:28.156 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 26 20 00 fe f2 93 9b 1e ca 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.156 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f f2 93 9b 1e 01 87 06 f7 f0 17 f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:28.176 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 3f 20 00 fe f3 98 9b 1e 79 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.176 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f f3 98 9b 1e 01 75 06 f6 f0 19 f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:28.196 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 30 20 00 fe 37 9c 9b 1e 10 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.196 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 37 9c 9b 1e 01 72 06 f5 f0 1a f2 92 f1 22 f0 00 00 00]
2026-04-11 03:09:28.216 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 30 20 00 fe a4 9c 9b 1e 10 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.216 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f a4 9c 9b 1e 01 72 06 f5 f0 1a f2 92 f1 22 f0 00 00 00]
2026-04-11 03:09:28.255 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 30 20 00 fe cf a0 9b 1e 10 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.256 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f cf a0 9b 1e 01 72 06 f5 f0 1a f2 92 f1 22 f0 00 00 00]
2026-04-11 03:09:28.257 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 3a 20 00 fe 03 a2 9b 1e 56 11 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.257 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 03 a2 9b 1e 01 8d 06 f9 f0 19 f2 92 f1 22 f0 00 00 00]
2026-04-11 03:09:28.296 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 17 20 00 fe c4 7c 9c 1e 61 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.296 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f c4 7c 9c 1e 01 90 06 f5 f0 18 f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:28.316 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 17 20 00 fe 3c 7d 9c 1e 61 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.317 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 3c 7d 9c 1e 01 90 06 f5 f0 18 f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:28.336 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 17 20 00 fe 05 7e 9c 1e 61 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.336 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 05 7e 9c 1e 01 90 06 f5 f0 18 f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:28.356 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 17 20 00 fe 6b 7e 9c 1e 61 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.356 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 6b 7e 9c 1e 01 90 06 f5 f0 18 f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:28.376 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 17 20 00 fe c7 7f 9c 1e 61 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.376 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f c7 7f 9c 1e 01 90 06 f5 f0 18 f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:28.396 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 17 20 00 fe 11 80 9c 1e 61 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.396 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 11 80 9c 1e 01 90 06 f5 f0 18 f2 93 f1 22 f0 00 00 00]
2026-04-11 03:09:28.416 [BLE:debug] Notification 00008a2100001000800000805f9b34fb: [1d 17 20 00 fe 60 80 9c 1e 61 10 00 ff 01 09 00 00 00 00]
2026-04-11 03:09:28.416 [BLE:debug] Notification 00008a2200001000800000805f9b34fb: [6f 60 80 9c 1e 01 90 06 f5 f0 18 f2 93 f1 22 f0 00 00 00]
`;

/** Every characteristic of the scale's 0x78B2 service, as the log listed them. */
const CHARS = ['8a82', '8a21', '8a22', '8a20', '8a81'];
const advert = { localName: '01319800000000AA', address: FAKE_ADDRESS, serviceUuids: ['78b2'] };

export const session: SessionFixture = {
  adapter: 'Medisana BS44x',
  // The receipt time of the first frame of the second session.
  now: Date.UTC(2026, 3, 11, 3, 9, 27, 817),
  chars: CHARS,
  traces: {
    'bs444-511-no-frames': {
      provenance: 'derived',
      source: '#511 security@ log 2026-11-01, first session: no frame, link ended after 7.1 s',
      advert,
      steps: [],
      disconnectAtMs: 7123,
    },
    'bs444-511-memory-and-weigh-in': {
      provenance: 'derived',
      source: '#511 security@ log 2026-11-01, second session: 30 stored records, the last one live',
      advert,
      steps: fromDebugLog(DERIVED_511),
      // 0.742 s after the first frame, 0.143 s after the last.
      disconnectAtMs: 742,
    },
  },
};
