import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';

/**
 * 1byone Scale (new protocol, FFB0): the AB 2A unlock written once at
 * connect and once more after the subscribe (send-once adapter), then an
 * 0x80 final weight held up to 8 s for the 0x01 impedance (D028).
 *
 * No frame of this scale is on record, so every trace is characterization,
 * built as tests/scales/one-byone.test.ts builds its frames: 0x80 weight
 * [3..5] 24-bit BE & 0x03FFFF / 1000, 0x01 impedance [4..5] BE, 0x00 with
 * [7] = 0x80 a history frame.
 */

const WEIGHT_80 = 'ab2a80013880';

const traces: Record<string, Trace> = {
  'new-weight-then-impedance': {
    provenance: 'characterization',
    source: 'tests/scales/one-byone.test.ts: a history frame, 80.000 kg, then 500 ohm',
    steps: [
      { atMs: 300, dir: 'rx', hex: 'ab2a000000000080' },
      { atMs: 1000, dir: 'rx', hex: WEIGHT_80 },
      { atMs: 2500, dir: 'rx', hex: 'ab2a010001f4' },
    ],
  },
  'new-weight-only': {
    provenance: 'characterization',
    source: 'tests/scales/one-byone.test.ts: 80.000 kg and no impedance frame (socks)',
    steps: [{ atMs: 1000, dir: 'rx', hex: WEIGHT_80 }],
  },
};

export const session: SessionFixture = {
  adapter: '1byone Scale (new)',
  traces,
};
