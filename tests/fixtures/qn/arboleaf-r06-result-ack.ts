import type { SessionFixture } from '../../helpers/replay/session.js';
import { P181, qnSteps } from './frames.js';
import { NOW_R06, WEIGH_IN_R06 } from './arboleaf-r06.js';

/**
 * The #331 weigh-in of arboleaf-r06.ts with `ble.qn_weight_ack: true` and
 * `ble.qn_result_ack: true`: the 0x1F the vendor's SDK sends at the 0x16 of a
 * complete result block (D059).
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnWeightAck: true, qnResultAck: true },
  profile: P181,
  now: NOW_R06,
  traces: {
    'r06-result-ack': {
      provenance: 'derived',
      source: '#331 comment 6019596187 and its attachment; spacing set by hand',
      steps: qnSteps(WEIGH_IN_R06),
    },
  },
};
