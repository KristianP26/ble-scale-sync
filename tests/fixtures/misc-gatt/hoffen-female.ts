import type { SessionFixture } from '../../helpers/replay/session.js';

/** hoffen.ts for a female profile: the write and its echo carry gender 0x01. */
export const session: SessionFixture = {
  adapter: 'Hoffen BS-8107',
  profile: { height: 162, age: 45, gender: 'female', isAthlete: false },
  traces: {
    'hoffen-female-profile': {
      provenance: 'characterization',
      source: 'hoffen.test.ts: echo of the female write, then the BIA frame',
      steps: [
        { atMs: 100, dir: 'rx', hex: 'fa8503012da2f2' },
        { atMs: 1000, dir: 'rx', hex: 'fa0000200300e1002602900100002300005000' },
      ],
    },
  },
};
