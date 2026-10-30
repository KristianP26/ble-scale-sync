import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';
import { session as msc04 } from './r-msc04.js';
import { session as byte } from './r-msc04-profile-byte.js';

/**
 * Renpho R-MSC04 sessions for a user with `estimate_body_composition: false`
 * (#497), with ble.rmsc04_profile_byte set as in r-msc04-profile-byte.ts.
 *
 * The traces are those of r-msc04.ts and r-msc04-profile-byte.ts, unchanged
 * (sources there: the #117 capture and constructed answers to our writes);
 * only the profile differs. They pin the three outcomes: the scale's own body
 * fat passes the D079 gates and goes out as usual; a gate fails and the six
 * composition values are withheld while the segment impedances still go out;
 * the hold expires with no record and only the weight-derived values remain.
 * The profile and the byte are made up (187 cm fits the record).
 */

const traces: Record<string, Trace> = {
  'msc04-no-estimate-weigh-in': byte.traces['msc04-byte-weigh-in'],
  'msc04-no-estimate-gate-fails': byte.traces['msc04-byte-no-answer'],
  'msc04-no-estimate-hold-expiry': msc04.traces['msc04-434-hold-expiry'],
};

export const session: SessionFixture = {
  adapter: 'Renpho R-MSC04',
  profile: {
    height: 187,
    age: 30,
    gender: 'male',
    isAthlete: false,
    estimateBodyComposition: false,
  },
  config: { rmsc04ProfileByte: '9e' },
  traces,
};
