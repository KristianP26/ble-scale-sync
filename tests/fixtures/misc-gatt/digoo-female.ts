import type { SessionFixture } from '../../helpers/replay/session.js';

/** digoo.ts for a female profile: the user-config write's gender byte and checksum. */
export const session: SessionFixture = {
  adapter: 'Digoo',
  profile: { height: 162, age: 45, gender: 'female', isAthlete: false },
  traces: {
    'digoo-female-profile': {
      provenance: 'characterization',
      source: 'digoo.test.ts layout, stable + all values',
      steps: [{ atMs: 1000, dir: 'rx', hex: '0000001f400300e10000500226000000019023' }],
    },
  },
};
