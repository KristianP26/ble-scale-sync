/**
 * Circuit-breaker for the continuous-mode poll loop.
 *
 * On Linux the BlueZ controller can enter a "zombie discovery" state after a
 * few GATT cycles (especially on Raspberry Pi 3/4 Broadcom on-board chips):
 * `Discovering=true` is reported, but no actual scanning happens. The handler
 * already has multiple recovery tiers (D-Bus stop, btmgmt power-cycle, rfkill,
 * systemctl restart bluetooth), but on this hardware they sometimes fail to
 * unwedge the firmware. The deterministic recovery is to exit the process so
 * Docker `restart: unless-stopped` rebuilds the container, which closes all
 * D-Bus clients and runs the entrypoint's BT reset, which generally clears
 * the wedge.
 *
 * The watchdog only arms after the first successful scan in the process'
 * lifetime. This avoids restart loops when the user is on vacation (scale
 * powered off the whole time → no first success → watchdog stays disarmed).
 *
 * See: bluez/bluer#47, home-assistant/operating-system#4022, issue #80.
 */
export interface WatchdogTripContext {
  consecutiveFailures: number;
}

export class ConsecutiveFailureWatchdog {
  private consecutiveFailures = 0;
  private hasSucceededOnce = false;

  constructor(
    private readonly maxFailures: number,
    private readonly onTrip: (ctx: WatchdogTripContext) => void,
  ) {}

  /** Record a successful scan cycle. Resets the failure count and arms the watchdog. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.hasSucceededOnce = true;
  }

  /**
   * Record a failed scan cycle. If the watchdog is enabled (max > 0) and armed
   * (first success seen), increment the counter and trip when it reaches the
   * configured max.
   */
  recordFailure(): void {
    if (this.maxFailures <= 0) return;
    if (!this.hasSucceededOnce) return;

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxFailures) {
      this.onTrip({ consecutiveFailures: this.consecutiveFailures });
    }
  }

  /** Inspectable state for tests and logging. */
  get state(): { consecutiveFailures: number; hasSucceededOnce: boolean; enabled: boolean } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      hasSucceededOnce: this.hasSucceededOnce,
      enabled: this.maxFailures > 0,
    };
  }
}
