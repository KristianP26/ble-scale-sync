import type { SessionFixture } from '../../helpers/replay/session.js';
import { at, BCS, BCS_WITH_WEIGHT } from './frames.js';

/**
 * A Sanitas SBF72/73 without Weight Measurement 0x2A9D: the optional binding
 * is skipped and 0x2A9C alone carries the weigh-in, as the adapter read it
 * before review C-02. Characterization, SIG layout (frames.ts).
 */
export const session: SessionFixture = {
  adapter: 'Sanitas SBF72/73',
  chars: ['2a9c', '2a9f'],
  traces: {
    'sbf72-no-weight-measurement-char': {
      provenance: 'characterization',
      source: 'SIG BCS layout: flags 0x0600, 22.5 %, 500.0 ohm, 80.00 kg; no 0x2A9D on the device',
      steps: [at(1000, BCS, BCS_WITH_WEIGHT)],
    },
  },
};
