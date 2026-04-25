import NodeBle from 'node-ble';
import type { ScaleAdapter, ScaleReading, BleDeviceInfo, BodyComposition } from '../interfaces/scale-adapter.js';
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
  CONNECT_TIMEOUT_MS,
  MAX_CONNECT_RETRIES,
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_POLL_MS,
  POST_DISCOVERY_QUIESCE_MS,
  GATT_DISCOVERY_TIMEOUT_MS,
  CHAR_DISCOVERY_MAX_RETRIES,
  CHAR_DISCOVERY_RETRY_DELAY_MS,
} from './types.js';

type Device = NodeBle.Device;
type Adapter = NodeBle.Adapter;
type GattCharacteristic = NodeBle.GattCharacteristic;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the Bluetooth adapter. If bleAdapter is specified (e.g., 'hci1'),
 * use bluetooth.getAdapter(). Otherwise fall back to defaultAdapter().
 */
async function getAdapter(bluetooth: NodeBle.Bluetooth, bleAdapter?: string): Promise<Adapter> {
  if (bleAdapter) {
    bleLog.debug(`Using adapter: ${bleAdapter}`);
    return bluetooth.getAdapter(bleAdapter);
  }
  return bluetooth.defaultAdapter();
}

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
    'Cannot connect to D-Bus — Bluetooth is not accessible.\n' +
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
 * When `bluetooth` is provided, Tier 4 (btmgmt) can re-acquire a fresh D-Bus proxy
 * after the kernel-level reset invalidates the current one.
 */
async function startDiscoverySafe(
  btAdapter: Adapter,
  bluetooth?: NodeBle.Bluetooth,
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

  // Already running (another D-Bus client owns the session)
  if (await btAdapter.isDiscovering()) {
    bleLog.debug('Discovery already active (owned by another client), continuing');
    return btAdapter;
  }

  // 2. Force-stop via D-Bus (bypass node-ble's isDiscovering guard) + retry
  bleLog.debug('Attempting D-Bus StopDiscovery to reset stale state...');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (btAdapter as any).helper.callMethod('StopDiscovery');
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const helper = (btAdapter as any).helper;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Variant } = (await import('dbus-next')) as any;
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

  // 4. Kernel-level adapter reset via btmgmt (bypasses D-Bus session ownership)
  bleLog.debug('Attempting kernel-level adapter reset via btmgmt...');
  if (await resetAdapterBtmgmt(parseHciIndex(bleAdapter))) {
    // btmgmt power-cycles the adapter at kernel level, which causes BlueZ to
    // remove and re-create the D-Bus object at /org/bluez/hciN. The existing
    // proxy is now stale — re-acquire a fresh one if possible.
    if (bluetooth) {
      try {
        const freshAdapter = await getAdapter(bluetooth, bleAdapter);
        await freshAdapter.startDiscovery();
        bleLog.debug('Discovery started after btmgmt reset (fresh adapter)');
        return freshAdapter;
      } catch (e) {
        bleLog.debug(`startDiscovery after btmgmt reset failed: ${errMsg(e)}`);
      }
    } else {
      try {
        await btAdapter.startDiscovery();
        bleLog.debug('Discovery started after btmgmt reset');
        return btAdapter;
      } catch (e) {
        bleLog.debug(`startDiscovery after btmgmt reset failed: ${errMsg(e)}`);
      }
    }
  }

  // All strategies failed — warn but don't throw
  bleLog.warn(
    'Could not start active discovery. ' +
      'Proceeding with passive scanning (device may take longer to appear).',
  );
  return false;
}

