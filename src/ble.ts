import NodeBle from 'node-ble';
import type {
  ScaleAdapter,
  UserProfile,
  GarminPayload,
  ScaleReading,
  ConnectionContext,
  BleDeviceInfo,
} from './interfaces/scale-adapter.js';
import type { WeightUnit } from './validate-env.js';

type Device = NodeBle.Device;
type Adapter = NodeBle.Adapter;
type GattCharacteristic = NodeBle.GattCharacteristic;

const LBS_TO_KG = 0.453592;
const BT_BASE_UUID_SUFFIX = '00001000800000805f9b34fb';
const CONNECT_TIMEOUT_MS = 30_000;
const MAX_CONNECT_RETRIES = 5;
const DISCOVERY_TIMEOUT_MS = 120_000;
const DISCOVERY_POLL_MS = 2_000;

function debug(msg: string): void {
  if (process.env.DEBUG) console.log(`[BLE:debug] ${msg}`);
}

/** Normalize a UUID to lowercase 32-char (no dashes) form for comparison. */
function normalizeUuid(uuid: string): string {
  const stripped = uuid.replace(/-/g, '').toLowerCase();
  if (stripped.length === 4) {
    return `0000${stripped}${BT_BASE_UUID_SUFFIX}`;
  }
  return stripped;
}

/** Format MAC address for BlueZ D-Bus (uppercase with colons). */
function formatMac(mac: string): string {
  const clean = mac.replace(/[:-]/g, '').toUpperCase();
  return clean.match(/.{2}/g)!.join(':');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Try to start BlueZ discovery with escalating recovery strategies.
 * Returns true if discovery is active, false if all attempts failed.
 * waitDevice()/devices() still work without active discovery (they poll
 * BlueZ's device cache), so callers can proceed even on false.
 */
async function startDiscoverySafe(btAdapter: Adapter): Promise<boolean> {
  // 1. Normal start
  try {
    await btAdapter.startDiscovery();
    debug('Discovery started');
    return true;
  } catch (e) {
    debug(`startDiscovery failed: ${errMsg(e)}`);
  }

  // Already running (another D-Bus client owns the session)
  if (await btAdapter.isDiscovering()) {
    debug('Discovery already active (owned by another client), continuing');
    return true;
  }

  // 2. Force-stop via D-Bus (bypass node-ble's isDiscovering guard) + retry
  debug('Attempting D-Bus StopDiscovery to reset stale state...');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (btAdapter as any).helper.callMethod('StopDiscovery');
    debug('D-Bus StopDiscovery succeeded');
  } catch (e) {
    debug(`D-Bus StopDiscovery failed: ${errMsg(e)}`);
  }
  await sleep(1000);

  try {
    await btAdapter.startDiscovery();
    debug('Discovery started after D-Bus reset');
    return true;
  } catch (e) {
    debug(`startDiscovery after D-Bus reset failed: ${errMsg(e)}`);
  }

  // 3. Power-cycle the adapter + retry
  debug('Attempting adapter power cycle...');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const helper = (btAdapter as any).helper;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Variant } = (await import('dbus-next')) as any;
    await helper.set('Powered', new Variant('b', false));
    debug('Adapter powered off');
    await sleep(1000);
    await helper.set('Powered', new Variant('b', true));
    debug('Adapter powered on');
    await sleep(1000);

    await btAdapter.startDiscovery();
    debug('Discovery started after power cycle');
    return true;
  } catch (e) {
    debug(`Power cycle / startDiscovery failed: ${errMsg(e)}`);
  }

  // All strategies failed — warn but don't throw
  console.warn(
    '[BLE] Warning: Could not start active discovery. ' +
      'Proceeding with passive scanning (device may take longer to appear).',
  );
  return false;
}

export interface ScanOptions {
  targetMac?: string;
  adapters: ScaleAdapter[];
  profile: UserProfile;
  weightUnit?: WeightUnit;
  onLiveData?: (reading: ScaleReading) => void;
}

/**
 * Scan for a BLE scale, read weight + impedance, and compute body composition.
 * Uses node-ble (BlueZ D-Bus) — requires bluetoothd running on Linux.
 */
