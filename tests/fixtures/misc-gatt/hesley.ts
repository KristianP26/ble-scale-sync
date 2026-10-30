import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Hesley / YunChen (`yunchen`): one unlock write, then the first frame with a
 * weight ends the session. No capture exists; frames are synthetic from
 * src/scales/hesley.ts (weight BE/100 at [2], fat [4], water [8], muscle [10],
 * bone [12], all BE/10).
 */
export const session: SessionFixture = {
  adapter: 'Hesley',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'hesley-composition': {
      provenance: 'characterization',
      source: 'hesley.test.ts layout: zero-weight frame dropped, then 80.00 kg with composition',
      steps: [
        { atMs: 500, dir: 'rx', hex: '0000000000000000000000000000000000000000' },
        { atMs: 1500, dir: 'rx', hex: '00001f4000e10000022601900023000000000000' },
      ],
    },
    'hesley-weight-only': {
      provenance: 'characterization',
      source: 'hesley.test.ts layout: 79.90 kg, composition fields zero',
      steps: [{ atMs: 1000, dir: 'rx', hex: '00001f3600000000000000000000000000000000' }],
    },
  },
};