/** Remove a device from BlueZ D-Bus cache to force a fresh proxy on re-discovery. */
async function removeDevice(btAdapter: Adapter, mac: string): Promise<void> {
  try {
    const devSerialized = `dev_${formatMac(mac).replace(/:/g, '_')}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterHelper = (btAdapter as any).helper;
    await adapterHelper.callMethod('RemoveDevice', `${adapterHelper.object}/${devSerialized}`);
    bleLog.debug('Removed device from BlueZ cache');
  } catch {
    // Device wasn't in cache — expected on first call
  }
}

interface ConnectRecoveryContext {
  btAdapter: Adapter;
  mac: string;
  initialDevice: Device;
  maxRetries: number;
  bluetooth?: NodeBle.Bluetooth;
  bleAdapter?: string;
}

/**
 * Connect to a BLE device with recovery for BlueZ-specific failures.
 * On each failed attempt: disconnect → RemoveDevice → re-discover → quiesce → retry.
 * Returns the (possibly refreshed) Device reference.
 */
async function connectWithRecovery(ctx: ConnectRecoveryContext): Promise<Device> {
  let { btAdapter } = ctx;
  const { mac, maxRetries, bluetooth, bleAdapter } = ctx;
  const formattedMac = formatMac(mac);
  let device = ctx.initialDevice;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
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

      // 4. Re-discover and acquire fresh device reference
      try {
        const result = await startDiscoverySafe(btAdapter, bluetooth, bleAdapter);
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
    }
  }

  throw new Error('Connection failed');
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
  // dbus-next wraps dict values in Variant objects — unwrap .value if present
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = (val as any)?.value ?? val;
  if (Buffer.isBuffer(inner)) return inner;
  if (inner instanceof Uint8Array) return Buffer.from(inner);
  if (Array.isArray(inner) && (inner as unknown[]).every((b) => typeof b === 'number'))
    return Buffer.from(inner as number[]);
  // dbus-next serialises Buffer values to JSON as {type:"Buffer",data:[...]}
  // (standard Node.js Buffer.toJSON() format)
  if (
    typeof inner === 'object' &&
    inner !== null &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (inner as any).type === 'Buffer' &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Array.isArray((inner as any).data)
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Buffer.from((inner as any).data as number[]);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Variant } = (await import('dbus-next')) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterHelper = (btAdapter as any).helper;
    await adapterHelper.callMethod('SetDiscoveryFilter', {
      Transport: new Variant('s', 'le'),
      DuplicateData: new Variant('b', true),
    });
    bleLog.debug('Discovery filter: DuplicateData=true');
  } catch (err: unknown) {
    bleLog.debug(`SetDiscoveryFilter: ${errMsg(err)} (non-fatal, will poll)`);
  }

  bleLog.info('Adapter prefers passive mode. Listening for broadcast weight data. Step on the scale.');

  return new Promise<RawReading>((resolve, reject) => {
    let done = false;

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let propsIface: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let onPropsChanged: ((...args: any[]) => void) | null = null;

    const cleanup = () => {
      abortSignal?.removeEventListener('abort', onAbort);
      if (propsIface && onPropsChanged) {
        try { propsIface.removeListener('PropertiesChanged', onPropsChanged); } catch {}
      }
    };

    const onAbort = () =>
      fail(abortSignal!.reason ?? new DOMException('Aborted', 'AbortError'));
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    // If the scale broadcasts stable weight frames but never adds impedance
    // (some firmware variants), resolve after this grace period.
    const IMPEDANCE_GRACE_MS = 5000;
    let bestWeightOnly: ScaleReading | null = null;
    let stableAt: number | null = null;

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
          bleLog.info(`Broadcast reading: ${reading.weight.toFixed(2)} kg (with impedance)`);
          finish({ reading, adapter });
          return true;
        }

        // Stable weight-only frame: remember as fallback
        if (reading.weight > 10) {
          if (!stableAt) {
            stableAt = Date.now();
            bleLog.debug(
              `${adapter.name}: stable weight=${reading.weight.toFixed(2)} kg, ` +
                `waiting up to ${IMPEDANCE_GRACE_MS / 1000}s for impedance`,
            );
          }
          bestWeightOnly = reading;
        } else {
          bleLog.debug(
            `${adapter.name} frame: weight=${reading.weight.toFixed(2)} kg, ` +
              `impedance=${reading.impedance} (waiting for complete reading)`,
          );
        }
      }

      // Resolve with weight-only once grace period has elapsed
      if (stableAt && Date.now() - stableAt >= IMPEDANCE_GRACE_MS && bestWeightOnly) {
        bleLog.info(
          `Broadcast reading: ${bestWeightOnly.weight.toFixed(2)} kg (no impedance within ${IMPEDANCE_GRACE_MS / 1000}s)`,
        );
        finish({ reading: bestWeightOnly, adapter });
        return true;
      }

      return false;
    };

    // Subscribe to PropertiesChanged for real-time ServiceData updates.
    // This fires on every advertisement when DuplicateData=true is set above.
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const deviceHelper = (device as any).helper;
        // node-ble's helper exposes the dbus-next bus and the object path
        const bus = deviceHelper.bus ?? deviceHelper._bus;
        const devicePath =
          deviceHelper.object ??
          deviceHelper._obj ??
          // derive path from adapter path + MAC
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          `${(btAdapter as any).helper.object}/dev_${formatMac(mac).replace(/:/g, '_')}`;

        if (!bus) {
          bleLog.debug('D-Bus bus not accessible from helper; relying on poll fallback');
          return;
        }

        const proxyObj = await bus.getProxyObject('org.bluez', devicePath);
        propsIface = proxyObj.getInterface('org.freedesktop.DBus.Properties');

        onPropsChanged = (ifaceName: string, changed: Record<string, unknown>) => {
          if (done || ifaceName !== 'org.bluez.Device1') return;
          if (changed.ServiceData) tryServiceData(changed.ServiceData);
        };

        propsIface.on('PropertiesChanged', onPropsChanged);
        bleLog.debug('Subscribed to Device1 PropertiesChanged for ServiceData');
      } catch (err: unknown) {
        bleLog.debug(`PropertiesChanged subscription failed: ${errMsg(err)} (poll fallback active)`);
      }
    })();

    // Poll ServiceData every 500 ms as a fallback (and for first-read before
    // the PropertiesChanged subscription is established).
    const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
    (async () => {
      while (!done && Date.now() < deadline) {
        if (abortSignal?.aborted) break;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sd: unknown = await (device as any).helper.prop('ServiceData');
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
 * Uses node-ble (BlueZ D-Bus) — requires bluetoothd running on Linux.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const { targetMac, adapters, profile, weightUnit, onLiveData, abortSignal, bleAdapter } = opts;

  let bluetooth: NodeBle.Bluetooth;
  let destroy: () => void;
  try {
    ({ bluetooth, destroy } = NodeBle.createBluetooth());
  } catch (err) {
    if (isDbusConnectionError(err)) throw dbusError();
    throw err;
  }

  let device: Device | null = null;
  let btAdapter: Adapter | null = null;

  try {
    try {
      btAdapter = await getAdapter(bluetooth, bleAdapter);
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

    // In continuous mode, BlueZ caches the device from a previous cycle.
    // The cached D-Bus proxy becomes stale after destroy(), causing
    // "interface not found in proxy object" errors on reconnect.
    // Removing it forces a fresh discovery + proxy creation.
    if (targetMac) {
      await removeDevice(btAdapter, targetMac);
    }

    const discoveryResult = await startDiscoverySafe(btAdapter, bluetooth, bleAdapter);
    if (discoveryResult) btAdapter = discoveryResult;

    let matchedAdapter: ScaleAdapter;
    let deviceMac = targetMac ?? '';

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

      // Stop discovery before connecting — BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      await stopDiscoveryAndQuiesce(btAdapter);

      device = await connectWithRecovery({
        btAdapter,
        mac: targetMac,
        initialDevice: device,
        maxRetries: MAX_CONNECT_RETRIES,
        bluetooth,
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

      // Stop discovery before connecting — BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      await stopDiscoveryAndQuiesce(btAdapter);

      device = await connectWithRecovery({
        btAdapter,
        mac: result.mac,
        initialDevice: device,
        maxRetries: MAX_CONNECT_RETRIES,
        bluetooth,
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
    const gatt = await device.gatt();
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
    const raw = await waitForRawReading(
      charMap,
      wrapDevice(device),
      matchedAdapter,
      profile,
      deviceMac.replace(/[:-]/g, '').toUpperCase(),
      weightUnit,
      onLiveData,
    );

    try {
      await device.disconnect();
    } catch {
      /* ignore */
    }
    return raw;
  } finally {
    // Always stop discovery before destroying the D-Bus connection to prevent
    // orphaned BlueZ discovery sessions that cause "Operation already in progress"
    // on the next scan cycle in continuous mode.
    if (btAdapter) {
      try {
        await btAdapter.stopDiscovery();
      } catch {
        /* may already be stopped */
      }
    }
    destroy();
  }
}

/** Scan, read, and compute body composition. Wrapper around scanAndReadRaw(). */
export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { reading, adapter } = await scanAndReadRaw(opts);
  return adapter.computeMetrics(reading, opts.profile);
}

/**
 * Scan for nearby BLE devices and identify recognized scales.
 * Uses node-ble (BlueZ D-Bus) — Linux only.
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
      btAdapter = await getAdapter(bluetooth, bleAdapter);
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

    const discoveryResult = await startDiscoverySafe(btAdapter, bluetooth, bleAdapter);
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
    destroy();
  }
}
