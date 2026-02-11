import type {
  ScaleAdapter,
  UserProfile,
  ScaleReading,
  BodyComposition,
  ConnectionContext,
} from '../interfaces/scale-adapter.js';
import type { WeightUnit } from '../validate-env.js';
import { LBS_TO_KG, normalizeUuid, errMsg, bleLog } from './types.js';

// ─── Thin abstractions over BLE library objects ───────────────────────────────

export interface BleChar {
  /** Subscribe to notifications. Returns an unsubscribe function to remove the listener. */
  subscribe(onData: (data: Buffer) => void): Promise<() => void>;
  write(data: Buffer, withResponse: boolean): Promise<void>;
  read(): Promise<Buffer>;
}

export interface BleDevice {
  onDisconnect(callback: () => void): void;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function resolveChar(charMap: Map<string, BleChar>, uuid: string): BleChar | undefined {
  return charMap.get(normalizeUuid(uuid));
}

/** Subscribe to a GATT characteristic and forward notifications to the handler.
 *  Returns the unsubscribe function from the BleChar. */
async function subscribeToChar(
  charMap: Map<string, BleChar>,
  charUuid: string,
  onNotification: (sourceUuid: string, data: Buffer) => void,
): Promise<() => void> {
  const char = resolveChar(charMap, charUuid);
  if (!char) throw new Error(`Characteristic ${charUuid} not found`);
  const normalized = normalizeUuid(charUuid);
  return char.subscribe((data: Buffer) => onNotification(normalized, data));
}

/** Run adapter.onConnected() or fall back to legacy unlock-command interval. */
function initializeAdapter(
  charMap: Map<string, BleChar>,
  adapter: ScaleAdapter,
  profile: UserProfile,
  isResolved: () => boolean,
  onNotification: (sourceUuid: string, data: Buffer) => void,
  unsubscribers: (() => void)[],
): { start: () => Promise<void>; cleanup: () => void } {
  let unlockInterval: ReturnType<typeof setInterval> | null = null;

  const cleanup = (): void => {
    if (unlockInterval) {
      clearInterval(unlockInterval);
      unlockInterval = null;
    }
    for (const unsub of unsubscribers) unsub();
    unsubscribers.length = 0;
  };

  const start = async (): Promise<void> => {
    if (adapter.onConnected) {
      const ctx: ConnectionContext = {
        profile,
        write: async (charUuid, data, withResponse = true) => {
          const char = resolveChar(charMap, charUuid);
          if (!char) throw new Error(`Characteristic ${charUuid} not found`);
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          await char.write(buf, withResponse);
        },
        read: async (charUuid) => {
          const char = resolveChar(charMap, charUuid);
          if (!char) throw new Error(`Characteristic ${charUuid} not found`);
          return char.read();
        },
        subscribe: async (charUuid) => {
          const unsub = await subscribeToChar(charMap, charUuid, onNotification);
          unsubscribers.push(unsub);
        },
      };
      bleLog.debug('Calling adapter.onConnected()');
      await adapter.onConnected(ctx);
      bleLog.debug('adapter.onConnected() completed');
    } else {
      // Legacy unlock command interval
      const writeChar =
        resolveChar(charMap, adapter.charWriteUuid) ??
        (adapter.altCharWriteUuid ? resolveChar(charMap, adapter.altCharWriteUuid) : undefined);
      if (!writeChar) return;

      const unlockBuf = Buffer.from(adapter.unlockCommand);
      const sendUnlock = async (): Promise<void> => {
        if (isResolved()) return;
        try {
          await writeChar.write(unlockBuf, false);
        } catch (e: unknown) {
          if (!isResolved()) bleLog.error(`Unlock write error: ${errMsg(e)}`);
        }
      };

      sendUnlock();
      unlockInterval = setInterval(() => void sendUnlock(), adapter.unlockIntervalMs);
    }
  };

  return { start, cleanup };
}

/** Subscribe to notifications in multi-char or legacy mode, then start adapter init. */
async function subscribeAndInit(
  charMap: Map<string, BleChar>,
  adapter: ScaleAdapter,
  onNotification: (sourceUuid: string, data: Buffer) => void,
  startInit: () => Promise<void>,
  unsubscribers: (() => void)[],
): Promise<void> {
  if (adapter.characteristics) {
    // Multi-char mode
    bleLog.debug(`Multi-char mode: ${adapter.characteristics.length} bindings`);
    const notifyBindings = adapter.characteristics.filter((b) => b.type === 'notify');

    if (notifyBindings.length === 0) {
      throw new Error(
        `No notify characteristics in adapter bindings. Discovered: [${[...charMap.keys()].join(', ')}]`,
      );
    }

    for (const binding of notifyBindings) {
      const unsub = await subscribeToChar(charMap, binding.uuid, onNotification);
      unsubscribers.push(unsub);
    }
    bleLog.info(`Subscribed to ${notifyBindings.length} notification(s). Step on the scale.`);
    await startInit();
  } else {
    // Legacy mode — single notify + write pair
    bleLog.debug(
      `Looking for notify=${adapter.charNotifyUuid}` +
        (adapter.altCharNotifyUuid ? ` (alt=${adapter.altCharNotifyUuid})` : '') +
        `, write=${adapter.charWriteUuid}` +
        (adapter.altCharWriteUuid ? ` (alt=${adapter.altCharWriteUuid})` : ''),
    );

    const notifyChar =
      resolveChar(charMap, adapter.charNotifyUuid) ??
      (adapter.altCharNotifyUuid ? resolveChar(charMap, adapter.altCharNotifyUuid) : undefined);
    const writeChar =
      resolveChar(charMap, adapter.charWriteUuid) ??
      (adapter.altCharWriteUuid ? resolveChar(charMap, adapter.altCharWriteUuid) : undefined);

    if (!notifyChar || !writeChar) {
      throw new Error(
        `Required characteristics not found. ` +
          `Notify (${adapter.charNotifyUuid}): ${!!notifyChar}, ` +
          `Write (${adapter.charWriteUuid}): ${!!writeChar}. ` +
          `Discovered: [${[...charMap.keys()].join(', ')}]`,
      );
    }

    const effectiveNotifyUuid = resolveChar(charMap, adapter.charNotifyUuid)
      ? adapter.charNotifyUuid
      : adapter.altCharNotifyUuid!;
    // Legacy mode — subscribe + first unlock in parallel to prevent
    // the scale from disconnecting before receiving the unlock command
    const [unsub] = await Promise.all([
      subscribeToChar(charMap, effectiveNotifyUuid, onNotification),
      startInit(),
    ]);
    unsubscribers.push(unsub);
    bleLog.info('Subscribed to notifications. Step on the scale.');
  }
}

// ─── Shared reading logic ─────────────────────────────────────────────────────

/**
 * Subscribe to GATT notifications and wait for a complete scale reading.
 * Shared by both the node-ble (Linux) and noble (Windows/macOS) handlers.
 */
export function waitForReading(
  charMap: Map<string, BleChar>,
  bleDevice: BleDevice,
  adapter: ScaleAdapter,
  profile: UserProfile,
  weightUnit?: WeightUnit,
  onLiveData?: (reading: ScaleReading) => void,
): Promise<BodyComposition> {
  return new Promise<BodyComposition>((resolve, reject) => {
    let resolved = false;

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
        init.cleanup();
        // Clear any \r progress line before logging
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        bleLog.info(`Reading complete: ${reading.weight.toFixed(2)} kg / ${reading.impedance} Ohm`);
        try {
          resolve(adapter.computeMetrics(reading, profile));
        } catch (e) {
          reject(e);
        }
      }
    };

    const unsubscribers: (() => void)[] = [];
    const init = initializeAdapter(
      charMap,
      adapter,
      profile,
      () => resolved,
      handleNotification,
      unsubscribers,
    );

    // Handle unexpected disconnect
    bleDevice.onDisconnect(() => {
      if (!resolved) {
        init.cleanup();
        reject(new Error('Scale disconnected before reading completed'));
      }
    });

    // Subscribe to notifications and start adapter init.
    // Errors are caught and forwarded to the Promise's reject.
    subscribeAndInit(charMap, adapter, handleNotification, init.start, unsubscribers).catch((e) => {
      if (!resolved) {
        init.cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}
