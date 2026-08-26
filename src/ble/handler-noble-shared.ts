import type { Peripheral, Characteristic, Service } from '@stoprocent/noble';
import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  BodyComposition,
  LiveWeight,
} from '../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from './types.js';
import type { BleChar, BleDevice, RawReading } from './shared.js';
import { waitForRawReading } from './shared.js';
import { evaluateAdvertisement, GraceTimers } from './advertisement.js';
import { resolveAdapter } from '../scales/resolve.js';
import {
  bleLog,
  normalizeUuid,
  sleep,
  errMsg,
  withTimeout,
  withIdleTimeout,
  resetAdapterBtmgmt,
  CONNECT_TIMEOUT_MS,
  MAX_CONNECT_RETRIES,
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_POLL_MS,
  GATT_DISCOVERY_TIMEOUT_MS,
  IMPEDANCE_GRACE_MS,
  RAW_READING_TIMEOUT_MS,
  READING_SESSION_CAP_FACTOR,
} from './types.js';

/**
 * Upper bound on enabling notifications (#283).
 *
 * @abandonware/noble promisifies subscribe over a single `once('notify')` with
 * no error path, and its WinRT binding has several branches that emit nothing
 * at all: the device-not-connected guard, a failed characteristic lookup, and a
 * CCCD write that comes back as anything other than AsyncStatus::Completed
 * (the reporter's log shows `BLEManager::OnNotify: status: 3`). On those paths
 * subscribeAsync never settles, so the whole reading hangs on a promise that
 * can only be ended by the scale dropping the link, and the user sees a
 * misleading "disconnected before reading completed".
 */
const NOTIFY_ENABLE_TIMEOUT_MS = 10_000;

/**
 * Client Characteristic Configuration descriptor, and the value that turns
 * notifications on.
 */
const CCCD_UUID = '2902';
const CCCD_NOTIFY_ON = Buffer.from([0x01, 0x00]);
const CCCD_OFF = Buffer.from([0x00, 0x00]);

/**
 * Upper bound on the direct CCCD fallback below. Shorter than the subscribe it
 * backs up: by the time it runs the session has already spent that budget once,
 * and this path either works quickly or not at all.
 */
const CCCD_WRITE_TIMEOUT_MS = 5_000;

/**
 * Minimal descriptor surface. Both drivers expose it; the cast is contained
 * here rather than widening the shared Characteristic type.
 */
interface NobleDescriptor {
  uuid: string;
  writeValueAsync(data: Buffer): Promise<void>;
}
interface DescriptorCapable {
  discoverDescriptorsAsync?(): Promise<NobleDescriptor[]>;
}

/**
 * Enable notifications by writing the CCCD directly, bypassing subscribeAsync.
 *
 * Why this exists: `subscribeAsync` is promisified over a single `once('notify')`
 * with no error path, and the WinRT binding has branches that emit nothing at
 * all, including a CCCD write returning anything other than Completed (the #283
 * reporter's log shows `BLEManager::OnNotify: status: 3`). The subscribe then
 * never settles and the session is dead. Writing the descriptor goes through
 * `writeValue` instead of the notify machinery, so it fails loudly or succeeds,
 * rather than hanging.
 *
 * Returns a function that turns notifications back off, or null when the
 * descriptor is not reachable, in which case the caller keeps the original
 * subscribe error as the thing worth reporting.
 */
async function enableViaCccd(char: Characteristic): Promise<(() => void) | null> {
  const cap = char as unknown as DescriptorCapable;
  if (typeof cap.discoverDescriptorsAsync !== 'function') return null;
  const descriptors = await withTimeout(
    cap.discoverDescriptorsAsync(),
    CCCD_WRITE_TIMEOUT_MS,
    `Descriptor discovery on ${char.uuid} timed out`,
  );
  // Drivers report a descriptor UUID either short ('2902') or in full 128-bit
  // form. The 16-bit value sits at the START of the expanded form, after the
  // four zero nibbles, so matching on a suffix finds nothing.
  const cccd = descriptors.find((d) => {
    const u = d.uuid.toLowerCase().replace(/-/g, '');
    return u === CCCD_UUID || u.startsWith(`0000${CCCD_UUID}`);
  });
  if (!cccd) return null;
  await withTimeout(
    cccd.writeValueAsync(CCCD_NOTIFY_ON),
    CCCD_WRITE_TIMEOUT_MS,
    `CCCD write on ${char.uuid} timed out`,
  );
  return () => {
    // Best effort: the link is usually gone by the time this runs.
    void cccd.writeValueAsync(CCCD_OFF).catch(() => {});
  };
}

