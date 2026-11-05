import type { UserProfile } from '../../../src/interfaces/scale-adapter.js';
import type { SessionFixture } from '../../helpers/replay/session.js';
import type { SnoopLine } from '../../helpers/replay/trace.js';
import { ADDRESS, AE00_CHARS, qnSteps } from './frames.js';

/**
 * #331, an Arboleaf CS10E on the 20-byte extended dialect with the JieLi AE00
 * gate, v1.39.1 over an ESPHome proxy with the reporter's options
 * (qn_user_key 1000, qn_config_long, qn_time_sync_long, qn_weight_ack): the
 * public DEBUG log of comment 6635516737, every `ESPHome notify handle` line
 * of its first two sessions, timed by the log. Rewritten: the MAC (frames.ts),
 * in the 0x12 and the advertisement.
 *
 * Both sessions answer the profile frame with seven bytes,
 * `a1 07 02 01 01 07 b3`. At 15:17 the scale streams live frames after that
 * answer and ends the weigh-in with three 0xB4 for no user and a one-part
 * 119-byte 0xB1 for user slot 1. At 15:18 the proxy connects again while the
 * scale is still on, and nothing follows the answer. Only the 15:18 session
 * had an advertisement. The profile is the fixture's own, not the reporter's.
 */
export const SESSION_331_1517: readonly SnoopLine[] = [
  ['15:17:48.728', 'rx', '12 14 ff 01 00 00 00 00 02 22 0f 51 00 08 05 03 e0 6f eb f4'],
  ['15:17:48.980', 'rx', '12 14 ff 01 00 00 00 00 02 22 0f 51 00 08 05 03 e0 6f eb f4'],
  ['15:17:49.190', 'rx', '14 0f ff 01 00 01 00 00 64 01 fd 08 01 01 90'],
  ['15:17:49.347', 'rx', '00 cc f0 58 3c d7 9b 06 e6 bd 8e 73 2e f4 3a ce b9'],
  ['15:17:49.443', 'rx', '02 70 61 73 73'],
  ['15:17:49.545', 'rx', '21 07 ff 01 61 2c b5'],
  ['15:17:49.858', 'rx', 'a1 07 02 01 01 07 b3'],
  ['15:17:49.994', 'rx', '10 14 01 00 11 24 36 00 00 00 00 00 00 00 00 00 00 00 00 90'],
  ['15:17:50.204', 'rx', '10 14 01 00 11 24 45 00 00 00 00 00 00 00 00 00 00 00 00 9f'],
  ['15:17:50.467', 'rx', '10 14 01 00 11 24 4f 00 00 00 00 00 00 00 00 00 00 00 00 a9'],
  ['15:17:50.774', 'rx', '10 14 01 00 11 24 40 00 00 00 00 00 00 00 00 00 00 00 00 9a'],
  ['15:17:50.981', 'rx', 'a3 04 01 a8'],
  ['15:17:50.981', 'rx', '10 14 01 00 11 24 40 00 00 00 00 00 00 00 00 00 00 00 00 9a'],
  ['15:17:51.083', 'rx', 'a3 04 01 a8'],
  ['15:17:51.186', 'rx', '10 14 01 00 11 24 40 00 00 00 00 00 00 00 00 00 00 00 00 9a'],
  ['15:17:51.428', 'rx', '10 14 01 00 11 24 45 00 00 00 00 00 00 00 00 00 00 00 00 9f'],
  ['15:17:51.695', 'rx', '10 14 01 00 11 24 4a 00 00 00 00 00 00 00 00 00 00 00 00 a4'],
  ['15:17:52.001', 'rx', '10 14 01 00 11 24 4a 00 00 00 00 00 00 00 00 00 00 00 00 a4'],
  ['15:17:52.215', 'rx', '10 14 01 00 11 24 4a 00 00 00 00 00 00 00 00 00 00 00 00 a4'],
  ['15:17:52.413', 'rx', '10 14 01 00 11 24 4f 00 00 00 00 00 00 00 00 00 00 00 00 a9'],
  ['15:17:52.742', 'rx', '10 14 01 00 11 24 4a 00 00 00 00 00 00 00 00 00 00 00 00 a4'],
  ['15:17:52.975', 'rx', '10 14 01 00 11 24 4a 00 00 00 00 00 00 00 00 00 00 00 00 a4'],
  ['15:17:53.181', 'rx', '10 14 01 00 11 24 4a 00 00 00 00 00 00 00 00 00 00 00 00 a4'],
  ['15:17:53.438', 'rx', '10 14 01 00 11 24 4f 00 00 00 00 00 00 00 00 00 00 00 00 a9'],
  ['15:17:54.058', 'rx', '10 14 01 01 11 24 4a 00 00 00 00 00 00 00 00 00 00 00 00 a5'],
  [
    '15:18:07.568',
    'rx',
    'b4 7d 01 01 f0 08 01 30 e9 7c 32 3b 24 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 02 54',
  ],
  [
    '15:18:07.979',
    'rx',
    'b4 7d 01 01 f0 08 01 30 e9 7c 32 3b 24 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 02 54',
  ],
  [
    '15:18:08.234',
    'rx',
    'b4 7d 01 01 f0 08 01 30 e9 7c 32 3b 24 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 02 54',
  ],
  [
    '15:18:08.338',
    'rx',
    'b1 77 01 01 01 4a 24 22 0d b7 0b 27 0d c7 0b aa 0a 80 09 39 0a 19 09 10 01 ea 00 2e 0d c9 ' +
      '0b 30 0d d7 0b 48 0a 2c 09 15 0a f4 08 04 01 e1 00 ed 00 00 00 18 01 26 02 d4 02 0a 29 6c ' +
      '07 ad 00 00 26 00 fb 02 cf 00 ec 01 c8 02 07 cf 83 8e 01 e2 83 8e 01 26 0a 77 01 d3 66 8e ' +
      '01 d4 64 8e 01 da 75 8e 01 69 76 8e 01 cd 08 77 01 b5 5b 8e 01 84 59 8e 01 f5 0a 01 9a',
  ],
];

