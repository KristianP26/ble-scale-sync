import { z } from 'zod';
import { isLoopback } from '../ble/loopback.js';
import { isValidScaleId, SCALE_ID_HINT } from '../ble/scale-id.js';
import { cliCommand } from '../cli-invocation.js';
import { findTokenDirCollisions } from './token-dirs.js';

// --- Sub-schemas ---

export const EsphomeEndpointSchema = z
  .object({
    host: z.string().min(1, 'ESPHome host is required'),
    port: z.number().int().min(1).max(65535).default(6053),
    encryption_key: z.string().optional().nullable(),
    password: z.string().optional().nullable(),
    client_info: z.string().default('ble-scale-sync'),
  })
  .refine((c) => !(c.encryption_key && c.password), {
    message: 'Set either encryption_key (Noise) or password (legacy), not both',
    path: ['encryption_key'],
  });

export const EsphomeProxySchema = z
  .object({
    host: z.string().min(1, 'ESPHome host is required'),
    port: z.number().int().min(1).max(65535).default(6053),
    encryption_key: z.string().optional().nullable(),
    password: z.string().optional().nullable(),
    client_info: z.string().default('ble-scale-sync'),
    // Additional ESPHome proxies for a mesh setup. Optional; an empty list
    // (the default) preserves the original single-proxy behavior. GATT
    // connects route to the proxy that last saw the scale (#116).
    additional_proxies: z.array(EsphomeEndpointSchema).default([]),
    /**
     * Seconds without a single BLE advertisement from a proxy before its client
     * is torn down and rebuilt. 0 (the default) disables the watchdog entirely.
     *
     * Off by default on purpose. A home proxy normally sees some BLE traffic
     * constantly, so a long silence means the transport died (#303: a single
     * ECONNRESET produced 4h35m of nothing while the proxy itself stayed
     * healthy). But a rebuild is a real teardown, and there is a documented
     * setup where it would fire forever without helping: a proxy already
     * adopted by Home Assistant only serves one advertisement subscription, so
     * the rebuild succeeds and advertisements still never arrive. Opt in with
     * 180 to 600 once you have seen the silence in your own log.
     */
    advertisement_timeout: z.number().int().min(0).max(86400).default(0),
  })
  .refine((c) => !(c.encryption_key && c.password), {
    message: 'Set either encryption_key (Noise) or password (legacy), not both',
    path: ['encryption_key'],
  });

export type EsphomeEndpointConfig = z.infer<typeof EsphomeEndpointSchema>;

/**
 * Home Assistant as the BLE radio: the app subscribes to HA's
 * `bluetooth/subscribe_advertisements` websocket stream, which carries every
 * advertisement any HA Bluetooth scanner hears (local adapter, ESPHome proxies,
 * SMLIGHT SLZB, Shelly). Passive only; scales that need a GATT connection are
 * not reachable this way.
 */
export const HaBluetoothSchema = z.object({
  url: z
    .string()
    .min(1, 'Home Assistant URL is required')
    .refine((v) => /^(https?|wss?):\/\//.test(v), {
      message: 'Must start with http://, https://, ws:// or wss://',
    }),
  // Long-lived access token of an administrator user; the subscription is
  // admin-only. Keep it in .env and reference it as ${HA_TOKEN}.
  token: z.string().min(1, 'Home Assistant long-lived access token is required'),
  // Optional: only accept advertisements heard by this HA scanner (its `source`
  // id as shown in HA's Bluetooth advertisement monitor, e.g. the proxy's MAC).
  source: z.string().optional().nullable(),
});

