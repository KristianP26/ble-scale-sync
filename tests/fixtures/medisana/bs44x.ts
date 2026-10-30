import type { SessionFixture } from '../../helpers/replay/session.js';
import { FAKE_ADDRESS } from '../../helpers/replay/session.js';

/**
 * Medisana BS44x / BS440 / BS430 sessions. No capture of these scales exists
 * (PROTOCOLS.md "Medisana BS44x"), so every trace is characterization, with
 * the frame shapes tests/scales/medisana-bs44x.test.ts builds: a 4-byte weight
 * frame (80.00 kg LE at [1..2]) and a 16-byte feature frame (fat 22.5 %, water
 * 55.0 %, muscle 40.0 %, bone 3.5 at [8..15], LE, low 12 bits). Spacing is
 * invented. What the traces pin is the time sync written on connect, whose
 * epoch follows the advertised name, and the weight + fat pairing.
 */

const WEIGHT_80 = '00401f00';
const FEATURES = '0000000000000000e100260290012300';
/** FEATURES with the top nibble of the fat field set, which the 0x0fff mask drops. */
const FEATURES_HIGH_NIBBLE = '0000000000000000e1f0260290012300';

const rx = (atMs: number, hex: string) => ({ atMs, dir: 'rx' as const, hex });

const SYNTH = 'characterization: frame shapes of tests/scales/medisana-bs44x.test.ts';

export const session: SessionFixture = {
  adapter: 'Medisana BS44x',
  traces: {
    // BS444/BS440 name: seconds since 2010-01-01 in the time sync.
    'bs444-weight-then-features': {
      provenance: 'characterization',
      source: SYNTH,
      advert: { localName: '013197', address: FAKE_ADDRESS, serviceUuids: ['78b2'] },
      steps: [rx(1000, WEIGHT_80), rx(1500, FEATURES_HIGH_NIBBLE)],
    },
    // BS430 name: Unix seconds. A feature frame before any weight is no reading.
    'bs430-features-then-weight': {
      provenance: 'characterization',
      source: SYNTH,
      advert: { localName: '0203B0001', address: FAKE_ADDRESS, serviceUuids: ['78b2'] },
      steps: [rx(1000, FEATURES), rx(1500, WEIGHT_80)],
    },
    // No name (a transport that saw none): Unix seconds. Weight without fat
    // never completes.
    'nameless-weight-only-link-drops': {
      provenance: 'characterization',
      source: `${SYNTH}; no feature frame, link dropped at 5 s`,
      steps: [rx(1000, WEIGHT_80), rx(2000, WEIGHT_80)],
      disconnectAtMs: 5000,
    },
  },
};
