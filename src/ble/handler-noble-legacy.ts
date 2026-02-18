import noble from '@abandonware/noble';
import type { Peripheral, Characteristic, Service } from '@abandonware/noble';
import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { BleChar, BleDevice, RawReading } from './shared.js';
import { waitForRawReading } from './shared.js';
import {
  bleLog,
  normalizeUuid,
  sleep,
  errMsg,
  withTimeout,
  CONNECT_TIMEOUT_MS,
  MAX_CONNECT_RETRIES,
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_POLL_MS,
  GATT_DISCOVERY_TIMEOUT_MS,
} from './types.js';

// ─── Noble state management ───────────────────────────────────────────────────

/** Wait for the Bluetooth adapter to reach 'poweredOn' state. */
function waitForPoweredOn(): Promise<void> {
  if (noble._state === 'poweredOn') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      noble.removeListener('stateChange', onState);
      reject(new Error(`Bluetooth adapter state: '${noble._state}' (expected 'poweredOn')`));
    }, 10_000);

    const onState = (state: string): void => {
      if (state === 'poweredOn') {
        clearTimeout(timeout);
        noble.removeListener('stateChange', onState);
        resolve();
      }
    };
    noble.on('stateChange', onState);
  });
}

/** Get a stable device address: MAC on Windows/Linux, peripheral.id on macOS. */
function peripheralAddress(peripheral: Peripheral): string {
  // On macOS, peripheral.address is often empty or '<unknown>'.
  // peripheral.id is the CoreBluetooth UUID and is always available.
  if (peripheral.address && !['', 'unknown', '<unknown>'].includes(peripheral.address)) {
    return peripheral.address.toUpperCase();
  }
  return peripheral.id;
}

/** Check whether a peripheral matches a target identifier (MAC or CoreBluetooth UUID). */
function matchesTarget(peripheral: Peripheral, target: string): boolean {
  const normalizedTarget = target.replace(/[:-]/g, '').toUpperCase();
  const addr = peripheral.address?.replace(/[:-]/g, '').toUpperCase() ?? '';
  const id = peripheral.id?.toUpperCase() ?? '';
  return addr === normalizedTarget || id === normalizedTarget;
}

// ─── BLE abstraction wrappers ─────────────────────────────────────────────────

function wrapChar(char: Characteristic): BleChar {
  return {
    subscribe: async (onData) => {
      const listener = (data: Buffer) => onData(data);
      char.on('data', listener);
      await char.subscribeAsync();
      return () => {
        char.removeListener('data', listener);
      };
    },
    write: (data, withResponse) => char.writeAsync(data, !withResponse),
    read: () => char.readAsync(),
  };
}

function wrapPeripheral(peripheral: Peripheral): BleDevice {
  return {
    onDisconnect: (callback) => {
      peripheral.once('disconnect', () => callback());
    },
  };
}

// ─── Connection helpers ───────────────────────────────────────────────────────

async function connectWithRetries(peripheral: Peripheral, maxRetries: number): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      bleLog.debug(`Connect attempt ${attempt + 1}/${maxRetries + 1}...`);
      await withTimeout(peripheral.connectAsync(), CONNECT_TIMEOUT_MS, 'Connection timed out');
      bleLog.debug('Connected');
      return;
    } catch (err: unknown) {
      const msg = errMsg(err);
      if (attempt >= maxRetries) {
        throw new Error(`Connection failed after ${maxRetries + 1} attempts: ${msg}`);
      }
      const delay = 1000 + attempt * 500;
      bleLog.warn(
        `Connect error: ${msg}. Retrying (${attempt + 1}/${maxRetries}) in ${delay}ms...`,
      );
      try {
        await peripheral.disconnectAsync();
      } catch {
        /* ignore */
      }

      // On 3rd+ failure, restart scanning to reset noble's internal radio state
      if (attempt >= 2) {
        bleLog.debug('Restarting scan to reset radio state...');
        try {
          await noble.stopScanningAsync();
          await sleep(500);
          await noble.startScanningAsync([], true);
          await sleep(500);
          await noble.stopScanningAsync();
        } catch {
          bleLog.debug('Scan restart failed (ignored)');
        }
      }

      await sleep(delay);
    }
  }
}

