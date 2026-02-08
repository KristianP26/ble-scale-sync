/**
 * BLE communication module for Renpho-compatible smart scales.
 * Uses @abandonware/noble which supports Linux, macOS, and Windows.
 */

import noble from '@abandonware/noble';

/**
 * Connect to a Renpho scale, unlock its data stream, and resolve
 * once a valid measurement (weight > 10 kg, impedance > 200 Ohm)
 * is received.
 *
 * @param {object} opts
 * @param {string} opts.scaleMac      - Target MAC address (e.g. "FF:03:00:13:A1:04")
 * @param {string} opts.charNotify    - Notify characteristic UUID
 * @param {string} opts.charWrite     - Write characteristic UUID
 * @param {number[]} opts.cmdUnlock   - Unlock command bytes
 * @param {function} [opts.onLiveData] - Optional callback for live readings
 * @returns {Promise<{weight: number, impedance: number}>}
 */
export function connectAndRead(opts) {
  const {
    scaleMac,
    charNotify,
    charWrite,
    cmdUnlock,
    onLiveData,
  } = opts;

  const targetId = scaleMac.toLowerCase().replace(/:/g, '');

  return new Promise((resolve, reject) => {
    let unlockInterval = null;
    let resolved = false;
    let writeChar = null;

    function cleanup(peripheral) {
      if (unlockInterval) {
        clearInterval(unlockInterval);
        unlockInterval = null;
      }
      noble.stopScanning();
      if (peripheral && peripheral.state === 'connected') {
        peripheral.disconnect(() => {});
      }
    }

    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        console.log('[BLE] Adapter powered on, scanning...');
        noble.startScanning([], false);
      } else {
        console.log(`[BLE] Adapter state: ${state}`);
        noble.stopScanning();
      }
    });

    noble.on('discover', (peripheral) => {
      const id = peripheral.id?.replace(/:/g, '').toLowerCase()
        || peripheral.address?.replace(/:/g, '').toLowerCase()
        || '';

      if (id !== targetId) return;

      console.log(`[BLE] Found scale: ${peripheral.advertisement.localName || peripheral.id}`);
      noble.stopScanning();

      peripheral.connect((err) => {
        if (err) {
          reject(new Error(`BLE connect failed: ${err.message}`));
          return;
        }

        console.log('[BLE] Connected. Discovering services...');

        peripheral.discoverAllServicesAndCharacteristics((err, _services, characteristics) => {
          if (err) {
            cleanup(peripheral);
            reject(new Error(`Service discovery failed: ${err.message}`));
            return;
          }

          const notifyChar = characteristics.find(
            (c) => c.uuid === charNotify.replace(/-/g, '')
          );
          writeChar = characteristics.find(
            (c) => c.uuid === charWrite.replace(/-/g, '')
          );

          if (!notifyChar || !writeChar) {
            cleanup(peripheral);
            reject(new Error(
              `Required characteristics not found. ` +
              `Notify: ${!!notifyChar}, Write: ${!!writeChar}`
            ));
            return;
          }

          // Subscribe to notifications
          notifyChar.subscribe((err) => {
            if (err) {
              cleanup(peripheral);
              reject(new Error(`Subscribe failed: ${err.message}`));
              return;
            }
            console.log('[BLE] Subscribed to notifications. Step on the scale.');
          });

          notifyChar.on('data', (data) => {
            if (resolved) return;
            if (data[0] !== 0x10 || data.length < 10) return;

            const weight = ((data[3] << 8) + data[4]) / 100.0;
            const impedance = (data[8] << 8) + data[9];

            if (onLiveData) {
              onLiveData(weight, impedance);
            }

            if (weight > 10.0 && impedance > 200) {
              resolved = true;
              cleanup(peripheral);
              resolve({ weight, impedance });
            }
          });

          // Periodically send unlock command
          const unlockBuf = Buffer.from(cmdUnlock);
          const sendUnlock = () => {
            if (writeChar && !resolved) {
              writeChar.write(unlockBuf, true, (err) => {
                if (err && !resolved) {
                  console.error(`[BLE] Unlock write error: ${err.message}`);
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

    // If the adapter is already powered on
    if (noble.state === 'poweredOn') {
      console.log('[BLE] Adapter already on, scanning...');
      noble.startScanning([], false);
    }
  });
}
