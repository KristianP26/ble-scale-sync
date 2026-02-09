import noble, { Peripheral, Characteristic } from '@abandonware/noble';
import type {
  ScaleAdapter,
  UserProfile,
  GarminPayload,
  ScaleReading,
} from './interfaces/scale-adapter.js';
import type { WeightUnit } from './validate-env.js';

const LBS_TO_KG = 0.453592;
const BT_BASE_UUID_SUFFIX = '00001000800000805f9b34fb';
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_CONNECT_RETRIES = 5;
/** Delay after stopScanning before calling connect — on Linux HCI the adapter
 *  needs time to transition from scanning mode to connection mode. */
const SCAN_SETTLE_MS = 500;

function debug(msg: string): void {
  if (process.env.DEBUG) console.log(`[BLE:debug] ${msg}`);
}

/** Normalize a UUID to lowercase 32-char (no dashes) form for comparison. */
function normalizeUuid(uuid: string): string {
  const stripped = uuid.replace(/-/g, '').toLowerCase();
  // Expand 4-char short UUIDs to full 128-bit form
  if (stripped.length === 4) {
    return `0000${stripped}${BT_BASE_UUID_SUFFIX}`;
  }
  return stripped;
}

/** Compare two BLE UUIDs, handling short (4-char) vs long (32-char) forms. */
function uuidMatch(a: string, b: string): boolean {
  return normalizeUuid(a) === normalizeUuid(b);
}

export interface ScanOptions {
  targetMac?: string;
  adapters: ScaleAdapter[];
  profile: UserProfile;
  weightUnit?: WeightUnit;
  onLiveData?: (reading: ScaleReading) => void;
}