// ─── Build charMap from pre-discovered services ─────────────────────────────

/**
 * Collect characteristics from each Service object instead of using the flat
 * `characteristics` array returned by `discoverAllServicesAndCharacteristicsAsync()`.
 *
 * Noble's flat array silently drops characteristics when per-service discovery
 * returns an error (the `if (error == null)` guard in peripheral.js). The per-
 * service `service.characteristics` is always populated, so iterating services
 * is more reliable — especially on WinRT where custom-service char discovery
 * can fail intermittently.
 */
function wrapCharacteristics(services: Service[]): Map<string, BleChar> {
  const charMap = new Map<string, BleChar>();
  for (const svc of services) {
    const svcId = normalizeUuid(svc.uuid);
    const chars: Characteristic[] = svc.characteristics ?? [];
    bleLog.debug(`Service ${svcId}: ${chars.length} characteristic(s)`);
    for (const char of chars) {
      const normalized = normalizeUuid(char.uuid);
      bleLog.debug(`  Char ${char.uuid} (${normalized}) props=[${char.properties.join(',')}]`);
      charMap.set(normalized, wrapChar(char));
    }
  }
  return charMap;
}

// ─── Discovery helpers ────────────────────────────────────────────────────────

/**
 * Discover peripherals via noble's event-driven scanning.
 * Returns the first peripheral that matches the target or adapter criteria.
 */
function discoverPeripheral(
  adapters: ScaleAdapter[],
  targetMac?: string,
  abortSignal?: AbortSignal,
): Promise<{ peripheral: Peripheral; matchedAdapter?: ScaleAdapter }> {
  if (abortSignal?.aborted) {
    return Promise.reject(abortSignal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`No device found within ${DISCOVERY_TIMEOUT_MS / 1000}s`));
    }, DISCOVERY_TIMEOUT_MS);

    let heartbeat = 0;
    const heartbeatInterval = setInterval(() => {
      heartbeat++;
      if (heartbeat % 5 === 0) {
        bleLog.info('Still scanning...');
      }
    }, DISCOVERY_POLL_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(heartbeatInterval);
      noble.removeListener('discover', onDiscover);
      noble.stopScanningAsync().catch(() => {});
      abortSignal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(abortSignal!.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });

    const seen = new Set<string>();
    const onDiscover = (peripheral: Peripheral): void => {
      const name = peripheral.advertisement?.localName ?? '';
      const addr = peripheralAddress(peripheral);
      const svcUuids = (peripheral.advertisement?.serviceUuids ?? []).map(normalizeUuid);

      if (!seen.has(addr)) {
        seen.add(addr);
        bleLog.debug(`Discovered: ${name || '(no name)'} [${addr}]`);
      }

      const mfgData: Buffer | undefined = peripheral.advertisement?.manufacturerData;

      if (targetMac) {
        // Target mode: match by MAC or CoreBluetooth UUID
        if (!matchesTarget(peripheral, targetMac)) return;
        bleLog.debug(`Target device matched: ${name} [${addr}]`);

        cleanup();

        // Adapter matching will happen post-connect (when all services are known)
        resolve({ peripheral });
      } else {
        // Auto-discovery: try matching adapters by name + advertised service UUIDs
        const info: BleDeviceInfo = {
          localName: name,
          serviceUuids: svcUuids,
          manufacturerData: mfgData,
        };
        const matched = adapters.find((a) => a.matches(info));
        if (!matched) return;

        bleLog.info(`Auto-discovered: ${matched.name} (${name} [${addr}])`);

        cleanup();

        resolve({ peripheral, matchedAdapter: matched });
      }
    };

    noble.on('discover', onDiscover);

    // allowDuplicates=true so we keep receiving advertisements
    noble.startScanningAsync([], true).catch((err) => {
      cleanup();
      reject(new Error(`Failed to start scanning: ${errMsg(err)}`));
    });

    bleLog.info('Scanning for device...');
  });
}

