import type { AdvertFixture } from '../../helpers/replay/broadcast.js';

/**
 * Silvergear Smart Scale 108 adverts (#297, #357). Payloads and their spacing
 * from the iOS PacketLogger captures attached to #297 and from the Foryond
 * FG263LB (AAA002) capture, as cited in tests/scales/silvergear-108.test.ts.
 * A settled weight is partial: the watcher holds it until the post-weigh-in
 * 0x06 frame completes it, or for IMPEDANCE_GRACE_MS. Rewritten: the unit's
 * address, reversed at [0..5], is the fake 02:00:00:00:00:01; the checksum
 * covers the payload [6..11] only.
 */

const ID = 0xa0ac;
const SG = { localName: '108', serviceUuids: ['ffb0'] };
const MAC = '010000000002';
const IDLE = MAC + 'a02ca0a00db9';
const SETTLED_108 = MAC + '202d07600da1';
const BODY_108 = MAC + 'a2b1a0a206bb';
const SETTLING_39_6 = MAC + 'a02c3a100da3';
const SETTLED_ST = MAC + '202d099c0dff';
const BODY_ST = MAC + 'a2ada0a206f7';

export const adverts: AdvertFixture = {
  adapter: 'Silvergear Smart Scale 108',
  traces: {
    'sg-108-5-kg': {
      provenance: 'captured',
      source: '#297 capture 108.5 kg: settling, settled, then 0x06 885 ms later',
      device: SG,
      adverts: [
        { atMs: 0, mfr: [ID, MAC + 'a02d07600da1'] },
        { atMs: 2112, mfr: [ID, SETTLED_108] },
        { atMs: 2997, mfr: [ID, BODY_108] },
        { atMs: 9021, mfr: [ID, BODY_108] },
      ],
    },
    'sg-5-6-kg': {
      provenance: 'captured',
      source: '#297 capture 5.6 kg (an object): the settled frame repeats for 1.3 s',
      device: SG,
      adverts: [
        { atMs: 0, mfr: [ID, MAC + 'a02cb54a0db8'] },
        { atMs: 1187, mfr: [ID, MAC + '202cb54a0db8'] },
        { atMs: 2465, mfr: [ID, MAC + '202cb54a0db8'] },
        { atMs: 2726, mfr: [ID, MAC + 'a0a0a0a206a8'] },
        { atMs: 18932, mfr: [ID, MAC + 'a0a0a0a206a8'] },
      ],
    },
    'sg-17-st-2-lb': {
      provenance: 'captured',
      source: '#297 capture with the display in stones, from the last settling frame',
      device: SG,
      adverts: [
        { atMs: 0, mfr: [ID, MAC + 'a02d099c0dff'] },
        { atMs: 622, mfr: [ID, SETTLED_ST] },
        { atMs: 2168, mfr: [ID, SETTLED_ST] },
        { atMs: 2319, mfr: [ID, BODY_ST] },
        { atMs: 8745, mfr: [ID, BODY_ST] },
      ],
    },
    'sg-fg263lb-node-ble': {
      provenance: 'captured',
      source:
        'Foryond FG263LB (AAA002) capture #73, #74, #88, #89, #91; no service list (node-ble)',
      device: { localName: 'AAA002' },
      adverts: [
        { atMs: 0, mfr: [ID, MAC + 'a02dac2e0db4'] },
        { atMs: 126, mfr: [ID, MAC + '202dac2e0db4'] },
        { atMs: 1423, mfr: [ID, MAC + '202dac2e0db4'] },
        { atMs: 1695, mfr: [ID, MAC + 'a2b9a0a306a4'] },
        { atMs: 1743, mfr: [ID, MAC + 'a2b9a0a306a4'] },
      ],
    },
    'sg-no-body-frame': {
      provenance: 'derived',
      source:
        '#297 108.5 kg settled frame with no 0x06 after it: exported weight only by the grace',
      device: SG,
      adverts: [{ atMs: 0, mfr: [ID, SETTLED_108], repeat: { count: 2, everyMs: 500 } }],
    },
    'sg-late-body-frame': {
      provenance: 'derived',
      source: '#297 108.5 kg capture with its 0x06 moved to 8.001 s, past the pairing window',
      device: SG,
      adverts: [
        { atMs: 0, mfr: [ID, SETTLED_108] },
        { atMs: 8001, mfr: [ID, BODY_108] },
      ],
    },
    'sg-step-off-before-body': {
      provenance: 'derived',
      source:
        '#297 frames: a step-off (39.60 kg settling) before the 0x06 reports the weigh-in at ' +
        'once; the next weigh-in (stones capture) gets a hold of its own',
      device: SG,
      adverts: [
        { atMs: 0, mfr: [ID, SETTLED_108] },
        { atMs: 3000, mfr: [ID, SETTLING_39_6] },
        { atMs: 3500, mfr: [ID, IDLE] },
        { atMs: 6000, mfr: [ID, SETTLED_ST] },
        { atMs: 14_000, mfr: [ID, BODY_ST] },
      ],
    },
    'sg-same-grams-again': {
      provenance: 'derived',
      source:
        '#297 108.5 kg frames: a paired weigh-in, a step-off, and a second weigh-in on the same ' +
        'grams 15 s later, which the watcher dedup window drops',
      device: SG,
      adverts: [
        { atMs: 0, mfr: [ID, SETTLED_108] },
        { atMs: 900, mfr: [ID, BODY_108] },
        { atMs: 3000, mfr: [ID, IDLE] },
        { atMs: 15_000, mfr: [ID, SETTLED_108] },
        { atMs: 16_000, mfr: [ID, BODY_108] },
      ],
    },
  },
};
