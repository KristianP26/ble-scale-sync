import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Speediance FG2211WBF (`SPEED_S_*`, PR #383). The A2 live frame and the A7
 * part-00 result (76.350 kg, impedance field 0x0bce = 3022, outside the BIA
 * range so dropped) are from the PacketLogger capture in PR #383 as carried
 * by tests/scales/speediance.test.ts; the in-range (302 ohm), part-01 and
 * short variants are that frame with the bytes the unit test names changed.
 * Frames arrive after the 16-write handshake (150 ms apart); spacing composed.
 */
const A2_LIVE = '071000a2012501252a0000000000000000000038';
const A7_CAPTURED = '4d2300a76a96d1ff25012a3e000a00ce0b970b2a';

export const session: SessionFixture = {
  adapter: 'Speediance',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'speediance-captured-a7': {
      provenance: 'derived',
      source: 'PR #383 capture (speediance.test.ts): A2 live, then the A7 part-00 result',
      steps: [
        { atMs: 3000, dir: 'rx', uuid: 'ffb2', hex: A2_LIVE },
        { atMs: 4000, dir: 'rx', uuid: 'ffb3', hex: A7_CAPTURED },
      ],
    },
    'speediance-impedance-in-range': {
      provenance: 'derived',
      source: 'PR #383 A7 with [15..16] = 2e 01 (302 ohm); a part-01 frame before it is ignored',
      steps: [
        { atMs: 3000, dir: 'rx', uuid: 'ffb2', hex: A2_LIVE },
        { atMs: 3900, dir: 'rx', uuid: 'ffb3', hex: '4d2301a76a96d1ff25012a3e000a002e01970b2a' },
        { atMs: 4000, dir: 'rx', uuid: 'ffb3', hex: '4d2300a76a96d1ff25012a3e000a002e01970b2a' },
      ],
    },
    'speediance-short-a7': {
      provenance: 'derived',
      source: 'PR #383 A7 cut to 14 bytes: weight only, no impedance field',
      steps: [{ atMs: 4000, dir: 'rx', uuid: 'ffb3', hex: '4d2300a76a96d1ff25012a3e0013' }],
    },
  },
};
