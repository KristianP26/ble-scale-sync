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
 * Build the `ReadingSource` + per-handler hooks for the loop. Proxy paths are
 * event-driven; the poll path scans on every iteration and applies the #143
 * grace floor + #154 watchdog only on node-ble (BlueZ).
 */
export async function buildReadingSource(
  ctx: AppContext,
  adapters: ScaleAdapter[],
  watchdogMaxFailures: number,
  scanCooldownSecFallback: number,
): Promise<ReadingSourceBundle> {
  if (ctx.bleHandler === 'mqtt-proxy' && ctx.mqttProxy) {
    const watcher = new ReadingWatcher(
      ctx.mqttProxy,
      adapters,
      ctx.scaleMac,
      resolveUserProfile(ctx.config.users[0], ctx.config.scale),
    );
    return {
      source: watcher,
      failureLogPrefix: 'Error processing reading',
      // Re-resolve profile from the (possibly hot-swapped) ctx.config so
      // edits to users[0].height/age/gender land on the next GATT cycle
      // without a process restart.
      onSourceReload: () =>
        watcher.updateConfig(
          adapters,
          ctx.scaleMac,
          resolveUserProfile(ctx.config.users[0], ctx.config.scale),
        ),
    };
  }

  if (ctx.bleHandler === 'esphome-proxy' && ctx.esphomeProxy) {
    const { ReadingWatcher: EsphomeReadingWatcher } =
      await import('../ble/handler-esphome-proxy/index.js');
    const esphomeScaleAuth = () => ({
      pin: ctx.config.users[0]?.beurer_pin,
      userIndex: ctx.config.users[0]?.beurer_user_index,
    });
    const watcher = new EsphomeReadingWatcher(
      ctx.esphomeProxy,
      adapters,
      ctx.scaleMac,
      resolveUserProfile(ctx.config.users[0], ctx.config.scale),
      esphomeScaleAuth(),
    );
    return {
      source: watcher,
      failureLogPrefix: 'Error processing ESPHome reading',
      onSourceReload: () =>
        watcher.updateConfig(
          adapters,
          ctx.scaleMac,
          resolveUserProfile(ctx.config.users[0], ctx.config.scale),
          esphomeScaleAuth(),
        ),
    };
  }

  // Poll-based loop for auto/noble BLE handlers. Watchdog is BlueZ-specific
  // (#154). Post-disconnect grace (#143) applies only to node-ble: proxy and
  // noble stacks use a different transport and don't hit the dying-peer stall.
  //
  // On trip: set non-zero exit code, then ask the app to abort. main()'s
  // finally runs (stops heartbeat, closes embedded broker), then the process
  // exits naturally with code 1 so the container/systemd unit restarts. Avoid
  // process.exit() here so cleanup is not skipped.
  const watchdog = new ConsecutiveFailureWatchdog(
    watchdogMaxFailures,
    ({ consecutiveFailures }) => {
      log.warn(
        `Watchdog triggered: ${consecutiveFailures} consecutive scan failures since last ` +
          `success. Exiting so the container can restart cleanly. ` +
          `If this persists on Raspberry Pi 3/4 with the on-board Bluetooth chip, ` +
          `consider an ESP32/ESPHome BLE proxy. See https://blescalesync.dev/troubleshooting`,
      );
      process.exitCode = 1;
      ctx.abortApp(new Error(`watchdog tripped after ${consecutiveFailures} failures`));
    },
  );

  const applyGraceFloor = resolveHandlerKey(ctx.bleHandler) === 'node-ble';

  return {
    source: new PollReadingSource(ctx, adapters),
    failureLogPrefix: 'No scale found',
    onFailure: () => {
      watchdog.recordFailure();
    },
    onSuccess: async () => {
      watchdog.recordSuccess();

      const cooldown = ctx.config.runtime?.scan_cooldown ?? scanCooldownSecFallback;
      const cooldownMs = cooldown * 1000;
      const effectiveMs = applyGraceFloor
        ? Math.max(cooldownMs, POST_DISCONNECT_GRACE_MS)
        : cooldownMs;
      if (effectiveMs > cooldownMs) {
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
