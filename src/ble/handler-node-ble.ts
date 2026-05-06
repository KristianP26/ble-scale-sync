import NodeBle from 'node-ble';
import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { BleChar, BleDevice, RawReading } from './shared.js';
import { waitForRawReading, findMissingCharacteristics } from './shared.js';
import {
  bleLog,
  normalizeUuid,
  formatMac,
  sleep,
  errMsg,
  withTimeout,
  resetAdapterBtmgmt,
  resetAdapterRfkill,
  restartBluetoothd,
  CONNECT_TIMEOUT_MS,
  MAX_CONNECT_RETRIES,
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_POLL_MS,
  POST_DISCOVERY_QUIESCE_MS,
  GATT_DISCOVERY_TIMEOUT_MS,
  RAW_READING_TIMEOUT_MS,
  CHAR_DISCOVERY_MAX_RETRIES,
  CHAR_DISCOVERY_RETRY_DELAY_MS,
  IMPEDANCE_GRACE_MS,
  RSSI_UNAVAILABLE,
  RSSI_FRESHNESS_MS,
} from './types.js';

type Device = NodeBle.Device;
type Adapter = NodeBle.Adapter;
type GattCharacteristic = NodeBle.GattCharacteristic;

// ─── D-Bus surface typings ───────────────────────────────────────────────────
// node-ble does not expose typings for the internal `helper` BusHelper field
// or for dbus-next Variant wrappers, so we declare the minimum surface we use.
// Replaces eight `eslint-disable @typescript-eslint/no-explicit-any` cast sites
// (#162) with one typed access pattern.

type Variant<T = unknown> = { signature?: string; value: T };

type PropsChangedHandler = (props: Record<string, unknown>) => void;

interface BluezHelper {
  on(event: 'PropertiesChanged', handler: PropsChangedHandler): void;
  removeListener(event: 'PropertiesChanged', handler: PropsChangedHandler): void;
  prop(name: string): Promise<unknown>;
  set(name: string, value: Variant): Promise<void>;
  callMethod(method: string, ...args: unknown[]): Promise<unknown>;
  object: string;
}

type WithHelper<T> = T & { helper: BluezHelper };

interface DbusNextModule {
  Variant: new <T>(signature: string, value: T) => Variant<T>;
}

const helperOf = <T>(obj: T): BluezHelper => (obj as WithHelper<T>).helper;

let _dbusNext: DbusNextModule | null = null;
async function getDbusNext(): Promise<DbusNextModule> {
  if (_dbusNext) return _dbusNext;
  _dbusNext = (await import('dbus-next')) as unknown as DbusNextModule;
  return _dbusNext;
}

// ─── Persistent D-Bus connection + adapter ──────────────────────────────────
// Both the D-Bus connection and the BlueZ adapter proxy are reused across scan
// cycles in continuous mode. This prevents orphaned BlueZ discovery sessions:
// - Same D-Bus client owns the discovery session across cycles
// - Same adapter proxy means stopDiscovery() always matches the startDiscovery() caller
// - Discovery is kept running between idle cycles (only stopped before connecting)
//
// This approach minimizes the start/stop cycling that triggers the well-known
// BlueZ bug where the Discovering property desyncs from the actual controller
// state (bluez/bluez#807, bluez/bluer#47).

let persistentConn: { bluetooth: NodeBle.Bluetooth; destroy: () => void } | null = null;
let persistentAdapter: Adapter | null = null;

function getConnection(): { bluetooth: NodeBle.Bluetooth; destroy: () => void } {
  if (!persistentConn) {
    persistentConn = NodeBle.createBluetooth();
    bleLog.debug('D-Bus connection established');
  }
  return persistentConn;
}

async function getAdapter(bleAdapter?: string): Promise<Adapter> {
  const conn = getConnection();
  if (!persistentAdapter) {
    if (bleAdapter) {
      bleLog.debug(`Using adapter: ${bleAdapter}`);
      persistentAdapter = await conn.bluetooth.getAdapter(bleAdapter);
    } else {
      persistentAdapter = await conn.bluetooth.defaultAdapter();
    }
  }
  return persistentAdapter;
}

function resetConnection(): void {
  persistentAdapter = null;
  if (persistentConn) {
    try {
      persistentConn.destroy();
    } catch {
      /* ignore */
    }
    persistentConn = null;
    bleLog.debug('D-Bus connection reset');
  }
}

