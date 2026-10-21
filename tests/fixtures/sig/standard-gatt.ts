import type { SessionFixture } from '../../helpers/replay/session.js';
import {
  at,
  BCS,
  BCS_168,
  BCS_229_ZEROED,
  BCS_FAT_ONLY,
  BCS_WITH_WEIGHT,
  WSS,
  WSS_168,
  WSS_229,
  WSS_LB,
  WSS_UNSUCCESSFUL,
} from './frames.js';

/**
 * Standard GATT (BCS/WSS) sessions: a 0x2A9D weight opens a weigh-in and is
 * held up to 5 s for the 0x2A9C that closes it; the consent `02 01 00 00` goes
 * to 0x2A9F every 5 s. Frames and rewrites: frames.ts. The spacing between
 * frames is invented (100 ms between a pair, as the #83 BF500 log shows).
 */

const PAIR = 'pair spacing invented';

export const session: SessionFixture = {
  adapter: 'Standard GATT (BCS/WSS)',
  traces: {
    'weight-then-composition': {
      provenance: 'derived',
      source: `#168 HCI snoop frames; stamp year -> 2000, ${PAIR}`,
      steps: [at(1000, WSS, WSS_168), at(1100, BCS, BCS_168)],
    },
    // The scale's zeroed stub closes the weigh-in with no composition: BMI
    // estimate, never 0 % fat.
    'weight-then-zeroed-stub': {
      provenance: 'derived',
      source: `#229 BF788 HCI snoop frames; stamp year -> 2000, ${PAIR}`,
      steps: [at(1000, WSS, WSS_229), at(1100, BCS, BCS_229_ZEROED)],
    },
    // A Weight Scale only device: the hold runs out and the weight goes alone.
    'weight-only-hold-runs-out': {
      provenance: 'derived',
      source: '#168 HCI snoop 0x2A9D frame alone; stamp year -> 2000',
      steps: [at(1000, WSS, WSS_168)],
    },
    'composition-with-weight': {
      provenance: 'characterization',
      source: 'SIG BCS layout: flags 0x0600, 22.5 %, 500.0 ohm, 80.00 kg',
      steps: [at(1000, BCS, BCS_WITH_WEIGHT)],
    },
    // 0x2A9C without a weight and no 0x2A9D: never complete.
    'composition-without-weight': {
      provenance: 'characterization',
      source: 'SIG BCS layout: fat only; link dropped at 8 s',
      steps: [at(1000, BCS, BCS_FAT_ONLY)],
      disconnectAtMs: 8000,
    },
    // The 0xFFFF weight opens nothing; a pounds weight is converted to kg and
    // closed by a fat-only 0x2A9C.
    'unsuccessful-then-pounds': {
      provenance: 'characterization',
      source: 'SIG WSS layout: weight ff ff, then 176.37 lb; SIG BCS fat only',
      steps: [at(1000, WSS, WSS_UNSUCCESSFUL), at(2000, WSS, WSS_LB), at(2100, BCS, BCS_FAT_ONLY)],
    },
    // Imperial 0x2A9C: its weight field is 0.01 lb per unit.
    'composition-pounds': {
      provenance: 'characterization',
      source: 'SIG BCS layout: flags 0x0401, 22.5 %, 176.37 lb',
      steps: [at(1000, BCS, '0104e100e544')],
    },
  },
};
