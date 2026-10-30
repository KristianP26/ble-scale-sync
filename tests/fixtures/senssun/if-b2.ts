import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromDebugLog, type Trace } from '../../helpers/replay/trace.js';
import type { UserProfile } from '../../../src/interfaces/scale-adapter.js';

/**
 * Senssun IF_B2 weigh-ins from three private DEBUG logs (security@, 2026-10-29
 * and 2026-10-30), ble-scale-sync v1.33.0 with the IF_B2 pull request, node-ble:
 * two barefoot and one in socks. The reporter set up a made-up profile for
 * these runs, and PROFILE below is that profile.
 *
 * The steps are the logs' Notification lines verbatim, cut at their own
 * timestamp: the live-weight line the console printed in front of some of
 * them is not part of the log line. The scale's address is rewritten to
 * 02:00:00:00:00:01 in the advert and in the address it echoes in bytes 3-8 of
 * its manufacturer data (no checksum covers them); the GATT frames do not
 * carry it and are unchanged. The logs do not show the profile writes, only
 * the scale's answers to them.
 */
const PROFILE: UserProfile = { height: 176, age: 42, gender: 'male', isAthlete: false };

const ADVERT = {
  address: '02:00:00:00:00:01',
  localName: 'IF_B2',
  serviceUuids: ['ffc0'],
  manufacturerData: { id: 0x0100, data: Buffer.from('010301020000000001', 'hex') },
};

/** Barefoot: live weights, the profile ack, then the record in 20 + 9 bytes. */
const BAREFOOT = `
2026-10-29 23:39:01.639 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 c9 08 5a 01 a0 60]
2026-10-29 23:39:01.778 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 c9 08 5a 01 a0 60]
2026-10-29 23:39:01.888 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 1e 01 a0 0a]
2026-10-29 23:39:02.063 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 1e 01 a0 0a]
2026-10-29 23:39:02.175 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b3 08 28 01 a0 18]
2026-10-29 23:39:02.326 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b3 08 28 01 a0 18]
2026-10-29 23:39:02.438 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b3 08 28 01 a0 18]
2026-10-29 23:39:02.551 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 ad 08 1a 01 a0 04]
2026-10-29 23:39:02.737 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 ad 08 1a 01 a0 04]
2026-10-29 23:39:02.812 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 ad 08 1a 01 a0 04]
2026-10-29 23:39:02.963 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 ad 08 1a 01 a0 04]
2026-10-29 23:39:03.151 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 ae 08 1c 01 a0 07]
2026-10-29 23:39:03.337 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 ae 08 1c 01 a0 07]
2026-10-29 23:39:03.450 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 ae 08 1c 01 a0 07]
2026-10-29 23:39:03.564 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 20 01 a0 0c]
2026-10-29 23:39:03.712 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 20 01 a0 0c]
2026-10-29 23:39:03.825 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 20 01 a0 0c]
2026-10-29 23:39:03.937 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 20 01 a0 0c]
2026-10-29 23:39:04.087 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 20 01 a0 0c]
2026-10-29 23:39:04.275 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 20 01 a0 0c]
2026-10-29 23:39:04.350 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 20 01 a0 0c]
2026-10-29 23:39:04.463 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 20 01 a0 0c]
2026-10-29 23:39:04.612 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 ae 08 1e 01 a0 09]
2026-10-29 23:39:07.987 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0b 03 81 00 00 01 90]
2026-10-29 23:39:13.762 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 1d 03 82 00 00 01 03 ae d3 0a 03 b5 71 98 56 04]
2026-10-29 23:39:13.762 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [00 1f 07 c3 00 00 00 00 35]
`;

/** In socks: live weights and the profile ack, then nothing until the scale drops the link. */
const SOCKS = `
2026-10-29 23:40:54.446 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b2 08 26 01 a0 15]
2026-10-29 23:40:54.607 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b1 08 22 01 a0 10]
2026-10-29 23:40:54.716 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b1 08 22 01 a0 10]
2026-10-29 23:40:54.854 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b1 08 22 01 a0 10]
2026-10-29 23:40:54.965 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b1 08 22 01 a0 10]
2026-10-29 23:40:55.101 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b1 08 22 01 a0 10]
2026-10-29 23:40:55.239 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b1 08 22 01 a0 10]
2026-10-29 23:40:55.404 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b1 08 22 01 a0 10]
2026-10-29 23:40:55.514 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b1 08 22 01 a0 10]
2026-10-29 23:40:55.625 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 b1 08 22 01 a0 10]
2026-10-29 23:40:57.466 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0b 03 81 00 00 01 90]
`;

/** Barefoot again: the record follows the ack within 0.1 s. */
const BAREFOOT_SECOND = `
2026-10-30 02:10:59.905 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 1e 01 a0 0a]
2026-10-30 02:11:00.043 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 1e 01 a0 0a]
2026-10-30 02:11:00.153 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0e 03 80 03 af 08 20 01 a0 0c]
2026-10-30 02:11:03.726 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 0b 03 81 00 00 01 90]
2026-10-30 02:11:03.802 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [10 00 00 c5 1d 03 82 00 00 01 03 af 01 17 00 fb 01 ef 01 76]
2026-10-30 02:11:03.802 [BLE:debug] Notification 0000fff100001000800000805f9b34fb: [00 1f 07 c5 00 00 00 00 ba]
`;

const traces: Record<string, Trace> = {
  'if-b2-473-barefoot': {
    provenance: 'captured',
    source: 'private DEBUG log, 2026-10-29 23:39:01 .. 23:39:13, barefoot',
    advert: ADVERT,
    steps: fromDebugLog(BAREFOOT),
  },
  'if-b2-473-socks': {
    provenance: 'captured',
    source: 'private DEBUG log, 2026-10-29 23:40:54 .. 23:41:09, in socks',
    advert: ADVERT,
    steps: fromDebugLog(SOCKS),
    // The log's first line after the scale dropped the link.
    disconnectAtMs: 15_247,
  },
  'if-b2-473-barefoot-second': {
    provenance: 'captured',
    source: 'private DEBUG log, 2026-10-30 02:10:59 .. 02:11:03, barefoot',
    advert: ADVERT,
    steps: fromDebugLog(BAREFOOT_SECOND),
  },
};

export const session: SessionFixture = {
  adapter: 'Senssun IF_B2',
  profile: PROFILE,
  config: { profileForWeight: () => PROFILE },
  traces,
};
