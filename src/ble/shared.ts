import type {
  ScaleAdapter,
  UserProfile,
  ScaleReading,
  BodyComposition,
  BleDeviceInfo,
  ConnectionContext,
  ScaleAuth,
} from '../interfaces/scale-adapter.js';
import type { WeightUnit } from '../config/schema.js';
import { LBS_TO_KG, normalizeUuid, errMsg, bleLog } from './types.js';
import { HistoryBuffer, HoldTimer, WeightStabilityTracker } from './notification-processor.js';

// ─── Broadcast-vs-GATT routing ────────────────────────────────────────────────

/**
 * True when the matched device still carries broadcast/service data this
 * adapter can parse — a usable reading may yet arrive in a future
 * advertisement, so the caller should keep waiting rather than opening a GATT
 * connection.
 *
 * False when the device exposes no parseable broadcast source: a dual-mode
 * adapter (e.g. QN Scale, which declares `parseBroadcast` for the AABB
 * broadcast variant but also has a GATT path) must then fall through to its
 * GATT path. This is the #201 fix — the scan-batch proxy paths previously let
 * any adapter that merely *declared* `parseBroadcast`/`parseServiceData` skip
 * GATT entirely, so GATT-only QN scales (which advertise just a name + service
 * UUID, no manufacturer data) were matched and then silently dropped.
 *
 * Known limitation (Option B): any `manufacturerData` counts as a broadcast
 * source even if `parseBroadcast` would reject it. A QN scale advertising
 * non-AABB manufacturer data would therefore be gated to "wait" — this matches
 * the pre-#201 behaviour, so it is no regression. GATT-only QN scales
 * advertise no manufacturer data at all, so they are unaffected. The
 * esphome-proxy *watcher* intentionally does not use this helper: its
 * per-advertisement stream GATT-connects such devices instead (QN Elis 1).
 */
export function hasParseableBroadcastSource(adapter: ScaleAdapter, info: BleDeviceInfo): boolean {
  if (adapter.parseBroadcast && info.manufacturerData) return true;
  if (adapter.parseServiceData && info.serviceData && info.serviceData.length > 0) return true;
  return false;
}

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

function resolveChar(charMap: Map<string, BleChar>, uuid: string | undefined): BleChar | undefined {
  if (uuid === undefined) return undefined;
  return charMap.get(normalizeUuid(uuid));
}

/**
 * Resolve the characteristic this adapter writes to for handler-driven writes
 * (per-frame ACKs). Prefers the `characteristics[]` write binding so a
 * multi-char adapter that declares no legacy `charWriteUuid` can still ack,
 * then falls back to the legacy `charWriteUuid` / `altCharWriteUuid` pair.
 * Returns undefined when no write char is present (caller no-ops).
 */
export function resolveWriteChar(
  charMap: Map<string, BleChar>,
  adapter: ScaleAdapter,
): BleChar | undefined {
  if (adapter.characteristics) {
    const writeBinding = adapter.characteristics.find((b) => b.type === 'write');
    if (writeBinding) {
      const char = resolveChar(charMap, writeBinding.uuid);
      if (char) return char;
    }
  }
  return (
    resolveChar(charMap, adapter.charWriteUuid) ??
    (adapter.altCharWriteUuid ? resolveChar(charMap, adapter.altCharWriteUuid) : undefined)
  );
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
  if (!hasNotify) missing.push(adapter.charNotifyUuid ?? '<no notify uuid>');

  const hasWrite =
    !!resolveChar(charMap, adapter.charWriteUuid) ||
    (!!adapter.altCharWriteUuid && !!resolveChar(charMap, adapter.altCharWriteUuid));
  if (!hasWrite) missing.push(adapter.charWriteUuid ?? '<no write uuid>');

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
  scaleAuth?: ScaleAuth,
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
        scaleAuth,
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
      // Legacy unlock command interval. Absent unlock fields mean this adapter
      // has no legacy unlock; do nothing (it is a pure notify-and-parse or a
      // broadcast adapter). #244: no adapter fakes an empty unlock anymore.
      const writeChar =
        resolveChar(charMap, adapter.charWriteUuid) ??
        (adapter.altCharWriteUuid ? resolveChar(charMap, adapter.altCharWriteUuid) : undefined);
      if (!writeChar) return;

      const hasMultiple = adapter.unlockCommands && adapter.unlockCommands.length > 0;
      const hasSingle = adapter.unlockCommand && adapter.unlockCommand.length > 0;
      if (!hasMultiple && !hasSingle) return; // no legacy unlock to send

      const commands = hasMultiple
        ? adapter.unlockCommands!.map((c) => Buffer.from(c))
        : [Buffer.from(adapter.unlockCommand!)];
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
      // The `?? 5000` is a defensive default for the impossible-in-practice
      // case of unlockCommands set without unlockIntervalMs; every real adapter
      // that keeps Unlockable declares both. 5000 ms mirrors the predominant
      // existing interval.
      unlockInterval = setInterval(() => void sendUnlock(), adapter.unlockIntervalMs ?? 5000);
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
      bleLog.debug(`Subscribing to ${binding.uuid} (${binding.type})...`);
      try {
        const unsub = await subscribeToChar(charMap, binding.uuid, onNotification);
        unsubscribers.push(unsub);
        subscribed += 1;
      } catch (err) {
        // Name the exact characteristic that failed and surface the underlying
        // BlueZ error. Enabling notifications/indications on a SIG service that
        // mandates an encrypted link (e.g. Beurer BF720 User Data 0x181C) fails
        // here when the device is not bonded, which otherwise looks like an
        // opaque mid-handshake disconnect. #168
        throw new Error(
          `Failed to enable notifications on ${binding.uuid} (${binding.type}): ${errMsg(err)}. ` +
            'The scale may require a bonded/encrypted link.',
          { cause: err },
        );
      }
    }
    bleLog.info(`Subscribed to ${subscribed} notification(s). Step on the scale.`);
    await startInit();
  } else {
    // Legacy mode — single notify + write pair
    bleLog.debug(
      `Looking for notify=${adapter.charNotifyUuid ?? '<none>'}` +
        (adapter.altCharNotifyUuid ? ` (alt=${adapter.altCharNotifyUuid})` : '') +
        `, write=${adapter.charWriteUuid ?? '<none>'}` +
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
          `Notify (${adapter.charNotifyUuid ?? '<none>'}): ${!!notifyChar}, ` +
          `Write (${adapter.charWriteUuid ?? '<none>'}): ${!!writeChar}. ` +
          `Discovered: [${[...charMap.keys()].join(', ')}]`,
      );
    }

    const effectiveNotifyUuid: string = resolveChar(charMap, adapter.charNotifyUuid)
      ? adapter.charNotifyUuid!
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
 * Defensive cap on cached historical frames buffered per GATT session. A
 * misbehaving scale or a stuck cache replay could otherwise grow the buffer
 * without bound on a long-lived continuous-mode process. Renpho ES-26BB-B
 * replays less than 50 frames in practice; 500 leaves comfortable headroom.
 */
