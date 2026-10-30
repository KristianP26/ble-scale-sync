import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Digoo (`mengii`). No capture exists; the 19-byte frames are synthetic from
 * src/scales/digoo.ts and tests/scales/digoo.test.ts: weight BE/100 at [3],
 * control [5] (bit0 stable, bit1 all values), then fat, visceral, water,
 * muscle, bone. Stable completes, all-values makes it final.
 */
const ALL_VALUES = '0000001f400300e10000500226000000019023';

export const session: SessionFixture = {
  adapter: 'Digoo',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'digoo-settle-then-all-values': {
      provenance: 'characterization',
      source: 'digoo.test.ts layout: settling 79.50 kg, stable 80.00 kg (hold), then all values',
      steps: [
        { atMs: 500, dir: 'rx', hex: '0000001f0e0000e10000500226000000019023' },
        { atMs: 1000, dir: 'rx', hex: '0000001f400100e10000500226000000019023' },
        { atMs: 3000, dir: 'rx', hex: ALL_VALUES },
      ],
    },
    'digoo-all-values-without-stable': {
      provenance: 'characterization',
      source: 'digoo.test.ts: an all-values frame without the stable bit is final',
      steps: [{ atMs: 1000, dir: 'rx', hex: '0000001f400200e10000500226000000019023' }],
    },
    'digoo-stable-weight-hold-expires': {
      provenance: 'characterization',
      source: 'digoo.test.ts: stable weight without composition completes after the hold (D028)',
      steps: [{ atMs: 1000, dir: 'rx', hex: '0000001f400100e10000500226000000019023' }],
    },
  },
};
