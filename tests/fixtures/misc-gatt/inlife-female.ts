import type { SessionFixture } from '../../helpers/replay/session.js';

/** inlife.ts for a female profile: the user-config write's sex byte and checksum. */
export const session: SessionFixture = {
  adapter: 'Inlife',
  profile: { height: 162, age: 45, gender: 'female', isAthlete: false },
  traces: {
    'inlife-female-profile': {
      provenance: 'characterization',
      source: 'inlife.test.ts layout, mode 0x80 78.4 kg / 500 ohm',
      steps: [{ atMs: 1000, dir: 'rx', hex: '02100310000001f4000000800000' }],
    },
  },
};
