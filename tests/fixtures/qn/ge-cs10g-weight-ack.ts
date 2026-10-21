import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, qnSteps } from './frames.js';
import { B4_THEN_B1_235, NOW_235 } from './ge-cs10g.js';

/**
 * The first ge-cs10g.ts trace with `ble.qn_weight_ack: true` and a 76 kg
 * anchor, as the #235 reporter ran it (comment 5415971947): the ready-time A2
 * carries the anchor instead of openScale's `0x32 <age>`, and so does the
 * trigger pair after START.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnWeightAck: true },
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false, lastKnownWeight: 76 },
  chars: AE00_CHARS,
  now: NOW_235,
  traces: {
    'ge-235-weight-ack': {
      provenance: 'derived',
      source:
        '#235 comment 4710137730 and the 2026-08-19 log; frames combined, spacing set by hand',
      steps: qnSteps(B4_THEN_B1_235),
    },
  },
};
