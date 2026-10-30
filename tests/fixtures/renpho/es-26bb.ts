import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';

/**
 * Renpho ES-26BB-B sessions. No frame of this scale is on record (#157 and
 * #317 carry only our own writes), so every trace is characterization: frames
 * built the way tests/scales/renpho-es26bb.test.ts builds them (openScale
 * RenphoES26BBHandler layout, header bytes [3..4] zero, sum checksum last).
 *
 *   live 0x14:    [5] type (0x01 / 0x11 final), [6..9] weight x100 BE, [10..11] ohm BE
 *   offline 0x15: [5..8] weight x100 BE, [9..10] ohm BE, [11..14] seconds ago BE
 */

const FINAL_80_500 = '55aa1400000100001f4001f468';

const traces: Record<string, Trace> = {
  // Dropped first: a bad checksum, a short frame, a progress frame and a
  // final with weight 0; then the final with impedance resolves at once.
  'es26bb-live-final': {
    provenance: 'characterization',
    source: 'tests/scales/renpho-es26bb.test.ts frame builders',
    steps: [
      { atMs: 500, dir: 'rx', hex: '55aa1400000100001f4001f497' },
      { atMs: 700, dir: 'rx', hex: '55aa140000' },
      { atMs: 900, dir: 'rx', hex: '55aa1400000000001f0e000040' },
      { atMs: 1100, dir: 'rx', hex: '55aa140000010000000001f409' },
      { atMs: 1300, dir: 'rx', hex: FINAL_80_500 },
    ],
  },
  // D028 / D-07: a final without impedance (socks) completes after the hold.
  'es26bb-final-no-impedance': {
    provenance: 'characterization',
    source: 'tests/scales/renpho-es26bb.test.ts: final type 0x11, impedance 0',
    steps: [{ atMs: 500, dir: 'rx', hex: '55aa1400001100001f40000083' }],
  },
  // An offline record is acked and buffered as history; the live final ends it.
  'es26bb-offline-then-live': {
    provenance: 'characterization',
    source: 'made up: 78.00 kg / 480 ohm from an hour ago, then 80.00 kg / 500 ohm live',
    steps: [
      { atMs: 500, dir: 'rx', hex: '55aa15000000001e7801e000000e10a9' },
      { atMs: 1500, dir: 'rx', hex: FINAL_80_500 },
    ],
  },
  'es26bb-offline-only': {
    provenance: 'characterization',
    source: 'made up: two offline records (2 h and 1 h old), no live weigh-in',
    steps: [
      { atMs: 500, dir: 'rx', hex: '55aa15000000001e1401d600001c2059' },
      { atMs: 700, dir: 'rx', hex: '55aa15000000001e7801e000000e10a9' },
    ],
  },
};

export const session: SessionFixture = {
  adapter: 'Renpho ES-26BB',
  traces,
};
