import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Senssun Fat Scale on FFF1. No capture exists; frames are synthetic, built
 * from the layout in src/scales/senssun.ts and tests/scales/senssun.test.ts
 * (A5 weight BE/10, B0 fat/water, C0 muscle/bone, D0 BMR). The session
 * completes once all four frame types have arrived.
 */
const WEIGHT_UNSTABLE = 'a50318000000'; // 79.2 kg, [5] != 0xAA
const WEIGHT_STABLE = 'a503200000aa'; // 80.0 kg
const FAT_WATER = 'b000e10226'; // 22.5 %, 55.0 %
const MUSCLE_BONE = 'c001900023'; // 40.0 %, 3.5 kg
const BMR = 'd00640';

export const session: SessionFixture = {
  adapter: 'Senssun Fat Scale',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'senssun-four-frames': {
      provenance: 'characterization',
      source: 'tests/scales/senssun.test.ts frame layout; one frame with 0xFF padding',
      steps: [
        { atMs: 500, dir: 'rx', hex: WEIGHT_UNSTABLE },
        { atMs: 1000, dir: 'rx', hex: 'ffffa503200000aa' },
        { atMs: 1500, dir: 'rx', hex: FAT_WATER },
        { atMs: 2000, dir: 'rx', hex: MUSCLE_BONE },
        { atMs: 2500, dir: 'rx', hex: BMR },
      ],
    },
    'senssun-composition-before-weight': {
      provenance: 'characterization',
      source:
        'tests/scales/senssun.test.ts: B0 before any weight returns nothing; all-0xFF frame dropped',
      steps: [
        { atMs: 500, dir: 'rx', hex: FAT_WATER },
        { atMs: 700, dir: 'rx', hex: 'ffffff' },
        { atMs: 1000, dir: 'rx', hex: WEIGHT_STABLE },
        { atMs: 1500, dir: 'rx', hex: MUSCLE_BONE },
        { atMs: 2000, dir: 'rx', hex: BMR },
      ],
    },
    'senssun-weight-only-never-completes': {
      provenance: 'characterization',
      source: 'tests/scales/senssun.test.ts: weight without B0/C0/D0 never satisfies the gate',
      steps: [
        { atMs: 500, dir: 'rx', hex: WEIGHT_UNSTABLE },
        { atMs: 1000, dir: 'rx', hex: WEIGHT_STABLE },
      ],
      disconnectAtMs: 6000,
    },
  },
};
