/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadBleConfig } from './config/load.js';
import { createLogger } from './logger.js';
import { sleep, withTimeout, errMsg } from './ble/types.js';

const log = createLogger('Diagnose');

function hex(buf: Buffer | undefined): string {
  if (!buf || buf.length === 0) return '(none)';
  return buf.toString('hex').toUpperCase().match(/.{2}/g)!.join(' ');
}

function normalizeAddr(addr: string): string {
  return addr.replace(/[:-]/g, '').toUpperCase();
}

function resolveDriver(configured?: string): string {
  if (configured === 'abandonware' || configured === 'stoprocent') return configured;
  return process.platform === 'darwin' ? 'stoprocent' : 'abandonware';
}

async function waitForPoweredOn(noble: any): Promise<void> {
  const getState = (): string => noble.state ?? noble._state ?? 'unknown';
  if (getState() === 'poweredOn') return;

  log.info('Waiting for Bluetooth adapter...');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Bluetooth adapter state: '${getState()}' (not poweredOn)`)),
      10_000,
    );
    const onState = (state: string): void => {
      if (state === 'poweredOn') {
        clearTimeout(timeout);
        noble.removeListener('stateChange', onState);
        resolve();
      }
    };
    noble.on('stateChange', onState);
  });
}

async function main(): Promise<void> {
  const bleConfig = loadBleConfig();
  const scaleMac = (process.argv[2] ?? bleConfig.scaleMac)?.toUpperCase();

  if (bleConfig.nobleDriver) {
    process.env.NOBLE_DRIVER = bleConfig.nobleDriver;
  }

  const driver = resolveDriver(bleConfig.nobleDriver);
  const driverLabel = driver === 'abandonware' ? '@abandonware/noble' : '@stoprocent/noble';

  log.info('BLE Diagnostic Tool\n');
  log.info(`Platform:     ${process.platform} (${process.arch})`);
  log.info(`Noble driver: ${driverLabel}`);
  if (scaleMac) {
    log.info(`Target MAC:   ${scaleMac}`);
  } else {
    log.info('Target MAC:   (none)');
    log.info('');
    log.info('Tip: npm run diagnose -- MAC_ADDRESS');
    log.info('  or set scale_mac in config.yaml');
  }
  log.info('');

  const noble =
    driver === 'stoprocent'
      ? (await import('@stoprocent/noble')).default
      : (await import('@abandonware/noble')).default;

  await waitForPoweredOn(noble);
  log.info('Bluetooth adapter: ready\n');

  // ─── Phase 1: Scan ────────────────────────────────────────────────────────

  log.info('Phase 1: Scanning (15 seconds)');
  log.info('Step on the scale to wake it up.\n');

  const seen = new Set<string>();
  let targetPeripheral: any = null;
  let targetConnectable = false;

  const onDiscover = (peripheral: any): void => {
    const rawAddr =
      peripheral.address && !['', 'unknown', '<unknown>'].includes(peripheral.address)
        ? peripheral.address.toUpperCase()
        : peripheral.id;
    const addr = normalizeAddr(rawAddr);
    if (seen.has(addr)) return;
    seen.add(addr);

    const adv = peripheral.advertisement ?? {};
    const name: string = adv.localName ?? '';
    const rssi: number = peripheral.rssi ?? 0;
    const connectable: boolean = peripheral.connectable ?? false;
    const addrType: string = peripheral.addressType ?? '?';
    const svcUuids: string[] = (adv.serviceUuids ?? []).map((u: string) => u.toUpperCase());
    const mfgData: Buffer | undefined = adv.manufacturerData;
    const svcData: Array<{ uuid: string; data: Buffer }> = adv.serviceData ?? [];

    const isTarget = scaleMac ? normalizeAddr(scaleMac) === addr : false;
    const marker = isTarget ? ' <<<' : '';

    log.info(
      `  ${rawAddr}  ${name || '(no name)'}  RSSI=${rssi}  ` +
        `${connectable ? 'connectable' : 'broadcast-only'}  type=${addrType}${marker}`,
    );
    if (svcUuids.length > 0) {
      log.info(`    Service UUIDs: ${svcUuids.join(', ')}`);
    }
    if (mfgData && mfgData.length > 0) {
      log.info(`    Manufacturer data: ${hex(mfgData)}`);

      // Parse QN broadcast weight from AABB manufacturer data
      if (mfgData.length >= 26 && mfgData[2] === 0xaa && mfgData[3] === 0xbb) {
        const rawWeight = mfgData.readUInt16BE(10);
        const weight = rawWeight / 100;
        const stable = mfgData[25] === 0x01;
        log.info(
          `    QN broadcast: ${weight.toFixed(2)} kg ${stable ? '(stable)' : '(measuring)'}`,
        );
      }
    }
    for (const sd of svcData) {
      log.info(`    Service data [${sd.uuid.toUpperCase()}]: ${hex(sd.data)}`);
    }

    if (isTarget) {
      targetPeripheral = peripheral;
      targetConnectable = connectable;
    }
  };

  noble.on('discover', onDiscover);
  await noble.startScanningAsync([], true);
  await sleep(15_000);
  noble.removeListener('discover', onDiscover);
  try {
    await noble.stopScanningAsync();
  } catch {
    /* ignore */
  }

  log.info(`\nScan complete. Found ${seen.size} device(s).\n`);

  // ─── Phase 2: Connect ─────────────────────────────────────────────────────

  if (!scaleMac) {
    log.info('Set scale_mac or pass MAC as argument to test GATT connection.');
    process.exit(0);
  }

  if (!targetPeripheral) {
    log.error(`Target device ${scaleMac} was NOT found during scan.`);
    log.info('Make sure the scale is awake (step on it right before scanning).');
    process.exit(1);
  }

  log.info('Phase 2: GATT Connection\n');

  if (!targetConnectable) {
    log.warn('Device is advertising as broadcast-only (non-connectable).');
    log.warn('GATT connections will fail. Attempting anyway...\n');
  }

  log.info(`Connecting to ${scaleMac}...`);

  try {
    await withTimeout(targetPeripheral.connectAsync(), 30_000, 'Connection timed out (30s)');
  } catch (err: unknown) {
    log.error(`Connection FAILED: ${errMsg(err)}\n`);

    if (!targetConnectable) {
      log.info('The device advertised as broadcast-only (ADV_NONCONN_IND).');
      log.info('No BLE stack can connect to a non-connectable device.\n');
      log.info('This usually means:');
      log.info('  1. The scale is bonded to a phone and switched to passive broadcast mode');
      log.info('     Factory reset the scale (pinhole button or remove batteries for 5+ min)');
      log.info('     Then test BEFORE opening any scale app on any device');
      log.info('  2. The scale firmware only broadcasts data in advertisements');
      log.info('     If QN broadcast (AABB) data was shown above, ble-scale-sync can read');
      log.info('     weight from advertisements automatically (no connection needed)');
      log.info('     Body composition will use BMI-based estimation (no impedance in broadcast)');
    } else {
      log.info('Possible causes:');
      log.info('  1. Scale is bonded to another phone/tablet');
      log.info('     On ALL phones: Settings > Bluetooth > find scale > Forget/Unpair');
      log.info('  2. ESPHome BT Proxy is occupying a connection slot');
      log.info('     Temporarily disable ESPHome BT proxies');
      log.info('  3. BLE adapter/driver issue');
      log.info('     Update Bluetooth drivers or try a different adapter');
    }

    process.exit(1);
  }

  log.info('Connected!\n');

  // ─── Phase 3: GATT Enumeration ────────────────────────────────────────────

  log.info('Phase 3: GATT Services\n');
  log.info('Discovering services...');

  try {
    const services: any[] = await withTimeout(
      targetPeripheral.discoverServicesAsync(),
      30_000,
      'Service discovery timed out (30s)',
    );

    log.info(`Found ${services.length} service(s):\n`);

    for (const svc of services) {
      log.info(`  Service: 0x${svc.uuid.toUpperCase()}`);

      try {
        const chars: any[] = await withTimeout(
          svc.discoverCharacteristicsAsync(),
          15_000,
          'Characteristic discovery timed out',
        );

        for (const char of chars) {
          const props: string = char.properties?.join(', ') ?? '?';
          log.info(`    Char: 0x${char.uuid.toUpperCase()}  [${props}]`);
        }
      } catch (charErr: unknown) {
        log.warn(`    (characteristic discovery failed: ${errMsg(charErr)})`);
      }
    }
  } catch (err: unknown) {
    log.error(`Service discovery failed: ${errMsg(err)}`);
  }

  log.info('');

  try {
    await targetPeripheral.disconnectAsync();
  } catch {
    /* ignore */
  }

  log.info('Diagnostic complete. Share this output when reporting issues.');
  process.exit(0);
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exit(1);
});
