import type { SessionFixture } from '../../helpers/replay/session.js';
import { qnSteps } from './frames.js';
import { LINES_283, NOW_283 } from './classic-283.js';

/**
 * The #283 session (classic-283.ts) with `scale.display_unit: lbs` and the
 * weight unit lbs: the unit flag of the unlock config and of the 0x13 is 0x02
 * (#269); the weight stays kg, the adapter normalises it.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { displayUnit: 'lbs' },
  weightUnit: 'lbs',
  now: NOW_283,
  traces: {
    'classic-283-lbs': {
      provenance: 'derived',
      source: '#283 issue body, DEBUG log without timestamps; spacing set by hand',
      steps: qnSteps(LINES_283),
    },
  },
};