export const MqttProxySchema = z
  .object({
    broker_url: z
      .string()
      .min(1, 'MQTT broker URL must not be empty')
      .refine((v) => /^mqtts?:\/\//.test(v), {
        message: 'Must start with mqtt:// or mqtts://',
      })
      .optional()
      .nullable(),
    device_id: z.string().default('esp32-ble-proxy'),
    username: z.string().optional().nullable(),
    password: z.string().optional().nullable(),
    topic_prefix: z.string().default('ble-proxy'),
    embedded_broker_port: z.number().int().min(1).max(65535).default(1883),
    embedded_broker_bind: z
      .string()
      .regex(/^\S+$/, 'Must be a non-empty hostname or IP with no whitespace')
      .default('0.0.0.0'),
    auto_connect: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), the ESP32 autonomously connects to known scale MACs ' +
          'the instant they appear in a scan, eliminating the MQTT round-trip latency. ' +
          'Set to false to use the legacy host-initiated connect flow.',
      ),
  })
  // A LAN-exposed embedded broker needs a username AND a password. Checking
  // only the username let a missing or empty password through, and the broker
  // then accepted that username with an empty password from anyone on the LAN.
  .superRefine((c, ctx) => {
    if (c.broker_url) return;
    if (isLoopback(c.embedded_broker_bind)) return;
    if (c.username && c.password) return;
    ctx.addIssue({
      code: 'custom',
      message:
        'Embedded broker bound to a non-loopback interface must have username/password set. ' +
        'Either add mqtt_proxy.username + mqtt_proxy.password (non-empty), or change ' +
        'embedded_broker_bind to 127.0.0.1.',
      path: [c.username ? 'password' : 'username'],
    });
  });

