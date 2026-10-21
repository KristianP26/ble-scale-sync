import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Hutbit / Lefu AC02 on FFB2. The stable 84.1 kg frame is the #254 capture and
 * the FD 01 518 ohm impedance frame the one posted in #322, both as carried by
 * tests/scales/hutbit.test.ts; the measuring, FD 00, FD FF, 3000 ohm and
 * bad-checksum frames are the unit test's own checksum-valid variants. Frames
 * follow the 5-write handshake (150 ms apart); spacing composed. A stable
 * weight completes and holds 8 s; a paired impedance makes it final.
 */
const MEASURING = 'ac0203480000ce19';
const STABLE_841 = 'ac0203490000ca16';
const IMPEDANCE_518 = 'ac02fd010206cbd1';

export const session: SessionFixture = {
  adapter: 'Hutbit',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'hutbit-weight-then-impedance': {
      provenance: 'derived',
      source: '#254 stable frame + #322 impedance frame, with FD 00 measuring frames between',
      steps: [
        { atMs: 1000, dir: 'rx', hex: MEASURING },
        { atMs: 2000, dir: 'rx', hex: STABLE_841 },
        { atMs: 3000, dir: 'rx', hex: 'ac02fd000000cbc8' },
        { atMs: 4000, dir: 'rx', hex: 'ac02fd000000cbc8' },
        { atMs: 5000, dir: 'rx', hex: IMPEDANCE_518 },
      ],
    },
    'hutbit-no-contact': {
      provenance: 'derived',
      source: '#254 stable frame, then the FD FF no-contact sentinel; the hold runs out',
      steps: [
        { atMs: 2000, dir: 'rx', hex: STABLE_841 },
        { atMs: 4000, dir: 'rx', hex: 'ac02fdff0000cbc7' },
      ],
    },
    'hutbit-rejected-frames': {
      provenance: 'derived',
      source:
        '#322 impedance before any weight, our own handshake frame, bad checksum, wrong header, 3000 ohm',
      steps: [
        { atMs: 1000, dir: 'rx', hex: IMPEDANCE_518 },
        { atMs: 1100, dir: 'rx', hex: 'ac02fde20101ccad' },
        { atMs: 1200, dir: 'rx', hex: 'ac0203490000ca00' },
        { atMs: 1300, dir: 'rx', hex: 'bb0203490000ca16' },
        { atMs: 2000, dir: 'rx', hex: STABLE_841 },
        { atMs: 3000, dir: 'rx', hex: 'ac02fd010bb8cb8c' },
      ],
    },
  },
};
