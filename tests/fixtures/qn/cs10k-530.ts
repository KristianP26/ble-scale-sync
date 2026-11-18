import type { UserProfile } from '../../../src/interfaces/scale-adapter.js';
import type { SessionFixture } from '../../helpers/replay/session.js';
import type { SnoopLine } from '../../helpers/replay/trace.js';
import { ADDRESS, AE00_CHARS, qnSteps } from './frames.js';

/**
 * #530, an Arboleaf CS10K on the 20-byte extended dialect with the JieLi AE00
 * gate, v1.40.0 over an ESPHome proxy with `ble.qn_user_key` 1000: the DEBUG
 * log shared by the reporter, who agreed to its use as test data, every
 * `Notification` line of one session, timed by the log. Rewritten: the MAC
 * (frames.ts), in the 0x12 and the advertisement.
 *
 * The 0x12 has [18] 0x0b, so the dynamic-package bit is clear, yet the scale
 * streams the 19-byte dialect's weigh-in: 0x10 live frames, a stored record
 * (three 0x23 parts, 0x24 and 0x25), a three-part result block, 0x15 and 0x16. It accepts
 * the profile frame for user slot 1 and answers the stored-record query about
 * 20 s after it was sent.
 * Left out: the advertisement that follows the session, our own writes (the
 * tests assert them) and the reporter's earlier log from a patched build.
 */
