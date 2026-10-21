import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * The #138 ADE measurement received four days after its stamp (D027): a
 * stored record, buffered as history, so the session ends only when the link
 * drops and hands it over then. Same frames as ade.ts; only the clock moved.
 */
export const session: SessionFixture = {
  adapter: 'Trisa',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  chars: ['8a24', '8a22', '8a20', '8a82', '8a81'],
  now: Date.UTC(2026, 4, 1, 13, 32, 21),
  traces: {
    'ade-stored-record': {
      provenance: 'derived',
      source: '#138 challenge + measurement from tests/scales/trisa.test.ts, received 4 days late',
      steps: [
        { atMs: 200, dir: 'rx', uuid: '8a82', hex: 'a10100b899' },
        { atMs: 1500, dir: 'rx', uuid: '8a24', hex: '1f681f00fe652ab21e000000006a1500ff011900' },
      ],
      disconnectAtMs: 5000,
    },
  },
};
