import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Xiaomi Mi Scale 2 over GATT (the history characteristic, unlock every 3 s).
 * No GATT capture exists; the 13-byte frames are synthetic, built like
 * makeFrame() in tests/scales/mi-scale-2.test.ts: [0] bit0 lbs, [1] bit1
 * impedance, bit5 stable, bit6 catty, bit7 removed, stamp 2026-01-01 07:30:05,
 * impedance u16 LE at [9], weight u16 LE at [11]. A reading completes only with
 * weight > 10 kg and impedance.
 */
export const session: SessionFixture = {
  adapter: 'Xiaomi Mi Scale 2',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'mi2-kg-impedance': {
      provenance: 'characterization',
      source:
        'mi-scale-2.test.ts frames: unstable, removed, stable without impedance, stable 80 kg / 500 ohm',
      steps: [
        { atMs: 500, dir: 'rx', hex: '0000ea070101071e050000b83d' },
        { atMs: 1000, dir: 'rx', hex: '00a2ea070101071e05f401803e' },
        { atMs: 1500, dir: 'rx', hex: '0020ea070101071e050000803e' },
        // Impedance bytes set but flag clear: read as 0, still not complete.
        { atMs: 2000, dir: 'rx', hex: '0020ea070101071e05f401803e' },
        { atMs: 4000, dir: 'rx', hex: '0022ea070101071e05f401803e' },
      ],
    },
    'mi2-lbs': {
      provenance: 'characterization',
      source: 'mi-scale-2.test.ts: lbs flag, 176.37 lb weight-only then with 480 ohm',
      steps: [
        { atMs: 500, dir: 'rx', hex: '0120ea070101071e050000e544' },
        { atMs: 1500, dir: 'rx', hex: '0122ea070101071e05e001e544' },
      ],
    },
    'mi2-catty': {
      provenance: 'characterization',
      source: 'mi-scale-2.test.ts: catty flag, 160.00 jin with 520 ohm',
      steps: [{ atMs: 500, dir: 'rx', hex: '0062ea070101071e050802803e' }],
    },
    'mi2-light-load-never-completes': {
      provenance: 'characterization',
      source: 'mi-scale-2.test.ts: 9 kg with impedance is under the 10 kg gate',
      steps: [{ atMs: 500, dir: 'rx', hex: '0022ea070101071e05f4010807' }],
      disconnectAtMs: 4000,
    },
  },
};
