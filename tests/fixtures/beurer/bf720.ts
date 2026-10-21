import type { SessionFixture } from '../../helpers/replay/session.js';
import { WSS_168, WSS_229, BCS_229_ZEROED } from '../sig/frames.js';

/**
 * Beurer BF720/BF105 family (BF500, BF788, BF915 here) with a consent code:
 * Current Time, the vendor user-list query on 0xFFF2, the consent on 0x2A9F,
 * and after an accepted consent the User Data write-back plus the change
 * increment. A reading comes only from a 0x2A9C (review C-01).
 *
 * Shared choices:
 *  - Characteristics: the declared ones plus the User Data fields and 0xFFF3
 *    that the #83 BF500 discovery log lists, so the post-consent write-back
 *    runs. The harness reads every characteristic as empty, so it writes empty
 *    values back (a real BF788 returns its stored ones; see bf720-provision.ts
 *    for what an unset field gets with provisioning on).
 *  - `pin` 1234 is made up; no reporter's code is used.
 *  - `now` is noon local time on 2026-01-01, built in the zone the suite runs
 *    in, so the 0x2A2B Current Time write (local getters) is the same bytes in
 *    every zone.
 *  - Every 0x2A9D Time Stamp year 2026 (ea 07) is rewritten to 2000 (d0 07): a
 *    SIG stamp is local time and the harness does not pin the zone, so a
 *    trusted stamp would make `reading.timestamp` zone dependent. 2000 is
 *    before MIN_TRUSTED_YEAR, so readings carry no stamp. The stored-record
 *    branch (stamp older than 5 minutes -> history) is not pinned here.
 */

const CHARS = ['2a9d', '2a9c', '2a9f', '2a99', 'fff2', '2a2b', '2a85', '2a8c', '2a8e', 'fff3'];
export const BF720_SETUP = {
  chars: CHARS,
  now: new Date(2026, 0, 1, 12, 0, 0).getTime(),
};

const at = (atMs: number, uuid: string, hex: string) => ({
  atMs,
  dir: 'rx' as const,
  uuid,
  hex,
});

/** #83 comment 5151446375 (BF500, 2026-08-01 12:28): weight and composition, 95 ms apart. */
export const BF500_WSS = '0e1c43d00708010e191001f6004e07';
export const BF500_BCS = '9803c3000f1e9b014033fc26240e';

/** #229 BF788 HCI snoop, the one real composition frame (tests/scales/beurer-bf720.test.ts). */
const BCS_229_REAL = '9803f300962389014042fa2f550f';

/** #229 comment 5335066553 (BF788 after a battery change, two sessions). */
const ISSUE_229 = '#229 comment 5335066553 DEBUG log';

export const session: SessionFixture = {
  adapter: 'Beurer BF720/BF105',
  ...BF720_SETUP,
  scaleAuth: { pin: 1234, userIndex: 1 },
  identityBound:
    'A-02, the composition is pinned to the reading object (compByReading) and onSessionEnd ' +
    'empties cachedComp, so a copy of the reading gets no scale composition',
  traces: {
    // Times from "consent sent" (12:28:30.876). The scale never answers the
    // consent here and sends a stored weigh-in at once.
    'bf500-weigh-in': {
      provenance: 'derived',
      source: '#83 comment 5151446375 DEBUG log; stamp year 2026 -> 2000',
      steps: [at(153, '2a9d', BF500_WSS), at(248, '2a9c', BF500_BCS)],
    },
    // Consent accepted 5.6 s after it was sent, then an empty user list; no
    // weigh-in follows. The write-back (empty values, see above) and the
    // increment go out.
    'bf788-consent-accepted-no-weigh-in': {
      provenance: 'captured',
      source: `${ISSUE_229}, 22:29:57.738 session`,
      steps: [at(5566, '2a9f', '200201'), at(7088, 'fff2', '02')],
    },
    // The commit runs once per session however often the consent is answered.
    'consent-accepted-three-times': {
      provenance: 'derived',
      source: `${ISSUE_229}, 22:29:57.738 session, its 20 02 01 repeated twice 100 ms apart`,
      steps: [at(5566, '2a9f', '200201'), at(5666, '2a9f', '200201'), at(5766, '2a9f', '200201')],
      disconnectAtMs: 8000,
    },
    // USER_NOT_AUTHORIZED: nothing is written back.
    'bf788-consent-rejected': {
      provenance: 'captured',
      source: `${ISSUE_229}, 22:45:43.863 session`,
      steps: [at(3599, '2a9f', '200205'), at(5015, 'fff2', '02')],
    },
    // A zeroed stub closes the first weigh-in with nothing; the real frame
    // closes the second.
    'bf788-stub-then-real': {
      provenance: 'derived',
      source: '#229 BF788 HCI snoop frames; stamp year -> 2000, spacing invented',
      steps: [
        at(1000, '2a9d', WSS_229),
        at(1100, '2a9c', BCS_229_ZEROED),
        at(2000, '2a9d', WSS_229),
        at(2100, '2a9c', BCS_229_REAL),
      ],
    },
    // A weight alone opens a weigh-in and never completes one.
    'bf915-weight-only': {
      provenance: 'derived',
      source:
        '#335 comment 5420928526 (reporter-substituted values); stamp year -> 2000, timing invented',
      steps: [at(500, '2a9d', '0e0c3ed007081a07003201f5000807')],
      disconnectAtMs: 5000,
    },
    'pounds-weight': {
      provenance: 'characterization',
      source: 'SIG WSS flags 0x01, 260.00 lb; SIG BCS fat 19.4 % only',
      steps: [at(1000, '2a9d', '019065'), at(1100, '2a9c', '0000c200')],
    },
    // Impedance field 0xffff is "unavailable": the reading has 0 ohm.
    'impedance-sentinel': {
      provenance: 'derived',
      source: '#229 BF788 HCI snoop frames, impedance bytes -> ff ff; stamp year -> 2000',
      steps: [at(1000, '2a9d', WSS_229), at(1100, '2a9c', '9803f300962389014042fa2fffff')],
    },
    // A 0xFFFF weight keeps the weight already cached (C-10).
    'weight-sentinel-keeps-cached': {
      provenance: 'derived',
      source: '#168 HCI snoop 0x2A9D frame (stamp year -> 2000), then ff ff, then fat 19.4 % only',
      steps: [at(1000, '2a9d', WSS_168), at(1100, '2a9d', '00ffff'), at(1200, '2a9c', '0000c200')],
    },
  },
};