export const BleSchema = z
  .object({
    scale_mac: z
      .string()
      .refine((v) => isValidScaleId(v), {
        message: `Must be ${SCALE_ID_HINT}`,
      })
      .optional()
      .nullable(),
    bind_key: z
      .string()
      .regex(/^[0-9a-fA-F]{32}$/, 'Must be a 32-character hex bind key (16 bytes)')
      .optional()
      .nullable(),
    noble_driver: z.enum(['abandonware', 'stoprocent']).optional().nullable(),
    handler: z.enum(['auto', 'mqtt-proxy', 'esphome-proxy', 'ha-bluetooth']).default('auto'),
    adapter: z
      .string()
      .regex(/^hci\d+$/, 'Must be a Linux HCI adapter name (e.g., hci0, hci1)')
      .optional()
      .nullable(),
    /**
     * Override protocol auto-detection with a named scale adapter (#318/#319).
     * Note the distinction from `adapter` above, which selects the host's
     * Bluetooth controller: this one selects the scale protocol.
     */
    force_scale_adapter: z.string().min(1).optional().nullable(),
    /**
     * Seconds of scale silence that end one GATT session (default 120); every
     * notification restarts the clock. Native BLE handlers only; the mqtt-proxy
     * and esphome-proxy transports ignore it. Some scales refuse to run a
     * standalone weigh-in while a host holds the session open (the Beurer BF500
     * shows "APP", #83), so a shorter session frees the scale sooner. The cost
     * is more Bluetooth adapter churn per hour, since a timed-out read resets
     * the adapter on node-ble and disconnects on Noble.
     */
    session_timeout_sec: z.number().int().min(5).max(600).optional().nullable(),
    /**
     * Protocol byte the QN handshake echoes back to the scale (#75, #331).
     *
     * The QN family disagrees about which value its firmware accepts, and the
     * wrong one is silent rather than an error: the scale acknowledges the whole
     * handshake and never streams a weight. The scale-info frame length picks a
     * default (0 for the 18-byte variant, the value the scale itself sent for
     * anything longer); set this when a scale runs the full handshake and then
     * reports nothing, or when its scale-info frame is unreliable in transit
     * (proxy transports) and sessions without it open on the wrong byte.
     */
    qn_protocol_byte: z.number().int().min(0).max(255).optional().nullable(),
    /**
     * Slot mask of the QN A00D user-delete frame `a0 0d 04 <mask> 00 ...`
     * (#461). Unset, the frame is not sent.
     *
     * The handshake used to answer the scale's 0x21 config request with this
     * frame on every QN scale (0xFE from openScale, 0xFC on the long dialects
     * from vendor-app captures), read as a "history response". In the vendor's
     * published SDK it is the command that deletes users from the scale, bit
     * i-1 selecting slot i, and the scales confirm it as a successful delete.
     * Set this only for a scale that stopped reporting once the frame was
     * dropped, knowing the slots the mask selects are deleted on every
     * connection (252 = slots 3 to 8, 254 = slots 2 to 8).
     */
    qn_report_byte: z.number().int().min(0).max(255).optional().nullable(),
    /**
     * Acknowledge every live QN weight frame with its own weight (#75, #235).
     *
     * One reading of a vendor-app capture has the app answering each 0x10 frame
     * with `a2 06 01 <that weight>`. The 20-byte extended dialect, the one that
     * capture covers, does it by default. It is not hardware confirmed, and the
     * 20-byte live frame, whose layout is not decoded yet, is never echoed.
     *
     * Set true on another dialect whose scale completes the whole handshake and
     * then streams nothing: it is the same class of silent failure as
     * `qn_protocol_byte`, and the same kind of knob. Left unset it changes
     * nothing.
     *
     * True also hands the scale the configured weight anchor: on the 20-byte
     * extended dialect in the ready-time A2, everywhere else as two A2 frames
     * right after START, the sequence two Android captures of the Arboleaf app
     * show (#331, #75). On the 19-byte dialect it also drops the ready-time A2
     * and sends the A00D #2 profile frame with the first user's age and
     * height, as that app does (#331, D033).
     */
    qn_weight_ack: z.boolean().optional().nullable(),
    /**
     * User key the QN profile frame carries, 1 to 9999 (#463).
     *
     * Per the vendor's published SDK the profile frame opens the session for a
     * user slot and carries the key the vendor app registered that user with,
     * and the scale keeps that key per slot. openScale's frame, the default
     * here, sends 8; the Feelfit, Arboleaf and GE apps send 1000. The Physiq
     * that refuses openScale's frame (`a1 06 02 01 00`) shows only the weight,
     * and no scale in the logs has streamed a live weight after a refusal.
     *
     * Set, the 18- and 19-byte dialects send the vendor-app profile frame with
     * this key, the first user's age, height and sex, and on the 18-byte one the
     * athlete setting, and skip openScale's ready-time A2. On the 19-byte
     * dialect that happens without `qn_weight_ack` too. A wrong key leaves the
     * scale refusing the frame, as without the option. The 20-byte and classic
     * dialects ignore it. Left unset it changes nothing.
     */
    qn_user_key: z.number().int().min(1).max(9999).optional().nullable(),
    /**
     * Send the two 0xA4 0x0F frames an Arboleaf vendor app sends between START
     * and the first live 0x10 weight frame (#331).
     *
     * Replayed byte for byte from one reporter's HCI capture of their own unit.
     * The payload is NOT decoded: five uint16 pairs per frame, the same shape as
     * the 0xA2 weight anchor, so it may be per-user calibration. Off by default
     * for that reason, and worth trying only when the handshake is acknowledged
     * end to end and the scale then streams nothing.
     */
    qn_a4_prelude: z.boolean().optional().nullable(),
    /**
     * Send the 9-byte form of the QN 0x20 time-sync frame (#331).
     *
     * The Arboleaf vendor app sends `20 09 ff <secs LE> 08 <checksum>` where this
     * app sends `20 08 ff <secs LE> <checksum>`. The timestamp field, its
     * position and the family checksum rule are identical; the whole difference
     * is one extra byte before the checksum. Per the vendor's published SDK it
     * is the phone's UTC offset (`0x08` = UTC+2 in the captures), and the long
     * form sends the host's own offset there (`timeZoneByte`).
     *
     * Off by default and opt-in per install, for the same reason as
     * `qn_a4_prelude`: a frame the scale does not expect fails silently in
     * exactly the way `qn_protocol_byte` does, and every QN scale in the
     * registry reads today on the 8-byte form.
     */
    qn_time_sync_long: z.boolean().optional().nullable(),
    /**
     * Send the 10-byte form of the QN 0x13 config frame (#331).
     *
     * Two independent captures show the vendor app sending ten bytes where this
     * app sends nine:
     *
     *   app (#235 GE CS 10 G)   13 0a ff 01 10 00 00 02 00 2f
     *   hedoric capture (#235)  13 0a ff 01 10 00 00 00 fa 27
     *   ble-scale-sync          13 09 ff 01 10 00 00 00    2c
     *
     * Bytes [0..6] are identical and all three close under the family checksum,
     * so the whole difference is the pair at [7..8]. Its meaning is NOT decoded
     * and the two captures disagree on its value, so the app's own pair is
     * replayed rather than derived.
     *
     * Off by default and opt-in per install, for the same reason as
     * `qn_a4_prelude` and `qn_time_sync_long`: every QN scale in the registry
     * reads today on the 9-byte form, and a wrong value here fails silently.
     */
    qn_config_long: z.boolean().optional().nullable(),
    /**
     * Send the end-of-measurement frame `1f 05 <protocol type> 10 <sum>` after
     * the 0x16 of a complete result block on the 19-byte QN dialect (#331).
     *
     * The vendor's published SDK sends it there for every 8-electrode
     * weigh-in; this app has never sent it. Whether its absence is why the
     * scale stores a second copy of a weigh-in it already delivered, and keeps
     * advertising after the export, is not known, so this is opt-in and off by
     * default until reporters' logs with it show an effect and no harm. Other
     * QN dialects ignore it.
     */
    qn_result_ack: z.boolean().optional().nullable(),
    /**
     * Delete a bond the scale has forgotten and pair again, instead of stopping
     * at the diagnostic (#290, #335).
     *
     * When a peripheral discards its half of the pairing, BlueZ replays the
     * dead key forever: every connect fails during encryption and the host
     * never invalidates anything, so the scale is unreachable until someone
     * runs `bluetoothctl remove` by hand. Turning this on lets a run of
     * authentication-class failures against a device BlueZ still lists as
     * bonded clear the bond once per connect and retry.
     *
     * Opt-in, because `le-connection-abort-by-local` also has benign producers
     * (a connect issued while discovery is still active, or another D-Bus
     * client holding a discovery session), and on these scales a bond dropped
     * in error costs a physical re-pair at the device.
     */
    auto_clear_stale_bond: z.boolean().optional().nullable(),
    /**
     * Longest wait, in minutes, before a bonding scale is connected and asked
     * to pair again after a pairing nobody confirmed on it (#471, D063).
     * Default 60; 0 tries again on every scan, as releases before it did.
     *
     * A Beurer scale shows a fresh code for every pairing and waits for SET.
     * Nobody standing there used to mean a new code every two or three
     * minutes, all night. Now, once our pairing agent has handled such a
     * request and the cycle ends with the scale still unpaired, the scale is
     * not connected to again for 2 minutes three times, then twice as long
     * each time (4, 8, 16, 32 minutes and so on) until the wait reaches this
     * cap, and then for the cap each time (`pairingRetryDelayMs`). It goes at
     * once when the scale comes back after a scan without it, when its
     * advertisement shows a new weigh-in (Beurer BF720 family), when it is
     * paired by other means, or after a restart.
     *
     * Read on every cycle (hot-swap). node-ble only, and only in continuous
     * mode: a single run is a fresh process and starts without the memory.
     */
    pairing_retry_max_min: z.number().int().min(0).max(1440).optional().nullable(),
    /**
     * Power-cycle the HCI controller with `btmgmt` after every GATT session
     * (#80). Default true; `false` skips that one step and nothing else.
     *
     * The cycle exists for the Broadcom "zombie discovery" state, where BlueZ
     * reports Discovering=true while the controller has stopped scanning.
     * This switch was added to test whether the cycle makes a Beurer scale
     * reject its stored key on the next connect; #417 showed it is not the
     * cause (that is the missing host IdKey, see adapter_privacy), and it is
     * kept as a diagnostic switch. The D-Bus reset, the failed-GATT cleanup and
     * the reactive recovery tiers all still run, and so does the reactive
     * power-cycle when BlueZ does not complete a Disconnect (a link it keeps
     * listing as connected, #472, D062).
     *
     * node-ble only: noble resets the adapter only reactively, and the proxy
     * transports never touch the host adapter.
     */
    preemptive_adapter_reset: z.boolean().optional().nullable(),
    /**
     * Turn on LE privacy on the host adapter with an IRK derived from its
     * address, so pairing hands the scale a host identity key (#417).
     *
     * A Beurer BF915 keeps a bond only from a peer that distributed an IRK, and
     * Linux distributes one only while the adapter has privacy enabled, which
     * is off by default. Without it every bond BlueZ makes is rejected on the
     * next reconnect with `PIN or Key Missing`.
     *
     * Off by default because privacy is adapter-wide: every LE connection and
     * active scan on that adapter, including Home Assistant's own Bluetooth
     * integration, then uses a random address. Read once at start-up
     * (restart-required). node-ble on Linux only.
     */
    adapter_privacy: z.boolean().optional().nullable(),
    /**
     * Minutes of total advertisement silence before a proxy transport is
     * treated as wedged rather than idle (#281). 0 disables the check.
     *
     * `mqtt-proxy` and `esphome-proxy` have no in-app liveness recovery: a
     * wedged link and a house where nobody has weighed in look identical,
     * because the reading wait never resolves in either case. Advertisements
     * are the signal that separates them, since they flow constantly from any
     * nearby device while the link is alive.
     *
     * The window is deliberately long. Getting this wrong means restart-looping
     * somebody whose proxy sits somewhere genuinely quiet, which is worse than
     * the bug it fixes.
     */
    proxy_liveness_timeout_min: z.number().int().min(0).max(1440).optional().nullable(),
    mqtt_proxy: MqttProxySchema.optional(),
    esphome_proxy: EsphomeProxySchema.optional(),
    ha_bluetooth: HaBluetoothSchema.optional(),
  })
  .refine((ble) => ble.handler !== 'mqtt-proxy' || ble.mqtt_proxy !== undefined, {
    message: 'mqtt_proxy config is required when handler is "mqtt-proxy"',
    path: ['mqtt_proxy'],
  })
  .refine((ble) => ble.handler !== 'esphome-proxy' || ble.esphome_proxy !== undefined, {
    message: 'esphome_proxy config is required when handler is "esphome-proxy"',
    path: ['esphome_proxy'],
  })
  .refine((ble) => ble.handler !== 'ha-bluetooth' || ble.ha_bluetooth !== undefined, {
    message: 'ha_bluetooth config is required when handler is "ha-bluetooth"',
    path: ['ha_bluetooth'],
  });
