import { RSSI_UNAVAILABLE, RSSI_FRESHNESS_MS } from '../types.js';
import { helperOf, type PropsChangedHandler, type Device } from './dbus.js';

/**
 * Tracks whether a BlueZ peer is still actively advertising.
 *
 * Two signals decide freshness:
 *  - the explicit `127` sentinel on `org.bluez.Device1.RSSI` (mgmt-protocol
 *    Device Found "unavailable") means the peer has gone dark.
 *  - the time since the last `RSSI` `PropertiesChanged` signal. BlueZ
 *    refreshes this on every received advertisement, so absence of an update
 *    within `RSSI_FRESHNESS_MS` means no new packets have arrived.
 *
 * `RSSI` is documented Readonly+Optional on `org.bluez.Device1` (BlueZ docs,
 * verified via context7). BlueZ legitimately omits the prop after
 * `StopDiscovery`, so absence is NOT a freshness signal (#167 regression).
 * The `lastRssiUpdateTs = Date.now()` init at construction is load-bearing:
 * trackers are only created after `waitDevice` resolved, which only fires on
 * a fresh advertisement.
 *
 * The 127 sentinel and time window cover the dying-peer scenario @fromport
 * reproduced for #143 / #140, where `device.connect()` would stall inside
 * GATT discovery against a peer whose link layer is shutting down.
 */
export interface PeerFreshnessTracker {
  isFresh: () => Promise<boolean>;
  stop: () => void;
}

export function startPeerFreshnessTracker(device: Device): PeerFreshnessTracker {
  const helper = helperOf(device);
  // Initialise as just-discovered: waitDevice resolved on a fresh advertisement.
  let lastRssiUpdateTs = Date.now();
  const onPropsChanged: PropsChangedHandler = (props) => {
    if ('RSSI' in props) lastRssiUpdateTs = Date.now();
  };
  let stopped = false;
  try {
    helper.on('PropertiesChanged', onPropsChanged);
  } catch {
    // Subscription unavailable: tracker reports fresh until the init
    // timestamp ages past RSSI_FRESHNESS_MS, then stale.
  }
  return {
    isFresh: async () => {
      let rssi: unknown;
      try {
        rssi = await helper.prop('RSSI');
      } catch {
        // RSSI is Optional on org.bluez.Device1 and BlueZ may not expose it
        // after StopDiscovery or on some controllers (#167). PropertiesChanged
        // remains the authoritative freshness signal via lastRssiUpdateTs.
        rssi = undefined;
      }
      if (typeof rssi === 'number' && rssi === RSSI_UNAVAILABLE) return false;
      return Date.now() - lastRssiUpdateTs <= RSSI_FRESHNESS_MS;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        helper.removeListener('PropertiesChanged', onPropsChanged);
      } catch {
        // Listener never attached or helper already torn down.
      }
    },
  };
}

/**
 * Convenience one-shot probe. Subscribes to PropertiesChanged for one freshness
 * check and tears down. Equivalent to instantiating the tracker, calling
 * `isFresh`, and stopping immediately. Useful in tests and for callers that
 * only need a single check.
 */
export async function isPeerFresh(device: Device): Promise<boolean> {
  const tracker = startPeerFreshnessTracker(device);
  try {
    return await tracker.isFresh();
  } finally {
    tracker.stop();
  }
}
