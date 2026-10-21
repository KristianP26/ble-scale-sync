import type { SessionFixture } from '../../helpers/replay/session.js';

/** mgb.ts for a female profile (sex 0x02 in the `fb` write); written with TZ=UTC like mgb.ts. */
export const session: SessionFixture = {
  adapter: 'MGB (Swan/Icomon/YG)',
  profile: { height: 162, age: 45, gender: 'female', isAthlete: false },
  now: Date.UTC(2026, 0, 15, 7, 30, 5),
  traces: {
    'mgb-female-profile': {
      provenance: 'characterization',
      source: 'mgb.test.ts: Frame1 (0x03) with fat',
      steps: [{ atMs: 1000, dir: 'rx', hex: 'ac03ff0000000000000000000320000000e10000' }],
    },
  },
};
