import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Exingtech Y1 (`vscale`). No capture exists; the 20-byte frames are synthetic
 * from the layout in src/scales/exingtech-y1.ts (weight BE/10 at [4], fat,
 * water, bone, muscle BE/10, visceral at [14]; `ff` at [6] = no composition).
 * A weight completes, composition makes it final, otherwise an 8 s hold.
 */
export const session: SessionFixture = {
  adapter: 'Exingtech Y1',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'exingtech-composition': {
      provenance: 'characterization',
      source:
        'exingtech-y1.test.ts layout: short and zero-weight frames dropped, then 80.0 kg with composition',
      steps: [
        { atMs: 500, dir: 'rx', hex: '0000000000000000000000000000' },
        { atMs: 800, dir: 'rx', hex: '0000000000000000000000000000000000000000' },
        { atMs: 1500, dir: 'rx', hex: '00000000032000e1022600230190080000000000' },
      ],
    },
    'exingtech-weight-then-composition-in-hold': {
      provenance: 'characterization',
      source: 'exingtech-y1.test.ts layout: `ff` composition holds, the full frame ends the hold',
      steps: [
        { atMs: 1000, dir: 'rx', hex: '000000000320ffff000000000000000000000000' },
        { atMs: 3000, dir: 'rx', hex: '00000000032000e1022600230190080000000000' },
      ],
    },
    'exingtech-weight-only-hold-expires': {
      provenance: 'characterization',
      source: 'exingtech-y1.test.ts layout: fat 0 is not final, the hold runs out (D028)',
      steps: [{ atMs: 1000, dir: 'rx', hex: '00000000031b0000000000000000000000000000' }],
    },
  },
};
