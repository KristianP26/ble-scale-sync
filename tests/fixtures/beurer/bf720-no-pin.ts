import type { SessionFixture } from '../../helpers/replay/session.js';
import { BF720_SETUP } from './bf720.js';

/**
 * Beurer BF720 family without `beurer_pin`: onConnected refuses before the
 * first write, so the session fails right after the subscribes. No frame is
 * needed. Setup as in bf720.ts.
 */
export const session: SessionFixture = {
  adapter: 'Beurer BF720/BF105',
  ...BF720_SETUP,
  traces: {
    'no-consent-pin': {
      provenance: 'characterization',
      source: 'no scaleAuth configured',
      steps: [],
    },
  },
};
