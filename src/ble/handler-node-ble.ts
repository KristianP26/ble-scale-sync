import NodeBle from 'node-ble';
import type { ScaleAdapter, BleDeviceInfo, BodyComposition } from '../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { BleChar, BleDevice } from './shared.js';
import { waitForReading } from './shared.js';
import {
  bleLog,
  normalizeUuid,
  formatMac,
  sleep,
  errMsg,
  withTimeout,
  CONNECT_TIMEOUT_MS,
  MAX_CONNECT_RETRIES,
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_POLL_MS,
} from './types.js';

type Device = NodeBle.Device;
type Adapter = NodeBle.Adapter;
type GattCharacteristic = NodeBle.GattCharacteristic;

// ─── Discovery helpers ────────────────────────────────────────────────────────

/**
 * Try to start BlueZ discovery with escalating recovery strategies.
 * Returns true if discovery is active, false if all attempts failed.
 */
async function startDiscoverySafe(btAdapter: Adapter): Promise<boolean> {
  // 1. Normal start
  try {
    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started');
    return true;
  } catch (e) {
    bleLog.debug(`startDiscovery failed: ${errMsg(e)}`);
  }

  // Already running (another D-Bus client owns the session)
  if (await btAdapter.isDiscovering()) {
    bleLog.debug('Discovery already active (owned by another client), continuing');
    return true;
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
    return true;
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
    return true;
  } catch (e) {
    bleLog.debug(`Power cycle / startDiscovery failed: ${errMsg(e)}`);
  }

  // All strategies failed — warn but don't throw
  bleLog.warn(
    'Could not start active discovery. ' +
      'Proceeding with passive scanning (device may take longer to appear).',
  );
  return false;
}

async function connectWithRetries(device: Device, maxRetries: number): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const t0 = Date.now();
      bleLog.debug(`Connect attempt ${attempt + 1}/${maxRetries + 1}...`);
      await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, 'Connection timed out');
      bleLog.debug(`Connected (took ${Date.now() - t0}ms)`);
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= maxRetries) {
        throw new Error(`Connection failed after ${maxRetries + 1} attempts: ${msg}`);
      }
      const delay = 1000 + attempt * 500;
      bleLog.warn(
        `Connect error: ${msg}. Retrying (${attempt + 1}/${maxRetries}) in ${delay}ms...`,
      );
      try {
        bleLog.debug('Disconnecting before retry...');
        await device.disconnect();
        bleLog.debug('Disconnect OK');
      } catch {
        bleLog.debug('Disconnect failed (ignored)');
      }
      await sleep(delay);
    }
  }
}

async function autoDiscover(
  btAdapter: Adapter,
  adapters: ScaleAdapter[],
  abortSignal?: AbortSignal,
): Promise<{ device: Device; adapter: ScaleAdapter }> {
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
          return { device: dev, adapter: matched };
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
    },
    write: async (data, withResponse) => {
      if (withResponse) {
        await char.writeValue(data);
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
        charMap.set(normalizeUuid(charUuid), wrapChar(char));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      bleLog.debug(`  Service ${svcUuid}: error=${msg}`);
    }
  }

  return charMap;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Scan for a BLE scale, read weight + impedance, and compute body composition.
 * Uses node-ble (BlueZ D-Bus) — requires bluetoothd running on Linux.
 */
export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { targetMac, adapters, profile, weightUnit, onLiveData, abortSignal } = opts;
  const { bluetooth, destroy } = NodeBle.createBluetooth();
  let device: Device | null = null;

  try {
    const btAdapter = await bluetooth.defaultAdapter();

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
      try {
        const devSerialized = `dev_${formatMac(targetMac).replace(/:/g, '_')}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adapterHelper = (btAdapter as any).helper;
        await adapterHelper.callMethod('RemoveDevice', `${adapterHelper.object}/${devSerialized}`);
        bleLog.debug('Removed stale device from BlueZ cache');
      } catch {
        // Device wasn't in cache — expected on first scan
      }
    }

    await startDiscoverySafe(btAdapter);

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

      // Stop discovery before connecting — BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      try {
        bleLog.debug('Stopping discovery before connect...');
        await btAdapter.stopDiscovery();
        bleLog.debug('Discovery stopped');
      } catch {
        bleLog.debug('stopDiscovery failed (may already be stopped)');
      }

      await connectWithRetries(device, MAX_CONNECT_RETRIES);
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

      // Stop discovery before connecting — BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      try {
        bleLog.debug('Stopping discovery before connect...');
        await btAdapter.stopDiscovery();
        bleLog.debug('Discovery stopped');
      } catch {
        bleLog.debug('stopDiscovery failed (may already be stopped)');
      }

      await connectWithRetries(device, MAX_CONNECT_RETRIES);
      bleLog.info('Connected. Discovering services...');
    }

    // Setup GATT characteristics and wait for a complete reading
    const gatt = await device.gatt();
    const charMap = await buildCharMap(gatt);
    const payload = await waitForReading(
      charMap,
      wrapDevice(device),
      matchedAdapter,
      profile,
      weightUnit,
      onLiveData,
    );

    try {
      await device.disconnect();
    } catch {
      /* ignore */
    }
    return payload;
  } finally {
    destroy();
  }
}

/**
 * Scan for nearby BLE devices and identify recognized scales.
 * Uses node-ble (BlueZ D-Bus) — Linux only.
 */
export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs = 15_000,
): Promise<ScanResult[]> {
  const { bluetooth, destroy } = NodeBle.createBluetooth();

  try {
    const btAdapter = await bluetooth.defaultAdapter();

    if (!(await btAdapter.isPowered())) {
      throw new Error(
        'Bluetooth adapter is not powered on. ' +
          'Ensure bluetoothd is running: sudo systemctl start bluetooth',
      );
    }

    await startDiscoverySafe(btAdapter);

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

    try {
      await btAdapter.stopDiscovery();
    } catch {
      /* ignore */
    }

    return results;
  } finally {
    destroy();
  }
}
