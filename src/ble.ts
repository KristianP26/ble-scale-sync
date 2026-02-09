import noble, { Peripheral, Characteristic } from '@abandonware/noble';
import type {
  ScaleAdapter,
  UserProfile,
  GarminPayload,
  ScaleReading,
} from './interfaces/scale-adapter.js';

export interface ScanOptions {
  targetMac?: string;
  adapters: ScaleAdapter[];
  profile: UserProfile;
  onLiveData?: (reading: ScaleReading) => void;
}

export function scanAndRead(opts: ScanOptions): Promise<GarminPayload> {
  const { targetMac, adapters, profile, onLiveData } = opts;
  const targetId: string | undefined = targetMac?.toLowerCase().replace(/:/g, '');

  return new Promise<GarminPayload>((resolve, reject) => {
    let unlockInterval: ReturnType<typeof setInterval> | null = null;
    let resolved = false;

    function cleanup(peripheral: Peripheral): void {
      if (unlockInterval) {
        clearInterval(unlockInterval);
        unlockInterval = null;
      }
      noble.stopScanning();
      if (peripheral && peripheral.state === 'connected') {
        peripheral.disconnect(() => {});
      }
    }

    noble.on('stateChange', (state: string) => {
      if (state === 'poweredOn') {
        console.log('[BLE] Adapter powered on, scanning...');
        noble.startScanning([], false);
      } else {
        console.log(`[BLE] Adapter state: ${state}`);
        noble.stopScanning();
      }
    });

    noble.on('discover', (peripheral: Peripheral) => {
      const id: string =
        peripheral.id?.replace(/:/g, '').toLowerCase() ||
        peripheral.address?.replace(/:/g, '').toLowerCase() ||
        '';

      let matchedAdapter: ScaleAdapter | undefined;

      if (targetId) {
        // Pinned mode: only consider the specific MAC
        if (id !== targetId) return;

        matchedAdapter = adapters.find((a) => a.matches(peripheral));
        if (!matchedAdapter) {
          const deviceName: string = peripheral.advertisement.localName || '(unknown)';
          reject(
            new Error(
              `Device found (${deviceName}) but no adapter recognized it. ` +
                `Registered adapters: ${adapters.map((a) => a.name).join(', ')}`,
            ),
          );
          return;
        }
      } else {
        // Auto-discovery mode: try all adapters against every peripheral
        matchedAdapter = adapters.find((a) => a.matches(peripheral));
        if (!matchedAdapter) return;

        console.log(`[BLE] Auto-discovered: ${matchedAdapter.name} (${peripheral.id})`);
      }

      console.log(
        `[BLE] Found scale: ${peripheral.advertisement.localName || peripheral.id} [${matchedAdapter.name}]`,
      );
      noble.stopScanning();

      peripheral.connect((err?: string) => {
        if (err) {
          reject(new Error(`BLE connect failed: ${err}`));
          return;
        }

        console.log('[BLE] Connected. Discovering services...');

        peripheral.discoverAllServicesAndCharacteristics((err, _services, characteristics) => {
          if (err) {
            cleanup(peripheral);
            reject(new Error(`Service discovery failed: ${err}`));
            return;
          }

          const notifyChar: Characteristic | undefined = characteristics.find(
            (c) => c.uuid === matchedAdapter.charNotifyUuid,
          );
          const writeChar: Characteristic | undefined = characteristics.find(
            (c) => c.uuid === matchedAdapter.charWriteUuid,
          );

          if (!notifyChar || !writeChar) {
            cleanup(peripheral);
            reject(
              new Error(
                `Required characteristics not found. ` +
                  `Notify (${matchedAdapter.charNotifyUuid}): ${!!notifyChar}, ` +
                  `Write (${matchedAdapter.charWriteUuid}): ${!!writeChar}`,
              ),
            );
            return;
          }

          notifyChar.subscribe((err?: string) => {
            if (err) {
              cleanup(peripheral);
              reject(new Error(`Subscribe failed: ${err}`));
              return;
            }
            console.log('[BLE] Subscribed to notifications. Step on the scale.');
          });

          notifyChar.on('data', (data: Buffer) => {
            if (resolved) return;

            const reading: ScaleReading | null = matchedAdapter.parseNotification(data);
            if (!reading) return;

            if (onLiveData) {
              onLiveData(reading);
            }

            if (matchedAdapter.isComplete(reading)) {
              resolved = true;
              cleanup(peripheral);

              try {
                const payload: GarminPayload = matchedAdapter.computeMetrics(reading, profile);
                resolve(payload);
              } catch (e) {
                reject(e);
              }
            }
          });

          const unlockBuf: Buffer = Buffer.from(matchedAdapter.unlockCommand);
          const sendUnlock = (): void => {
            if (!resolved) {
              writeChar.write(unlockBuf, true, (err?: string) => {
                if (err && !resolved) {
                  console.error(`[BLE] Unlock write error: ${err}`);
                }
              });
            }
          };

          sendUnlock();
          unlockInterval = setInterval(sendUnlock, matchedAdapter.unlockIntervalMs);
        });
      });

      peripheral.on('disconnect', () => {
        if (!resolved) {
          cleanup(peripheral);
          reject(new Error('Scale disconnected unexpectedly'));
        }
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((noble as any).state === 'poweredOn') {
      console.log('[BLE] Adapter already on, scanning...');
      noble.startScanning([], false);
    }
  });
}
