import type { SessionFixture } from '../../helpers/replay/session.js';
import type { SnoopLine } from '../../helpers/replay/trace.js';
import { AE00_CHARS, qnSteps } from './frames.js';
import { P180_501, SESSION_501_2338 } from './cs10g-501.js';

/**
 * The #501 23:38 session (cs10g-501.ts) replayed with `ble.qn_user_key: 1000`
 * and `ble.qn_user_slot: 2`, which it did not run. The scale's refusal of
 * openScale's profile frame for slot 1 (`a1 06 02 01 00 aa`) is replaced by
 * the acceptance for slot 2 (`a1 06 02 02 01 ac`), the CS10G's answer to its
 * vendor app; every other frame and its time is as captured. So the profile
 * frame, START and the anchor pair go to slot 2, and the 0xB1 of slot 2 ends
 * the session.
 */
const REFUSED_SLOT1 = 'a1 06 02 01 00 aa';
const ACCEPTED_SLOT2 = 'a1 06 02 02 01 ac';

const SLOT2_2338: readonly SnoopLine[] = SESSION_501_2338.map(([t, dir, hex]) =>
  hex === REFUSED_SLOT1 ? [t, dir, ACCEPTED_SLOT2] : [t, dir, hex],
);

export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnUserKey: 1000, qnUserSlot: 2 },
  profile: P180_501,
  chars: AE00_CHARS,
  now: Date.parse('2026-10-25T23:38:55.982Z'),
  traces: {
    '501-user-slot-2': {
      provenance: 'derived',
      source:
        '#501 issue body, DEBUG log 2026-10-25 23:38:55; the answer to the profile frame ' +
        'replaced by the acceptance for slot 2',
      steps: qnSteps(SLOT2_2338),
    },
  },
};
