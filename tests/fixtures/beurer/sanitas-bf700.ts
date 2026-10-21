import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Beurer / Sanitas, BF700 / BF800 layout: a Unix timestamp at [0..3], weight
 * u16 BE * 50 g at [4..5], and in a 16-byte frame impedance, fat, water,
 * muscle (/10) and bone (* 50 g) after it. No BF700 or BF800 frame exists in
 * any issue or capture (PROTOCOLS.md: this layout is `code` only, review
 * C-03), so all of it is characterization, shaped as
 * tests/scales/beurer-sanitas.test.ts builds it: 80.00 kg, 500 ohm, 22.5 %,
 * 55.0 %, 40.0 %, 3.00 kg. Kept apart from the SBF70 fixture: the variant
 * latch would carry an SBF70 session's layout into these.
 */

const rx = (atMs: number, hex: string) => ({ atMs, dir: 'rx' as const, hex });

const SYNTH = 'characterization: BF700 layout from the openScale port, no capture';

export const session: SessionFixture = {
  adapter: 'Beurer / Sanitas',
  traces: {
    // No hold on this variant: the first weight ends the session.
    'bf700-weight-only': {
      provenance: 'characterization',
      source: SYNTH,
      steps: [rx(2000, '690000000640')],
    },
    'bf700-composition': {
      provenance: 'characterization',
      source: SYNTH,
      steps: [rx(2000, '69000000064001f400e102260190003c')],
    },
    // A real impedance next to a zeroed composition: BIA, never 0 % fat (#386).
    'bf700-zeroed-composition': {
      provenance: 'characterization',
      source: `${SYNTH}; [8..15] zero`,
      steps: [rx(2000, '69000000064001f40000000000000000')],
    },
    // 305 kg is out of range and ignored; a 5-byte frame is too short.
    'bf700-rejected-then-weight': {
      provenance: 'characterization',
      source: `${SYNTH}; weight 0x17d4, then a frame cut to 5 bytes`,
      steps: [rx(2000, '6900000017d4'), rx(3000, '6900000006'), rx(7000, '690000000640')],
    },
  },
};