/**
 * Minimal structural surface of a Noble instance that the shared handler calls.
 * Both `@stoprocent/noble` and `@abandonware/noble` (cast) satisfy it at runtime;
 * typed event overloads keep this eslint-clean (no `any`).
 */
export interface NobleApi {
  on(event: 'stateChange', listener: (state: string) => void): unknown;
  on(event: 'discover', listener: (peripheral: Peripheral) => void): unknown;
  removeListener(event: 'stateChange', listener: (state: string) => void): unknown;
  removeListener(event: 'discover', listener: (peripheral: Peripheral) => void): unknown;
  startScanningAsync(serviceUuids?: string[], allowDuplicates?: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
}

/** Dependencies injected per Noble driver. */
export interface NobleHandlerDeps {
  noble: NobleApi;
  /**
   * Read the adapter state WITHOUT changing the driver's init semantics.
   * `@stoprocent/noble` reads `.state` (triggers lazy init, intended);
   * `@abandonware/noble` reads the raw `._state` field (avoids the init side
   * effect of its `.state` getter).
   */
  getState: () => string;
}

/** Convert Noble's raw manufacturer data buffer to {id, data} format. */
function parseMfgData(raw: Buffer | undefined): { id: number; data: Buffer } | undefined {
  if (!raw || raw.length < 2) return undefined;
  return { id: raw.readUInt16LE(0), data: raw.subarray(2) };
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
      // Attach before the CCCD write so a scale that notifies the instant
      // notifications are enabled cannot beat the listener.
      char.on('data', listener);
      const startedAt = Date.now();
      let cccdOff: (() => void) | null = null;
      try {
        await withTimeout(
          char.subscribeAsync(),
          NOTIFY_ENABLE_TIMEOUT_MS,
          `Enabling notifications on ${char.uuid} did not complete within ${NOTIFY_ENABLE_TIMEOUT_MS}ms (the CCCD write was never acknowledged)`,
        );
      } catch (subscribeErr: unknown) {
        // Fall back to writing the CCCD ourselves before giving the session up.
        // On the paths that bring us here the subscribe has already failed, so
        // this can only improve the outcome: it either enables notifications
        // through a different code path in the binding, or it fails and we
        // report the original error, which is the more informative one.
        bleLog.debug(
          `Subscribe on ${char.uuid} failed (${errMsg(subscribeErr)}); trying a direct CCCD write`,
        );
        try {
          cccdOff = await enableViaCccd(char);
        } catch (cccdErr: unknown) {
          bleLog.debug(`Direct CCCD write on ${char.uuid} failed: ${errMsg(cccdErr)}`);
          cccdOff = null;
        }
        if (!cccdOff) {
          // Leaving the listener attached would leak one per failed cycle.
          char.removeListener('data', listener);
          throw subscribeErr;
        }
        bleLog.info(
          `Notifications on ${char.uuid} were enabled by writing the CCCD directly, ` +
            `after the driver's subscribe failed (#283).`,
        );
      }
      bleLog.debug(`Notifications enabled on ${char.uuid} in ${Date.now() - startedAt}ms`);
      return () => {
        char.removeListener('data', listener);
        if (cccdOff) cccdOff();
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

/**
 * Build the Noble-based BLE handler for a specific driver.
 *
 * The two driver entrypoints (`handler-noble.ts` for `@stoprocent/noble`,
 * `handler-noble-legacy.ts` for `@abandonware/noble`) supply their own Noble
 * instance and a `getState` accessor; everything else is shared here (#181).
 */
export function createNobleHandler({ noble, getState }: NobleHandlerDeps) {
  // ─── Noble state management ─────────────────────────────────────────────────

  /** Wait for the Bluetooth adapter to reach 'poweredOn' state. */
  async function waitForPoweredOn(): Promise<void> {
    if (getState() === 'poweredOn') return;

    const waitOnce = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          noble.removeListener('stateChange', onState);
          resolve(false);
        }, 10_000);
        const onState = (state: string): void => {
          if (state === 'poweredOn') {
            clearTimeout(timeout);
            noble.removeListener('stateChange', onState);
            resolve(true);
          }
        };
        noble.on('stateChange', onState);
      });

