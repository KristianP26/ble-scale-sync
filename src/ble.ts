import noble, { Peripheral, Characteristic } from '@abandonware/noble';

export interface ScaleMeasurement {
  weight: number;
  impedance: number;
}

export interface ConnectOptions {
  scaleMac: string;
  charNotify: string;
  charWrite: string;
  cmdUnlock: number[];
  onLiveData?: (weight: number, impedance: number) => void;
}

export function connectAndRead(opts: ConnectOptions): Promise<ScaleMeasurement> {
  const { scaleMac, charNotify, charWrite, cmdUnlock, onLiveData } = opts;
  const targetId: string = scaleMac.toLowerCase().replace(/:/g, '');

  return new Promise<ScaleMeasurement>((resolve, reject) => {
    let unlockInterval: ReturnType<typeof setInterval> | null = null;
    let resolved = false;
    let writeChar: Characteristic | null = null;

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
        peripheral.id?.replace(/:/g, '').toLowerCase()
        || peripheral.address?.replace(/:/g, '').toLowerCase()
        || '';

      if (id !== targetId) return;

      console.log(`[BLE] Found scale: ${peripheral.advertisement.localName || peripheral.id}`);
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
            (c) => c.uuid === charNotify.replace(/-/g, ''),
          );
          writeChar = characteristics.find(
            (c) => c.uuid === charWrite.replace(/-/g, ''),
          ) ?? null;

          if (!notifyChar || !writeChar) {
            cleanup(peripheral);
            reject(new Error(
              `Required characteristics not found. `
              + `Notify: ${!!notifyChar}, Write: ${!!writeChar}`,
            ));
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
            if (data[0] !== 0x10 || data.length < 10) return;

            const rawWeight: number = (data[3] << 8) + data[4];
            const rawImpedance: number = (data[8] << 8) + data[9];

            if (Number.isNaN(rawWeight) || Number.isNaN(rawImpedance)) return;

            const weight: number = rawWeight / 100.0;
            const impedance: number = rawImpedance;

            if (onLiveData) {
              onLiveData(weight, impedance);
            }

            if (weight > 10.0 && impedance > 200) {
              resolved = true;
              cleanup(peripheral);
              resolve({ weight, impedance });
            }
          });

          const unlockBuf: Buffer = Buffer.from(cmdUnlock);
          const sendUnlock = (): void => {
            if (writeChar && !resolved) {
              writeChar.write(unlockBuf, true, (err?: string) => {
                if (err && !resolved) {
                  console.error(`[BLE] Unlock write error: ${err}`);
                }
              });
            }
          };

          sendUnlock();
          unlockInterval = setInterval(sendUnlock, 2000);
        });
      });

      peripheral.on('disconnect', () => {
        if (!resolved) {
          cleanup(peripheral);
          reject(new Error('Scale disconnected unexpectedly'));
        }
      });
    });

    if ((noble as any).state === 'poweredOn') {
      console.log('[BLE] Adapter already on, scanning...');
      noble.startScanning([], false);
    }
  });
}
