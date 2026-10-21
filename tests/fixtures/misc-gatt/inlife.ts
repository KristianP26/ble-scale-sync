import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Inlife (`000fatscale01` and the 0xFFF0 fingerprint). No session capture
 * exists; the 14-byte frames are synthetic from tests/scales/inlife.test.ts:
 * `02` marker, weight BE/10 at [2], mode at [11]. Mode 0x80/0x81 carries the
 * unverified impedance field [4..7] (#405) and is final; a legacy frame
 * (visceral BE/10 at [7]) only completes and holds 4 s for one (#413).
 */
const LEGACY = '0210031000000000500000000000'; // 78.4 kg, visceral 8.0

export const session: SessionFixture = {
  adapter: 'Inlife',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'inlife-legacy-then-impedance': {
      provenance: 'characterization',
      source:
        'inlife.test.ts #413 frames: rejected (marker, short), legacy holds, 0x80 500 ohm ends it',
      steps: [
        { atMs: 300, dir: 'rx', hex: '0310031000000000500000000000' },
        { atMs: 400, dir: 'rx', hex: '02100310' },
        { atMs: 1000, dir: 'rx', hex: LEGACY },
        { atMs: 2500, dir: 'rx', hex: '02100310000001f4000000800000' },
      ],
    },
    'inlife-mode-81': {
      provenance: 'characterization',
      source: 'inlife.test.ts: mode 0x81, 75.0 kg / 480 ohm',
      steps: [{ atMs: 1000, dir: 'rx', hex: '021002ee000001e0000000810000' }],
    },
    'inlife-impedance-field-zero': {
      provenance: 'characterization',
      source: 'inlife.test.ts #405: mode 0x80 with [4..7] zero is still the final frame',
      steps: [{ atMs: 1000, dir: 'rx', hex: '0210031000000000000000800000' }],
    },
    'inlife-legacy-hold-expires': {
      provenance: 'characterization',
      source: 'inlife.test.ts #413: legacy frame only, the 4 s hold runs out',
      steps: [{ atMs: 1000, dir: 'rx', hex: LEGACY }],
    },
  },
};
