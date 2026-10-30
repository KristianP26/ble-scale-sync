import type { AdvertFixture } from '../../helpers/replay/broadcast.js';

/**
 * Xiaomi Mi Smart Scale 2 legacy (XMTZC04HM, MI SCALE2): a 10-byte SIG Weight
 * Scale measurement in 0x181D service data, no impedance, complete on its
 * stable flag. The pounds frame `238e4eea070818103913` is the hardware retest
 * of PR #353 (.claude/docs/PROTOCOLS.md, "Mi Scale ... legacy"); the other
 * frames are that capture's timestamp with other flags and weights, as
 * tests/scales/xiaomi-mi-scale-legacy.test.ts builds them. Rewritten: the
 * Huami (0x0157) manufacturer data, six bytes that look like an address, is
 * the fake 02:00:00:00:00:01.
 */

const HUAMI: [number, string] = [0x0157, '020000000001'];
const LB_91_22 = '238e4eea070818103913';

export const adverts: AdvertFixture = {
  adapter: 'Xiaomi Mi Smart Scale 2 (XMTZC04HM)',
  traces: {
    'legacy-353-lb': {
      provenance: 'derived',
      source: 'PR #353 hardware retest frame (201.10 lb), repeated; times assumed',
      device: { localName: 'MI SCALE2', serviceUuids: ['181d'] },
      adverts: [
        { atMs: 0, mfr: HUAMI, svc: { '181d': LB_91_22 }, repeat: { count: 3, everyMs: 500 } },
      ],
    },
    'legacy-nameless': {
      provenance: 'derived',
      source: 'PR #353 frame without a name: claimed on the Huami id and the 10-byte 0x181D frame',
      adverts: [{ atMs: 0, mfr: HUAMI, svc: { '181d': LB_91_22 } }],
    },
    'legacy-flags': {
      provenance: 'characterization',
      source:
        'PR #353 timestamp with flags 0x22 (90.15 kg), 0x32 (jin, 100.4 kg), 0x03 (unstable) ' +
        'and 0xA3 (removed)',
      device: { localName: 'MI SCALE2' },
      adverts: [
        { atMs: 0, mfr: HUAMI, svc: { '181d': '226e46ea070818103913' } },
        { atMs: 1000, mfr: HUAMI, svc: { '181d': '32704eea070818103913' } },
        { atMs: 2000, mfr: HUAMI, svc: { '181d': '038e4eea070818103913' } },
        { atMs: 3000, mfr: HUAMI, svc: { '181d': 'a38e4eea070818103913' } },
      ],
    },
  },
};
