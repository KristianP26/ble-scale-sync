import { createReadingSource } from '../ble/index.js';
import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { resolveUserProfile } from '../config/resolve.js';
import { ConsecutiveFailureWatchdog } from '../ble/watchdog.js';
import { shouldCountAsWatchdogFailure } from '../ble/failure-kind.js';
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
 * Build the `ReadingSource` + per-handler hooks for the loop. Transport
 * selection lives entirely in `createReadingSource` (#246); this never branches
 * on handler name. The factory returns a ready watcher for the proxy transports
 * or a poll plan for the native ones, which gets the #143 grace floor + #154
 * watchdog wired here.
 */
export async function buildReadingSource(
  ctx: AppContext,
  adapters: ScaleAdapter[],
  watchdogMaxFailures: number,
  scanCooldownSecFallback: number,
): Promise<ReadingSourceBundle> {
  // Re-derived on each call (and on each reload) so edits to users[0] land on
  // the next cycle without a process restart.
  const profile = () => resolveUserProfile(ctx.config.users[0], ctx.config.scale);
  const scaleAuth = () => ({
    pin: ctx.config.users[0]?.beurer_pin,
    userIndex: ctx.config.users[0]?.beurer_user_index,
    provision: ctx.config.users[0]?.beurer_provision,
    registerNewUser: ctx.config.users[0]?.beurer_register_new_user,
  });

  const plan = await createReadingSource({
    bleHandler: ctx.bleHandler,
    mqttProxy: ctx.mqttProxy,
    esphomeProxy: ctx.esphomeProxy,
    adapters,
    targetMac: ctx.scaleMac,
    profile: profile(),
    scaleAuth: scaleAuth(),
  });

  if (plan.kind === 'watcher') {
    return {
      source: plan.watcher,
      failureLogPrefix: plan.failureLogPrefix,
      onSourceReload: () =>
        plan.watcher.updateConfig({
          adapters,
          targetMac: ctx.scaleMac,
          profile: profile(),
          scaleAuth: scaleAuth(),
        }),
    };
  }

  // Poll-based loop for native BLE handlers. Watchdog is BlueZ-specific (#154).
  // Post-disconnect grace (#143) applies only to node-ble (plan.appliesGraceFloor).
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

  const applyGraceFloor = plan.appliesGraceFloor;

  return {
    source: new PollReadingSource(ctx, adapters),
    failureLogPrefix: 'No scale found',
    onFailure: (err) => {
      // Idle cycles (radio alive, scale simply not advertising) must not trip
      // the watchdog (#213). Only GATT failures and dead-radio wedges count.
      if (shouldCountAsWatchdogFailure(err)) {
        watchdog.recordFailure();
      } else {
        log.debug('Idle cycle (radio alive, scale not on); not counting toward watchdog');
      }
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