    if (await waitOnce()) return;

    // Adapter not poweredOn — attempt btmgmt kernel-level reset
    bleLog.debug(`Adapter state '${getState()}', attempting btmgmt reset...`);
    if (await resetAdapterBtmgmt()) {
      if (getState() === 'poweredOn') return;
      if (await waitOnce()) return;
    }

    throw new Error(`Bluetooth adapter state: '${getState()}' (expected 'poweredOn')`);
  }

  // ─── Connection helpers ─────────────────────────────────────────────────────

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

  // ─── Discovery helpers ──────────────────────────────────────────────────────

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

        const mfgData = parseMfgData(peripheral.advertisement?.manufacturerData);

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
          const matched = resolveAdapter(info, adapters);
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

  // ─── Broadcast scan (advertisement-based weight reading) ───────────────────

  /**
   * Read weight from BLE advertisement data without establishing a GATT connection.
   * Used for broadcast-only devices (ADV_NONCONN_IND) that embed weight in
   * manufacturer data.
   *
   * Restarts scanning with allowDuplicates=true and calls adapter.parseBroadcast()
   * on each advertisement from the target device until a stable reading is returned.
   */
  function broadcastScan(
    adapter: ScaleAdapter,
    targetPeripheral: Peripheral,
    opts: {
      abortSignal?: AbortSignal;
      onLiveData?: (reading: ScaleReading) => void;
      onLiveWeight?: (live: LiveWeight) => void;
    },
  ): Promise<RawReading> {
    const { abortSignal, onLiveData, onLiveWeight } = opts;

    if (abortSignal?.aborted) {
      return Promise.reject(abortSignal.reason ?? new DOMException('Aborted', 'AbortError'));
    }

    return new Promise((resolve, reject) => {
      const targetAddr = peripheralAddress(targetPeripheral);

      // Grace timer for passive adapters: a weight-only frame is held for
      // IMPEDANCE_GRACE_MS in case an impedance-bearing frame follows; on
      // timeout the weight-only reading resolves. Single target, so one key.
      const grace = new GraceTimers(IMPEDANCE_GRACE_MS, (_addr, held) => {
        cleanup();
        bleLog.info(
          `Broadcast reading (weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s): ` +
            `${held.reading.weight.toFixed(2)} kg`,
        );
        resolve(held);
      });

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`No stable broadcast reading within ${DISCOVERY_TIMEOUT_MS / 1000}s`));
      }, DISCOVERY_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        grace.clear();
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

        // Build a bare advertisement info for the shared decision. serviceData
        // uuids are passed RAW (noble already yields lowercase short uuids) to
        // match the pre-#242 behaviour of this site.
        const svcDataList: Array<{ uuid: string; data: Buffer }> =
          (peripheral.advertisement as { serviceData?: Array<{ uuid: string; data: Buffer }> })
            ?.serviceData ?? [];
        const info: BleDeviceInfo = {
          localName: peripheral.advertisement?.localName ?? '',
          serviceUuids: [],
          manufacturerData: parseMfgData(peripheral.advertisement?.manufacturerData),
          serviceData: svcDataList,
        };

        const decision = evaluateAdvertisement(adapter, info);

        if (decision.kind === 'complete') {
          if (onLiveData) onLiveData(decision.reading);
          cleanup();
          bleLog.info(`Broadcast reading: ${decision.reading.weight.toFixed(2)} kg`);
          resolve({ reading: decision.reading, adapter });
          return;
        }

        if (decision.kind === 'partial') {
          if (onLiveData) onLiveData(decision.reading);
          bleLog.debug(
            `${adapter.name} broadcast frame not yet complete ` +
              `(weight=${decision.reading.weight.toFixed(2)} kg, impedance=${decision.reading.impedance})`,
          );
          grace.hold(targetAddr, { reading: decision.reading, adapter });
          return;
        }

        // A settling weight: what the scale is showing while it converges. Not
        // a reading, so it never completes the scan (#356).
        if (decision.kind === 'wait' && decision.live && onLiveWeight) {
          onLiveWeight(decision.live);
        }

        // wait / gatt / none: this is the broadcast-only path, so keep waiting
        // for the next advertisement from the target.
      };

      noble.on('discover', onDiscover);

      noble.startScanningAsync([], true).catch((err) => {
        cleanup();
        reject(new Error(`Failed to restart scanning for broadcast: ${errMsg(err)}`));
      });

      bleLog.info('Listening for broadcast weight data. Step on the scale.');
    });
  }

  // ─── Exports ────────────────────────────────────────────────────────────────

  /**
   * Scan for a BLE scale, read weight + impedance, and compute body composition.
   */
  let adapterWarningLogged = false;

  async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
    if (opts.bleAdapter && !adapterWarningLogged) {
      bleLog.warn(
        `ble.adapter='${opts.bleAdapter}' is only supported with node-ble (Linux default). ` +
          `Ignored when using Noble.`,
      );
      adapterWarningLogged = true;
    }

    const {
      targetMac,
      adapters,
      profile,
      scaleAuth,
      weightUnit,
      onLiveData,
      onLiveWeight,
      abortSignal,
    } = opts;
    const { readingTimeoutMs } = opts;

    try {
      await waitForPoweredOn();

      const { peripheral, matchedAdapter: discoveredAdapter } = await discoverPeripheral(
        adapters,
        targetMac,
        abortSignal,
      );

      // Match adapter from advertisement (needed for target-MAC mode where
      // discoveredAdapter is deferred until post-connect).
      const connectable = peripheral.connectable !== false;
      const mfgData = parseMfgData(peripheral.advertisement?.manufacturerData);
      const advName = peripheral.advertisement?.localName ?? '';
      const advSvcUuids = (peripheral.advertisement?.serviceUuids ?? []).map(normalizeUuid);
      let broadcastAdapter = discoveredAdapter;
      if (!broadcastAdapter) {
        const info: BleDeviceInfo = {
          localName: advName,
          serviceUuids: advSvcUuids,
          manufacturerData: mfgData,
        };
        broadcastAdapter = resolveAdapter(info, adapters);
      }

      // Use broadcast scanning when the device is non-connectable or the matched
      // adapter prefers passive advertisement decoding over a GATT connection.
      if (!connectable || broadcastAdapter?.preferPassive) {
        if (
          broadcastAdapter &&
          (broadcastAdapter.parseBroadcast || broadcastAdapter.parseServiceData)
        ) {
          if (!connectable) {
            bleLog.info(
              `Device is broadcast-only (non-connectable). Using advertisement-based reading.`,
            );
          } else {
            bleLog.info(`Adapter prefers passive mode. Using advertisement-based reading.`);
          }
          return await broadcastScan(broadcastAdapter, peripheral, {
            abortSignal,
            onLiveData,
            onLiveWeight,
          });
        }

        if (!connectable) {
          bleLog.warn('Device is broadcast-only but no adapter supports advertisement parsing.');
        }
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
          // and the discovered characteristics, so char-aware adapters (#177, #235)
          // can disambiguate devices that share a generic vendor service (fff0).
          // Union of advertised and discovered services. Target-MAC mode skips
          // the discovery-time match, so this is the ONLY adapter resolution for
          // a configured scale_mac, and it must carry both kinds of evidence.
          // A device record holding advertisement-scoped manufacturer data next
          // to a GATT-only service list is a scope hybrid that exists on no
          // other path, and adapters cannot tell the two apart: the Hutbit's
          // d618 is advertised (AD type 0x03) and is not known to be a GATT
          // primary service, so a signature check needing d618 would never fire
          // here while the manufacturer data suggested it should (#278).
          const discoveredUuids = services.map((s) => normalizeUuid(s.uuid));
          const serviceUuids = [
            ...new Set([
              ...(peripheral.advertisement?.serviceUuids ?? []).map(normalizeUuid),
              ...discoveredUuids,
            ]),
          ];
          const characteristicUuids = services.flatMap((s) =>
            (s.characteristics ?? []).map((c) => normalizeUuid(c.uuid)),
          );
          const name = peripheral.advertisement?.localName ?? '';
          bleLog.debug(`Services: [${discoveredUuids.join(', ')}]`);

          // Manufacturer data matters here too, for the same reason: adapters
          // that fingerprint the advertisement (the Lefu OEM signature #278,
          // Beurer 0x0611, Mi Scale, QN) silently lost that signal without it,
          // so an OEM-rebranded unit fell through to a wrong adapter.
          const info: BleDeviceInfo = {
            localName: name,
            serviceUuids,
            characteristicUuids,
            manufacturerData: parseMfgData(peripheral.advertisement?.manufacturerData),
          };
          const found = resolveAdapter(info, adapters);
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
        // Bounded like the node-ble path (handler-node-ble/scan.ts): without
        // this the reading phase relies entirely on the peripheral eventually
        // disconnecting, so a stalled GATT session wedges the process (#283).
        const raw = await withTimeout(
          withIdleTimeout(
            (onActivity) =>
              waitForRawReading(
                charMap,
                wrapPeripheral(peripheral),
                matchedAdapter,
                profile,
                peripheralAddress(peripheral).replace(/[:-]/g, '').toUpperCase(),
                weightUnit,
                onLiveData,
                scaleAuth,
                onActivity,
              ),
            readingTimeoutMs ?? RAW_READING_TIMEOUT_MS,
            'Timed out waiting for a complete scale reading',
          ),
          (readingTimeoutMs ?? RAW_READING_TIMEOUT_MS) * READING_SESSION_CAP_FACTOR,
          'GATT session cap exceeded',
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
  async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
    const { reading, adapter } = await scanAndReadRaw(opts);
    return adapter.computeMetrics(reading, opts.profile);
  }

  /**
   * Scan for nearby BLE devices and identify recognized scales.
   */
  async function scanDevices(adapters: ScaleAdapter[], durationMs = 15_000): Promise<ScanResult[]> {
    await waitForPoweredOn();

    const results: ScanResult[] = [];
    const seen = new Set<string>();

    const onDiscover = (peripheral: Peripheral): void => {
      const addr = peripheralAddress(peripheral);
      if (seen.has(addr)) return;
      seen.add(addr);

      // The sentinel is for display only. It must NOT reach `matches()`: it is
      // a truthy string, and adapters that branch on whether an advertisement
      // carries a name would read a nameless device as named, so this tool
      // would report an adapter the read path does not choose. `npm run scan`
      // is what users are told to run to fill in `ble.force_scale_adapter`, so
      // a wrong answer here is acted on.
      const localName = peripheral.advertisement?.localName ?? '';
      const svcUuids = (peripheral.advertisement?.serviceUuids ?? []).map(normalizeUuid);
      const mfgData = parseMfgData(peripheral.advertisement?.manufacturerData);
      const info: BleDeviceInfo = {
        localName,
        serviceUuids: svcUuids,
        manufacturerData: mfgData,
      };
      const matched = resolveAdapter(info, adapters);

      results.push({
        address: addr,
        name: localName || '(unknown)',
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

  return {
    scanAndReadRaw,
    scanAndRead,
    scanDevices,
    /** Test-only export of private helpers (#163, #283). */
    _internals: { broadcastScan, wrapChar },
  };
}
