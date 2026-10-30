import type { SessionFixture } from '../../helpers/replay/session.js';
import { P181, qnSteps } from './frames.js';
import { NOW_R06, WEIGH_IN_R06 } from './arboleaf-r06.js';

/**
 * The #331 weigh-in of arboleaf-r06.ts with `ble.qn_weight_ack: true`, the
 * reporter's setting then (comment 5960561006): no A2 at ready, the A00D
 * profile frame built from the user, the anchor twice after START (D033).
 * The scale accepted that profile and measured after it, so its own body
 * composition is the payload.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnWeightAck: true },
  profile: P181,
  now: NOW_R06,
  traces: {
    'r06-weight-ack-own-composition': {
      provenance: 'derived',
      source: '#331 comment 6019596187 and its attachment; spacing set by hand',
      steps: qnSteps(WEIGH_IN_R06),
    },
  },
};
