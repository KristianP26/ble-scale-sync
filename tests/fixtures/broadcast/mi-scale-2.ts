import type { AdvertFixture } from '../../helpers/replay/broadcast.js';
import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * Xiaomi Mi Scale 2 (MIBCS / MIBFS): read from its 0x181B service data
 * (preferPassive), with a GATT path the transports no longer open for it
 * (#422). The only real frames are the two "load removed" adverts and the
 * GATT unlock echoes from #422 (no MAC in any of them); everything else is
 * `characterization`: 13-byte frames built to the layout in mi-scale-2.ts
 * (control bytes, date 2026-01-01 12:00:00, impedance LE, weight LE), as the
 * adapter's tests build theirs.
 */

const MIBFS = { localName: 'MIBFS' };
/** 0x181B as the proxy transports hand it over (normalizeUuid); noble passes '181b'. */
const BCS = '0000181b00001000800000805f9b34fb';
/** Stable 75.00 kg, no impedance. */
const WEIGHT_ONLY = '0220ea0701010c00000000983a';
/** Stable 75.00 kg with impedance 500 ohm. */
const WITH_IMPEDANCE = '0222ea0701010c0000f401983a';

export const adverts: AdvertFixture = {
  adapter: 'Xiaomi Mi Scale 2',
  traces: {
    'mi2-impedance-after-weight': {
      provenance: 'characterization',
      source: 'mi-scale-2.ts layout: weight-only frames held, the impedance frame completes',
      device: MIBFS,
      adverts: [
        { atMs: 0, svc: { '181b': WEIGHT_ONLY }, repeat: { count: 2, everyMs: 500 } },
        { atMs: 2500, svc: { '181b': WITH_IMPEDANCE }, repeat: { count: 3, everyMs: 500 } },
      ],
    },
    'mi2-weight-only-grace': {
      provenance: 'characterization',
      source: 'mi-scale-2.ts layout: no impedance frame, so the grace exports the weight alone',
      device: MIBFS,
      adverts: [{ atMs: 0, svc: { '181b': WEIGHT_ONLY }, repeat: { count: 4, everyMs: 1000 } }],
    },
    'mi2-units-and-unstable': {
      provenance: 'characterization',
      source:
        'mi-scale-2.ts layout: 165.35 lb, 140.0 jin (both with impedance), then an unstable ' +
        'frame; nameless, claimed on the 0x181B service data (proxy path)',
      adverts: [
        { atMs: 0, svc: { [BCS]: '0322ea0701010c0000f4019740' } },
        { atMs: 1000, svc: { [BCS]: '0262ea0701010c0000f401b036' } },
        { atMs: 2000, svc: { [BCS]: '0200ea0701010c00000000343a' } },
      ],
    },
    'mi2-422-load-removed': {
      provenance: 'derived',
      source:
        '#422 comment 5961349470: the idle advert and the 1.60 kg step-off advert, both with ' +
        'the load-removed bit; nameless (ESP32 proxy); times assumed',
      adverts: [
        { atMs: 0, svc: { [BCS]: '02a6b207010402371b4a02684c' } },
        { atMs: 1000, svc: { [BCS]: '06a4b207010403032200004001' } },
      ],
    },
  },
};

/**
 * The GATT path as the #422 unit answered it. Weigh-ins over GATT are the
 * mi-scale-2 family's fixtures; this pins only the unit that never sends one.
 */
export const session: SessionFixture = {
  adapter: 'Xiaomi Mi Scale 2',
  traces: {
    'mi2-gatt-422-unlock-echo': {
      provenance: 'derived',
      source:
        '#422 issue body: each unlock write answered with an echo, never a weight frame; ' +
        'times assumed 100 ms after the 3 s unlock writes, link dropped at 10 s',
      steps: [
        { atMs: 3100, dir: 'rx', hex: '010400968abd62' },
        { atMs: 6100, dir: 'rx', hex: '010500968abd62' },
        { atMs: 9100, dir: 'rx', hex: '010500968abd62' },
      ],
      disconnectAtMs: 10_000,
    },
  },
};
