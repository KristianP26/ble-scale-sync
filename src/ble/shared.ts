import type {
  ScaleAdapter,
  UserProfile,
  ScaleReading,
  BodyComposition,
  ConnectionContext,
} from '../interfaces/scale-adapter.js';
import type { WeightUnit } from '../config/schema.js';
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

/**
 * Validate that a charMap contains every characteristic the adapter needs.
 *
 * Returns the list of missing UUIDs (empty when the map is complete). Handles
 * both multi-char adapters (`characteristics` bindings) and legacy adapters
 * (single notify + write with optional alt UUIDs).
 *
 * Callers use this after `buildCharMap` to detect the BlueZ `ServicesResolved`
 * race ([bluez/bluez#1489](https://github.com/bluez/bluez/issues/1489)) where
 * `ServicesResolved=true` fires before all GATT characteristics are exported
 * over D-Bus, yielding a charMap that is missing entries the scale actually
 * exposes. The typical workaround is to wait a few hundred ms and rebuild.
 */
export function findMissingCharacteristics(
  charMap: Map<string, BleChar>,
  adapter: ScaleAdapter,
): string[] {
  const missing: string[] = [];

  if (adapter.characteristics) {
    for (const binding of adapter.characteristics) {
      if (binding.optional) continue;
      if (!resolveChar(charMap, binding.uuid)) missing.push(binding.uuid);
    }
    return missing;
  }

  const hasNotify =
    !!resolveChar(charMap, adapter.charNotifyUuid) ||
    (!!adapter.altCharNotifyUuid && !!resolveChar(charMap, adapter.altCharNotifyUuid));
  if (!hasNotify) missing.push(adapter.charNotifyUuid);

  const hasWrite =
    !!resolveChar(charMap, adapter.charWriteUuid) ||
    (!!adapter.altCharWriteUuid && !!resolveChar(charMap, adapter.altCharWriteUuid));
  if (!hasWrite) missing.push(adapter.charWriteUuid);

  return missing;
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
  deviceAddress: string,
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
      const availableChars = new Set<string>(charMap.keys());
      const ctx: ConnectionContext = {
        profile,
        deviceAddress,
        availableChars,
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

      const commands = adapter.unlockCommands
        ? adapter.unlockCommands.map((c) => Buffer.from(c))
        : [Buffer.from(adapter.unlockCommand)];
      const sendUnlock = async (): Promise<void> => {
        if (isResolved()) return;
        for (const buf of commands) {
          try {
            await writeChar.write(buf, false);
            bleLog.debug(
              `Unlock write: [${[...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`,
            );
          } catch (e: unknown) {
            if (!isResolved()) bleLog.error(`Unlock write error: ${errMsg(e)}`);
          }
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

    let subscribed = 0;
    for (const binding of notifyBindings) {
      if (binding.optional && !resolveChar(charMap, binding.uuid)) {
        bleLog.debug(`Skipping optional notify binding ${binding.uuid} (not present on device)`);
        continue;
      }
      const unsub = await subscribeToChar(charMap, binding.uuid, onNotification);
      unsubscribers.push(unsub);
      subscribed += 1;
    }
    bleLog.info(`Subscribed to ${subscribed} notification(s). Step on the scale.`);
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

/** Raw scale reading paired with the adapter that produced it. */
export interface RawReading {
  reading: ScaleReading;
  adapter: ScaleAdapter;
  /**
   * Earlier readings collected during the same GATT session, oldest first.
   * Populated by adapters whose protocol dumps cached offline frames (each
   * frame carrying `ScaleReading.timestamp`) on reconnect. The primary
   * `reading` is the latest live frame, or, if the scale disconnected after
   * the cache dump without producing a live one, the newest historical
   * frame, with the rest in `history`.
   */
  history?: ScaleReading[];
}

/**
 * Subscribe to GATT notifications and wait for a complete raw scale reading.
 * Returns the reading + adapter WITHOUT computing body composition metrics.
 * Used by the multi-user flow to match a user by weight before computing metrics.
 *
 * Historical readings (those whose `ScaleReading.timestamp` is set by the
 * adapter from a cached-frame age field) are routed into `RawReading.history`
 * instead of resolving the Promise. The Promise resolves on the first live
 * frame that passes `isComplete()`. If the scale disconnects after dumping
 * cache but without sending a live frame, the Promise resolves with the
 * newest historical reading as `reading` and the rest in `history`. Reject
 * only fires when no reading at all was collected before disconnect.
 */
export function waitForRawReading(
  charMap: Map<string, BleChar>,
  bleDevice: BleDevice,
  adapter: ScaleAdapter,
  profile: UserProfile,
  deviceAddress: string,
  weightUnit?: WeightUnit,
  onLiveData?: (reading: ScaleReading) => void,
): Promise<RawReading> {
  return new Promise<RawReading>((resolve, reject) => {
    let resolved = false;
    const history: ScaleReading[] = [];

    const finalizeHistoryShape = (): ScaleReading[] | undefined =>
      history.length > 0 ? [...history] : undefined;

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

      if (reading.timestamp) {
        // Historical (cached) frame: collect, do not resolve. Sanity check
        // completeness so partial/garbage frames are not added to history.
        if (adapter.isComplete(reading)) {
          history.push(reading);
          bleLog.debug(
            `Historical reading buffered: ${reading.weight.toFixed(2)} kg / ` +
              `${reading.impedance} Ohm @ ${reading.timestamp.toISOString()}`,
          );
        }
        return;
      }

      if (adapter.isComplete(reading)) {
        resolved = true;
        init.cleanup();
        // Clear any \r progress line before logging
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        bleLog.info(`Reading complete: ${reading.weight.toFixed(2)} kg / ${reading.impedance} Ohm`);
        resolve({ reading, adapter, history: finalizeHistoryShape() });
      }
    };

    const unsubscribers: (() => void)[] = [];
    const init = initializeAdapter(
      charMap,
      adapter,
      profile,
      deviceAddress,
      () => resolved,
      handleNotification,
      unsubscribers,
    );

    // Handle unexpected disconnect
    bleDevice.onDisconnect(() => {
      if (resolved) return;
      if (history.length > 0) {
        resolved = true;
        init.cleanup();
        const latest = history.pop()!;
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        bleLog.info(
          `Disconnected after cache replay (${history.length + 1} historical reading(s)); ` +
            `no live frame.`,
        );
        resolve({ reading: latest, adapter, history: finalizeHistoryShape() });
        return;
      }
      init.cleanup();
      reject(new Error('Scale disconnected before reading completed'));
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

/**
 * Subscribe to GATT notifications and wait for a complete scale reading.
 * Wrapper around waitForRawReading() that computes body composition metrics.
 * Shared by both the node-ble (Linux) and noble (Windows/macOS) handlers.
 *
 * NOTE: this wrapper flattens to a single BodyComposition. Any history
 * collected during the GATT session is discarded. Callers that need
 * historical replay must use waitForRawReading and feed the orchestrator the
 * full RawReading.
 */
export function waitForReading(
  charMap: Map<string, BleChar>,
  bleDevice: BleDevice,
  adapter: ScaleAdapter,
  profile: UserProfile,
  deviceAddress: string,
  weightUnit?: WeightUnit,
  onLiveData?: (reading: ScaleReading) => void,
): Promise<BodyComposition> {
  return waitForRawReading(
    charMap,
    bleDevice,
    adapter,
    profile,
    deviceAddress,
    weightUnit,
    onLiveData,
  ).then(({ reading, adapter: matched }) => matched.computeMetrics(reading, profile));
}
