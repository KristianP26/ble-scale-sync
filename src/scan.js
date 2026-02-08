/**
 * BLE scanner utility — discovers nearby Bluetooth LE devices.
 * Run with: npm run scan
 *
 * Useful for finding your Renpho scale's MAC address.
 */

import noble from '@abandonware/noble';

const SCAN_DURATION_MS = 15_000;
const seen = new Map();

console.log('Scanning for BLE devices... (15 seconds)\n');

noble.on('stateChange', (state) => {
  if (state === 'poweredOn') {
    noble.startScanning([], true);
  } else {
    console.log(`Adapter state: ${state}`);
    process.exit(1);
  }
});

noble.on('discover', (peripheral) => {
  const id = peripheral.address || peripheral.id;
  if (seen.has(id)) return;
  seen.set(id, true);

  const name = peripheral.advertisement.localName || '(unknown)';
  const rssi = peripheral.rssi;
  console.log(`  ${id}  RSSI: ${rssi}  Name: ${name}`);
});

setTimeout(() => {
  noble.stopScanning();
  console.log(`\nDone. Found ${seen.size} device(s).`);
  console.log('Copy the MAC address of your Renpho scale into your .env file as SCALE_MAC.');
  process.exit(0);
}, SCAN_DURATION_MS);
