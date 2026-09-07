import type { Characteristic, Peripheral, Service } from '@stoprocent/noble';
import type { BleChar, BleDevice } from '../shared.js';
import { bleLog, normalizeUuid } from '../types.js';
import { wrapChar } from './char.js';

export function wrapPeripheral(peripheral: Peripheral): BleDevice {
  return {
    onDisconnect: (callback) => {
      peripheral.once('disconnect', () => callback());
    },
  };
}

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
export function wrapCharacteristics(services: Service[]): Map<string, BleChar> {
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
