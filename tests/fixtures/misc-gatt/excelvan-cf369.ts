import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Excelvan CF369 (`electronic scale`). No capture exists; frames are synthetic
 * from src/scales/excelvan-cf369.ts: `cf` marker, weight BE/10 at [4], fat BE
 * at [6] (`ff` = none), bone [8], muscle BE [9], visceral [11], water BE [12].
 * Weight completes, fat makes it final, otherwise an 8 s hold.
 */
const FULL = 'cf000000032000e12301900802260000';

export const session: SessionFixture = {
  adapter: 'Excelvan CF369',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'excelvan-composition': {
      provenance: 'characterization',
      source: 'excelvan-cf369.test.ts layout: wrong marker dropped, then 80.0 kg with composition',
      steps: [
        { atMs: 500, dir: 'rx', hex: 'ce000000032000e12301900802260000' },
        { atMs: 1500, dir: 'rx', hex: FULL },
      ],
    },
    'excelvan-weight-then-composition-in-hold': {
      provenance: 'characterization',
      source: 'excelvan-cf369.test.ts layout: `ff` composition holds, the full frame ends the hold',
      steps: [
        { atMs: 1000, dir: 'rx', hex: 'cf0000000320ffff0000000000000000' },
        { atMs: 3000, dir: 'rx', hex: FULL },
      ],
    },
    'excelvan-weight-only-hold-expires': {
      provenance: 'characterization',
      source: 'excelvan-cf369.test.ts layout: no composition, the hold runs out (D028)',
      steps: [{ atMs: 1000, dir: 'rx', hex: 'cf0000000320ffff0000000000000000' }],
    },
  },
};
