import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';

/**
 * Huawei AH100 with the vendor app (Huawei Health), from the public capture
 * `btsnoop_hci_20200618132813.txt` in oliexdev/openScale#547 (issue body,
 * dmitriytim). Only what the scale sent, timed from the vendor app's CCCD
 * write, up to the second half of the live record; the vendor app's writes
 * (its USER_INFO carries a profile) are left out.
 *
 * Derived, not captured (D086): the vendor app authenticated as its own user
 * 118 with its own token, and every payload is keyed on the scale's MAC. So the
 * MAC is rewritten to 06:A5:5A:C3:3C:96 (the plain `bd` frames re-XORed, their
 * checksums unchanged) and the record re-encrypted under openScale's user 1
 * token for that MAC. Recipe: decode with the capture's MAC 0c:95:41:4f:19:ca
 * and the vendor key, then encode again; it was done with a separate script,
 * not with src/scales/huawei-ch100.ts. The record's own values (87.6 kg, 22.9 %,
 * [13..14] 373, clock 2020-06-18 13:29:40) are the capture's.
 *
 * - ah100-547-live: the record's user slot set from 118 to 1, as a scale
 *   bound to openScale's user 1 sends it.
 * - ah100-547-other-slot: the slot left at 118, so the record is not ours.
 */

const ADDRESS = '06:A5:5A:C3:3C:96';
const advert = { localName: 'CH100', address: ADDRESS, serviceUuids: [] };

const lead = [
  { atMs: 457, dir: 'rx', hex: 'bd010001' }, // wakeup
  { atMs: 1222, dir: 'rx', hex: 'bd02260780' }, // AUTH accepted
  { atMs: 1447, dir: 'rx', hex: 'bd010001' }, // wakeup again
  { atMs: 1897, dir: 'rx', hex: 'bd0908e2a25cd1318b27a199' }, // answer to the vendor's SET_TIME
  { atMs: 2663, dir: 'rx', hex: 'bd012021' }, // answer to USER_INFO
  { atMs: 2752, dir: 'rx', hex: 'bd090cf95a5b52c369f95acf' }, // answer to the vendor's GET_VERSION
] as const;

const SECOND_HALF = {
  atMs: 9757,
  dir: 'rx',
  hex: 'bc118e4c8f41a716ec8b9114e96c894bcd2969',
} as const;

const SOURCE =
  'oliexdev/openScale#547 btsnoop_hci_20200618132813.txt (issue body), MAC rewritten and ' +
  "the record re-encrypted for openScale's user 1";

const traces: Record<string, Trace> = {
  'ah100-547-live': {
    provenance: 'derived',
    source: `${SOURCE}; record slot 118 -> 1`,
    advert,
    steps: [
      ...lead,
      { atMs: 9743, dir: 'rx', hex: 'bc110e0403168f2490843c5229433947137cea' },
      SECOND_HALF,
    ],
  },
  'ah100-547-other-slot': {
    provenance: 'derived',
    source: `${SOURCE}; record slot left at 118`,
    advert,
    steps: [
      ...lead,
      { atMs: 9743, dir: 'rx', hex: 'bc110e7303168f2490843c5229433947137cea' },
      SECOND_HALF,
    ],
  },
  // macOS hands over a CoreBluetooth UUID, and every frame is keyed on the MAC.
  'ch100-address-not-a-mac': {
    provenance: 'characterization',
    source: 'made up: a CoreBluetooth peripheral UUID where the MAC belongs',
    advert: { localName: 'CH100', address: '6F1C2E3A000040008000000000000001', serviceUuids: [] },
    steps: [{ atMs: 457, dir: 'rx', hex: 'bd010001' }],
  },
};

export const session: SessionFixture = {
  adapter: 'Huawei CH100/AH100',
  traces,
};