export function scanAndRead(opts: ScanOptions): Promise<GarminPayload> {
  const { targetMac, adapters, profile, weightUnit, onLiveData } = opts;
  const targetId: string | undefined = targetMac?.toLowerCase().replace(/:/g, '');

  return new Promise<GarminPayload>((resolve, reject) => {
    let unlockInterval: ReturnType<typeof setInterval> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let scanHeartbeat: ReturnType<typeof setInterval> | null = null;
    let resolved = false;
    let retryCount = 0;
    let connecting = false;
    let connectGen = 0;

    function clearTimers(): void {
      if (unlockInterval) {
        clearInterval(unlockInterval);
        unlockInterval = null;
      }
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (scanHeartbeat) {
        clearInterval(scanHeartbeat);
        scanHeartbeat = null;
      }
    }

    function fullCleanup(peripheral?: Peripheral): void {
      clearTimers();
      connecting = false;
      noble.stopScanning();
      noble.removeListener('stateChange', onStateChange);
      noble.removeListener('discover', onDiscover);
      if (peripheral && peripheral.state === 'connected') {
        peripheral.disconnect(() => {});
      }
    }

    function retryOrFail(reason: string, peripheral?: Peripheral): void {
      clearTimers();
      connecting = false;
      connectGen++; // invalidate any pending callbacks from old attempts

      if (peripheral && peripheral.state === 'connected') {
        try {
          peripheral.disconnect(() => {});
        } catch {
          /* ignore */
        }
      }

      retryCount++;
      if (retryCount > MAX_CONNECT_RETRIES) {
        fullCleanup(peripheral);
        reject(new Error(`${reason} (failed after ${retryCount} attempts)`));
        return;
      }

      console.log(`[BLE] ${reason}. Retrying (${retryCount}/${MAX_CONNECT_RETRIES})...`);

      // Stop and restart scanning to allow re-discovery of the same peripheral
      noble.stopScanning();
      setTimeout(() => {
        if (!resolved) {
          debug('Restarting scan...');
          noble.startScanning([], true);
          startHeartbeat();
        }
      }, 1000);
    }

    function startHeartbeat(): void {
      if (scanHeartbeat) clearInterval(scanHeartbeat);
      scanHeartbeat = setInterval(() => {
        if (!resolved && !connecting) {
          console.log('[BLE] Still scanning...');
        }
      }, 10_000);
    }

    function onStateChange(state: string): void {
      if (state === 'poweredOn') {
        console.log('[BLE] Adapter powered on, scanning...');
        noble.startScanning([], false);
        startHeartbeat();
      } else {
        console.log(`[BLE] Adapter state: ${state}`);
        noble.stopScanning();
      }
    }

    noble.on('stateChange', onStateChange);

    function connectToPeripheral(peripheral: Peripheral, adapter: ScaleAdapter): void {
      if (resolved || connecting) return;
      connecting = true;
      const myGen = ++connectGen;

      // Register disconnect handler BEFORE calling connect so we catch early disconnects
      const onDisconnect = (): void => {
        peripheral.removeListener('disconnect', onDisconnect);
        if (resolved || myGen !== connectGen) return;
        retryOrFail('Scale disconnected', peripheral);
      };
      peripheral.on('disconnect', onDisconnect);

      // Timeout in case peripheral.connect() callback never fires
      connectTimer = setTimeout(() => {
        if (resolved || !connecting || myGen !== connectGen) return;
        peripheral.removeListener('disconnect', onDisconnect);
        retryOrFail('Connection timed out', peripheral);
      }, CONNECT_TIMEOUT_MS);

      peripheral.connect((err?: string) => {
        // Ignore callback from a superseded connection attempt
        if (myGen !== connectGen) {
          debug(`Ignoring stale connect callback (gen ${myGen} vs ${connectGen})`);
          if (!err && peripheral.state === 'connected') {
            try { peripheral.disconnect(() => {}); } catch { /* ignore */ }
          }
          return;
        }

        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }

        if (err) {
          peripheral.removeListener('disconnect', onDisconnect);
          retryOrFail(`Connect error: ${err}`, peripheral);
          return;
        }

        console.log('[BLE] Connected. Discovering services...');
        setupCharacteristics(peripheral, adapter);
      });
    }

    function setupCharacteristics(peripheral: Peripheral, adapter: ScaleAdapter): void {
      peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
        if (err) {
          retryOrFail(`Service discovery failed: ${err}`, peripheral);
          return;
        }

        debug(`Services: [${(services || []).map((s) => s.uuid).join(', ')}]`);
        for (const c of characteristics) {
          debug(`  Char ${c.uuid} — properties: [${c.properties?.join(', ') ?? 'n/a'}]`);
        }

        debug(
          `Looking for notify=${adapter.charNotifyUuid}` +
            (adapter.altCharNotifyUuid ? ` (alt=${adapter.altCharNotifyUuid})` : '') +
            `, write=${adapter.charWriteUuid}` +
            (adapter.altCharWriteUuid ? ` (alt=${adapter.altCharWriteUuid})` : ''),
        );

        const findChar = (uuid: string): Characteristic | undefined =>
          characteristics.find((c) => uuidMatch(c.uuid, uuid));

        const notifyChar: Characteristic | undefined =
          findChar(adapter.charNotifyUuid) ??
          (adapter.altCharNotifyUuid ? findChar(adapter.altCharNotifyUuid) : undefined);
        const writeChar: Characteristic | undefined =
          findChar(adapter.charWriteUuid) ??
          (adapter.altCharWriteUuid ? findChar(adapter.altCharWriteUuid) : undefined);

        if (!notifyChar || !writeChar) {
          const discoveredUuids = characteristics.map((c) => c.uuid).join(', ');
          fullCleanup(peripheral);
          reject(
            new Error(
              `Required characteristics not found. ` +
                `Notify (${adapter.charNotifyUuid}): ${!!notifyChar}, ` +
                `Write (${adapter.charWriteUuid}): ${!!writeChar}. ` +
                `Discovered characteristics: [${discoveredUuids}]`,
            ),
          );
          return;
        }

        debug(`Matched notify=${notifyChar.uuid}, write=${writeChar.uuid}`);

        notifyChar.subscribe((err?: string) => {
          if (err) {
            fullCleanup(peripheral);
            reject(new Error(`Subscribe failed: ${err}`));
            return;
          }
          console.log('[BLE] Subscribed to notifications. Step on the scale.');
        });

        notifyChar.on('data', (data: Buffer) => {
          if (resolved) return;

          const reading: ScaleReading | null = adapter.parseNotification(data);
          if (!reading) return;

          // Convert lbs → kg when the user declared lbs and the adapter
          // doesn't already normalise to kg internally.
          if (weightUnit === 'lbs' && !adapter.normalizesWeight) {
            reading.weight *= LBS_TO_KG;
          }

          if (onLiveData) {
            onLiveData(reading);
          }

          if (adapter.isComplete(reading)) {
            resolved = true;
            fullCleanup(peripheral);

            try {
              const payload: GarminPayload = adapter.computeMetrics(reading, profile);
              resolve(payload);
            } catch (e) {
              reject(e);
            }
          }
        });

        const unlockBuf: Buffer = Buffer.from(adapter.unlockCommand);
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
        unlockInterval = setInterval(sendUnlock, adapter.unlockIntervalMs);
      });
    }

    function onDiscover(peripheral: Peripheral): void {
      const id: string =
        peripheral.id?.replace(/:/g, '').toLowerCase() ||
        peripheral.address?.replace(/:/g, '').toLowerCase() ||
        '';

      const advUuids = peripheral.advertisement.serviceUuids || [];
      debug(
        `Discovered: ${peripheral.advertisement.localName || '(unnamed)'} [${id}] services=[${advUuids.join(', ')}]`,
      );

      // Skip if we're already in the middle of connecting
      if (connecting) return;

      let matchedAdapter: ScaleAdapter | undefined;

      if (targetId) {
        // Pinned mode: only consider the specific MAC
        if (id !== targetId) return;

        matchedAdapter = adapters.find((a) => a.matches(peripheral));
        if (!matchedAdapter) {
          const deviceName: string = peripheral.advertisement.localName || '(unknown)';
          fullCleanup();
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

      // On Linux HCI, the adapter needs time to transition out of scanning mode
      // before it can initiate a connection. Without this delay peripheral.connect()
      // may silently hang (same transition bleak/BlueZ handles internally).
      const adapterForConnect = matchedAdapter;
      setTimeout(() => {
        if (!resolved && !connecting) {
          connectToPeripheral(peripheral, adapterForConnect);
        }
      }, SCAN_SETTLE_MS);
    }

    noble.on('discover', onDiscover);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((noble as any).state === 'poweredOn') {
      console.log('[BLE] Adapter already on, scanning...');
      noble.startScanning([], false);
      startHeartbeat();
    }
  });
}
