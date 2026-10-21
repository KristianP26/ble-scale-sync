import type { SessionFixture } from '../../helpers/replay/session.js';
import { P181, qnSteps } from './frames.js';
import { NOW_R06, WEIGH_IN_R06 } from './arboleaf-r06.js';

/**
 * The #331 weigh-in of arboleaf-r06.ts with `ble.qn_protocol_byte: 0`, which a
 * #331 reporter ran against the 19-byte echo (comment 5989716312): every
 * protocol-bearing write carries 0x00 instead of the 0xff of the 0x12.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnProtocolByte: 0 },
  profile: P181,
  now: NOW_R06,
  traces: {
    'r06-protocol-byte-0': {
      provenance: 'derived',
      source: '#331 comment 6019596187 and its attachment; spacing set by hand',
      steps: qnSteps(WEIGH_IN_R06),
    },
  },
};
