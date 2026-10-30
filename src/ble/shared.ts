import type {
  ScaleAdapter,
  UserProfile,
  ScaleReading,
  ConnectionContext,
  ScaleAuth,
} from '../interfaces/scale-adapter.js';
import { errMsg, bleLog } from './types.js';
import { HistoryBuffer, HoldTimer } from './notification-processor.js';
import { isHistoricalReading } from '../interfaces/reading-time.js';
import { createWriteLanes, type WriteLanes } from './write-lane.js';
import { getRawCaptureConfig, toHex } from './session/capture.js';
import type { BleChar, BleDevice } from './session/ports.js';
import { adapterSuffix, resolveChar, resolveWriteChar, subscribeToChar } from './session/wiring.js';

/** Run adapter.onConnected() or fall back to legacy unlock-command interval. */
function initializeAdapter(
  { charMap, adapter, profile, address, scaleAuth, deviceName, manufacturerData }: SessionRequest,
  isResolved: () => boolean,
  onNotification: (sourceUuid: string, data: Buffer) => void,
  unsubscribers: (() => void)[],
  lanes: WriteLanes,
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
  // Before anything is subscribed, so no frame can be parsed against the
  // previous session's state. It has to be here rather than in `start()`,
  // because `subscribeAndInit` subscribes first and calls `start` after (#394).
  try {
    adapter.onSessionStart?.(address);
  } catch (e: unknown) {
    bleLog.debug(`Adapter onSessionStart failed: ${errMsg(e)}`);
  }

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
    // Drops a queued unlock; a queued ACK or adapter write still goes out (see
    // write-lane.ts, rule 5).
    lanes.close();
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
        deviceAddress: address,
        ...(deviceName ? { deviceName } : {}),
        ...(manufacturerData ? { manufacturerData } : {}),
        availableChars,
        write: async (charUuid, data, withResponse = true) => {
          const char = resolveChar(charMap, charUuid);
          if (!char) throw new Error(`Characteristic ${charUuid} not found`);
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          // Through the session's lane, not straight to the char: BlueZ refuses
          // a second write to a characteristic while one with a response is
          // still open (#211). Called before the first await, so an idle lane
          // still puts the write on the wire synchronously (#370).
          await lanes.write(char, buf, withResponse, 'adapter');
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
            await lanes.write(writeChar, buf, false, 'unlock');
            bleLog.debug(`Unlock write: [${toHex(buf)}]`);
          } catch (e: unknown) {
            if (!isResolved()) bleLog.error(`Unlock write error: ${errMsg(e)}`);
          }
        }
      };

      sendUnlock();
      // `unlockIntervalMs: 0` means "send the unlock once", and three adapters
      // declare exactly that (Active Era, Hesley, 1byone new). `??`
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

/**
 * How each `waitForRawReading()` session still in progress on a device ends
 * itself the way a disconnect ends it, returning what that settled it with,
 * or, with `handOver` false, only ends it. Read only by withAbandonmentCleanup.
 */
const sessionEnders = new WeakMap<
  BleDevice,
  (cause: string, handOver?: boolean) => RawReading | undefined
>();

/** The cause waitForRawReading's own disconnect callback ends a session with. */
const DISCONNECTED = 'Disconnected';

/**
 * Run a bounded reading session and make sure an abandoned one cleans up.
 *
 * `withTimeout` / `withIdleTimeout` abandon the promise they raced rather than
 * cancelling it, so when they win, `waitForRawReading()` is left running with
 * its unlock interval, its notify subscriptions and the adapter's session state
 * all live. Firing the disconnect drives the one cleanup path that already
 * exists instead of giving every transport its own (#404).
 *
 * The abandoned session also hands over what a disconnect would: the reading
 * held for body composition, or the stored records it buffered while no live
 * weigh-in came. Those are returned instead of the timeout error. A timeout used
 * to drop them, and an adapter that counts a stored record as reported once it
 * hands it over (`dedupMark`) then never handed it over again: a 19-byte QN
 * scale that sends its stored weigh-ins and keeps the link up until the idle
 * timeout lost them for good (#331). On a shutdown (`abortSignal`) the session
 * is only cleaned up: it is ended before the disconnect is fired, so the
 * disconnect does not settle it with a reading nobody receives, logged as
 * "Reading complete" as if it had gone out (#463).
 */