// NOTE: force_scale_adapter also requires a scale_mac, but that pairing is NOT
// checked here. Schema validation runs before applyEnvOverrides (yaml-load.ts),
// so a config.yaml that names a forced adapter and takes its MAC from the
// documented SCALE_MAC Docker override would be rejected while being perfectly
// valid. The check lives in src/run.ts (and in forced-adapter.ts for
// `validate`), after the effective MAC is known.

export const ScaleSchema = z.object({
  weight_unit: z.enum(['kg', 'lbs']).default('kg'),
  height_unit: z.enum(['cm', 'in']).default('cm'),
  /** Unit requested on the physical scale; independent from exported values. */
  display_unit: z.enum(['weight_unit', 'kg', 'lbs', 'st']).default('weight_unit'),
});

export const ExporterEntrySchema = z
  .object({
    type: z.string().min(1, 'Exporter type is required'),
  })
  .passthrough();

const WeightRangeSchema = z
  .object({
    min: z.number().positive('Must be a positive number'),
    max: z.number().positive('Must be a positive number'),
  })
  .refine((range) => range.max > range.min, {
    message: 'max must be greater than min',
  });

/**
 * True for a date string that names a day that actually exists, and is not in
 * the future.
 *
 * The regex above only fixes the SHAPE, so `2024-02-31` and `9999-99-99` both
 * passed validation and went straight into the age arithmetic that drives every
 * body-composition estimate. `new Date('2024-02-31')` is not a safety net
 * either: it normalises to 2024-03-02 rather than failing, which is why the
 * components are compared back against the parsed date instead of merely
 * checking for NaN.
 */
