import type NodeBle from 'node-ble';
import type { BleChar, BleDevice } from '../shared.js';
import { bleLog, normalizeUuid, errMsg } from '../types.js';
import type { Device } from './dbus.js';

type GattCharacteristic = NodeBle.GattCharacteristic;

export function wrapChar(char: GattCharacteristic): BleChar {
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

export function wrapDevice(device: Device): BleDevice {
  return {
    onDisconnect: (callback) => {
      device.on('disconnect', callback);
    },
  };
}

export async function buildCharMap(gatt: NodeBle.GattServer): Promise<Map<string, BleChar>> {
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
