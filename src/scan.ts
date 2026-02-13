import { scanDevices } from './ble/index.js';
import type { ScanResult } from './ble/index.js';
import { adapters } from './scales/index.js';
import { createLogger } from './logger.js';
import { loadBleConfig } from './config/load.js';

const log = createLogger('Scan');

async function main(): Promise<void> {
  const bleConfig = loadBleConfig();

  // Set NOBLE_DRIVER before BLE handler import (dynamic import happens in scanDevices)
  if (bleConfig.nobleDriver) {
    process.env.NOBLE_DRIVER = bleConfig.nobleDriver;
  }

  log.info('Scanning for BLE devices... (15 seconds)\n');

  const results: ScanResult[] = await scanDevices(adapters, 15_000);
  const recognized = results.filter((r) => r.matchedAdapter);

  for (const r of results) {
    const tag = r.matchedAdapter ? ` << ${r.matchedAdapter}` : '';
    log.info(`  ${r.address}  Name: ${r.name}${tag}`);
  }

  log.info(`\nDone. Found ${results.length} device(s).`);

  if (recognized.length === 0) {
    log.info('\nNo recognized scales found. Make sure your scale is powered on.');
    log.info('Note: Some scales require SCALE_MAC for identification.');
  } else {
    log.info(`\n--- Recognized scales (${recognized.length}) ---`);
    for (const s of recognized) {
      log.info(`  ${s.address}  ${s.name}  [${s.matchedAdapter}]`);
    }
    log.info('\nTo pin to a specific scale, set scale_mac in config.yaml or SCALE_MAC in .env:');
    log.info(`  scale_mac: "${recognized[0].address}"`);
    if (recognized.length === 1) {
      log.info('\nOnly one scale found — auto-discovery will work without scale_mac.');
    }
  }
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