function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(parsed.getTime())) return false;
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    return false;
  }
  return parsed.getTime() <= Date.now();
}

export const UserSchema = z.object({
  name: z.string().min(1, 'User name is required'),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  height: z.number().positive('Must be a positive number (e.g., 183)'),
  birth_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format (e.g., "1990-06-15")')
    .refine(isRealCalendarDate, {
      message: 'Must be a real calendar date, not in the future (e.g., "1990-06-15")',
    }),
  gender: z.enum(['male', 'female']),
  is_athlete: z.boolean(),
  weight_range: WeightRangeSchema,
  last_known_weight: z.number().nullable().default(null),
  exporters: z.array(ExporterEntrySchema).optional(),
  // Beurer SIG-standard scales (BF720 / BF105) gate measurements behind a
  // User Control Point consent code. Obtain it once by pairing the scale with
  // the Beurer / openScale app (or read it off the scale's control unit), then
  // put it here. z.coerce so a `${ENV}` reference (resolved to a string before
  // schema parse) still validates.
  beurer_pin: z.coerce.number().int().min(0).max(9999).optional(),
  beurer_user_index: z.coerce.number().int().min(0).max(255).optional(),
  /**
   * Write this user's profile (date of birth, gender, height, activity level)
   * into the scale when it has nothing stored. Removing the batteries wipes
   * every slot on a Beurer BF7xx/BF9xx (#229), and the vendor app is otherwise
   * the only way to recreate one. Opt in: the field heuristics are validated
   * against a single captured device.
   */
  beurer_provision: z.boolean().optional(),
  /**
   * Register a NEW user record on the scale instead of consenting to an
   * existing one (#335).
   *
   * A SIG user record exists only after User Control Point "Register New User",
   * and normally only the vendor app performs it, so a scale set up that way
   * refuses every consent code from any other client: there is no record it is
   * entitled to.
   *
   * NOT the first move on a BF915, where the scale's own menu profiles ARE the
   * SIG slots: a factory reset followed by creating U:1 in the menu, with no
   * BLE operation at all, leaves Register New User returning index 2, and
   * consent on index 1 returns the values typed into the menu. On that model
   * the profile and its displayed four-digit consent code come from the menu
   * and this only burns slots (#335).
   *
   * One-shot and opt-in, because it writes a record to the device and the slots
   * are finite. Turn it on once, read the assigned index out of the log, put
   * that in `beurer_user_index`, then turn it off.
   */
  beurer_register_new_user: z.boolean().optional(),
});

