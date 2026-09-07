import type { Peripheral } from '@stoprocent/noble';
import type {
  BleDeviceInfo,
  LiveWeight,
  ScaleAdapter,
  ScaleReading,
} from '../../interfaces/scale-adapter.js';
import type { RawReading } from '../shared.js';
import { evaluateAdvertisement, GraceTimers } from '../advertisement.js';
import { bleLog, errMsg, formatMac, DISCOVERY_TIMEOUT_MS, IMPEDANCE_GRACE_MS } from '../types.js';
import { parseMfgData, peripheralAddress } from './peripheral.js';
import type { NobleApi } from './types.js';

/**
 * Read weight from BLE advertisement data without establishing a GATT connection.
 * Used for broadcast-only devices (ADV_NONCONN_IND) that embed weight in
 * manufacturer data.
 *
 * Restarts scanning with allowDuplicates=true and calls adapter.parseBroadcast()
 * on each advertisement from the target device until a stable reading is returned.
 */
export function broadcastScan(
  noble: NobleApi,
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
        address: peripheral.address ? formatMac(peripheral.address) : undefined,
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