export async function withAbandonmentCleanup(
  bleDevice: BleDevice,
  run: () => Promise<RawReading>,
  abortSignal?: AbortSignal,
): Promise<RawReading> {
  try {
    return await run();
  } catch (err) {
    const end = sessionEnders.get(bleDevice);
    sessionEnders.delete(bleDevice);
    const settled = abortSignal?.aborted
      ? end?.(`Shutdown (${errMsg(err)})`, false)
      : end?.(`Gave up waiting (${errMsg(err)})`);
    bleDevice.fireDisconnect();
    if (settled) return settled;
    throw err;
  }
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
    let deferred = 0;
    for (const binding of notifyBindings) {
      // The adapter enables it from onConnected, after the writes the scale
      // expects first (#408). Counted above, so an adapter whose only notify
      // binding is deferred still passes the check.
      if (binding.deferred) {
        bleLog.debug(`Leaving notify binding ${binding.uuid} to the adapter's onConnected`);
        deferred += 1;
        continue;
      }
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
    // With a deferred binding nothing the weigh-in arrives on is enabled yet,
    // so "step on the scale" would be premature; the adapter says it instead.
    if (deferred === 0) {
      bleLog.info(`Subscribed to ${subscribed} notification(s). Step on the scale.`);
    }
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
    // and never retry. Repeating it here costs one write on three adapters.
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

/**
 * Margin by which a composition hold keeps the caller's idle timeout and, on
 * the native handlers, its absolute session cap away, so the hold's own timer,
 * which resolves with the settled weight, fires first. The proxy handlers'
 * fixed caps are not moved by it.
 */
const HOLD_IDLE_SLACK_MS = 2_000;

/** Raw scale reading paired with the adapter that produced it. */
export interface RawReading {
  reading: ScaleReading;
  adapter: ScaleAdapter;
  /**
   * Earlier readings collected during the same GATT session, oldest first.
   * Populated by adapters whose protocol dumps cached offline frames (each
   * frame carrying a `ScaleReading.timestamp` older than `HISTORY_WINDOW_MS`,
   * or flagged `fromMemory` by its adapter) on reconnect. The primary
   * `reading` is the latest live frame, or, if the scale disconnected after
   * the cache dump without producing a live one, the newest historical
   * frame, with the rest in `history`.
   */
  history?: ScaleReading[];
}

/** One GATT reading session: everything waitForRawReading runs on. */
export interface SessionRequest {
  charMap: Map<string, BleChar>;
  device: BleDevice;
  adapter: ScaleAdapter;
  profile: UserProfile;
  /** `ConnectionContext.deviceAddress`; every transport passes it without separators. */
  address: string;
  scaleAuth: ScaleAuth | undefined;
  /** What the device advertised, for `ConnectionContext`. */
  deviceName?: string;
  manufacturerData?: { id: number; data: Buffer };
  onLiveData?: (reading: ScaleReading) => void;
  /**
   * Restarts the caller's idle timeout; called for every frame except one the
   * adapter calls a status frame (`isStatusFrame`, D070).
   */
  onActivity?: (minIdleMs?: number) => void;
  /** Called for every frame, status frames included: the scale answered at all (node-ble, D041). */
  onFrame?: () => void;
}

/**
 * Subscribe to GATT notifications and wait for a complete raw scale reading.
 * Returns the reading + adapter WITHOUT computing body composition metrics.
 * Used by the multi-user flow to match a user by weight before computing metrics.
 *
 * Historical readings (those whose `ScaleReading.timestamp` is older than
 * `HISTORY_WINDOW_MS`, D027, or that the adapter flagged `fromMemory`, D065)
 * are routed into `RawReading.history`
 * instead of resolving the Promise. The Promise resolves on the first live
 * frame that passes `isComplete()`. If the scale disconnects after dumping
 * cache but without sending a live frame, the Promise resolves with the
 * newest historical reading as `reading` and the rest in `history`. Reject
 * only fires when no reading at all was collected before disconnect. A caller
 * whose timeout gives up gets the same through withAbandonmentCleanup.
 */
export function waitForRawReading(req: SessionRequest): Promise<RawReading> {
  const { charMap, device: bleDevice, adapter, onLiveData, onActivity, onFrame } = req;
  return new Promise<RawReading>((resolve, reject) => {
    let resolved = false;
    // Per session, so every session says it once (D070).
    let statusFrameLogged = false;
    const history = new HistoryBuffer(MAX_HISTORY_FRAMES, adapter.name);
    const ackWriteChar = resolveWriteChar(charMap, adapter);
    // One FIFO per characteristic for every write of this session: ACKs, the
    // legacy unlock and the adapter's own ctx.write (#211).
    const lanes = createWriteLanes();

    const finishWith = (r: ScaleReading): RawReading => {
      resolved = true;
      hold.clear();
      clearCaptureHold();
      init.cleanup();
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      bleLog.info(`Reading complete: ${r.weight.toFixed(2)} kg / ${r.impedance} Ohm`);
      const raw: RawReading = { reading: r, adapter, history: history.snapshot() };
      resolve(raw);
      return raw;
    };

    // Armed only for adapters with completionHoldMs; the hold() call below is
    // gated on it, so a 0 ms timer is never started for other adapters.
    const hold = new HoldTimer(
      () => adapter.completionHoldMs ?? 0,
      (r) => {
        if (!resolved) finishWith(r);
      },
      // The scale may say nothing for the whole window. Without this a
      // session_timeout_sec shorter than the hold ends the session first, and
      // the caller's timeout discards the settled weight along with it (#434).
      (holdMs) => onActivity?.(holdMs + HOLD_IDLE_SLACK_MS),
      () => adapter.isCompositionPending?.() === true,
    );

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

      onFrame?.();

      // Every frame the scale sends, before any adapter gate can discard it.
      // Without this a silent cycle cannot be told apart from one where frames
      // arrived and were rejected, which is the question every stalled-scale
      // report ends up asking (#229).
      bleLog.debug(
        `Notification ${sourceUuid}: [${[...data.subarray(0, 32)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')}]${data.length > 32 ? ` (+${data.length - 32} bytes)` : ''}`,
      );

      // Counted before the adapter gate, because a frame the adapter rejects
      // (an unstable QN 0x10) still shows the scale is mid weigh-in. A status
      // frame does not: counted, the Yunmai's reply to the unlock written every
      // 5 s kept a session nobody was weighing in on open until its cap (#474,
      // D070). Asked after the Notification line, so that line is there even
      // if the hook misbehaves.
      const status = adapter.isStatusFrame?.(sourceUuid, data) === true;
      if (!status) onActivity?.();
      if (status && !statusFrameLogged) {
        statusFrameLogged = true;
        bleLog.debug(
          `${adapter.name}: that frame is a status frame, not part of a weigh-in, ` +
            'so it does not keep the session open',
        );
      }

      if (adapter.buildAck && ackWriteChar) {
        const ack = adapter.buildAck(data);
        if (ack) {
          const ackBuf = Buffer.isBuffer(ack) ? ack : Buffer.from(ack);
          const ackHex = toHex(ackBuf);
          // Queued behind any write still open on this characteristic instead
          // of fired next to it, which BlueZ refused as "In Progress" (#211).
          // The timing line is there to measure a slow link.
          void lanes.write(ackWriteChar, ackBuf, adapter.ackWithResponse ?? true, 'ack').then(
            (t) => {
              bleLog.debug(
                t.coalesced
                  ? `ACK [${ackHex}] coalesced with an identical one still waiting`
                  : `ACK [${ackHex}] written in ${t.tookMs} ms (waited ${t.waitedMs} ms)`,
              );
            },
            (e: unknown) => {
              if (!resolved) bleLog.debug(`ACK write error: ${errMsg(e)}`);
            },
          );
        }
      }

      const reading: ScaleReading | null = adapter.parseCharNotification
        ? adapter.parseCharNotification(sourceUuid, data)
        : adapter.parseNotification(data);
      if (!reading) return;

      if (onLiveData) onLiveData(reading);

      // A stored record never ends the session: it is buffered, and the live
      // weigh-in (or the disconnect) does. "Stored" is decided by AGE, not by
      // the presence of a stamp (D027): a scale that stamps its live frames too
      // must still be able to end the session with one, or it would be held
      // open until the scale gave up and the weigh-in arrived as history.
      if (isHistoricalReading(reading)) {
        if (!adapter.isComplete(reading)) return;
        if (history.push(reading)) {
          // A reading flagged fromMemory need not carry a readable stamp
          // (D065), and toISOString throws on an invalid Date.
          const ts = reading.timestamp;
          const at = ts && !Number.isNaN(ts.getTime()) ? ts.toISOString() : 'receipt time';
          bleLog.debug(
            `Historical reading buffered: ${reading.weight.toFixed(2)} kg / ` +
              `${reading.impedance} Ohm @ ${at}`,
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
    const init = initializeAdapter(req, () => resolved, handleNotification, unsubscribers, lanes);

    /**
     * End the session as the scale disconnecting does, and return what that
     * settled it with; undefined when it was already settled or had nothing,
     * which rejects it. `cause` opens the log lines: the disconnect itself, or
     * a caller whose timeout gave up (withAbandonmentCleanup). With `handOver`
     * false (a shutdown) the session only ends: nothing it held or buffered is
     * settled, since nothing would receive it (D051).
     */
    const endSession = (cause: string, handOver = true): RawReading | undefined => {
      if (resolved) return undefined;
      hold.clear();
      clearCaptureHold();
      if (!handOver) {
        resolved = true;
        init.cleanup();
        bleLog.debug(`${cause} during the session; nothing is handed over.`);
        reject(new Error(`Session ended: ${cause}`));
        return undefined;
      }
      // A held live weigh-in wins over the stored records of the same session:
      // finishWith hands them over as history. Checked first, because with the
      // history branch first a scale that replays its memory and then
      // disconnects while a live weight is held lost the live weight entirely
      // (#331). hold.clear() above stops the timer only, the reading stays.
      const held = hold.heldReading;
      if (held) {
        if (history.length > 0) {
          bleLog.debug(
            `${cause} while holding a live reading; ${history.length} historical ` +
              `reading(s) go out as history.`,
          );
        }
        return finishWith(held);
      }
      if (history.length > 0) {
        resolved = true;
        init.cleanup();
        const latest = history.popLatest()!;
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        bleLog.info(
          `${cause} after cache replay (${history.length + 1} historical reading(s)); ` +
            `no live frame.`,
        );
        const raw: RawReading = { reading: latest, adapter, history: history.snapshot() };
        resolve(raw);
        return raw;
      }
      const r = lastCaptureReading;
      if (capture.enabled && r) {
        // Common capture exit: the scale powered off after sending its trailing
        // frames (logged above). Resolve with the weight-only reading instead of
        // rejecting, so a capture session does not spam errors + btmgmt churn.
        resolved = true;
        init.cleanup();
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
        const why = cause === DISCONNECTED ? 'scale disconnected' : cause;
        bleLog.info(`Capture mode: ${why}; recorded frames above. Returning reading.`);
        const raw: RawReading = { reading: r, adapter, history: undefined };
        resolve(raw);
        return raw;
      }
      // Latch before cleaning up. Without this a notification arriving after an
      // abandoned session is still parsed, and the capture/hold timers above
      // would treat the session as live.
      resolved = true;
      init.cleanup();
      reject(new Error('Scale disconnected before reading completed'));
      return undefined;
    };
    bleDevice.onDisconnect(() => {
      endSession(DISCONNECTED);
    });
    sessionEnders.set(bleDevice, endSession);

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
        // Latch, like the other settle paths. Without it a fireDisconnect()
        // from the caller's abandonment cleanup walks the whole disconnect
        // cascade again and can log "Reading complete" for a session whose
        // init failed, if a frame happened to arrive before the failure.
        resolved = true;
        hold.clear();
        clearCaptureHold();
        init.cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}
