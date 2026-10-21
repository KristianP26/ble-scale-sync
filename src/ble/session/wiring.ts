import type { ScaleAdapter } from '../../interfaces/scale-adapter.js';
import { normalizeUuid, errMsg, bleLog, withTimeout } from '../types.js';
import type { BleChar } from './ports.js';

export function resolveChar(
  charMap: Map<string, BleChar>,
  uuid: string | undefined,
): BleChar | undefined {
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
export function adapterSuffix(adapterName?: string): string {
  return adapterName ? ` for adapter "${adapterName}"` : '';
}

/** Subscribe to a GATT characteristic and forward notifications to the handler.
 *  Returns the unsubscribe function from the BleChar. */
export async function subscribeToChar(
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

/** How long one StopNotify may take before the disconnect goes ahead anyway. */
const STOP_NOTIFY_TIMEOUT_MS = 2_000;

/**
 * Whether the adapter declares a deferred notify binding. Synchronous on
 * purpose: a caller checks it before awaiting anything, so an adapter without
 * one goes on to its disconnect without even an extra await (#408).
 */
export function hasDeferredNotifyBinding(adapter: ScaleAdapter): boolean {
  return (adapter.characteristics ?? []).some((b) => b.type === 'notify' && b.deferred === true);
}

/**
 * Turn the adapter's deferred notify bindings off again, on a transport whose
 * characteristics can (`BleChar.stop`). Returns how many were stopped.
 *
 * A bonded peer keeps its CCCD across connections (Core spec Vol 3 Part G
 * 3.3.3.3). Our unsubscribe only removes the listener, so a deferred binding
 * left on could make the scale indicate at the start of the next connection,
 * before the adapter has written what it writes first and before anything
 * listens; BlueZ confirms every indication by itself, so the scale would count
 * that weigh-in as delivered. The vendor app of the one scale that needs this
 * turns indications off before the scale disconnects (#408).
 *
 * Never throws: a failure here must not cost the reading already in hand.
 * Adapters without a deferred binding are not touched at all.
 */
export async function stopDeferredNotifications(
  charMap: Map<string, BleChar>,
  adapter: ScaleAdapter,
): Promise<number> {
  let stopped = 0;
  for (const binding of adapter.characteristics ?? []) {
    if (binding.type !== 'notify' || !binding.deferred) continue;
    const char = resolveChar(charMap, binding.uuid);
    if (!char?.stop) continue;
    try {
      await withTimeout(char.stop(), STOP_NOTIFY_TIMEOUT_MS, 'StopNotify timed out');
      bleLog.debug(`Notifications turned off on ${binding.uuid} before disconnecting`);
      stopped += 1;
    } catch (e: unknown) {
      bleLog.debug(`Could not turn notifications off on ${binding.uuid}: ${errMsg(e)}`);
    }
  }
  return stopped;
}