// ─── Broadcast scan (advertisement-based weight reading) ─────────────────────

/**
 * Read weight from BLE advertisement data without establishing a GATT connection.
 * Used for broadcast-only devices (ADV_NONCONN_IND) that embed weight in
 * manufacturer data.
 *
 * Restarts scanning with allowDuplicates=true and calls adapter.parseAdvertisement()
 * on each advertisement from the target device until a stable reading is returned.
 */
function broadcastScan(
  adapter: ScaleAdapter,
  targetPeripheral: Peripheral,
  opts: {
    abortSignal?: AbortSignal;
    onLiveData?: (reading: ScaleReading) => void;
  },
): Promise<RawReading> {
  const { abortSignal, onLiveData } = opts;

  if (abortSignal?.aborted) {
    return Promise.reject(abortSignal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const targetAddr = peripheralAddress(targetPeripheral);

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`No stable broadcast reading within ${DISCOVERY_TIMEOUT_MS / 1000}s`));
    }, DISCOVERY_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      noble.removeListener('discover', onDiscover);
      noble.stopScanningAsync().catch(() => {});
      abortSignal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(abortSignal!.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });

    const onDiscover = (peripheral: Peripheral): void => {
      if (peripheralAddress(peripheral) !== targetAddr) return;

      const mfgData: Buffer | undefined = peripheral.advertisement?.manufacturerData;
      if (!mfgData || !adapter.parseAdvertisement) return;

      const reading = adapter.parseAdvertisement(mfgData);

      if (reading && onLiveData) {
        onLiveData(reading);
      }

      if (reading) {
        cleanup();
        bleLog.info(
          `Broadcast reading: ${reading.weight.toFixed(2)} kg (no impedance in broadcast mode)`,
        );
        resolve({ reading, adapter });
      }
    };

    noble.on('discover', onDiscover);

    noble.startScanningAsync([], true).catch((err) => {
      cleanup();
      reject(new Error(`Failed to restart scanning for broadcast: ${errMsg(err)}`));
    });

    bleLog.info('Listening for broadcast weight data. Step on the scale.');
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Scan for a BLE scale, read weight + impedance, and compute body composition.
 * Uses @abandonware/noble — works on Windows, macOS, and Linux.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  const { targetMac, adapters, profile, weightUnit, onLiveData, abortSignal } = opts;

  try {
    await waitForPoweredOn();

    const { peripheral, matchedAdapter: discoveredAdapter } = await discoverPeripheral(
      adapters,
      targetMac,
      abortSignal,
    );

    // Broadcast-only device: read weight from advertisements instead of GATT
    const connectable = peripheral.connectable !== false;
    if (!connectable) {
      const mfgData: Buffer | undefined = peripheral.advertisement?.manufacturerData;
      const name = peripheral.advertisement?.localName ?? '';
      const svcUuids = (peripheral.advertisement?.serviceUuids ?? []).map(normalizeUuid);

      // Match adapter if not already matched during discovery
      let adapter = discoveredAdapter;
      if (!adapter) {
        const info: BleDeviceInfo = {
          localName: name,
          serviceUuids: svcUuids,
          manufacturerData: mfgData,
        };
        adapter = adapters.find((a) => a.matches(info));
      }

      if (adapter?.parseAdvertisement) {
        bleLog.info(
          `Device is broadcast-only (non-connectable). Using advertisement-based reading.`,
        );
        return await broadcastScan(adapter, peripheral, { abortSignal, onLiveData });
      }

      bleLog.warn('Device is broadcast-only but no adapter supports advertisement parsing.');
    }

    await connectWithRetries(peripheral, MAX_CONNECT_RETRIES);
    try {
      bleLog.info('Connected. Discovering services...');

      // Sequential per-service discovery — one GATT request at a time.
      // discoverAllServicesAndCharacteristicsAsync() fires all per-service
      // characteristic discoveries in parallel (peripheral.js line 124-141),
      // which overwhelms low-power BLE devices on WinRT.
      const services = await withTimeout(
        (async () => {
          const svcs = await peripheral.discoverServicesAsync();
          for (const svc of svcs) {
            try {
              await svc.discoverCharacteristicsAsync();
            } catch {
              // WinRT may return AccessDenied on first attempt for custom services.
              // Retrying after a short delay lets WinRT's GATT cache settle
              // (mirrors old @abandonware/noble's accidental two-call warm-up).
              await sleep(1000);
              await svc.discoverCharacteristicsAsync();
            }
          }
          return svcs;
        })(),
        GATT_DISCOVERY_TIMEOUT_MS,
        'GATT service discovery timed out',
      );

      let matchedAdapter: ScaleAdapter;

      if (discoveredAdapter) {
        matchedAdapter = discoveredAdapter;
      } else {
        // Target-MAC mode: match adapter post-connect using full service list
        const serviceUuids = services.map((s) => normalizeUuid(s.uuid));
        const name = peripheral.advertisement?.localName ?? '';
        bleLog.debug(`Services: [${serviceUuids.join(', ')}]`);

        const info: BleDeviceInfo = { localName: name, serviceUuids };
        const found = adapters.find((a) => a.matches(info));
        if (!found) {
          throw new Error(
            `Device found (${name}) but no adapter recognized it. ` +
              `Services: [${serviceUuids.join(', ')}]. ` +
              `Adapters: ${adapters.map((a) => a.name).join(', ')}`,
          );
        }
        matchedAdapter = found;
      }

      bleLog.info(`Matched adapter: ${matchedAdapter.name}`);

      const charMap = wrapCharacteristics(services);
      const raw = await waitForRawReading(
        charMap,
        wrapPeripheral(peripheral),
        matchedAdapter,
        profile,
        weightUnit,
        onLiveData,
      );

      return raw;
    } finally {
      try {
        await peripheral.disconnectAsync();
      } catch {
        /* ignore */
      }
    }
  } finally {
    // Safety net: stop any leftover scanning (targeted — not removeAllListeners)
    noble.stopScanningAsync().catch(() => {});
  }
}

