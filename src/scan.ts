import NodeBle from 'node-ble';
import { adapters } from './scales/index.js';

const SCAN_DURATION_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;

async function main(): Promise<void> {
  const { bluetooth, destroy } = NodeBle.createBluetooth();

  try {
    const adapter = await bluetooth.defaultAdapter();

    if (!(await adapter.isPowered())) {
      console.log('Bluetooth adapter is not powered on.');
      console.log('Ensure bluetoothd is running: sudo systemctl start bluetooth');
      process.exit(1);
    }

    console.log('Scanning for BLE devices... (15 seconds)\n');
    try {
      await adapter.stopDiscovery();
    } catch {
      /* not discovering — ignore */
    }
    await adapter.startDiscovery();

    const seen = new Set<string>();
    const recognized: { addr: string; name: string; adapter: string }[] = [];
    const deadline = Date.now() + SCAN_DURATION_MS;

    while (Date.now() < deadline) {
      const addresses = await adapter.devices();

      for (const addr of addresses) {
        if (seen.has(addr)) continue;
        seen.add(addr);

        try {
          const device = await adapter.getDevice(addr);
          const name = await device.getName().catch(() => '(unknown)');

          const deviceInfo = { localName: name, serviceUuids: [] as string[] };
          const matched = adapters.find((a) => a.matches(deviceInfo));
          const tag = matched ? ` << ${matched.name}` : '';

          if (matched) {
            recognized.push({ addr, name, adapter: matched.name });
          }

          console.log(`  ${addr}  Name: ${name}${tag}`);
        } catch {
          /* device may have gone away */
        }
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    try {
      await adapter.stopDiscovery();
    } catch {
      /* ignore */
    }

    console.log(`\nDone. Found ${seen.size} device(s).`);

    if (recognized.length === 0) {
      console.log('\nNo recognized scales found. Make sure your scale is powered on.');
      console.log('Note: Some scales require SCALE_MAC for identification.');
    } else {
      console.log(`\n--- Recognized scales (${recognized.length}) ---`);
      for (const s of recognized) {
        console.log(`  ${s.addr}  ${s.name}  [${s.adapter}]`);
      }
      console.log('\nTo pin to a specific scale, add to .env:');
      console.log(`  SCALE_MAC=${recognized[0].addr}`);
      if (recognized.length === 1) {
        console.log('\nOnly one scale found — auto-discovery will work without SCALE_MAC.');
      }
    }
  } finally {
    destroy();
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
