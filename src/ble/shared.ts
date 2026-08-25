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
import { HistoryBuffer, HoldTimer } from './notification-processor.js';

// ─── Raw frame capture (protocol debugging) ───────────────────────────────────

/** Default hold window after a complete reading while capturing trailing frames. */
const RAW_CAPTURE_DEFAULT_HOLD_MS = 20_000;

/** Format a buffer as a space-separated lowercase hex string (e.g. "e7 58 01"). */
export function toHex(buf: Buffer | number[]): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Env-gated raw BLE frame capture for protocol reverse-engineering (#211).
 *
 * When enabled, `waitForRawReading()` logs every notify frame as hex (including
 * frames the adapter parses to null, e.g. the Beurer/Sanitas 0x59 composition
 * frame) and holds the GATT connection open past the weight-stable point so the
 * scale actually transmits its trailing frames before we disconnect.
 *
 *   BLE_RAW_CAPTURE          truthy enables (off for unset/empty/0/false/no/off)
 *   BLE_RAW_CAPTURE_HOLD_SEC optional hold window in seconds (default 20)
 *
 * Read from the environment on each call so tests can toggle it without a module
 * reload. Off by default; has no effect on normal runs.
 */
export function getRawCaptureConfig(): { enabled: boolean; holdMs: number } {
  const raw = (process.env.BLE_RAW_CAPTURE ?? '').trim().toLowerCase();
  const enabled = raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
  const holdSec = Number(process.env.BLE_RAW_CAPTURE_HOLD_SEC);
  const holdMs =
    Number.isFinite(holdSec) && holdSec > 0 ? holdSec * 1000 : RAW_CAPTURE_DEFAULT_HOLD_MS;
  return { enabled, holdMs };
}

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
  // A forced adapter (ble.force_scale_adapter) is exempt from the "any
  // manufacturer data counts" shortcut above, because the shortcut assumes the
  // adapter was chosen BY that advertisement. A forced one was not: it claims
  // every device it is shown, so a dual-mode adapter like QN or Eufy P2 pointed
  // at a scale whose manufacturer data it cannot parse would return "wait"
  // forever and the GATT path would never run. Here the parse must actually
  // succeed.
  const forced = adapter.isForcedOverride === true;
  if (adapter.parseBroadcast && info.manufacturerData) {
    if (!forced) return true;
    if (adapter.parseBroadcast(info.manufacturerData.data) !== null) return true;
  }
  if (adapter.parseServiceData && info.serviceData && info.serviceData.length > 0) {
    if (!forced) return true;
    if (info.serviceData.some((sd) => adapter.parseServiceData!(sd.uuid, sd.data) !== null)) {
      return true;
    }
  }
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

/** ` for adapter "X"`, or nothing when the adapter is unknown. */
function adapterSuffix(adapterName?: string): string {
  return adapterName ? ` for adapter "${adapterName}"` : '';
}

/** Subscribe to a GATT characteristic and forward notifications to the handler.
 *  Returns the unsubscribe function from the BleChar. */
async function subscribeToChar(
  charMap: Map<string, BleChar>,
  charUuid: string,
  onNotification: (sourceUuid: string, data: Buffer) => void,
  adapterName?: string,
): Promise<() => void> {
  const char = resolveChar(charMap, charUuid);
  // Name the adapter: this almost always means the wrong adapter was selected
  // for the device, and without the name the log gives no way to see that
  // (#317, #319).
  if (!char) throw new Error(`Characteristic ${charUuid} not found${adapterSuffix(adapterName)}`);
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
): {
  start: () => Promise<void>;
  cleanup: () => void;
  /**
   * Register a notification unsubscriber for teardown at the end of the
   * session. Use this rather than pushing onto the array directly: a subscribe
   * can settle after the session has already been torn down, and this drops
   * the listener straight away in that case.
   */
  register: (unsub: () => void) => void;
  /**
   * Re-send a send-once unlock after notifications are confirmed enabled.
   * No-op for adapters with a repeating interval or no legacy unlock.
   */
  resendUnlockAfterSubscribe: () => Promise<void>;
} {
  let unlockInterval: ReturnType<typeof setInterval> | null = null;
  let resendUnlock: (() => Promise<void>) | null = null;

  let closed = false;
  /**
   * A subscribe that resolves after cleanup() has already drained the list has
   * nobody left to unsubscribe it. On the proxy transports the underlying
   * client outlives the session, so such a listener stays attached for the
   * lifetime of the process and re-processes every later notification (#338).
   */
  const register = (unsub: () => void): void => {
    if (closed) {
      try {
        unsub();
      } catch (e: unknown) {
        bleLog.debug(`Late unsubscribe failed: ${errMsg(e)}`);
      }
      return;
    }
    unsubscribers.push(unsub);
  };

  let sessionEnded = false;
  const cleanup = (): void => {
    closed = true;
    if (unlockInterval) {
      clearInterval(unlockInterval);
      unlockInterval = null;
    }
    for (const unsub of unsubscribers) unsub();
    unsubscribers.length = 0;
    // Tell the adapter its session is over. Adapters are shared singletons, so
    // without this they cannot distinguish "not connected yet" from "the
    // previous connection" and may write through a dead context (#138).
    // Idempotent: cleanup() is called from several completion paths.
    if (!sessionEnded) {
      sessionEnded = true;
      try {
        adapter.onSessionEnd?.();
      } catch (e: unknown) {
        bleLog.debug(`Adapter onSessionEnd failed: ${errMsg(e)}`);
      }
    }
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
          const unsub = await subscribeToChar(charMap, charUuid, onNotification, adapter.name);
          register(unsub);
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
            bleLog.debug(`Unlock write: [${toHex(buf)}]`);
          } catch (e: unknown) {
            if (!isResolved()) bleLog.error(`Unlock write error: ${errMsg(e)}`);
          }
        }
      };

      sendUnlock();
      // `unlockIntervalMs: 0` means "send the unlock once", and four adapters
      // declare exactly that (Active Era, ES-CS20M, Hesley, 1byone new). `??`
      // does not catch 0, so they used to arm setInterval(fn, 0), which clamps
      // to about 1 ms on Linux: a write flood for the whole session on every
      // transport. The 5000 ms fallback stays for an adapter that declares
      // unlockCommands without an interval at all.
      const interval = adapter.unlockIntervalMs ?? 5000;
      if (interval > 0) {
        unlockInterval = setInterval(() => void sendUnlock(), interval);
      } else {
        // Send-once adapters need one repeat after notifications are actually
        // enabled. Noble queues the CCCD write from inside its descriptor
        // discovery callback, so this first unlock is guaranteed to reach the
        // scale BEFORE notifications are on, and its reply would be lost. The
        // old accidental 1 ms flood hid that; with a single write it would not
        // be hidden. resendUnlock() below is called once the subscribe settles.
        resendUnlock = sendUnlock;
      }
    }
  };

  const resendUnlockAfterSubscribe = async (): Promise<void> => {
    if (resendUnlock) await resendUnlock();
  };

  return { start, cleanup, register, resendUnlockAfterSubscribe };
}

