import { ReadingWatcher, resolveHandlerKey } from '../ble/index.js';
import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { resolveUserProfile } from '../config/resolve.js';
import { ConsecutiveFailureWatchdog } from '../ble/watchdog.js';
import { abortableSleep, POST_DISCONNECT_GRACE_MS } from '../ble/types.js';
import { createLogger } from '../logger.js';
import { PollReadingSource } from './poll-source.js';
import type { ReadingSource } from './loop.js';
import type { AppContext } from './context.js';

const log = createLogger('Sync');

export interface ReadingSourceBundle {
  source: ReadingSource;
  failureLogPrefix: string;
  onSourceReload?: () => void;
  onSuccess?: () => Promise<void> | void;
  onFailure?: (err: unknown) => void;
}

/**
 * Pick the right `ReadingSource` for the configured BLE handler and wire up
 * the per-handler hooks the loop needs (cooldown sleep, watchdog, etc.).
 *
 * mqtt-proxy + esphome-proxy paths are event-driven: the persistent watcher
 * yields readings as they arrive, no inter-iteration sleep. The poll path
 * scans on every iteration and applies the #143 post-disconnect grace floor
 * + #154 consecutive-failure watchdog only when the resolved handler is
 * `node-ble` (BlueZ).
 */
export async function buildReadingSource(
  ctx: AppContext,
  adapters: ScaleAdapter[],
  watchdogMaxFailures: number,
  scanCooldownSecFallback: number,
): Promise<ReadingSourceBundle> {
  if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
    const defaultProfile = resolveUserProfile(ctx.config.users[0], ctx.config.scale);
    const watcher = new ReadingWatcher(ctx.mqttProxy, adapters, ctx.scaleMac, defaultProfile);
    return {
      source: watcher,
      failureLogPrefix: 'Error processing reading',
      onSourceReload: () => watcher.updateConfig(adapters, ctx.scaleMac),
    };
  }

  if (ctx.bleHandler === 'esphome-proxy' && ctx.esphomeProxy) {
    const { ReadingWatcher: EsphomeReadingWatcher } =
      await import('../ble/handler-esphome-proxy.js');
    const watcher = new EsphomeReadingWatcher(ctx.esphomeProxy, adapters, ctx.scaleMac);
    return {
      source: watcher,
      failureLogPrefix: 'Error processing ESPHome reading',
      onSourceReload: () => watcher.updateConfig(adapters, ctx.scaleMac),
    };
  }

  // Poll-based loop for auto/noble BLE handlers.
  //
  // The watchdog is BlueZ-specific: on Pi 3/4 Broadcom on-board chips the
  // controller can enter a stuck state after a few GATT cycles where the
  // in-handler recovery tiers (D-Bus stop, btmgmt, rfkill, systemctl) don't
  // unwedge the firmware. After N consecutive failures (post first-success)
  // we exit so Docker's `restart: unless-stopped` can rebuild the container,
  // closing all D-Bus clients and re-running the entrypoint's BT reset.
  const watchdog = new ConsecutiveFailureWatchdog(
    watchdogMaxFailures,
    ({ consecutiveFailures }) => {
      log.warn(
        `Watchdog triggered: ${consecutiveFailures} consecutive scan failures since last ` +
          `success. Exiting so the container can restart cleanly. ` +
          `If this persists on Raspberry Pi 3/4 with the on-board Bluetooth chip, ` +
          `consider an ESP32/ESPHome BLE proxy. See https://blescalesync.dev/troubleshooting`,
      );
      process.exit(1);
    },
  );

  return {
    source: new PollReadingSource(ctx, adapters),
    failureLogPrefix: 'No scale found',
    onFailure: () => {
      // Watchdog records the failure and may exit the process if armed and
      // tripped. Order matters: trip before sleeping so we don't waste a
      // backoff cycle on a controller we already know is wedged.
      watchdog.recordFailure();
    },
    onSuccess: async () => {
      watchdog.recordSuccess();

      // After a successful read, the scale typically keeps advertising for
      // 15-25 s while the link layer winds down (display fades). Connecting
      // during that tail-off triggers the dying-peer GATT stall on BlueZ
      // (#143). Apply POST_DISCONNECT_GRACE_MS as a floor on top of the
      // configured cooldown, but only when the resolved handler is node-ble:
      // proxy handlers and noble-based stacks talk to a different transport
      // and do not hit the stall, so the floor would only add UX latency.
      // Failed scans in the catch branch use plain backoff, no grace.
      const cooldown = ctx.config.runtime?.scan_cooldown ?? scanCooldownSecFallback;
      const cooldownMs = cooldown * 1000;
      const handlerKey = resolveHandlerKey(ctx.bleHandler);
      const applyGraceFloor = handlerKey === 'node-ble';
      const effectiveMs = applyGraceFloor
        ? Math.max(cooldownMs, POST_DISCONNECT_GRACE_MS)
        : cooldownMs;
      if (applyGraceFloor && effectiveMs > cooldownMs) {
        log.info(
          `\nWaiting ${effectiveMs / 1000}s before next scan ` +
            `(cooldown ${cooldown}s, post-disconnect grace floor ${POST_DISCONNECT_GRACE_MS / 1000}s)...`,
        );
      } else {
        log.info(`\nWaiting ${cooldown}s before next scan...`);
      }
      await abortableSleep(effectiveMs, ctx.signal);
    },
  };
}
