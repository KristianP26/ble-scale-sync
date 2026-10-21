import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromSnoop } from '../../helpers/replay/trace.js';

/**
 * An A&D UC-352BLE without a Date Time characteristic: the adapter skips the
 * time write and only enables indications. Derived from connection 1 of the
 * openScale PR #1505 btsnoop (see uc352ble.ts for the stamp rewrite); the
 * capture's scale has 0x2A08, so its absence is the change.
 */
export const session: SessionFixture = {
  adapter: 'A&D UC-352BLE',
  chars: ['2a9d'],
  traces: {
    'no-date-time-char': {
      provenance: 'derived',
      source: 'openScale PR #1505 btsnoop, connection 1; 0x2A08 removed, stamp year 2026 -> 2014',
      steps: fromSnoop([['06:42:37.199', 'rx', '025433de070816082a24']]),
    },
  },
};
