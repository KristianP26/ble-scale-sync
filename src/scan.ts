import noble, { Peripheral } from '@abandonware/noble';

const SCAN_DURATION_MS = 15_000;
const seen = new Map<string, boolean>();

console.log('Scanning for BLE devices... (15 seconds)\n');

noble.on('stateChange', (state: string) => {
  if (state === 'poweredOn') {
    noble.startScanning([], true);
  } else {
    console.log(`Adapter state: ${state}`);
    process.exit(1);
  }
});

noble.on('discover', (peripheral: Peripheral) => {
  const id: string = peripheral.address || peripheral.id;
  if (seen.has(id)) return;
  seen.set(id, true);

  const name: string = peripheral.advertisement.localName || '(unknown)';
  const rssi: number = peripheral.rssi;
  console.log(`  ${id}  RSSI: ${rssi}  Name: ${name}`);
});

setTimeout(() => {
  noble.stopScanning();
  console.log(`\nDone. Found ${seen.size} device(s).`);
  console.log('Copy the MAC address of your Renpho scale into your .env file as SCALE_MAC.');
  process.exit(0);
}, SCAN_DURATION_MS);