export async function scanAndRead(opts: ScanOptions): Promise<GarminPayload> {
  const { targetMac, adapters, profile, weightUnit, onLiveData } = opts;
  const { bluetooth, destroy } = NodeBle.createBluetooth();
  let device: Device | null = null;

  try {
    const btAdapter = await bluetooth.defaultAdapter();

    if (!(await btAdapter.isPowered())) {
      throw new Error(
        'Bluetooth adapter is not powered on. ' +
          'Ensure bluetoothd is running: sudo systemctl start bluetooth',
      );
    }

    await startDiscoverySafe(btAdapter);

    let matchedAdapter: ScaleAdapter;

    if (targetMac) {
      const mac = formatMac(targetMac);
      console.log('[BLE] Scanning for device...');

      device = await withTimeout(
        btAdapter.waitDevice(mac),
        DISCOVERY_TIMEOUT_MS,
        `Device ${mac} not found within ${DISCOVERY_TIMEOUT_MS / 1000}s`,
      );

      const name = await device.getName().catch(() => '');
      debug(`Found device: ${name} [${mac}]`);

      await connectWithRetries(device, MAX_CONNECT_RETRIES);
      console.log('[BLE] Connected. Discovering services...');

      // Match adapter using device name + GATT service UUIDs (post-connect)
      const gatt = await device.gatt();
      const serviceUuids = await gatt.services();
      debug(`Services: [${serviceUuids.join(', ')}]`);

      const info: BleDeviceInfo = {
        localName: name,
        serviceUuids: serviceUuids.map(normalizeUuid),
      };
      const found = adapters.find((a) => a.matches(info));
      if (!found) {
        throw new Error(
          `Device found (${name}) but no adapter recognized it. ` +
            `Services: [${serviceUuids.join(', ')}]. ` +
            `Adapters: ${adapters.map((a) => a.name).join(', ')}`,
        );
      }
      matchedAdapter = found;
      console.log(`[BLE] Matched adapter: ${matchedAdapter.name}`);
    } else {
      // Auto-discovery: poll discovered devices, match by name, connect, verify
      const result = await autoDiscover(btAdapter, adapters);
      device = result.device;
      matchedAdapter = result.adapter;

      await connectWithRetries(device, MAX_CONNECT_RETRIES);
      console.log('[BLE] Connected. Discovering services...');
    }

    // Stop discovery to save radio resources
    try {
      await btAdapter.stopDiscovery();
    } catch {
      /* may already be stopped */
    }

    // Setup GATT characteristics and wait for a complete reading
    const gatt = await device.gatt();
    const payload = await setupAndRead(
      gatt,
      device,
      matchedAdapter,
      profile,
      weightUnit,
      onLiveData,
    );

    try {
      await device.disconnect();
    } catch {
      /* ignore */
    }
    return payload;
  } finally {
    destroy();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function connectWithRetries(device: Device, maxRetries: number): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      debug(`Connect attempt ${attempt + 1}/${maxRetries + 1}...`);
      await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, 'Connection timed out');
      debug('Connected');
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= maxRetries) {
        throw new Error(`Connection failed after ${maxRetries + 1} attempts: ${msg}`);
      }
      console.log(`[BLE] Connect error: ${msg}. Retrying (${attempt + 1}/${maxRetries})...`);
      try {
        await device.disconnect();
      } catch {
        /* ignore */
      }
      await sleep(1000);
    }
  }
}

async function autoDiscover(
  btAdapter: Adapter,
  adapters: ScaleAdapter[],
): Promise<{ device: Device; adapter: ScaleAdapter }> {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  const checked = new Set<string>();
  let heartbeat = 0;

  while (Date.now() < deadline) {
    const addresses: string[] = await btAdapter.devices();

    for (const addr of addresses) {
      if (checked.has(addr)) continue;
      checked.add(addr);

      try {
        const dev = await btAdapter.getDevice(addr);
        const name = await dev.getName().catch(() => '');
        if (!name) continue;

        debug(`Discovered: ${name} [${addr}]`);

        // Try matching with name only (serviceUuids not available pre-connect on D-Bus).
        // Adapters that require serviceUuids will fail to match here and need SCALE_MAC.
        const info: BleDeviceInfo = { localName: name, serviceUuids: [] };
        const matched = adapters.find((a) => a.matches(info));
        if (matched) {
          console.log(`[BLE] Auto-discovered: ${matched.name} (${name} [${addr}])`);
          return { device: dev, adapter: matched };
        }
      } catch {
        /* device may have gone away */
      }
    }

    heartbeat++;
    if (heartbeat % 5 === 0) {
      console.log('[BLE] Still scanning...');
    }
    await sleep(DISCOVERY_POLL_MS);
  }

  throw new Error(`No recognized scale found within ${DISCOVERY_TIMEOUT_MS / 1000}s`);
}

// ─── GATT Setup & Reading ─────────────────────────────────────────────────────

