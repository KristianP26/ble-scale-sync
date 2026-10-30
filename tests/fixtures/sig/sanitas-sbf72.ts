import type { SessionFixture } from '../../helpers/replay/session.js';
import { at, BCS, BCS_168, BCS_WITH_WEIGHT, WSS, WSS_168 } from './frames.js';

/**
 * Sanitas SBF72/73 sessions. No SBF72 capture exists; the SIG frames are the
 * ones the adapter test borrows from the #168 snoop of another SIG scale
 * (frames.ts has them and their rewrite). Same pairing as Standard GATT, with
 * 0x2A9C and 0x2A9F required and 0x2A9D optional; consent `02 01 00 00` every
 * 5 s. Spacing invented.
 */
export const session: SessionFixture = {
  adapter: 'Sanitas SBF72/73',
  traces: {
    'sbf72-weight-then-composition': {
      provenance: 'derived',
      source: '#168 HCI snoop frames (not an SBF72); stamp year -> 2000, pair spacing invented',
      steps: [at(1000, WSS, WSS_168), at(1100, BCS, BCS_168)],
    },
    'sbf72-weight-only-hold-runs-out': {
      provenance: 'derived',
      source: '#168 HCI snoop 0x2A9D frame alone (not an SBF72); stamp year -> 2000',
      steps: [at(1000, WSS, WSS_168)],
    },
    'sbf72-composition-with-weight': {
      provenance: 'characterization',
      source: 'SIG BCS layout: flags 0x0600, 22.5 %, 500.0 ohm, 80.00 kg',
      steps: [at(1000, BCS, BCS_WITH_WEIGHT)],
    },
  },
};
