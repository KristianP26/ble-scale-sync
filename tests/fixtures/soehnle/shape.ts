import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Soehnle Shape / Style sessions. No capture of this scale exists anywhere
 * (PROTOCOLS.md "Soehnle Shape / Style"), so every trace is characterization:
 * 0x09 frames built from the layout the adapter ports from openScale's
 * SoehnleHandler, 80.0 kg at [9..10], 300 ohm (5 kHz) at [11..12] and 450 ohm
 * (50 kHz) at [13..14], user 1 at [1], 2026-01-01 12:00:00 at [2..8], which
 * the adapter does not read. Spacing is one frame a second, invented.
 */

const FULL = '0901 07ea 0101 0c0000 0320 012c 01c2';
const NO_IMPEDANCE = '0901 07ea 0101 0c0000 0320 0000 0000';

/** Same frame with [13..14] = 0xffff: complete, but not a body for BIA. */
const IMPEDANCE_FFFF = '0901 07ea 0101 0c0000 0320 012c ffff';

const frame = (atMs: number, h: string) => ({ atMs, dir: 'rx' as const, hex: h.replace(/ /g, '') });

const SYNTH = 'characterization: 0x09 layout from the openScale port, no capture';

export const session: SessionFixture = {
  adapter: 'Soehnle Shape/Style',
  traces: {
    // Weight frames without impedance do not complete; the unlock 09 01 keeps
    // going every 5 s until the 50 kHz impedance arrives.
    'weight-then-impedance': {
      provenance: 'characterization',
      source: SYNTH,
      steps: [frame(1000, NO_IMPEDANCE), frame(6000, NO_IMPEDANCE), frame(11000, FULL)],
    },
    'impedance-out-of-band': {
      provenance: 'characterization',
      source: `${SYNTH}; [13..14] = ffff, so body fat falls back to the BMI estimate`,
      steps: [frame(1000, IMPEDANCE_FFFF)],
    },
    // A wrong frame type, a 14-byte frame and a zero weight are all ignored.
    'ignored-frames-then-full': {
      provenance: 'characterization',
      source: `${SYNTH}; [0] = 05, the last byte cut, weight 0`,
      steps: [
        frame(1000, '0501 07ea 0101 0c0000 0320 012c 01c2'),
        frame(2000, '0901 07ea 0101 0c0000 0320 012c 01'),
        frame(3000, '0901 07ea 0101 0c0000 0000 012c 01c2'),
        frame(4000, FULL),
      ],
    },
    'weight-only-link-drops': {
      provenance: 'characterization',
      source: `${SYNTH}; no impedance ever, link dropped at 8 s`,
      steps: [frame(1000, NO_IMPEDANCE), frame(2000, NO_IMPEDANCE)],
      disconnectAtMs: 8000,
    },
  },
};
