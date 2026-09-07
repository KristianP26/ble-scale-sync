import type { Peripheral } from '@stoprocent/noble';
import type { BleDeviceInfo, ScaleAdapter } from '../../interfaces/scale-adapter.js';
import { resolveAdapter } from '../../scales/resolve.js';
import {
  bleLog,
  errMsg,
  formatMac,
  normalizeUuid,
  DISCOVERY_POLL_MS,
  DISCOVERY_TIMEOUT_MS,
} from '../types.js';
import { matchesTarget, parseMfgData, peripheralAddress } from './peripheral.js';
import type { NobleApi } from './types.js';

/**
 * Discover peripherals via noble's event-driven scanning.
 * Returns the first peripheral that matches the target or adapter criteria.
 */
export function discoverPeripheral(
  noble: NobleApi,
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
          address: peripheral.address ? formatMac(peripheral.address) : undefined,
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