export const SESSION_331_1818: readonly SnoopLine[] = [
  ['15:18:09.308', 'rx', '12 14 ff 01 00 00 00 00 02 22 0f 51 00 00 05 03 e0 6f eb ec'],
  ['15:18:09.513', 'rx', '12 14 ff 01 00 00 00 00 02 22 0f 51 00 00 05 03 e0 6f eb ec'],
  ['15:18:09.726', 'rx', '14 0f ff 01 00 01 00 00 65 01 fd 08 01 01 91'],
  ['15:18:09.828', 'rx', '00 06 4a 7d 93 ec 26 ee 88 de a0 3a 2a 47 1b 14 55'],
  ['15:18:09.922', 'rx', '21 07 ff 01 61 2c b5'],
  ['15:18:09.963', 'rx', '02 70 61 73 73'],
  ['15:18:10.235', 'rx', 'a1 07 02 01 01 07 b3'],
  ['15:18:11.294', 'rx', 'a3 04 01 a8'],
  ['15:18:11.460', 'rx', 'a3 04 01 a8'],
];

/** The 15:18 advertisement: model 152, impedance not scrambled. */
export const ADVERT_331 = {
  localName: 'QN-Scale',
  address: ADDRESS,
  serviceUuids: ['ffe0'],
  manufacturerData: { id: 0xffff, data: Buffer.from('0de601000801000000000267080102005b', 'hex') },
};

/** A neutral profile, not the reporter's. */
export const P170_331: UserProfile = {
  height: 170,
  age: 30,
  gender: 'female',
  isAthlete: false,
  lastKnownWeight: 80,
};

export const session: SessionFixture = {
  adapter: 'QN Scale',
  profile: P170_331,
  config: { qnUserKey: 1000, qnConfigLong: true, qnTimeSyncLong: true, qnWeightAck: true },
  chars: AE00_CHARS,
  now: Date.parse('2026-11-04T15:17:48.728Z'),
  traces: {
    '331-cs10e-accepted': {
      provenance: 'captured',
      source: '#331 comment 6635516737, DEBUG log 2026-11-04 15:17:48',
      steps: qnSteps(SESSION_331_1517),
    },
    '331-cs10e-accepted-reconnect': {
      provenance: 'captured',
      source: '#331 comment 6635516737, DEBUG log 2026-11-04 15:18:08',
      advert: ADVERT_331,
      steps: qnSteps(SESSION_331_1818),
    },
  },
};
