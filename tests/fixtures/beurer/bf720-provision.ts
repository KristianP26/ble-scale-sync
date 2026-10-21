import type { SessionFixture } from '../../helpers/replay/session.js';
import { BF720_SETUP } from './bf720.js';

/**
 * Beurer BF720 family with `beurer_provision` on, on a scale whose User Data
 * reads back empty: the #229 BF788 after a battery change. The scale's frames
 * and their timing are the captured 22:29:57.738 session of #229 comment
 * 5335066553, where the reporter used consent code 0 (the documented code for
 * a wiped scale). The profile carries a birth date, so the date of birth
 * written is that calendar date; the rest comes from the profile (male,
 * 183 cm) and the fixed activity level 3. Setup as in bf720.ts.
 */
export const session: SessionFixture = {
  adapter: 'Beurer BF720/BF105',
  ...BF720_SETUP,
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false, birthDate: '1995-06-15' },
  scaleAuth: { pin: 0, userIndex: 1, provision: true },
  traces: {
    'bf788-consent-accepted-provisioned': {
      provenance: 'captured',
      source: '#229 comment 5335066553 DEBUG log, 22:29:57.738 session',
      steps: [
        { atMs: 5566, dir: 'rx', uuid: '2a9f', hex: '200201' },
        { atMs: 7088, dir: 'rx', uuid: 'fff2', hex: '02' },
      ],
    },
  },
};
