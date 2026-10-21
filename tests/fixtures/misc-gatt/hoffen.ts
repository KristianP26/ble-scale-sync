import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Hoffen BS-8107: notify and write share FFB2, so the scale's echo of the
 * user-config write (`fa 85 03 ...`, built from this profile) arrives as a
 * notification and must not be read as a weight. No capture exists; frames are
 * synthetic from tests/scales/hoffen.test.ts (`fa`, weight LE/10 at [3], [5]
 * 0x00 = BIA contact with fat, water, muscle LE/10, bone [14], visceral LE/10
 * [17]). The first frame with a weight ends the session.
 */
export const session: SessionFixture = {
  adapter: 'Hoffen BS-8107',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'hoffen-echo-then-bia': {
      provenance: 'characterization',
      source: 'hoffen.test.ts: echo of our write, wrong magic, zero weight, then the BIA frame',
      steps: [
        { atMs: 100, dir: 'rx', hex: 'fa8503001eb7d5' },
        { atMs: 500, dir: 'rx', hex: 'fb00002003010000' },
        { atMs: 800, dir: 'rx', hex: 'fa00000000010000' },
        { atMs: 1500, dir: 'rx', hex: 'fa0000200300e1002602900100002300005000' },
      ],
    },
    'hoffen-weight-only': {
      provenance: 'characterization',
      source: 'hoffen.test.ts: no BIA contact, 80.0 kg',
      steps: [{ atMs: 1000, dir: 'rx', hex: 'fa00002003010000' }],
    },
  },
};
