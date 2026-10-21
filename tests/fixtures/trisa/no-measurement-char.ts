import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * GATT discovery race guard: neither 0x8A21 nor 0x8A24 discovered, so
 * onConnected throws before writing anything (tests/scales/trisa.test.ts).
 */
export const session: SessionFixture = {
  adapter: 'Trisa',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  chars: ['8a82', '8a81'],
  traces: {
    'trisa-no-measurement-char': {
      provenance: 'characterization',
      source: 'tests/scales/trisa.test.ts: upload + download only',
      steps: [{ atMs: 500, dir: 'rx', uuid: '8a82', hex: 'a0112233' }],
    },
  },
};