export const RuntimeSchema = z.object({
  continuous_mode: z.boolean().default(false),
  scan_cooldown: z.number().int().min(5).max(3600).default(30),
  dry_run: z.boolean().default(false),
  debug: z.boolean().default(false),
  /**
   * Continuous-mode watchdog: exit the process after this many consecutive scan
   * failures (after at least one successful scan). Docker `restart: unless-stopped`
   * then performs a clean BlueZ recovery. Set to 0 to disable.
   */
  watchdog_max_consecutive_failures: z.number().int().min(0).max(1000).default(10),
  /**
   * Auto-reload config.yaml on edit (continuous mode only). When false, only
   * SIGHUP triggers a reload. Useful on flaky filesystems or when restart-based
   * deploys are preferred. Default true.
   */
  watch_config: z.boolean().default(true),
  /**
   * Seconds to wait after a continuous-mode cycle that found no scale, when the
   * radio itself is healthy (`bleFailureKind === 'idle'`).
   *
   * Idle cycles used to go through the same exponential failure backoff as a
   * dead radio, so a house where nobody had stepped on the scale reached the
   * 60 s cap within five cycles and then spent a minute per cycle not
   * listening. A scale that only advertises while somebody is standing on it
   * can weigh in entirely inside that window (#398).
   *
   * Real failures - GATT errors, a wedged controller - keep the 5 s -> 60 s
   * backoff, which is the right thing for those.
   */
  idle_rescan_delay: z.number().int().min(0).max(3600).default(5),
  /**
   * Minimum seconds to wait after a continuous-mode session that connected,
   * heard the scale and then went quiet until its idle timeout
   * (`bleFailureKind === 'no-reading'`, D041), when that is longer than the
   * 5 s -> 60 s retry backoff (#475). The backoff still advances; 0 keeps it
   * exactly as before.
   *
   * For a scale that accepts a connection all the time and keeps its weigh-ins
   * until the next one: a Beurer BF915 showed PAIR through 10 to 15 sessions an
   * hour, all day. A weigh-in made during the wait arrives with the next
   * session; more than 5 minutes late it is a past measurement, which only the
   * exporters that can backdate receive (D027). A scale that does not keep its
   * weigh-ins can lose one made during the wait.
   *
   * A `.default()`, not `.optional()`: applyEnvOverrides rebuilds runtime from
   * a fixed list, and only a required key makes tsc point at it.
   *
   * node-ble only: nothing else tags 'no-reading'. Must stay far below
   * 2^31 - 1 ms, above which setTimeout fires after 1 ms.
   */
  no_reading_rescan_delay: z.number().int().min(0).max(3600).default(0),
  /**
   * Keep a reading whose export failed and retry it on a later cycle (#412).
   *
   * On by default. The failure it covers is silent and total: a cloud target
   * that is down for an hour loses the weigh-in with no artefact anywhere, and
   * a reporter lost four that way in a week. Bounded at 72 hours, 5 attempts
   * and 50 entries, and only for exporters that can record a past reading.
   *
   * Turning it off restores the previous behaviour exactly, including keeping
   * no queue on disk (the de-duplication marks in `.scale-dedup-marks.json`
   * are written either way). See ADR D014: this persists body composition and a user
   * name by default, which is why it is a decision and not just a flag.
   */
  retry_failed_exports: z.boolean().default(true),
});

export const DockerSchema = z.object({
  mode: z.enum(['pull', 'build']).default('pull'),
});

