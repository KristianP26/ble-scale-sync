import type { AdvertFixture } from '../../helpers/replay/broadcast.js';

/**
 * QN Scale's AABB broadcast path (src/scales/qn-scale/broadcast.ts): company id
 * 0xFFFF, magic AA BB, [15] bit 5 stable, [17..18] weight LE / 100. No real
 * AABB frame is in the repo, so those are `characterization`, built as
 * tests/scales/qn-scale.test.ts builds them, with the fake 02:00:00:00:00:01
 * at [2..7] where the scale puts its MAC. The GATT sessions of this adapter
 * belong to the QN family's fixtures; only the advert decision is here.
 */

const QN = { localName: 'QN-Scale' };
const STABLE_72_50 = 'aabb020000000001000000000000002300521c00000000';

export const adverts: AdvertFixture = {
  adapter: 'QN Scale',
  traces: {
    'qn-aabb-weigh-in': {
      provenance: 'characterization',
      source: 'qn-scale.test.ts makeBroadcast: unsettled 72.40 kg, then stable 72.50 kg repeated',
      device: QN,
      adverts: [
        { atMs: 0, mfr: [0xffff, 'aabb020000000001000000000000000400481c00000000'] },
        { atMs: 1000, mfr: [0xffff, STABLE_72_50], repeat: { count: 3, everyMs: 500 } },
      ],
    },
    'qn-aabb-nameless': {
      provenance: 'characterization',
      source: 'qn-scale.test.ts makeBroadcast: claimed on 0xFFFF and the AABB magic alone',
      adverts: [{ atMs: 0, mfr: [0xffff, STABLE_72_50] }],
    },
    'qn-gatt-scale-advert-463': {
      provenance: 'derived',
      source:
        '#463 Physiq advert of 2026-10-19 16:38 (ADVERT_1019 in qn-scale.test.ts), the MAC it ' +
        'echoes at [5..10] rewritten to the fake one; name and service assumed: not AABB, so ' +
        'the watcher waits on it',
      device: { ...QN, serviceUuids: ['fff0'] },
      adverts: [{ atMs: 0, mfr: [0xffff, '08140100030100000000026108020015'] }],
    },
  },
};
