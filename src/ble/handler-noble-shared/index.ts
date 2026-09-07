import type { Peripheral } from '@stoprocent/noble';
import type {
  BleDeviceInfo,
  BodyComposition,
  ScaleAdapter,
} from '../../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from '../types.js';
import type { RawReading } from '../shared.js';
import { waitForRawReading } from '../shared.js';
import { resolveAdapter } from '../../scales/resolve.js';
import {
  bleLog,
  normalizeUuid,
  sleep,
  withTimeout,
  withIdleTimeout,
  MAX_CONNECT_RETRIES,
  GATT_DISCOVERY_TIMEOUT_MS,
  RAW_READING_TIMEOUT_MS,
  READING_SESSION_CAP_FACTOR,
  formatMac,
} from '../types.js';
import { wrapChar } from './char.js';
import { wrapCharacteristics, wrapPeripheral } from './gatt.js';
import { parseMfgData, peripheralAddress } from './peripheral.js';
import { waitForPoweredOn } from './state.js';
import { connectWithRetries } from './connect.js';
import { discoverPeripheral } from './discovery.js';
import { broadcastScan } from './broadcast.js';
import type { NobleHandlerDeps } from './types.js';

export type { NobleApi, NobleHandlerDeps } from './types.js';

/**
 * Build the Noble-based BLE handler for a specific driver.
 *
 * The two driver entrypoints (`handler-noble.ts` for `@stoprocent/noble`,
 * `handler-noble-legacy.ts` for `@abandonware/noble`) supply their own Noble
 * instance and a `getState` accessor; everything else is shared here (#181).
 */
export function createNobleHandler({ noble, getState }: NobleHandlerDeps) {
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
      await waitForPoweredOn(noble, getState);

      const { peripheral, matchedAdapter: discoveredAdapter } = await discoverPeripheral(
        noble,
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
          address: peripheral.address ? formatMac(peripheral.address) : undefined,
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
          return await broadcastScan(noble, broadcastAdapter, peripheral, {
            abortSignal,
            onLiveData,
            onLiveWeight,
          });
        }

        if (!connectable) {
          bleLog.warn('Device is broadcast-only but no adapter supports advertisement parsing.');
        }
      }

      await connectWithRetries(noble, peripheral, MAX_CONNECT_RETRIES);
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
            address: peripheral.address ? formatMac(peripheral.address) : undefined,
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
    await waitForPoweredOn(noble, getState);

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
    // broadcastScan takes the Noble instance explicitly now that it lives in
    // its own module, so bind it here rather than changing the three-argument
    // shape the tests in handler-noble.test.ts and handler-noble-legacy.test.ts
    // call it with.
    _internals: {
      broadcastScan: (
        adapter: Parameters<typeof broadcastScan>[1],
        peripheral: Parameters<typeof broadcastScan>[2],
        opts: Parameters<typeof broadcastScan>[3],
      ) => broadcastScan(noble, adapter, peripheral, opts),
      wrapChar,
    },
  };
}
