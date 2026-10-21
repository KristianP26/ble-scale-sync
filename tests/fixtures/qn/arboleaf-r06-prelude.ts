import type { SessionFixture } from '../../helpers/replay/session.js';
import { P181, qnSteps } from './frames.js';
import { NOW_R06, WEIGH_IN_R06 } from './arboleaf-r06.js';

/**
 * The #331 weigh-in of arboleaf-r06.ts with the vendor-app replays a #331
 * reporter ran together (comment 5608367362): `ble.qn_weight_ack`,
 * `ble.qn_a4_prelude` (the two 0xA4 frames after the anchors) and
 * `ble.qn_config_long` (the 10-byte 0x13). The prelude overwrote the slot's
 * segment values, so the scale's own composition is not used.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnWeightAck: true, qnA4Prelude: true, qnConfigLong: true },
  profile: P181,
  now: NOW_R06,
  traces: {
    'r06-a4-prelude-config-long': {
      provenance: 'derived',
      source: '#331 comment 6019596187 and its attachment; spacing set by hand',
      steps: qnSteps(WEIGH_IN_R06),
    },
  },
};
