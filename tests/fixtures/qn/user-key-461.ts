import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, P182_ATHLETE } from './frames.js';
import { ADVERT_461, NOW_461, SESSION_461 } from './es26m-461.js';

/**
 * The #461 session (es26m-461.ts) replayed with `ble.qn_user_key: 1000`,
 * which it did not run: the scale's `a1 06 02 01 00` is the refusal it gave
 * openScale's profile frame, here standing for a refusal of the keyed one. So
 * the 0x22 waits for the handshake instead of the acceptance, and the fresh
 * record still ends the session.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnUserKey: 1000 },
  profile: P182_ATHLETE,
  chars: AE00_CHARS,
  now: NOW_461,
  traces: {
    '461-user-key-refused': {
      provenance: 'derived',
      source: '#461 issue body, DEBUG log 2026-10-10 09:23:03; replayed with ble.qn_user_key',
      advert: ADVERT_461,
      steps: SESSION_461,
    },
  },
};
