import type { SessionFixture } from '../../helpers/replay/session.js';
import { BF500_BCS, BF500_WSS, BF720_SETUP } from './bf720.js';

/**
 * Beurer BF720 family with `beurer_register_new_user` (and provisioning) on:
 * Register New User `01 <code LE>` on 0x2A9F instead of the consent (#335).
 * No capture has the scale's answer to it, so the answers are
 * characterization, as tests/scales/beurer-bf720.test.ts writes them:
 * `20 01 01 04` (success, index 4) and `20 01 04` (operation failed). The
 * weigh-in after the registration is the #83 BF500 pair (bf720.ts), 95 ms
 * apart. Default profile without a birth date, so the date of birth written
 * is 1 January of the year the age gives. Setup as in bf720.ts.
 */
export const session: SessionFixture = {
  adapter: 'Beurer BF720/BF105',
  ...BF720_SETUP,
  scaleAuth: { pin: 1234, userIndex: 1, registerNewUser: true, provision: true },
  traces: {
    'register-new-user-assigned-index': {
      provenance: 'characterization',
      source:
        'UCP response 20 01 01 04 from the adapter test; then #83 frames (stamp year -> 2000)',
      steps: [
        { atMs: 500, dir: 'rx', uuid: '2a9f', hex: '20010104' },
        { atMs: 3000, dir: 'rx', uuid: '2a9d', hex: BF500_WSS },
        { atMs: 3095, dir: 'rx', uuid: '2a9c', hex: BF500_BCS },
      ],
    },
    'register-new-user-refused': {
      provenance: 'characterization',
      source: 'UCP response 20 01 04 from the adapter test; link dropped at 5 s',
      steps: [{ atMs: 500, dir: 'rx', uuid: '2a9f', hex: '200104' }],
      disconnectAtMs: 5000,
    },
  },
};
