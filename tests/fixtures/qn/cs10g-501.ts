import type { UserProfile } from '../../../src/interfaces/scale-adapter.js';
import type { SessionFixture } from '../../helpers/replay/session.js';
import type { SnoopLine } from '../../helpers/replay/trace.js';
import { ADDRESS, AE00_CHARS, qnSteps } from './frames.js';

/**
 * #501, an Arboleaf CS10G on the 20-byte extended dialect with the JieLi AE00
 * gate, v1.37.0 without options over the ESP32 proxy: the DEBUG log in the
 * issue body, every `Notification` line of two sessions, timed by the log,
 * with the full frame of the `QN RAW` line where the log cut a 45-byte one.
 * Rewritten: the MAC (frames.ts), in the 0x12 and the advertisement.
 *
 * In both the scale refuses openScale's profile frame for user slot 1
 * (`a1 06 02 01 00`). At 23:33 nothing follows. At 23:38 the scale sends a
 * 0xB4 with [2] 03, which this dialect does not read, and then the 0xB1 of
 * its user slot 2 (77.95 kg), which ends the session. The 23:38 session had
 * no advertisement. The profile is the fixture's own, not the reporter's.
 */
export const SESSION_501_2333: readonly SnoopLine[] = [
  ['23:33:03.545', 'rx', '12 14 ff 01 00 00 00 00 02 0e 0f 4a 00 04 05 03 e2 6f 3b 27'],
  ['23:33:03.913', 'rx', '12 14 ff 01 00 00 00 00 02 0e 0f 4a 00 04 05 03 e2 6f 3b 27'],
  ['23:33:04.027', 'rx', '12 14 ff 01 00 00 00 00 02 0e 0f 4a 00 04 05 03 e2 6f 3b 27'],
  ['23:33:04.323', 'rx', '14 0c ff 01 00 01 0a 02 0d 00 fd 37'],
  ['23:33:04.642', 'rx', 'a3 04 01 a8'],
  ['23:33:04.683', 'rx', '21 07 ff 01 64 2d b9'],
  ['23:33:04.702', 'rx', '00 40 6b 41 88 dc 2c 0f 51 8e 5d fb 81 ac 9a de 1c'],
  ['23:33:04.949', 'rx', '02 70 61 73 73'],
  ['23:33:05.166', 'rx', 'a1 06 02 01 00 aa'],
  ['23:33:05.464', 'rx', 'a3 04 01 a8'],
  ['23:33:05.564', 'rx', 'a3 04 01 a8'],
];

export const SESSION_501_2338: readonly SnoopLine[] = [
  ['23:38:55.982', 'rx', '12 14 ff 01 00 00 00 00 02 0e 0f 4a 00 05 05 03 e2 6f 3b 28'],
  ['23:38:56.195', 'rx', '12 14 ff 01 00 00 00 00 02 0e 0f 4a 00 05 05 03 e2 6f 3b 28'],
  ['23:38:56.491', 'rx', '14 0c ff 01 00 01 0a 02 0d 00 fd 37'],
  ['23:38:56.800', 'rx', '21 07 ff 01 64 2d b9'],
  ['23:38:56.903', 'rx', 'a3 04 01 a8'],
  ['23:38:57.011', 'rx', '00 53 57 4e 5b f6 81 f0 d3 02 42 02 85 cc 66 16 3b'],
  ['23:38:57.209', 'rx', '02 70 61 73 73'],
  ['23:38:57.418', 'rx', 'a1 06 02 01 00 aa'],
  ['23:38:57.722', 'rx', 'a3 04 01 a8'],
  ['23:38:57.823', 'rx', 'a3 04 01 a8'],
  [
    '23:39:48.142',
    'rx',
    'b4 2d 03 01 f0 04 01 54 4e 71 32 50 1e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 8d',
  ],
  [
    '23:40:12.267',
    'rx',
    'b4 2d 03 01 f0 04 01 54 4e 71 32 50 1e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
      '00 00 00 00 00 00 00 00 00 00 00 00 00 00 8d',
  ],
  [
    '23:40:12.379',
    'rx',
    'b1 2d 03 01 02 73 1e 9d 0a 72 09 af 0a 7e 09 bf 09 d2 08 70 09 86 08 aa 00 61 00 5d 0a 33 ' +
      '09 73 0a 49 09 51 0a 27 09 24 0a f3 08 d4 85',
  ],
];

/** The 23:33 advertisement: model 152, impedance not scrambled. Its last byte is flags. */
export const ADVERT_501 = {
  localName: 'QN-Scale',
  address: ADDRESS,
  serviceUuids: ['ffe0'],
  manufacturerData: { id: 0xffff, data: Buffer.from('0dfd01000301000000000267080302001b', 'hex') },
};

/** A neutral profile, not the reporter's. */
export const P180_501: UserProfile = {
  height: 180,
  age: 40,
  gender: 'male',
  isAthlete: false,
  lastKnownWeight: 78,
};

export const session: SessionFixture = {
  adapter: 'QN Scale',
  profile: P180_501,
  chars: AE00_CHARS,
  now: Date.parse('2026-10-25T23:33:03.545Z'),
  traces: {
    '501-cs10g-refused-silent': {
      provenance: 'captured',
      source: '#501 issue body, DEBUG log 2026-10-25 23:33:02',
      advert: ADVERT_501,
      steps: qnSteps(SESSION_501_2333),
    },
    '501-cs10g-refused-then-b1-slot-2': {
      provenance: 'captured',
      source: '#501 issue body, DEBUG log 2026-10-25 23:38:55',
      steps: qnSteps(SESSION_501_2338),
    },
  },
};
