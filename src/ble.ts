import noble, { Peripheral, Characteristic } from '@abandonware/noble';
import type {
  ScaleAdapter,
  UserProfile,
  GarminPayload,
  ScaleReading,
  ConnectionContext,
} from './interfaces/scale-adapter.js';
import type { WeightUnit } from './validate-env.js';

const LBS_TO_KG = 0.453592;
const BT_BASE_UUID_SUFFIX = '00001000800000805f9b34fb';
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_CONNECT_RETRIES = 5;

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

      // Timeout in case peripheral.connect() callback never fires
      connectTimer = setTimeout(() => {
        if (resolved || !connecting || myGen !== connectGen) return;
        retryOrFail('Connection timed out', peripheral);
      }, CONNECT_TIMEOUT_MS);

      debug('Issuing peripheral.connect()...');
      peripheral.connect((err?: string) => {
        // Ignore callback from a superseded connection attempt
        if (myGen !== connectGen) {
          debug(`Ignoring stale connect callback (gen ${myGen} vs ${connectGen})`);
          if (!err && peripheral.state === 'connected') {
            try {
              peripheral.disconnect(() => {});
            } catch {
              /* ignore */
            }
          }
          return;
        }

        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }

        if (err) {
          retryOrFail(`Connect error: ${err}`, peripheral);
          return;
        }

        // Register disconnect handler AFTER successful connect to avoid
        // spurious disconnect events on an unconnected peripheral
        const onDisconnect = (): void => {
          peripheral.removeListener('disconnect', onDisconnect);
          if (resolved || myGen !== connectGen) return;
          retryOrFail('Scale disconnected', peripheral);
        };
        peripheral.on('disconnect', onDisconnect);

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

        // Build a normalized-UUID → Characteristic map for fast lookups
        const charByUuid = new Map<string, Characteristic>();
        for (const c of characteristics) {
          charByUuid.set(normalizeUuid(c.uuid), c);
        }

        /** Resolve a discovered characteristic by adapter-specified UUID. */
        const resolveChar = (uuid: string): Characteristic | undefined =>
          charByUuid.get(normalizeUuid(uuid));

        /**
         * Shared notification handler — dispatches via parseCharNotification
         * when available, otherwise falls back to parseNotification.
         */
        const handleNotification = (sourceUuid: string, data: Buffer): void => {
          if (resolved) return;

          const reading: ScaleReading | null = adapter.parseCharNotification
            ? adapter.parseCharNotification(sourceUuid, data)
            : adapter.parseNotification(data);
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
        };

        /** Subscribe to a characteristic and wire up the notification handler. */
        const subscribeAndListen = (char: Characteristic): Promise<void> =>
          new Promise<void>((subResolve, subReject) => {
            const normalized = normalizeUuid(char.uuid);
            char.on('data', (data: Buffer) => handleNotification(normalized, data));
            char.subscribe((subErr?: string) => {
              if (subErr) subReject(new Error(`Subscribe failed on ${char.uuid}: ${subErr}`));
              else subResolve();
            });
          });

        /**
         * Start adapter init: call onConnected() hook when available,
         * otherwise fall back to legacy unlockCommand periodic writes.
         */
        const startInit = async (): Promise<void> => {
          if (adapter.onConnected) {
            const ctx: ConnectionContext = {
              profile,
              write: async (charUuid, data, withResponse = true) => {
                const char = resolveChar(charUuid);
                if (!char) throw new Error(`Characteristic ${charUuid} not found`);
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                return new Promise<void>((wRes, wRej) => {
                  char.write(buf, !withResponse, (wErr?: string) => {
                    if (wErr) wRej(new Error(`Write to ${charUuid} failed: ${wErr}`));
                    else wRes();
                  });
                });
              },
              read: async (charUuid) => {
                const char = resolveChar(charUuid);
                if (!char) throw new Error(`Characteristic ${charUuid} not found`);
                return new Promise<Buffer>((rRes, rRej) => {
                  char.read((rErr?: string, rData?: Buffer) => {
                    if (rErr) rRej(new Error(`Read from ${charUuid} failed: ${rErr}`));
                    else rRes(rData ?? Buffer.alloc(0));
                  });
                });
              },
              subscribe: async (charUuid) => {
                const char = resolveChar(charUuid);
                if (!char) throw new Error(`Characteristic ${charUuid} not found`);
                await subscribeAndListen(char);
              },
            };
            debug('Calling adapter.onConnected()');
            await adapter.onConnected(ctx);
            debug('adapter.onConnected() completed');
          } else {
            // Legacy unlock command interval
            const writeChar =
              resolveChar(adapter.charWriteUuid) ??
              (adapter.altCharWriteUuid ? resolveChar(adapter.altCharWriteUuid) : undefined);
            if (!writeChar) return; // Should not happen — already validated above

            const unlockBuf: Buffer = Buffer.from(adapter.unlockCommand);
            const sendUnlock = (): void => {
              if (!resolved) {
                writeChar.write(unlockBuf, true, (wErr?: string) => {
                  if (wErr && !resolved) {
                    console.error(`[BLE] Unlock write error: ${wErr}`);
                  }
                });
              }
            };

            sendUnlock();
            unlockInterval = setInterval(sendUnlock, adapter.unlockIntervalMs);
          }
        };

        /** Handle errors from the async init chain. */
        const handleInitError = (e: unknown): void => {
          if (!resolved) {
            fullCleanup(peripheral);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        };

        // ─── Multi-char mode (adapter.characteristics defined) ──────────
        if (adapter.characteristics) {
          debug(`Multi-char mode: ${adapter.characteristics.length} bindings`);

          const notifyChars: Characteristic[] = [];
          for (const binding of adapter.characteristics) {
            const char = resolveChar(binding.uuid);
            if (!char) {
              debug(`Characteristic not found: ${binding.type}:${binding.uuid}`);
              continue;
            }
            if (binding.type === 'notify') {
              notifyChars.push(char);
            }
          }

          if (notifyChars.length === 0) {
            const discoveredUuids = characteristics.map((c) => c.uuid).join(', ');
            fullCleanup(peripheral);
            reject(
              new Error(
                `No notify characteristics found from adapter bindings. ` +
                  `Discovered: [${discoveredUuids}]`,
              ),
            );
            return;
          }

          Promise.all(notifyChars.map(subscribeAndListen))
            .then(() => {
              console.log(
                `[BLE] Subscribed to ${notifyChars.length} notification(s). Step on the scale.`,
              );
              return startInit();
            })
            .catch(handleInitError);

          return;
        }

        // ─── Legacy mode (single notify + write pair) ───────────────────
        debug(
          `Looking for notify=${adapter.charNotifyUuid}` +
            (adapter.altCharNotifyUuid ? ` (alt=${adapter.altCharNotifyUuid})` : '') +
            `, write=${adapter.charWriteUuid}` +
            (adapter.altCharWriteUuid ? ` (alt=${adapter.altCharWriteUuid})` : ''),
        );

        const notifyChar: Characteristic | undefined =
          resolveChar(adapter.charNotifyUuid) ??
          (adapter.altCharNotifyUuid ? resolveChar(adapter.altCharNotifyUuid) : undefined);
        const writeChar: Characteristic | undefined =
          resolveChar(adapter.charWriteUuid) ??
          (adapter.altCharWriteUuid ? resolveChar(adapter.altCharWriteUuid) : undefined);

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

        subscribeAndListen(notifyChar)
          .then(() => {
            console.log('[BLE] Subscribed to notifications. Step on the scale.');
            return startInit();
          })
          .catch(handleInitError);
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

      // Set connecting early to prevent duplicate discover handlers from proceeding
      // while we wait for the scan to fully stop.
      connecting = true;

      const adapter = matchedAdapter;
      const doConnect = (): void => {
        // Reset so connectToPeripheral can set it properly
        connecting = false;
        connectToPeripheral(peripheral, adapter);
      };

      // Wait for scanning to fully stop before issuing LE Create Connection.
      // On Linux HCI (Raspberry Pi), the controller may ignore or drop the
      // connect command while scan-disable is still in flight.
      let scanStopFired = false;
      noble.once('scanStop', () => {
        if (scanStopFired) return;
        scanStopFired = true;
        debug('Scan stopped (event), connecting...');
        doConnect();
      });
      noble.stopScanning();

      // Fallback: if scanStop event doesn't fire within 300ms, connect anyway.
      setTimeout(() => {
        if (!scanStopFired && !resolved) {
          scanStopFired = true;
          debug('scanStop timeout, connecting anyway...');
          doConnect();
        }
      }, 300);
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
