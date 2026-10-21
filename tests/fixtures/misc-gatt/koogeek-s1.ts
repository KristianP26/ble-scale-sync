import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Koogeek-S1 (Shenzhen Belter OEM, #270). The init frame and the stable
 * 78.3 kg / 470 ohm frame are the reporter's captures (#270 comment
 * 4934182232); the live, query and impedance-less frames are those with the
 * command byte or payload changed and the XOR checksum recomputed. The order
 * follows the comment's description (init repeats until acked, then 0x02 live,
 * 0x03 stable); the spacing is composed.
 */
const INIT = '55aa55aa010d010101162601735500000000001a';
const STABLE = '55aa55aa0307010000030f01d6de';
const SOURCE = '#270 comment 4934182232';

export const session: SessionFixture = {
  adapter: 'Koogeek-S1',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'koogeek-init-live-stable': {
      provenance: 'derived',
      source: `${SOURCE}: init (acked), a 75.6 kg live frame, a 0x07 query, then the captured stable frame`,
      steps: [
        { atMs: 100, dir: 'rx', hex: INIT },
        { atMs: 300, dir: 'rx', hex: INIT },
        { atMs: 1000, dir: 'rx', hex: '55aa55aa020701000002f40000f2' },
        { atMs: 1200, dir: 'rx', hex: '55aa55aa07020500' },
        { atMs: 2000, dir: 'rx', hex: STABLE },
      ],
    },
    'koogeek-stable-without-impedance': {
      provenance: 'derived',
      source: `${SOURCE}: stable frame with impedance zeroed holds 2 s; a live frame after it does not resolve`,
      steps: [
        { atMs: 100, dir: 'rx', hex: INIT },
        { atMs: 1000, dir: 'rx', hex: '55aa55aa0307010000030f000009' },
        { atMs: 1500, dir: 'rx', hex: '55aa55aa020701000002f40000f2' },
      ],
    },
    'koogeek-rejected-frames': {
      provenance: 'derived',
      source: `${SOURCE}: bad checksum and 300.1 kg frames rejected, then the captured stable frame`,
      steps: [
        { atMs: 100, dir: 'rx', hex: INIT },
        { atMs: 800, dir: 'rx', hex: '55aa55aa0307010000030f01d6df' },
        { atMs: 1000, dir: 'rx', hex: '55aa55aa03070100000bb901d660' },
        { atMs: 2000, dir: 'rx', hex: STABLE },
      ],
    },
  },
};