const MAX_HISTORY_FRAMES = 500;

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
  scaleAuth?: ScaleAuth,
): Promise<RawReading> {
  return new Promise<RawReading>((resolve, reject) => {
    let resolved = false;
    const history = new HistoryBuffer(MAX_HISTORY_FRAMES, adapter.name);
    const ackWriteChar = resolveWriteChar(charMap, adapter);
    const weightStability = adapter.weightStability
      ? new WeightStabilityTracker(adapter.weightStability)
      : null;

    const finishWith = (r: ScaleReading): void => {
      resolved = true;
      hold.clear();
      init.cleanup();
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      bleLog.info(`Reading complete: ${r.weight.toFixed(2)} kg / ${r.impedance} Ohm`);
      resolve({ reading: r, adapter, history: history.snapshot() });
    };

    // Armed only for adapters with completionHoldMs; the hold() call below is
    // gated on it, so a 0 ms timer is never started for other adapters.
    const hold = new HoldTimer(adapter.completionHoldMs ?? 0, (r) => {
      if (!resolved) finishWith(r);
    });

    const handleNotification = (sourceUuid: string, data: Buffer): void => {
      if (resolved) return;

      if (adapter.buildAck && ackWriteChar) {
        const ack = adapter.buildAck(data);
        if (ack) {
          const ackBuf = Buffer.isBuffer(ack) ? ack : Buffer.from(ack);
          void ackWriteChar.write(ackBuf, adapter.ackWithResponse ?? true).catch((e: unknown) => {
            if (!resolved) bleLog.debug(`ACK write error: ${errMsg(e)}`);
          });
        }
      }

      const reading: ScaleReading | null = adapter.parseCharNotification
        ? adapter.parseCharNotification(sourceUuid, data)
        : adapter.parseNotification(data);
      if (!reading) return;

      if (weightUnit === 'lbs' && !adapter.normalizesWeight) {
        reading.weight *= LBS_TO_KG;
      }

      if (onLiveData) onLiveData(reading);

      if (reading.timestamp) {
        if (!adapter.isComplete(reading)) return;
        if (history.push(reading)) {
          bleLog.debug(
            `Historical reading buffered: ${reading.weight.toFixed(2)} kg / ` +
              `${reading.impedance} Ohm @ ${reading.timestamp.toISOString()}`,
          );
        }
        return;
      }

      const weightIsStable = weightStability ? weightStability.observe(reading) : true;

      if (adapter.isComplete(reading)) {
        if (!weightIsStable) return;
        const final = adapter.isFinal ? adapter.isFinal(reading) : true;
        if (adapter.completionHoldMs && !final) {
          hold.hold(reading);
          return;
        }
        finishWith(reading);
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
      scaleAuth,
    );

    bleDevice.onDisconnect(() => {
      if (resolved) return;
      hold.clear();
      if (history.length > 0) {
        resolved = true;
        init.cleanup();
        const latest = history.popLatest()!;
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        bleLog.info(
          `Disconnected after cache replay (${history.length + 1} historical reading(s)); ` +
            `no live frame.`,
        );
        resolve({ reading: latest, adapter, history: history.snapshot() });
        return;
      }
      const held = hold.heldReading;
      if (held) {
        finishWith(held);
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
