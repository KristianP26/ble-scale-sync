import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';

/**
 * Eufy Smart Scale P2 / P2 Pro over GATT, the paths a replay can pin today.
 *
 * NOT covered: the authenticated session (C0 -> C1 -> C2 -> C3, then FFF2
 * weight frames, the #284 stability hold and the impedance latch). The adapter
 * draws its client UUID from crypto.randomUUID() inside onConnected, so the
 * C0 and C2 writes differ on every run, and a fixture has no way to seed it.
 *
 * What is pinned: a transport that knows no address (the handshake is skipped
 * and every FFF2 frame ignored), and one that hands over something that is not
 * a MAC (macOS CoreBluetooth gives a UUID), where onConnected throws.
 *
 * The FFF2 frame is the #289 P2 Pro frame "person 1" of
 * tests/scales/eufy-p2.test.ts (88.00 kg, 470 ohm); the C3 frame is the
 * success reply the tests feed the handler.
 */

const WEIGHT_FRAME = 'cf0e00cf5c1260221113f10000000030';

const traces: Record<string, Trace> = {
  'p2-no-address': {
    provenance: 'characterization',
    source: 'tests/scales/eufy-p2.test.ts frames; the advert carries no address',
    advert: { localName: 'eufy T9149', serviceUuids: [], address: '' },
    steps: [
      { atMs: 500, dir: 'rx', uuid: 'fff4', hex: 'c301000100c3' },
      { atMs: 1000, dir: 'rx', uuid: 'fff2', hex: WEIGHT_FRAME },
      { atMs: 1500, dir: 'rx', uuid: 'fff2', hex: WEIGHT_FRAME },
    ],
  },
  'p2-address-not-a-mac': {
    provenance: 'characterization',
    source: 'made up: a CoreBluetooth peripheral UUID where the MAC belongs',
    advert: {
      localName: 'eufy T9149',
      serviceUuids: [],
      address: '6F1C2E3A-0000-4000-8000-000000000001',
    },
    steps: [{ atMs: 1000, dir: 'rx', uuid: 'fff2', hex: WEIGHT_FRAME }],
  },
};

export const session: SessionFixture = {
  adapter: 'Eufy Smart Scale P2/P2 Pro',
  traces,
};