/** Subscribe to notifications in multi-char or legacy mode, then start adapter init. */
async function subscribeAndInit(
  charMap: Map<string, BleChar>,
  adapter: ScaleAdapter,
  onNotification: (sourceUuid: string, data: Buffer) => void,
  startInit: () => Promise<void>,
  onNotifyEnabled: () => Promise<void>,
  register: (unsub: () => void) => void,
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
        const unsub = await subscribeToChar(charMap, binding.uuid, onNotification, adapter.name);
        register(unsub);
        subscribed += 1;
      } catch (err) {
        // A characteristic being present says nothing about it being
        // notifiable: the char map holds every discovered characteristic
        // regardless of its properties. An optional binding must therefore
        // tolerate a rejected subscribe exactly as it tolerates absence,
        // otherwise one vendor characteristic that turns out to be write-only
        // on a sibling model fails every reading on that model.
        if (binding.optional) {
          bleLog.debug(
            `Optional notify binding ${binding.uuid} could not be enabled: ${errMsg(err)}`,
          );
          continue;
        }
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
        `Required characteristics not found${adapterSuffix(adapter.name)}. ` +
          `Notify (${adapter.charNotifyUuid ?? '<none>'}): ${!!notifyChar}, ` +
          `Write (${adapter.charWriteUuid ?? '<none>'}): ${!!writeChar}. ` +
          `Discovered: [${[...charMap.keys()].join(', ')}]`,
      );
    }

    const effectiveNotifyUuid: string = resolveChar(charMap, adapter.charNotifyUuid)
      ? adapter.charNotifyUuid!
      : adapter.altCharNotifyUuid!;
    // Legacy mode — subscribe + first unlock in parallel to prevent
    // the scale from disconnecting before receiving the unlock command.
    // Register the unsubscriber from inside the subscribe chain rather than
    // after the Promise.all: a rejecting startInit() makes Promise.all discard
    // the still-pending subscribe, and the listener it goes on to install
    // would then never be torn down (#338). register() handles the case where
    // the session was already cleaned up by then.
    await Promise.all([
      subscribeToChar(charMap, effectiveNotifyUuid, onNotification, adapter.name).then(register),
      startInit(),
    ]);
    bleLog.info('Subscribed to notifications. Step on the scale.');
    // The unlock above was necessarily written before notifications were on:
    // noble queues the CCCD write from inside its descriptor discovery
    // callback, so a send-once adapter would otherwise have its reply dropped
    // and never retry. Repeating it here costs one write on four adapters.
    await onNotifyEnabled();
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
  onActivity?: () => void,
): Promise<RawReading> {
  return new Promise<RawReading>((resolve, reject) => {
    let resolved = false;
    const history = new HistoryBuffer(MAX_HISTORY_FRAMES, adapter.name);
    const ackWriteChar = resolveWriteChar(charMap, adapter);

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

    // Raw frame capture (#211): log every notify frame and hold the connection
    // open past weight-stable so trailing frames (e.g. the Beurer/Sanitas 0x59
    // composition frame) are recorded before disconnect. Off by default.
    const capture = getRawCaptureConfig();
    let captureHoldTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCaptureReading: ScaleReading | null = null;
    const clearCaptureHold = (): void => {
      if (captureHoldTimer) {
        clearTimeout(captureHoldTimer);
        captureHoldTimer = null;
      }
    };

    const handleNotification = (sourceUuid: string, data: Buffer): void => {
      if (capture.enabled) {
        bleLog.info(`[RAW] ${sourceUuid} (${data.length}B): ${toHex(data)}`);
      }
      if (resolved) return;

      // Counted before the adapter gate, because a frame the adapter rejects
      // (an unstable QN 0x10) still shows the scale is mid weigh-in.
      onActivity?.();

      // Every frame the scale sends, before any adapter gate can discard it.
      // Without this a silent cycle cannot be told apart from one where frames
      // arrived and were rejected, which is the question every stalled-scale
      // report ends up asking (#229).
      bleLog.debug(
        `Notification ${sourceUuid}: [${[...data.subarray(0, 32)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')}]${data.length > 32 ? ` (+${data.length - 32} bytes)` : ''}`,
      );

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

      if (adapter.isComplete(reading)) {
        // Capture mode takes precedence over both the normal completion and the
        // composition hold. The point of a capture run is the frames that come
        // AFTER the weight settles, so resolving on the weight would end the
        // session before the thing being captured arrives.
        if (capture.enabled) {
          lastCaptureReading = reading;
          if (!captureHoldTimer) {
            const holdSec = (capture.holdMs / 1000).toFixed(0);
            bleLog.info(
              `Capture mode: weight stable, holding the connection for ${holdSec}s to record ` +
                `trailing frames (e.g. 0x59 composition). Stay on the scale.`,
            );
            captureHoldTimer = setTimeout(() => {
              if (resolved) return;
              const r = lastCaptureReading;
              if (!r) return;
              clearCaptureHold();
              bleLog.info('Capture window elapsed; returning weight-only reading.');
              finishWith(r);
            }, capture.holdMs);
          }
          return;
        }
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
      clearCaptureHold();
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
      const r = lastCaptureReading;
      if (capture.enabled && r) {
        // Common capture exit: the scale powered off after sending its trailing
        // frames (logged above). Resolve with the weight-only reading instead of
        // rejecting, so a capture session does not spam errors + btmgmt churn.
        resolved = true;
        init.cleanup();
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        bleLog.info('Capture mode: scale disconnected; recorded frames above. Returning reading.');
        resolve({ reading: r, adapter, history: undefined });
        return;
      }
      init.cleanup();
      reject(new Error('Scale disconnected before reading completed'));
    });

    // Subscribe to notifications and start adapter init.
    // Errors are caught and forwarded to the Promise's reject.
    subscribeAndInit(
      charMap,
      adapter,
      handleNotification,
      init.start,
      init.resendUnlockAfterSubscribe,
      init.register,
    ).catch((e) => {
      if (!resolved) {
        hold.clear();
        clearCaptureHold();
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
