import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * The 80 kg / 500 ohm frame of mi-scale-2.ts for a female profile, so the
 * female branches of the Xiaomi composition formulas are pinned too.
 */
export const session: SessionFixture = {
  adapter: 'Xiaomi Mi Scale 2',
  profile: { height: 165, age: 52, gender: 'female', isAthlete: false },
  traces: {
    'mi2-female-profile': {
      provenance: 'characterization',
      source: 'mi-scale-2.test.ts frame layout, stable 80 kg / 500 ohm',
      steps: [{ atMs: 500, dir: 'rx', hex: '0022ea070101071e05f401803e' }],
    },
  },
};
