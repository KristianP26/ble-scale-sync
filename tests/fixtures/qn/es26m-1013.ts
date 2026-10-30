import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, P182_ATHLETE } from './frames.js';
import { ADVERT_1013, NOW_1013, SESSION_1013 } from './user-key-1013.js';

/**
 * The #463 session of 2026-10-13 18:03:57 (user-key-1013.ts) replayed without
 * `ble.qn_user_key`, which it ran with: openScale's profile frame and the A2 go
 * out, the scale's acceptance stands for its answer to them, and the weigh-in
 * it kept for user slot 1 from before the session is not exported. The live
 * one ends the session.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  profile: P182_ATHLETE,
  chars: AE00_CHARS,
  now: NOW_1013,
  traces: {
    '463-1013-kept-slot-1-without-user-key': {
      provenance: 'derived',
      source:
        '#463 comment 6220373939, DEBUG log 2026-10-13 18:03:57; body fat zeroed, ' +
        'replayed without ble.qn_user_key',
      advert: ADVERT_1013,
      steps: SESSION_1013,
    },
  },
};