async function setupAndRead(
  gatt: NodeBle.GattServer,
  device: Device,
  adapter: ScaleAdapter,
  profile: UserProfile,
  weightUnit?: WeightUnit,
  onLiveData?: (reading: ScaleReading) => void,
): Promise<GarminPayload> {
  // Build UUID → GattCharacteristic map across all services
  const charMap = new Map<string, GattCharacteristic>();
  const serviceUuids = await gatt.services();

  for (const svcUuid of serviceUuids) {
    try {
      const service = await gatt.getPrimaryService(svcUuid);
      const charUuids = await service.characteristics();
      debug(`  Service ${svcUuid}: chars=[${charUuids.join(', ')}]`);

      for (const charUuid of charUuids) {
        const char = await service.getCharacteristic(charUuid);
        charMap.set(normalizeUuid(charUuid), char);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      debug(`  Service ${svcUuid}: error=${msg}`);
    }
  }

  const resolveChar = (uuid: string): GattCharacteristic | undefined =>
    charMap.get(normalizeUuid(uuid));

  return new Promise<GarminPayload>((resolve, reject) => {
    let resolved = false;
    let unlockInterval: ReturnType<typeof setInterval> | null = null;

    const cleanup = (): void => {
      if (unlockInterval) {
        clearInterval(unlockInterval);
        unlockInterval = null;
      }
    };

    // Handle unexpected disconnect
    device.on('disconnect', () => {
      if (!resolved) {
        cleanup();
        reject(new Error('Scale disconnected before reading completed'));
      }
    });

    const handleNotification = (sourceUuid: string, data: Buffer): void => {
      if (resolved) return;

      const reading: ScaleReading | null = adapter.parseCharNotification
        ? adapter.parseCharNotification(sourceUuid, data)
        : adapter.parseNotification(data);
      if (!reading) return;

      if (weightUnit === 'lbs' && !adapter.normalizesWeight) {
        reading.weight *= LBS_TO_KG;
      }

      if (onLiveData) onLiveData(reading);

      if (adapter.isComplete(reading)) {
        resolved = true;
        cleanup();
        try {
          resolve(adapter.computeMetrics(reading, profile));
        } catch (e) {
          reject(e);
        }
      }
    };

    const subscribeAndListen = async (charUuid: string): Promise<void> => {
      const char = resolveChar(charUuid);
      if (!char) throw new Error(`Characteristic ${charUuid} not found`);
      const normalized = normalizeUuid(charUuid);
      char.on('valuechanged', (data: Buffer) => handleNotification(normalized, data));
      await char.startNotifications();
    };

    const startInit = async (): Promise<void> => {
      if (adapter.onConnected) {
        const ctx: ConnectionContext = {
          profile,
          write: async (charUuid, data, withResponse = true) => {
            const char = resolveChar(charUuid);
            if (!char) throw new Error(`Characteristic ${charUuid} not found`);
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (withResponse) {
              await char.writeValue(buf);
            } else {
              await char.writeValueWithoutResponse(buf);
            }
          },
          read: async (charUuid) => {
            const char = resolveChar(charUuid);
            if (!char) throw new Error(`Characteristic ${charUuid} not found`);
            return char.readValue();
          },
          subscribe: async (charUuid) => {
            await subscribeAndListen(charUuid);
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
        if (!writeChar) return;

        const unlockBuf = Buffer.from(adapter.unlockCommand);
        const sendUnlock = async (): Promise<void> => {
          if (resolved) return;
          try {
            await writeChar.writeValueWithoutResponse(unlockBuf);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!resolved) console.error(`[BLE] Unlock write error: ${msg}`);
          }
        };

        sendUnlock();
        unlockInterval = setInterval(() => void sendUnlock(), adapter.unlockIntervalMs);
      }
    };

    // Subscribe to notifications and start adapter init
    (async () => {
      try {
        if (adapter.characteristics) {
          // Multi-char mode
          debug(`Multi-char mode: ${adapter.characteristics.length} bindings`);
          const notifyBindings = adapter.characteristics.filter((b) => b.type === 'notify');

          if (notifyBindings.length === 0) {
            throw new Error(
              `No notify characteristics in adapter bindings. Discovered: [${[...charMap.keys()].join(', ')}]`,
            );
          }

          for (const binding of notifyBindings) {
            await subscribeAndListen(binding.uuid);
          }
          console.log(
            `[BLE] Subscribed to ${notifyBindings.length} notification(s). Step on the scale.`,
          );
        } else {
          // Legacy mode — single notify + write pair
          debug(
            `Looking for notify=${adapter.charNotifyUuid}` +
              (adapter.altCharNotifyUuid ? ` (alt=${adapter.altCharNotifyUuid})` : '') +
              `, write=${adapter.charWriteUuid}` +
              (adapter.altCharWriteUuid ? ` (alt=${adapter.altCharWriteUuid})` : ''),
          );

          const notifyChar =
            resolveChar(adapter.charNotifyUuid) ??
            (adapter.altCharNotifyUuid ? resolveChar(adapter.altCharNotifyUuid) : undefined);
          const writeChar =
            resolveChar(adapter.charWriteUuid) ??
            (adapter.altCharWriteUuid ? resolveChar(adapter.altCharWriteUuid) : undefined);

          if (!notifyChar || !writeChar) {
            throw new Error(
              `Required characteristics not found. ` +
                `Notify (${adapter.charNotifyUuid}): ${!!notifyChar}, ` +
                `Write (${adapter.charWriteUuid}): ${!!writeChar}. ` +
                `Discovered: [${[...charMap.keys()].join(', ')}]`,
            );
          }

          const effectiveNotifyUuid = resolveChar(adapter.charNotifyUuid)
            ? adapter.charNotifyUuid
            : adapter.altCharNotifyUuid!;
          await subscribeAndListen(effectiveNotifyUuid);
          console.log('[BLE] Subscribed to notifications. Step on the scale.');
        }

        await startInit();
      } catch (e) {
        if (!resolved) {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    })();
  });
}
