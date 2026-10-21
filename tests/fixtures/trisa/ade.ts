import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * ADE BA 1600 / fitvigo firmware (#138): no 0x8A21, so the adapter picks the
 * ADE branch (0x22 broadcast, 0x20 challenge echo, no resistance walk). The
 * frames are the ones tests/scales/trisa.test.ts carries from #138: the
 * challenge `a1 01 00 b8 99`, the 0x8A24 measurement (80.40 kg, stamped
 * 2026-04-27 13:32:21 UTC) and the 0x8A22 body-comp push. Their order and
 * spacing are composed; the issue's logs predate per-frame Notification lines.
 * The clock is set just before the stamp so the measurement is live.
 */
const UPLOAD = '8a82';
const MEAS = '8a24';
const BODYCOMP = '8a22';
const ADE_CHARS = ['8a24', '8a22', '8a20', '8a82', '8a81'];
const MEASUREMENT = '1f681f00fe652ab21e000000006a1500ff011900';

export const session: SessionFixture = {
  adapter: 'Trisa',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  chars: ADE_CHARS,
  now: Date.UTC(2026, 3, 27, 13, 32, 20),
  traces: {
    'ade-challenge-measurement': {
      provenance: 'derived',
      source: '#138 frames from tests/scales/trisa.test.ts, sequence composed',
      steps: [
        { atMs: 200, dir: 'rx', uuid: UPLOAD, hex: 'a10100b899' },
        // Not answered on ADE: a 0xA0 frame, and a challenge one byte short.
        { atMs: 300, dir: 'rx', uuid: UPLOAD, hex: 'a011223344' },
        { atMs: 350, dir: 'rx', uuid: UPLOAD, hex: 'a1010203' },
        { atMs: 1400, dir: 'rx', uuid: BODYCOMP, hex: '6d652ab21e01caf07af252f11cf0' },
        { atMs: 1500, dir: 'rx', uuid: MEAS, hex: MEASUREMENT },
      ],
    },
    'ade-r2-flag-ignored': {
      provenance: 'characterization',
      source: 'tests/scales/trisa.test.ts: r2 500.0 on ADE still gives impedance 0',
      steps: [{ atMs: 1000, dir: 'rx', uuid: MEAS, hex: '04401f00fe881300ff' }],
    },
  },
};