/** Returns true if the error indicates a stale or broken D-Bus connection. */
function isStaleConnectionError(err: unknown): boolean {
  const msg = errMsg(err);
  return (
    msg.includes('interface not found') ||
    msg.includes('not found in proxy') ||
    msg.includes('connection closed') ||
    msg.includes('The name is not activatable') ||
    msg.includes('was not provided')
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract the numeric index from an hci adapter name (e.g., 'hci1' -> 1). */
function parseHciIndex(adapterName?: string): number {
  if (!adapterName) return 0;
  const match = adapterName.match(/^hci(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function isDbusConnectionError(err: unknown): boolean {
  const msg = errMsg(err);
  return msg.includes('ENOENT') && msg.includes('bus_socket');
}

function dbusError(): Error {
  return new Error(
    'Cannot connect to D-Bus. Bluetooth is not accessible.\n' +
      'If running in Docker, mount the D-Bus socket:\n' +
      '  -v /var/run/dbus:/var/run/dbus:ro\n' +
      'On the host, ensure bluetoothd is running:\n' +
      '  sudo systemctl start bluetooth',
  );
}

/** Stop discovery and wait for the post-discovery quiesce period. */
async function stopDiscoveryAndQuiesce(btAdapter: Adapter): Promise<void> {
  try {
    bleLog.debug('Stopping discovery before connect...');
    await btAdapter.stopDiscovery();
    bleLog.debug('Discovery stopped');
  } catch {
    bleLog.debug('stopDiscovery failed (may already be stopped)');
  }
  await sleep(POST_DISCOVERY_QUIESCE_MS);
}

// ─── Discovery helpers ────────────────────────────────────────────────────────

/**
 * Try to start BlueZ discovery with escalating recovery strategies.
 * Returns the (possibly refreshed) adapter on success, or false if all attempts failed.
 */
async function startDiscoverySafe(
  btAdapter: Adapter,
  bleAdapter?: string,
): Promise<Adapter | false> {
  // 1. Normal start
  try {
    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started');
    return btAdapter;
  } catch (e) {
    bleLog.debug(`startDiscovery failed: ${errMsg(e)}`);
  }

  // Already running (same client's previous session still active)
  if (await btAdapter.isDiscovering()) {
    bleLog.debug('Discovery already active, continuing');
    return btAdapter;
  }

  // 2. Force-stop via D-Bus (bypass node-ble's isDiscovering guard) + retry
  bleLog.debug('Attempting D-Bus StopDiscovery to reset stale state...');
  try {
    await helperOf(btAdapter).callMethod('StopDiscovery');
    bleLog.debug('D-Bus StopDiscovery succeeded');
  } catch (e) {
    bleLog.debug(`D-Bus StopDiscovery failed: ${errMsg(e)}`);
  }
  await sleep(1000);

  try {
    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started after D-Bus reset');
    return btAdapter;
  } catch (e) {
    bleLog.debug(`startDiscovery after D-Bus reset failed: ${errMsg(e)}`);
  }

  // 3. Power-cycle the adapter + retry
  bleLog.debug('Attempting adapter power cycle...');
  try {
    const helper = helperOf(btAdapter);
    const { Variant } = await getDbusNext();
    await helper.set('Powered', new Variant('b', false));
    bleLog.debug('Adapter powered off');
    await sleep(1000);
    await helper.set('Powered', new Variant('b', true));
    bleLog.debug('Adapter powered on');
    await sleep(1000);

    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started after power cycle');
    return btAdapter;
  } catch (e) {
    bleLog.debug(`Power cycle / startDiscovery failed: ${errMsg(e)}`);
  }

  // 4. Kernel-level adapter reset via btmgmt + fresh D-Bus connection
  bleLog.debug('Attempting kernel-level adapter reset via btmgmt...');
  if (await resetAdapterBtmgmt(parseHciIndex(bleAdapter))) {
    resetConnection();
    try {
      const freshAdapter = await getAdapter(bleAdapter);
      await freshAdapter.startDiscovery();
      bleLog.debug('Discovery started after btmgmt reset');
      return freshAdapter;
    } catch (e) {
      bleLog.debug(`startDiscovery after btmgmt reset failed: ${errMsg(e)}`);
    }
  }

  // 5. RF-level reset via rfkill (more thorough than btmgmt)
  bleLog.debug('Attempting rfkill block/unblock...');
  if (await resetAdapterRfkill()) {
    resetConnection();
    try {
      const freshAdapter = await getAdapter(bleAdapter);
      await freshAdapter.startDiscovery();
      bleLog.debug('Discovery started after rfkill reset');
      return freshAdapter;
    } catch (e) {
      bleLog.debug(`startDiscovery after rfkill reset failed: ${errMsg(e)}`);
    }
  }

  // 6. Restart bluetoothd service (clears all D-Bus session state)
  bleLog.debug('Attempting bluetoothd service restart...');
  if (await restartBluetoothd()) {
    resetConnection();
    try {
      const freshAdapter = await getAdapter(bleAdapter);
      await freshAdapter.startDiscovery();
      bleLog.debug('Discovery started after bluetoothd restart');
      return freshAdapter;
    } catch (e) {
      bleLog.debug(`startDiscovery after bluetoothd restart failed: ${errMsg(e)}`);
    }
  }

  // All strategies failed
  bleLog.warn(
    'Could not start active discovery. ' +
      'Proceeding with passive scanning (device may take longer to appear).',
  );
  return false;
}

/**
 * Tracks whether a BlueZ peer is still actively advertising.
 *
 * Two signals decide freshness:
 *  - the current `RSSI` value from `org.bluez.Device1` (Readonly+Optional int16
 *    per the BlueZ docs, verified via context7). Missing or the sentinel 127
 *    ("unavailable" per mgmt-protocol Device Found) means the peer has gone
 *    dark.
 *  - the time since the last `RSSI` `PropertiesChanged` signal. BlueZ
 *    refreshes this on every received advertisement, so absence of an update
 *    within `RSSI_FRESHNESS_MS` means no new packets have arrived even though
 *    the cached value may still be present.
 *
 * Either failing signal points at the dying-peer scenario @fromport
 * reproduced for #143 / #140, where `device.connect()` would stall inside
 * GATT discovery against a peer whose link layer is shutting down.
 */
interface PeerFreshnessTracker {
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
    // Subscription unavailable: fall back to prop-only freshness check.
  }
  return {
    isFresh: async () => {
      try {
        const rssi: unknown = await helper.prop('RSSI');
        if (rssi === undefined || rssi === null) return false;
        if (typeof rssi === 'number' && rssi === RSSI_UNAVAILABLE) return false;
        if (Date.now() - lastRssiUpdateTs > RSSI_FRESHNESS_MS) return false;
        return true;
      } catch {
        // Property absent (BlueZ dropped it) or D-Bus error: treat as stale.
        return false;
      }
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

/** Remove a device from BlueZ D-Bus cache to force a fresh proxy on re-discovery. */
async function removeDevice(btAdapter: Adapter, mac: string): Promise<void> {
  try {
    const devSerialized = `dev_${formatMac(mac).replace(/:/g, '_')}`;
    const adapterHelper = helperOf(btAdapter);
    await adapterHelper.callMethod('RemoveDevice', `${adapterHelper.object}/${devSerialized}`);
    bleLog.debug('Removed device from BlueZ cache');
  } catch {
    // Device wasn't in cache
  }
}

interface ConnectRecoveryContext {
  btAdapter: Adapter;
  mac: string;
  initialDevice: Device;
  maxRetries: number;
  bleAdapter?: string;
}

/**
 * Connect to a BLE device with recovery for BlueZ-specific failures.
 * On each failed attempt: disconnect -> RemoveDevice -> re-discover -> quiesce -> retry.
 * Returns the (possibly refreshed) Device reference.
 */
async function connectWithRecovery(ctx: ConnectRecoveryContext): Promise<Device> {
  let { btAdapter } = ctx;
  const { mac, maxRetries, bleAdapter } = ctx;
  const formattedMac = formatMac(mac);
  let device = ctx.initialDevice;
  // RSSI freshness re-discovery is a one-shot defense per call: if the peer
  // already looks dark, we re-discover once. Repeating it on every retry just
  // burns the budget on a peer that never came back; let the outer loop pick
  // the next cooldown instead.
  let rssiRediscoverUsed = false;
  // Long-lived PropertiesChanged subscription on the current device proxy so
  // every received advertisement updates the freshness clock. The tracker is
  // rebound when the catch branch swaps the device reference.
  let tracker = startPeerFreshnessTracker(device);

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Skip the dying-peer connect attempt: a missing or 127-sentinel RSSI
        // OR no PropertiesChanged for RSSI within RSSI_FRESHNESS_MS means
        // BlueZ has not heard a fresh advertisement, and connect will stall
        // inside GATT discovery (#143). Force one re-discovery to either
        // refresh the cached props or fail fast.
        if (!(await tracker.isFresh())) {
          if (rssiRediscoverUsed) {
            throw new Error(`Peer ${formattedMac} not advertising (RSSI stale after re-discovery)`);
          }
          rssiRediscoverUsed = true;
          bleLog.warn(`Peer ${formattedMac} RSSI stale, re-discovering before connect...`);
          try {
            tracker.stop();
            const result = await startDiscoverySafe(btAdapter, bleAdapter);
            if (result) btAdapter = result;
            device = await withTimeout(
              btAdapter.waitDevice(formattedMac),
              DISCOVERY_TIMEOUT_MS,
              `Device ${formattedMac} not found during RSSI re-discovery`,
            );
            tracker = startPeerFreshnessTracker(device);
            await stopDiscoveryAndQuiesce(btAdapter);
            if (!(await tracker.isFresh())) {
              throw new Error(`Peer ${formattedMac} still not advertising after re-discovery`);
            }
          } catch (rssiErr: unknown) {
            throw new Error(`Skipped connect to dying peer ${formattedMac}: ${errMsg(rssiErr)}`);
          }
        }

        const t0 = Date.now();
        bleLog.debug(`Connect attempt ${attempt + 1}/${maxRetries + 1}...`);
        await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, 'Connection timed out');
        bleLog.debug(`Connected (took ${Date.now() - t0}ms)`);
        return device;
      } catch (err: unknown) {
        const msg = errMsg(err);
        if (attempt >= maxRetries) {
          throw new Error(`Connection failed after ${maxRetries + 1} attempts: ${msg}`);
        }

        const delay = 1000 + attempt * 500;
        bleLog.warn(
          `Connect error: ${msg}. Retrying (${attempt + 1}/${maxRetries}) in ${delay}ms...`,
        );

        // 1. Disconnect (best-effort)
        try {
          bleLog.debug('Disconnecting before retry...');
          await device.disconnect();
          bleLog.debug('Disconnect OK');
        } catch {
          bleLog.debug('Disconnect failed (ignored)');
        }

        // 2. Purge stale D-Bus proxy
        await removeDevice(btAdapter, mac);

        // 3. Progressive delay
        await sleep(delay);

        // 4. Re-discover and acquire fresh device reference + rebind tracker
        tracker.stop();
        try {
          const result = await startDiscoverySafe(btAdapter, bleAdapter);
          if (result) btAdapter = result;
          device = await withTimeout(
            btAdapter.waitDevice(formattedMac),
            DISCOVERY_TIMEOUT_MS,
            `Device ${formattedMac} not found during retry`,
          );

          try {
            await btAdapter.stopDiscovery();
          } catch {
            bleLog.debug('stopDiscovery failed during retry (ignored)');
          }
          await sleep(POST_DISCOVERY_QUIESCE_MS);
        } catch (retryErr: unknown) {
          bleLog.debug(`Re-discovery during retry failed: ${errMsg(retryErr)}`);
          // Fallback: try to get device directly without re-discovery
          try {
            device = await btAdapter.getDevice(formattedMac);
          } catch {
            throw new Error(
              `Connection failed and device re-acquisition failed: ${errMsg(retryErr)}`,
            );
          }
        }
        tracker = startPeerFreshnessTracker(device);
      }
    }

    throw new Error('Connection failed');
  } finally {
    tracker.stop();
  }
}

async function autoDiscover(
  btAdapter: Adapter,
  adapters: ScaleAdapter[],
  abortSignal?: AbortSignal,
): Promise<{ device: Device; adapter: ScaleAdapter; mac: string }> {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  const checked = new Set<string>();
  let heartbeat = 0;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    const addresses: string[] = await btAdapter.devices();

    for (const addr of addresses) {
      if (checked.has(addr)) continue;
      checked.add(addr);

      try {
        const dev = await btAdapter.getDevice(addr);
        const name = await dev.getName().catch(() => '');
        if (!name) continue;

        bleLog.debug(`Discovered: ${name} [${addr}]`);

        // Try matching with name only (serviceUuids not available pre-connect on D-Bus).
        // Adapters that require serviceUuids will fail to match here and need SCALE_MAC.
        const info: BleDeviceInfo = { localName: name, serviceUuids: [] };
        const matched = adapters.find((a) => a.matches(info));
        if (matched) {
          bleLog.info(`Auto-discovered: ${matched.name} (${name} [${addr}])`);
          return { device: dev, adapter: matched, mac: addr };
        }
      } catch {
        /* device may have gone away */
      }
    }

    heartbeat++;
    if (heartbeat % 5 === 0) {
      bleLog.info('Still scanning...');
    }
    await sleep(DISCOVERY_POLL_MS);
  }

  throw new Error(`No recognized scale found within ${DISCOVERY_TIMEOUT_MS / 1000}s`);
}

// ─── BLE abstraction wrappers ─────────────────────────────────────────────────

function wrapChar(char: GattCharacteristic): BleChar {
  return {
    subscribe: async (onData) => {
      char.on('valuechanged', onData);
      await char.startNotifications();
      return () => {
        char.removeListener('valuechanged', onData);
      };
    },
    write: async (data, withResponse) => {
      if (withResponse) {
        await char.writeValueWithResponse(data);
      } else {
        await char.writeValueWithoutResponse(data);
      }
    },
    read: () => char.readValue(),
  };
}

function wrapDevice(device: Device): BleDevice {
  return {
    onDisconnect: (callback) => {
      device.on('disconnect', callback);
    },
  };
}

// ─── Build charMap from GATT server ───────────────────────────────────────────

async function buildCharMap(gatt: NodeBle.GattServer): Promise<Map<string, BleChar>> {
  const charMap = new Map<string, BleChar>();
  const serviceUuids = await gatt.services();

  for (const svcUuid of serviceUuids) {
    try {
      const service = await gatt.getPrimaryService(svcUuid);
      const charUuids = await service.characteristics();
      bleLog.debug(`  Service ${svcUuid}: chars=[${charUuids.join(', ')}]`);

      for (const charUuid of charUuids) {
        const char = await service.getCharacteristic(charUuid);
        try {
          const flags = await char.getFlags();
          bleLog.debug(`    Char ${charUuid}: flags=[${flags.join(', ')}]`);
        } catch {
          // Flags not available on all BlueZ versions
        }
        charMap.set(normalizeUuid(charUuid), wrapChar(char));
      }
    } catch (e: unknown) {
      bleLog.debug(`  Service ${svcUuid}: error=${errMsg(e)}`);
    }
  }

  return charMap;
}

// ─── Broadcast / passive scan (service-data advertisement decoding) ───────────

/** Extract a Buffer from a D-Bus value that may be a Variant wrapper, Buffer, Uint8Array, or number[]. */
function extractDbusBytes(val: unknown): Buffer | null {
  if (!val) return null;
  // dbus-next wraps dict values in Variant objects, so unwrap .value if present.
  const inner: unknown =
    typeof val === 'object' && val !== null && 'value' in val
      ? (val as { value: unknown }).value
      : val;
  if (Buffer.isBuffer(inner)) return inner;
  if (inner instanceof Uint8Array) return Buffer.from(inner);
  if (Array.isArray(inner) && inner.every((b) => typeof b === 'number'))
    return Buffer.from(inner as number[]);
  // dbus-next serialises Buffer values to JSON as {type:"Buffer",data:[...]}
  // (standard Node.js Buffer.toJSON() format)
  if (typeof inner === 'object' && inner !== null && 'type' in inner && 'data' in inner) {
    const obj = inner as { type: unknown; data: unknown };
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return Buffer.from(obj.data as number[]);
    }
  }
  return null;
}

/**
 * Read weight + impedance from BLE service-data advertisements without connecting.
 *
 * Sets DuplicateData=true in the BlueZ discovery filter so every advertisement
 * triggers a PropertiesChanged signal, then subscribes to that signal on the
 * Device1 D-Bus object. Falls back to polling the ServiceData property every
 * 500 ms if signal subscription fails.
 */
async function broadcastScanNodeBle(
  adapter: ScaleAdapter,
  btAdapter: Adapter,
  device: Device,
  mac: string,
  opts: { abortSignal?: AbortSignal; onLiveData?: (r: ScaleReading) => void },
): Promise<RawReading> {
  const { abortSignal, onLiveData } = opts;

  // Tell BlueZ to report duplicate advertisements so ServiceData is refreshed
  // on every packet from the scale, not just on first discovery.
  try {
    const { Variant } = await getDbusNext();
    const adapterHelper = helperOf(btAdapter);
    await adapterHelper.callMethod('SetDiscoveryFilter', {
      Transport: new Variant('s', 'le'),
      DuplicateData: new Variant('b', true),
    });
    bleLog.debug('Discovery filter: DuplicateData=true');
  } catch (err: unknown) {
    bleLog.debug(`SetDiscoveryFilter: ${errMsg(err)} (non-fatal, will poll)`);
  }

  bleLog.info(
    'Adapter prefers passive mode. Listening for broadcast weight data. Step on the scale.',
  );

  return new Promise<RawReading>((resolve, reject) => {
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let bestWeightOnly: RawReading | null = null;

    const finish = (result: RawReading) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    let onPropsChanged: PropsChangedHandler | null = null;

    const cleanup = () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      abortSignal?.removeEventListener('abort', onAbort);
      if (onPropsChanged) {
        try {
          helperOf(device).removeListener('PropertiesChanged', onPropsChanged);
        } catch {
          // Helper torn down or listener already removed.
        }
        onPropsChanged = null;
      }
    };

    const onAbort = () => fail(abortSignal!.reason ?? new DOMException('Aborted', 'AbortError'));
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    /** Try to parse ServiceData entries and resolve if a complete reading is found. */
    const tryServiceData = (sd: unknown): boolean => {
      if (!sd || typeof sd !== 'object') return false;

      const entries: Iterable<[unknown, unknown]> =
        sd instanceof Map
          ? (sd as Map<unknown, unknown>).entries()
          : Object.entries(sd as Record<string, unknown>);

      for (const [uuid, val] of entries) {
        const buf = extractDbusBytes(val);
        if (!buf) continue;

        const reading = adapter.parseServiceData!(String(uuid), buf);
        if (!reading) continue;

        if (onLiveData) onLiveData(reading);

        if (adapter.isComplete(reading)) {
          bleLog.info(`Broadcast reading: ${reading.weight.toFixed(2)} kg`);
          finish({ reading, adapter });
          return true;
        }

        bleLog.debug(
          `${adapter.name} broadcast frame not yet complete ` +
            `(weight=${reading.weight.toFixed(2)} kg, impedance=${reading.impedance})`,
        );
        bestWeightOnly = { reading, adapter };
        if (!graceTimer) {
          graceTimer = setTimeout(() => {
            graceTimer = null;
            bleLog.info(
              `Broadcast reading (weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s): ` +
                `${bestWeightOnly!.reading.weight.toFixed(2)} kg`,
            );
            finish(bestWeightOnly!);
          }, IMPEDANCE_GRACE_MS);
        }
      }

      return false;
    };

    // Subscribe to PropertiesChanged via node-ble's BusHelper, which re-emits
    // the signal directly (Device is constructed with usePropsEvents: true).
    // This fires on every advertisement when DuplicateData=true is set above.
    try {
      const deviceHelper = helperOf(device);
      onPropsChanged = (changedProps) => {
        if (done) return;
        if (changedProps.ServiceData) tryServiceData(changedProps.ServiceData);
      };
      deviceHelper.on('PropertiesChanged', onPropsChanged);
      bleLog.debug('Subscribed to Device1 PropertiesChanged for ServiceData');
    } catch (err: unknown) {
      bleLog.debug(`PropertiesChanged subscription failed: ${errMsg(err)} (poll fallback active)`);
      onPropsChanged = null;
    }

    // Poll ServiceData every 500 ms as a fallback (and for first-read before
    // the PropertiesChanged subscription is established).
    const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
    (async () => {
      while (!done && Date.now() < deadline) {
        if (abortSignal?.aborted) break;
        try {
          const sd: unknown = await helperOf(device).prop('ServiceData');
          tryServiceData(sd);
        } catch (err: unknown) {
          bleLog.debug(`ServiceData poll error: ${errMsg(err)}`);
        }
        await sleep(500);
      }
      if (!done) {
        fail(
          new Error(
            `No stable broadcast reading within ${DISCOVERY_TIMEOUT_MS / 1000}s. ` +
              `Step on the scale and make sure it is awake.`,
          ),
        );
      }
    })();
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Scan for a BLE scale, read weight + impedance, and compute body composition.
 * Uses node-ble (BlueZ D-Bus). Requires bluetoothd running on Linux.
 *
 * The D-Bus connection is kept alive across calls (singleton) to prevent
 * orphaned BlueZ discovery sessions in continuous mode. If the connection
 * becomes stale (e.g. bluetoothd restart), it is automatically reset.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const { targetMac, adapters, profile, weightUnit, onLiveData, abortSignal, bleAdapter } = opts;

  let device: Device | null = null;
  let btAdapter: Adapter;
  let gattAttempted = false;
  let gattSucceeded = false;
  let deviceMac: string = targetMac ?? '';

  try {
    try {
      btAdapter = await getAdapter(bleAdapter);
    } catch (err) {
      if (isDbusConnectionError(err)) throw dbusError();
      // Stale connection (e.g. bluetoothd restarted): reset and retry once
      if (isStaleConnectionError(err)) {
        bleLog.debug('D-Bus connection stale, resetting...');
        resetConnection();
        btAdapter = await getAdapter(bleAdapter);
      } else if (bleAdapter) {
        throw new Error(
          `Bluetooth adapter '${bleAdapter}' not found. ` +
            'Check that the adapter exists (hciconfig or btmgmt info).',
        );
      } else {
        throw err;
      }
    }

    if (!(await btAdapter.isPowered())) {
      throw new Error(
        'Bluetooth adapter is not powered on. ' +
          'Ensure bluetoothd is running: sudo systemctl start bluetooth',
      );
    }

    // In continuous mode, BlueZ caches the device from a previous cycle.
    // Removing it forces a fresh discovery + proxy creation.
    if (targetMac) {
      await removeDevice(btAdapter, targetMac);
    }

    const discoveryResult = await startDiscoverySafe(btAdapter, bleAdapter);
    if (discoveryResult) btAdapter = discoveryResult;

    let matchedAdapter: ScaleAdapter;

    if (targetMac) {
      const mac = formatMac(targetMac);
      bleLog.info('Scanning for device...');

      if (abortSignal?.aborted) {
        throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
      }

      const waitPromise = withTimeout(
        btAdapter.waitDevice(mac),
        DISCOVERY_TIMEOUT_MS,
        `Device ${mac} not found within ${DISCOVERY_TIMEOUT_MS / 1000}s`,
      );

      if (abortSignal) {
        // Wrap in a promise that cleans up the abort listener in all paths
        // to prevent MaxListenersExceededWarning in continuous mode
        const sig = abortSignal;
        device = await new Promise<Device>((resolve, reject) => {
          const onAbort = () => {
            reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
          };
          sig.addEventListener('abort', onAbort, { once: true });
          waitPromise.then(
            (d) => {
              sig.removeEventListener('abort', onAbort);
              resolve(d);
            },
            (err) => {
              sig.removeEventListener('abort', onAbort);
              reject(err);
            },
          );
        });
      } else {
        device = await waitPromise;
      }

      const name = await device.getName().catch(() => '');
      bleLog.debug(`Found device: ${name} [${mac}]`);

      // Pre-connection adapter match (by name only). Needed for preferPassive adapters
      // so we can skip the GATT connect entirely and go straight to broadcast scanning.
      const preInfo: BleDeviceInfo = { localName: name, serviceUuids: [] };
      const preMatchedAdapter = adapters.find((a) => a.matches(preInfo));

      if (preMatchedAdapter?.preferPassive && preMatchedAdapter.parseServiceData) {
        matchedAdapter = preMatchedAdapter;
        bleLog.info(`Matched adapter: ${matchedAdapter.name}`);
        return await broadcastScanNodeBle(matchedAdapter, btAdapter, device, mac, {
          abortSignal,
          onLiveData,
        });
      }

      // Stop discovery before connecting. BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      await stopDiscoveryAndQuiesce(btAdapter);

      gattAttempted = true;
      device = await connectWithRecovery({
        btAdapter,
        mac: targetMac,
        initialDevice: device,
        maxRetries: MAX_CONNECT_RETRIES,
        bleAdapter,
      });
      bleLog.info('Connected. Discovering services...');

      // Match adapter using device name + GATT service UUIDs (post-connect)
      const gatt = await device.gatt();
      const serviceUuids = await gatt.services();
      bleLog.debug(`Services: [${serviceUuids.join(', ')}]`);

      const info: BleDeviceInfo = {
        localName: name,
        serviceUuids: serviceUuids.map(normalizeUuid),
      };
      const found = adapters.find((a) => a.matches(info));
      if (!found) {
        throw new Error(
          `Device found (${name}) but no adapter recognized it. ` +
            `Services: [${serviceUuids.join(', ')}]. ` +
            `Adapters: ${adapters.map((a) => a.name).join(', ')}`,
        );
      }
      matchedAdapter = found;
      bleLog.info(`Matched adapter: ${matchedAdapter.name}`);
    } else {
      // Auto-discovery: poll discovered devices, match by name, connect, verify
      const result = await autoDiscover(btAdapter, adapters, abortSignal);
      device = result.device;
      matchedAdapter = result.adapter;
      deviceMac = result.mac;

      // Passive-mode adapters: read from service-data advertisements without connecting.
      if (matchedAdapter.preferPassive && matchedAdapter.parseServiceData) {
        bleLog.info(`Matched adapter: ${matchedAdapter.name}`);
        return await broadcastScanNodeBle(matchedAdapter, btAdapter, device, result.mac, {
          abortSignal,
          onLiveData,
        });
      }

      // Stop discovery before connecting. BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      await stopDiscoveryAndQuiesce(btAdapter);

      gattAttempted = true;
      device = await connectWithRecovery({
        btAdapter,
        mac: result.mac,
        initialDevice: device,
        maxRetries: MAX_CONNECT_RETRIES,
        bleAdapter,
      });
      bleLog.info('Connected. Discovering services...');
    }

    // Setup GATT characteristics and wait for a complete reading.
    // BlueZ has a known race ([bluez/bluez#1489]) where ServicesResolved=true
    // fires before all characteristic interfaces are exported over D-Bus, so
    // the first enumeration can be missing chars the scale actually exposes.
    // Retry the enumeration a few times with a short backoff when we detect
    // that the adapter's required chars are not yet present.
    const gatt = await withTimeout(
      device.gatt(),
      GATT_DISCOVERY_TIMEOUT_MS,
      'GATT server acquisition timed out',
    );
    let charMap = await withTimeout(
      buildCharMap(gatt),
      GATT_DISCOVERY_TIMEOUT_MS,
      'GATT service discovery timed out',
    );
    for (let attempt = 1; attempt <= CHAR_DISCOVERY_MAX_RETRIES; attempt++) {
      const missing = findMissingCharacteristics(charMap, matchedAdapter);
      if (missing.length === 0) break;
      if (attempt === CHAR_DISCOVERY_MAX_RETRIES) {
        bleLog.warn(
          `GATT enumeration incomplete after ${attempt} attempt(s). ` +
            `Missing: [${missing.join(', ')}]. Discovered: [${[...charMap.keys()].join(', ')}]`,
        );
        break;
      }
      bleLog.debug(
        `GATT enumeration missing [${missing.join(', ')}], retry ${attempt}/${CHAR_DISCOVERY_MAX_RETRIES - 1} in ${CHAR_DISCOVERY_RETRY_DELAY_MS}ms...`,
      );
      await new Promise<void>((r) => setTimeout(r, CHAR_DISCOVERY_RETRY_DELAY_MS));
      charMap = await withTimeout(
        buildCharMap(gatt),
        GATT_DISCOVERY_TIMEOUT_MS,
        'GATT service discovery timed out',
      );
    }
    const raw = await withTimeout(
      waitForRawReading(
        charMap,
        wrapDevice(device),
        matchedAdapter,
        profile,
        deviceMac.replace(/[:-]/g, '').toUpperCase(),
        weightUnit,
        onLiveData,
      ),
      RAW_READING_TIMEOUT_MS,
      'Timed out waiting for a complete scale reading',
    );
    gattSucceeded = true;

    try {
      await device.disconnect();
    } catch {
      /* ignore */
    }
    return raw;
  } finally {
    // Best-effort disconnect if we got partway through a connection
    if (device) {
      try {
        await device.disconnect();
      } catch {
        /* already disconnected or never connected */
      }
    }

    if (gattAttempted) {
      // Cleanup after a FAILED read (scale disconnected before completion,
      // GATT discovery timed out, etc.). BlueZ keeps the device proxy plus
      // any orphaned notification subscriptions cached, and the controller
      // level Discovering flag can desync from our client state
      // (bluez/bluez#807). Before the shared btmgmt power-cycle runs, mirror
      // what bleak-retry-connector does on Linux: force StopDiscovery via
      // D-Bus and RemoveDevice the scale, so the next scan cycle starts from
      // a clean BlueZ state instead of inheriting the zombie subscription.
      if (!gattSucceeded) {
        try {
          await helperOf(btAdapter!).callMethod('StopDiscovery');
          bleLog.debug('Force StopDiscovery after failed GATT');
        } catch (e) {
          bleLog.debug(`Force StopDiscovery failed: ${errMsg(e)}`);
        }
        if (deviceMac) {
          await removeDevice(btAdapter!, deviceMac);
        }
      }

      // After a GATT connection (successful or failed), reset the D-Bus
      // connection AND power-cycle the HCI controller. BlueZ on Broadcom
      // adapters (RPi) enters a "zombie discovery" state after a few
      // connect/disconnect cycles: Discovering=true, fresh startDiscovery()
      // succeeds, but the controller is no longer running LE scan. D-Bus
      // reset alone is insufficient because bluetoothd's controller-state
      // tracking survives across client reconnects. btmgmt power off/on
      // clears the zombie at the kernel level. See bluez/bluez#807,
      // bluez/bluer#47.
      await sleep(500);
      resetConnection();
      bleLog.debug('D-Bus connection reset after GATT operation');
      if (await resetAdapterBtmgmt(parseHciIndex(bleAdapter))) {
        bleLog.debug('Preemptive btmgmt reset after GATT');
      }
    }
    // For idle cycles (no GATT connection), discovery is kept running.
    // Stopping and restarting discovery on every idle cycle triggers a BlueZ
    // bug where the Discovering property desyncs from the controller state.
  }
}

/** Scan, read, and compute body composition. Wrapper around scanAndReadRaw(). */
export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { reading, adapter } = await scanAndReadRaw(opts);
  return adapter.computeMetrics(reading, opts.profile);
}

/**
 * Scan for nearby BLE devices and identify recognized scales.
 * Uses node-ble (BlueZ D-Bus). Linux only.
 *
 * Uses its own short-lived D-Bus connection (not the persistent singleton)
 * because scan operations are one-shot and should not interfere with
 * continuous mode scanning.
 */
export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs = 15_000,
  bleAdapter?: string,
): Promise<ScanResult[]> {
  let bluetooth: NodeBle.Bluetooth;
  let destroy: () => void;
  try {
    ({ bluetooth, destroy } = NodeBle.createBluetooth());
  } catch (err) {
    if (isDbusConnectionError(err)) throw dbusError();
    throw err;
  }

  let btAdapter: Adapter | null = null;

  try {
    try {
      btAdapter = bleAdapter
        ? await bluetooth.getAdapter(bleAdapter)
        : await bluetooth.defaultAdapter();
    } catch (err) {
      if (isDbusConnectionError(err)) throw dbusError();
      if (bleAdapter) {
        throw new Error(
          `Bluetooth adapter '${bleAdapter}' not found. ` +
            'Check that the adapter exists (hciconfig or btmgmt info).',
        );
      }
      throw err;
    }

    if (!(await btAdapter.isPowered())) {
      throw new Error(
        'Bluetooth adapter is not powered on. ' +
          'Ensure bluetoothd is running: sudo systemctl start bluetooth',
      );
    }

    const discoveryResult = await startDiscoverySafe(btAdapter, bleAdapter);
    if (discoveryResult) btAdapter = discoveryResult;

    const seen = new Set<string>();
    const results: ScanResult[] = [];
    const deadline = Date.now() + durationMs;

    while (Date.now() < deadline) {
      const addresses = await btAdapter.devices();

      for (const addr of addresses) {
        if (seen.has(addr)) continue;
        seen.add(addr);

        try {
          const dev = await btAdapter.getDevice(addr);
          const name = await dev.getName().catch(() => '(unknown)');
          const info: BleDeviceInfo = { localName: name, serviceUuids: [] };
          const matched = adapters.find((a) => a.matches(info));

          results.push({
            address: addr,
            name,
            matchedAdapter: matched?.name,
          });
        } catch {
          /* device may have gone away */
        }
      }

      await sleep(DISCOVERY_POLL_MS);
    }

    return results;
  } finally {
    if (btAdapter) {
      try {
        await btAdapter.stopDiscovery();
      } catch {
        /* ignore */
      }
    }
    await sleep(POST_DISCOVERY_QUIESCE_MS);
    destroy();
  }
}

/** Test-only exports of private helpers (#143 / #163). */
export const _internals = { connectWithRecovery, broadcastScanNodeBle };
