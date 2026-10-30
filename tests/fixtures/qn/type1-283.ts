import type { SessionFixture } from '../../helpers/replay/session.js';
import { qnSteps } from './frames.js';
import { LINES_283, NOW_283 } from './classic-283.js';

/**
 * The #283 session (classic-283.ts) on a "Type 1" unit, which exposes only
 * FFE1/FFE3: the frames arrive on FFE1, and every write goes to FFE3 after
 * FFF2 is refused. No capture of such a unit exists; the frames are #283's.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  chars: ['ffe1', 'ffe3'],
  now: NOW_283,
  traces: {
    'type1-283': {
      provenance: 'characterization',
      source: '#283 issue body frames moved to FFE1; spacing set by hand',
      steps: qnSteps(LINES_283, 'ffe1'),
    },
  },
};
