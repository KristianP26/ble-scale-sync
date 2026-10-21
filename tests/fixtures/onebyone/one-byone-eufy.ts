import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';

/**
 * 1byone (Eufy C1/P1/A1, "Health Scale"): the FD 37 mode/unit command and the
 * F1 clock (local time) at connect, both without response, then 0xCF frames
 * on FFF4 held until two in a row report the same weight (#284).
 *
 * No frame of this scale is on record (#177, #251 and #319 carry adverts and
 * errors, no notifications), so every trace is characterization, built as
 * tests/scales/one-byone.test.ts builds its frames: [1..2] impedance x10 (LE
 * as the adapter reads it), [3..4] weight x100 LE, [9] = 1 impedance invalid.
 */

const W_80_0 = 'cf0000401f0000000001';

const traces: Record<string, Trace> = {
  'eufy-stable-weight': {
    provenance: 'characterization',
    source: 'tests/scales/one-byone.test.ts #284: 80.2, 80.0, 80.0 kg, impedance invalid',
    steps: [
      { atMs: 500, dir: 'rx', hex: 'cf0000541f0000000001' },
      { atMs: 800, dir: 'rx', hex: W_80_0 },
      { atMs: 1100, dir: 'rx', hex: W_80_0 },
    ],
  },
  'eufy-impedance': {
    provenance: 'characterization',
    source: 'made up: 80.0 kg twice with raw impedance 5000 (500.0 ohm), [9] = 0',
    steps: [
      { atMs: 500, dir: 'rx', hex: 'cf8813401f0000000000' },
      { atMs: 800, dir: 'rx', hex: 'cf8813401f0000000000' },
    ],
  },
  // The weight never repeats: the 3 s hold resolves the last frame.
  'eufy-hold-expiry': {
    provenance: 'characterization',
    source:
      'made up: 80.2, 80.0, 79.9, 80.1 kg, then nothing; a short and a wrong-header frame first',
    steps: [
      { atMs: 200, dir: 'rx', hex: 'cf000054' },
      { atMs: 300, dir: 'rx', hex: 'ce0000541f0000000001' },
      { atMs: 500, dir: 'rx', hex: 'cf0000541f0000000001' },
      { atMs: 800, dir: 'rx', hex: W_80_0 },
      { atMs: 1100, dir: 'rx', hex: 'cf0000361f0000000001' },
      { atMs: 1400, dir: 'rx', hex: 'cf00004a1f0000000001' },
    ],
  },
};

export const session: SessionFixture = {
  adapter: '1byone (Eufy)',
  traces,
};
