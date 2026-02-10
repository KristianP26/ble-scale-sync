import NodeBle from 'node-ble';
import { adapters } from './scales/index.js';

type Adapter = NodeBle.Adapter;

const SCAN_DURATION_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Try to start discovery with escalating recovery. Returns true if active. */
async function startDiscoverySafe(btAdapter: Adapter): Promise<boolean> {
  try {
    await btAdapter.startDiscovery();
    return true;
  } catch (e) {
    console.log(`[Scan] startDiscovery failed: ${errMsg(e)}`);
  }

  if (await btAdapter.isDiscovering()) return true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (btAdapter as any).helper.callMethod('StopDiscovery');
  } catch {
    /* ignore */
  }
  await sleep(1000);

  try {
    await btAdapter.startDiscovery();
    return true;
  } catch {
    /* fall through to power cycle */
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const helper = (btAdapter as any).helper;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Variant } = (await import('dbus-next')) as any;
    await helper.set('Powered', new Variant('b', false));
    await sleep(1000);
    await helper.set('Powered', new Variant('b', true));
    await sleep(1000);
    await btAdapter.startDiscovery();
    return true;
  } catch (e) {
    console.warn(`[Scan] Warning: Could not start discovery: ${errMsg(e)}`);
    console.warn('[Scan] Proceeding — cached devices may still appear.');
    return false;
  }
}

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
    await startDiscoverySafe(adapter);

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