export const SESSION_530: readonly SnoopLine[] = [
  ['07:03:44.188', 'rx', '12 14 ff 01 00 00 00 00 02 1a 0f 29 00 01 05 03 e0 6f 0b dd'],
  ['07:03:44.289', 'rx', '12 14 ff 01 00 00 00 00 02 1a 0f 29 00 01 05 03 e0 6f 0b dd'],
  ['07:03:44.408', 'rx', '12 14 ff 01 00 00 00 00 02 1a 0f 29 00 01 05 03 e0 6f 0b dd'],
  ['07:03:44.511', 'rx', '12 14 ff 01 00 00 00 00 02 1a 0f 29 00 01 05 03 e0 6f 0b dd'],
  ['07:03:44.639', 'rx', '12 14 ff 01 00 00 00 00 02 1a 0f 29 00 01 05 03 e0 6f 0b dd'],
  ['07:03:44.745', 'rx', '14 0b ff 01 00 01 00 00 00 00 20'],
  ['07:03:45.006', 'rx', '00 a1 a1 d3 ef 0d 5d da 60 b1 ce 91 0b c4 3a 47 2e'],
  ['07:03:45.008', 'rx', '21 07 ff 01 5d 2a af'],
  ['07:03:45.210', 'rx', '02 70 61 73 73'],
  ['07:03:45.415', 'rx', 'a1 06 02 01 01 ab'],
  ['07:03:45.518', 'rx', '10 14 01 00 11 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['07:03:45.620', 'rx', 'a3 04 01 a8'],
  ['07:03:45.723', 'rx', '10 14 01 00 11 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['07:03:45.740', 'rx', 'a3 04 01 a8'],
  ['07:03:45.973', 'rx', '10 14 01 00 11 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['07:03:46.180', 'rx', '10 14 01 00 11 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['07:03:46.439', 'rx', '10 14 01 00 11 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['07:03:46.674', 'rx', '10 14 01 00 11 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['07:03:46.967', 'rx', '10 14 01 00 11 05 b4 00 00 00 00 00 00 00 00 00 00 00 00 ef'],
  ['07:03:47.171', 'rx', '10 14 01 00 11 12 93 00 00 00 00 00 00 00 00 00 00 00 00 db'],
  ['07:03:47.408', 'rx', '10 14 01 00 11 1c 52 00 00 00 00 00 00 00 00 00 00 00 00 a4'],
  ['07:03:47.668', 'rx', '10 14 01 00 11 1e 5a 00 00 00 00 00 00 00 00 00 00 00 00 ae'],
  ['07:03:47.899', 'rx', '10 14 01 00 11 1f 77 00 00 00 00 00 00 00 00 00 00 00 00 cc'],
  ['07:03:48.180', 'rx', '10 14 01 00 11 1f 95 00 00 00 00 00 00 00 00 00 00 00 00 ea'],
  ['07:03:48.400', 'rx', '10 14 01 00 11 20 b2 00 00 00 00 00 00 00 00 00 00 00 00 08'],
  ['07:03:48.633', 'rx', '10 14 01 00 11 1f c7 00 00 00 00 00 00 00 00 00 00 00 00 1c'],
  ['07:03:48.897', 'rx', '10 14 01 00 11 21 61 00 00 00 00 00 00 00 00 00 00 00 00 b8'],
  ['07:03:49.204', 'rx', '10 14 01 00 11 20 85 00 00 00 00 00 00 00 00 00 00 00 00 db'],
  ['07:03:49.408', 'rx', '10 14 01 00 11 1f 59 00 00 00 00 00 00 00 00 00 00 00 00 ae'],
  ['07:03:49.614', 'rx', '10 14 01 00 11 20 0d 00 00 00 00 00 00 00 00 00 00 00 00 63'],
  ['07:03:49.854', 'rx', '10 14 01 00 11 20 3f 00 00 00 00 00 00 00 00 00 00 00 00 95'],
  ['07:03:50.147', 'rx', '10 14 01 00 11 20 3a 00 00 00 00 00 00 00 00 00 00 00 00 90'],
  ['07:03:50.432', 'rx', '10 14 01 00 11 20 3a 00 00 00 00 00 00 00 00 00 00 00 00 90'],
  ['07:03:50.591', 'rx', '10 14 01 00 11 20 30 00 00 00 00 00 00 00 00 00 00 00 00 86'],
  ['07:03:50.843', 'rx', '10 14 01 00 11 20 30 00 00 00 00 00 00 00 00 00 00 00 00 86'],
  ['07:03:51.085', 'rx', '10 14 01 00 11 20 30 00 00 00 00 00 00 00 00 00 00 00 00 86'],
  ['07:03:51.373', 'rx', '10 14 01 00 11 20 30 00 00 00 00 00 00 00 00 00 00 00 00 86'],
  ['07:03:52.071', 'rx', '10 14 01 01 11 20 30 00 00 00 00 00 00 00 00 00 00 00 00 87'],
  ['07:04:05.329', 'rx', '23 01 01 01 31 18 14 8c 32 1f db 0c 1e 0a 7c 0b 56 09 ce 23'],
  ['07:04:05.486', 'rx', '23 0b ce 01 32 09 e4 0b 32 09 59 01 2f 01 1c 0c 08 0a 7b a1'],
  ['07:04:05.643', 'rx', '23 0b 25 01 33 09 aa 0b 16 09 87 0a af 09 21 01 20 01 0d fd'],
  ['07:04:05.792', 'rx', '24 13 ff 01 01 02 48 03 01 08 1b 07 02 00 b8 00 bf 00 29'],
  ['07:04:05.896', 'rx', '25 0f ff 00 00 28 03 29 00 a7 02 0a 03 3d 08 82'],
  ['07:04:06.323', 'rx', '10 14 01 02 31 20 30 0c 44 0a aa 0b ae 0a 34 0b f2 0a 4d f7'],
  ['07:04:06.425', 'rx', '10 14 0b 4d 32 09 b7 01 14 00 e2 0c 0f 0a 80 0b 35 09 ba 0d'],
  ['07:04:06.550', 'rx', '10 14 0b 31 33 09 9f 0a c2 09 33 01 1f 01 0c 00 c3 00 00 33'],
  ['07:04:06.715', 'rx', '15 10 ff 01 04 02 44 02 fd 08 1b 07 0a 00 b6 58'],
  ['07:04:06.866', 'rx', '16 10 ff 00 00 28 03 25 00 ab 02 07 03 31 08 65'],
];

/** The log's 0x12 with the MAC rewritten to `01 00 00 00 00 02` and the sum recomputed. */
export const INFO_530 = Buffer.from('1214ff0100000000021a0f2900010503e06f0bdd', 'hex');

/** The advertisement of 07:03:43.588: model 134, impedance not scrambled. */
export const ADVERT_530 = {
  localName: 'QN-Scale',
  address: ADDRESS,
  serviceUuids: ['ffe0'],
  manufacturerData: { id: 0xffff, data: Buffer.from('0ca5010001010000000002520801020001', 'hex') },
};

/**
 * The fixture's own profile. The height is chosen so that the BMI in the
 * scale's own composition fits it within BMI_MATCH_TOLERANCE;
 * `lastKnownWeight` is the anchor the log's A2 frames carry.
 */
export const P178_530: UserProfile = {
  height: 178,
  age: 40,
  gender: 'male',
  isAthlete: false,
  lastKnownWeight: 90,
};

export const session: SessionFixture = {
  adapter: 'QN Scale',
  profile: P178_530,
  config: { qnUserKey: 1000 },
  chars: AE00_CHARS,
  now: Date.parse('2026-11-15T07:03:44.188Z'),
  persists: {
    keys: ['history'],
    why: 'storedMark (dedupMark, #331): a stored weigh-in reported once is never reported again, also in a later session',
  },
  traces: {
    '530-cs10k-weigh-in': {
      provenance: 'captured',
      source: "#530, reporter's DEBUG log shared for this fixture, 2026-11-15 07:03:44",
      advert: ADVERT_530,
      steps: qnSteps(SESSION_530),
    },
  },
};