const AppConfigObjectSchema = z.object({
  version: z.literal(1),
  ble: BleSchema.optional(),
  scale: ScaleSchema.default({
    weight_unit: 'kg',
    height_unit: 'cm',
    display_unit: 'weight_unit',
  }),
  unknown_user: z.enum(['nearest', 'log', 'ignore']).default('nearest'),
  /**
   * What to do with a reading that no configured user's `weight_range` covers.
   *
   * `warn` (default) is the behaviour every install has had: log it and export
   * it anyway. `skip` stops before the exporters and before the
   * `last_known_weight` write.
   *
   * The distinction matters because `weight_range` was only ever a MATCHING
   * input, never a guard. A reading nobody's range covers still resolves to
   * somebody, through the single-user tier or the `last_known_weight` proximity
   * tier, and then exports normally. A reporter stood on the scale holding a
   * suitcase, got 178 kg at 0 ohm, and it went to Garmin and to a retained MQTT
   * topic. Worse, `last_known_weight` was rewritten to 178, so the NEXT genuine
   * weigh-in tie-broke to the other user and was dropped (#395).
   *
   * The default stays `warn` so no existing install silently starts discarding
   * readings, but `skip` is the safer setting for a multi-user household.
   */
  out_of_range: z.enum(['warn', 'skip']).default('warn'),
  users: z
    .array(UserSchema)
    .min(1, 'At least one user is required')
    /**
     * The slug is an identity, not a label. Nothing enforced that it was
     * unique, and everything downstream assumes it is: `getExportersForUser`
     * caches by slug and resolves the user with `users.find`, so a second user
     * with the same slug silently inherited the first one's exporters - and
     * with them the first one's Garmin account. The exporter cache made it
     * stick for the life of the process.
     */
    .superRefine((users, ctx) => {
      const seen = new Set<string>();
      users.forEach((user, i) => {
        if (seen.has(user.slug)) {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'slug'],
            message:
              `Duplicate user slug '${user.slug}': each user needs its own slug. ` +
              'Exporters, the retry queue and last_known_weight are all keyed by it.',
          });
          return;
        }
        seen.add(user.slug);
      });
    }),
  global_exporters: z.array(ExporterEntrySchema).optional(),
  runtime: RuntimeSchema.optional(),
  docker: DockerSchema.optional(),
  update_check: z.boolean().default(true),
});

/**
 * The config schema for a config.yaml in `configDir`.
 *
 * Two accounts sharing one token directory means one user's readings upload
 * into the other's account; see findTokenDirCollisions. A relative token_dir
 * is taken from the config's own directory (F-11), so the check needs to know
 * it. Without one it compares from the working directory.
 */
export function createAppConfigSchema(configDir?: string) {
  return AppConfigObjectSchema.superRefine((config, ctx) => {
    for (const c of findTokenDirCollisions(config, configDir)) {
      ctx.addIssue({ code: 'custom', path: c.path, message: c.message });
    }
  });
}

export const AppConfigSchema = createAppConfigSchema();

// --- Standalone types ---

export type WeightUnit = 'kg' | 'lbs';
export type ScaleDisplayUnit = WeightUnit | 'st';

// --- Inferred types ---

export type MqttProxyConfig = z.infer<typeof MqttProxySchema>;
export type EsphomeProxyConfig = z.infer<typeof EsphomeProxySchema>;
export type HaBluetoothConfig = z.infer<typeof HaBluetoothSchema>;
export type BleConfig = z.infer<typeof BleSchema>;
export type ScaleConfig = z.infer<typeof ScaleSchema>;
export type ExporterEntry = z.infer<typeof ExporterEntrySchema>;
export type UserConfig = z.infer<typeof UserSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeSchema>;
export type DockerConfig = z.infer<typeof DockerSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type UnknownUserStrategy = AppConfig['unknown_user'];
export type OutOfRangeStrategy = AppConfig['out_of_range'];

// --- Error formatting ---

export function formatConfigError(error: z.ZodError): string {
  const lines = ['Configuration error in config.yaml:', ''];

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    lines.push(`  ${path}`);
    lines.push(`    ${issue.message}`);
    lines.push('');
  }

  lines.push(
    `Run '${cliCommand('validate')}' to check your config, or '${cliCommand('setup')}' to reconfigure.`,
  );

  return lines.join('\n');
}
