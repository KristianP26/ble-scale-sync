import NodeBle from 'node-ble';
import type {
  ScaleAdapter,
  BleDeviceInfo,
  BodyComposition,
} from '../../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from '../types.js';
import type { RawReading } from '../shared.js';
import { waitForRawReading, findMissingCharacteristics } from '../shared.js';
import {
  bleLog,
  normalizeUuid,
  formatMac,
  sleep,
  errMsg,
  withTimeout,
  resetAdapterBtmgmt,
  MAX_CONNECT_RETRIES,
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_POLL_MS,
  POST_DISCOVERY_QUIESCE_MS,
  GATT_DISCOVERY_TIMEOUT_MS,
  RAW_READING_TIMEOUT_MS,
  CHAR_DISCOVERY_MAX_RETRIES,
  CHAR_DISCOVERY_RETRY_DELAY_MS,
} from '../types.js';
import { helperOf, type Adapter, type Device } from './dbus.js';
import {
  getAdapter,
  resetConnection,
  isStaleConnectionError,
  isDbusConnectionError,
  dbusError,
  parseHciIndex,
} from './connection.js';
import {
  startDiscoverySafe,
  removeDevice,
  autoDiscover,
  stopDiscoveryAndQuiesce,
} from './discovery.js';
import { connectWithRecovery } from './connect.js';
import { wrapDevice, buildCharMap } from './gatt.js';
import { broadcastScanNodeBle } from './broadcast.js';

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
      // Limitation: serviceUuids is empty pre-connect (BlueZ does not expose advertised
      // service UUIDs through D-Bus before connection), so adapters whose `matches()`
      // returns true only on serviceUuids are NOT detected here and will fall through
      // to the GATT path even when `preferPassive=true`. All current passive adapters
      // (e.g. Mi Scale 2 `MIBFS`) match by name. To support a UUID-only passive
      // adapter, add a `passiveServiceUuids: string[]` hint to ScaleAdapter and check
      // it here against the advertised UUIDs from BlueZ ServiceData.
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

      // Resolve the adapter post-discovery using characteristics as well as
      // service UUIDs, so devices that share a generic vendor service (e.g.
      // 0xFFF0: 1byone/Eufy vs Inlife) are disambiguated instead of falling to
      // the first service-only match. BlueZ can export characteristics late
      // ([bluez/bluez#1489]), so retry the enumeration within the existing
      // discovery budget until an adapter is recognized. #177
      const gatt = await device.gatt();
      const serviceUuids = await gatt.services();
      bleLog.debug(`Services: [${serviceUuids.join(', ')}]`);

      let resolved: ScaleAdapter | undefined;
      let matchCharMap = await withTimeout(
        buildCharMap(gatt),
        GATT_DISCOVERY_TIMEOUT_MS,
        'GATT service discovery timed out',
      );
      for (let attempt = 1; attempt <= CHAR_DISCOVERY_MAX_RETRIES; attempt++) {
        const info: BleDeviceInfo = {
          localName: name,
          serviceUuids: serviceUuids.map(normalizeUuid),
          characteristicUuids: [...matchCharMap.keys()],
        };
        resolved = adapters.find((a) => a.matches(info));
        if (resolved || attempt === CHAR_DISCOVERY_MAX_RETRIES) break;
        await sleep(CHAR_DISCOVERY_RETRY_DELAY_MS);
        matchCharMap = await withTimeout(
          buildCharMap(gatt),
          GATT_DISCOVERY_TIMEOUT_MS,
          'GATT service discovery timed out',
        );
      }
      if (!resolved) {
        throw new Error(
          `Device found (${name}) but no adapter recognized it. ` +
            `Services: [${serviceUuids.join(', ')}]. ` +
            `Adapters: ${adapters.map((a) => a.name).join(', ')}`,
        );
      }
      matchedAdapter = resolved;
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
    // Retry budget: MAX iterations total. Iterations 1..MAX-1 actually rebuild
    // the char map; the MAX-th iteration only logs the give-up warn and breaks,
    // so the user-facing retry counter is `attempt/(MAX-1)`.
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
