import type { SessionFixture } from '../../helpers/replay/session.js';
import { FAKE_ADDRESS } from '../../helpers/replay/session.js';
import { fromSnoop } from '../../helpers/replay/trace.js';

/**
 * A&D UC-352BLE sessions from the btsnoop_hci.log attached to the public
 * openScale PR #1505 (three connections, 2026-08-22, frames cited in
 * tests/scales/and-uc352ble.test.ts). `tx` is the vendor app's 7-byte Write
 * Request to Date Time 0x2A08, `rx` the Weight Measurement indication.
 *
 * Rewritten:
 *  - The name's address suffix and the address are the fake ones.
 *  - Every indication's Time Stamp year 2026 (ea 07) is 2014 (de 07). A SIG
 *    stamp is local time and the harness does not pin the process time zone,
 *    so a trusted stamp would put a zone-dependent `reading.timestamp` in the
 *    golden. 2014 is before MIN_TRUSTED_YEAR, so the reading carries no stamp
 *    and reads as live, as the captured ones did (0.9-1.3 s old). The stored
 *    record branch (a stamp older than 5 minutes -> history) is therefore not
 *    pinned here.
 *  - `now` is the capture's local wall clock, built in the zone the suite runs
 *    in, so our Date Time write is the captured `ea07 0816 082a 24` in every
 *    zone.
 */

const ADVERT = {
  localName: 'A&D_UC-352BLE_000001',
  address: FAKE_ADDRESS,
  serviceUuids: ['181d'],
};

const SOURCE = 'openScale PR #1505 btsnoop';

export const session: SessionFixture = {
  adapter: 'A&D UC-352BLE',
  now: new Date(2026, 7, 22, 8, 42, 36).getTime(),
  traces: {
    // Time written, indications enabled, one weigh-in, held 4 s.
    'connection-1': {
      provenance: 'derived',
      source: `${SOURCE}, connection 1 (06:42:36.869); stamp year 2026 -> 2014`,
      advert: ADVERT,
      steps: fromSnoop([
        ['06:42:36.869', 'tx', 'ea070816082a24'],
        ['06:42:37.199', 'rx', '025433de070816082a24'],
      ]),
    },
    // Two live records inside one hold: the later one wins. The frames of
    // connections 1 and 2, 200 ms apart in one session.
    'two-records-later-wins': {
      provenance: 'derived',
      source: `${SOURCE}, connections 1 and 2 in one session; stamp year 2026 -> 2014`,
      advert: ADVERT,
      steps: fromSnoop([
        ['06:42:36.869', 'tx', 'ea070816082a24'],
        ['06:42:37.199', 'rx', '025433de070816082a24'],
        ['06:42:37.399', 'rx', '024033de070816082b0b'],
      ]),
    },
    // Weight bytes ff ff = "Measurement Unsuccessful": no reading from it.
    // Our time write follows the fixture clock (connection 1), not this `tx`.
    'unsuccessful-then-weight': {
      provenance: 'derived',
      source: `${SOURCE}, connection 3 frame; first one with [1..2] = ff ff, stamp year 2026 -> 2014`,
      advert: ADVERT,
      steps: fromSnoop([
        ['06:43:40.927', 'tx', 'ea070816082b28'],
        ['06:43:41.257', 'rx', '02ffffde070816082b28'],
        ['06:43:41.457', 'rx', '027c33de070816082b28'],
      ]),
    },
  },
};
