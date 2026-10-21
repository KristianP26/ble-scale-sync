import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Trisa firmware (0x8A21 present, so the harness's default characteristics,
 * which include both measurement chars, pick the Trisa branch). No Trisa unit
 * was ever captured: every frame is synthetic, built from the layout in
 * src/scales/trisa.ts and tests/scales/trisa.test.ts, except the 0x1F frame,
 * which is the ADE BA 1600 measurement from #138 read through the Trisa
 * branch exactly as the unit test does. Upload frames go to 0x8A82, the
 * measurement to 0x8A21.
 */
const UPLOAD = '8a82';
const MEAS = '8a21';

export const session: SessionFixture = {
  adapter: 'Trisa',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'trisa-password-challenge': {
      provenance: 'characterization',
      source:
        'tests/scales/trisa.test.ts: password 0xA0 + challenge 0xA1 -> XOR response, r2 500.0',
      steps: [
        { atMs: 300, dir: 'rx', uuid: UPLOAD, hex: 'a0112233' },
        { atMs: 400, dir: 'rx', uuid: UPLOAD, hex: 'a1aabbcc' },
        { atMs: 1500, dir: 'rx', uuid: MEAS, hex: '04aa1e00fe881300ff' },
      ],
    },
    'trisa-challenge-without-password': {
      provenance: 'characterization',
      source: 'tests/scales/trisa.test.ts: a challenge with no password is not answered',
      steps: [
        { atMs: 300, dir: 'rx', uuid: UPLOAD, hex: 'a0' },
        { atMs: 400, dir: 'rx', uuid: UPLOAD, hex: 'a1aabbcc' },
        { atMs: 1500, dir: 'rx', uuid: MEAS, hex: '00401f00fe' },
      ],
    },
    'trisa-r2-below-410': {
      provenance: 'characterization',
      source: 'tests/scales/trisa.test.ts: zero-mantissa frame dropped, then r2 400.0 -> 3.0 ohm',
      steps: [
        { atMs: 500, dir: 'rx', uuid: MEAS, hex: '010000000000000000000000' },
        { atMs: 800, dir: 'rx', uuid: MEAS, hex: '04aa1e00fea00f00ff' },
      ],
    },
    'trisa-ade-frame-on-trisa-branch': {
      provenance: 'derived',
      source: '#138 ADE BA 1600 measurement frame, delivered on 0x8A21 to walk r1/r2 and the stamp',
      steps: [
        { atMs: 1000, dir: 'rx', uuid: MEAS, hex: '1f681f00fe652ab21e000000006a1500ff011900' },
      ],
    },
    'trisa-unset-clock-stamp': {
      provenance: 'derived',
      source: '#138 ADE frame with its stamp zeroed (2010-01-01): the stamp is dropped',
      steps: [
        { atMs: 1000, dir: 'rx', uuid: MEAS, hex: '1f681f00fe00000000000000006a1500ff011900' },
      ],
    },
  },
};
