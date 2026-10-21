import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';

/**
 * Yunmai SIGNAL (protocol 0x13, 18-byte final frame with the resistance and no
 * body fat field), frames byte for byte from the openScale issue #1286 debug
 * log (2026-01-15) as tests/scales/yunmai.test.ts carries them; spacing
 * invented. The profile is the made-up BMI 55 one of the D-08 tests, where the
 * Yunmai fat equation gives up and the BMI estimate takes over.
 */

const traces: Record<string, Trace> = {
  'signal-1286-weigh-in': {
    provenance: 'derived',
    source: 'openScale #1286 frames: unlock reply, live 79.86 kg, live 0, final 79.67 kg / 187',
    steps: [
      { atMs: 100, dir: 'rx', hex: '0d13050513' },
      { atMs: 1000, dir: 'rx', hex: '0d130b01000000491f327d' },
      { atMs: 1200, dir: 'rx', hex: '0d130b0100000049000050' },
      { atMs: 3000, dir: 'rx', hex: '0d131202000000006d000000011f1f00bbd4' },
    ],
  },
  'signal-141kg-bmi-fallback': {
    provenance: 'derived',
    source:
      'openScale #1286 final frame with the weight set to 141.00 kg (tests/scales/yunmai.test.ts)',
    steps: [{ atMs: 1000, dir: 'rx', hex: '0d131202000000006d00000001371400bbf7' }],
  },
};

export const session: SessionFixture = {
  adapter: 'Yunmai',
  profile: { height: 160, age: 40, gender: 'female', isAthlete: false },
  traces,
};
