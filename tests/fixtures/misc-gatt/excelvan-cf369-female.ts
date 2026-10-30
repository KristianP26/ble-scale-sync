import type { SessionFixture } from '../../helpers/replay/session.js';

/** excelvan-cf369.ts for a female profile: the user-config write's sex byte and checksum. */
export const session: SessionFixture = {
  adapter: 'Excelvan CF369',
  profile: { height: 162, age: 45, gender: 'female', isAthlete: false },
  traces: {
    'excelvan-female-profile': {
      provenance: 'characterization',
      source: 'excelvan-cf369.test.ts layout, 80.0 kg with composition',
      steps: [{ atMs: 1000, dir: 'rx', hex: 'cf000000032000e12301900802260000' }],
    },
  },
};