/** Scan, read, and compute body composition. Wrapper around scanAndReadRaw(). */
export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { reading, adapter } = await scanAndReadRaw(opts);
  return adapter.computeMetrics(reading, opts.profile);
}

/**
 * Scan for nearby BLE devices and identify recognized scales.
 * Uses @abandonware/noble — works on Windows, macOS, and Linux.
 */
export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs = 15_000,
): Promise<ScanResult[]> {
  await waitForPoweredOn();

  const results: ScanResult[] = [];
  const seen = new Set<string>();

  const onDiscover = (peripheral: Peripheral): void => {
    const addr = peripheralAddress(peripheral);
    if (seen.has(addr)) return;
    seen.add(addr);

    const name = peripheral.advertisement?.localName ?? '(unknown)';
    const svcUuids = (peripheral.advertisement?.serviceUuids ?? []).map(normalizeUuid);
    const mfgData: Buffer | undefined = peripheral.advertisement?.manufacturerData;
    const info: BleDeviceInfo = {
      localName: name,
      serviceUuids: svcUuids,
      manufacturerData: mfgData,
    };
    const matched = adapters.find((a) => a.matches(info));

    results.push({
      address: addr,
      name,
      matchedAdapter: matched?.name,
    });
  };

  noble.on('discover', onDiscover);
  await noble.startScanningAsync([], true);

  await sleep(durationMs);

  noble.removeListener('discover', onDiscover);
  try {
    await noble.stopScanningAsync();
  } catch {
    /* ignore */
  }

  return results;
}
