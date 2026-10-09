# BLE Scale Sync

Read body composition data from BLE smart scales and export to Home Assistant (MQTT auto-discovery), Garmin Connect, and more.

## Quick Start

1. Install the add-on
2. In the **Configuration** tab, set your **Scale MAC address** (or leave empty for auto-discovery)
3. Fill in your **user profile** (height, birth date, gender)
4. **MQTT** is enabled by default with auto-detection from the Mosquitto add-on
5. Start the add-on

Your scale measurements will appear as Home Assistant sensors automatically.

If this host's Bluetooth adapter is out of range of the scale, or the host has none, pick another **Bluetooth transport** first (see below).

## Finding Your Scale MAC

1. Start the add-on with debug logging enabled
2. Step on your scale to wake it up
3. Check the add-on logs for discovered devices
4. Copy the MAC address and paste it into the Scale MAC field

With the `ha-bluetooth` transport, Home Assistant's own **Settings > Devices & services > Bluetooth > Advertisement monitor** shows the address too, while you stand on the scale.

## Bluetooth transports

**Bluetooth transport** (`ble_transport`) picks how the add-on reaches the scale. The default, `local`, is this host's own Bluetooth adapter, as in every earlier version.

| Your setup                                                                                                          | Transport         |
| ------------------------------------------------------------------------------------------------------------------- | ----------------- |
| This host's Bluetooth adapter is in range of the scale                                                              | `local` (default) |
| The scale sends its weight in its advertisement, and Home Assistant already hears it (any adapter or proxy it uses) | `ha-bluetooth`    |
| The scale needs a connection, and an ESPHome Bluetooth proxy that Home Assistant has not adopted is near it         | `esphome-proxy`   |
| The scale needs a connection, and an ESP32 with the BLE Scale Sync proxy firmware is near it                        | `mqtt-proxy`      |

Which scales send their weight in the advertisement is listed under [which scales work](https://blescalesync.dev/guide/ha-bluetooth#which-scales-work). Every other scale needs a connection.

With any transport but `local`:

- The options that only steer this host's adapter (**Bluetooth adapter**, **Re-pair a scale that forgot its pairing**, **Power-cycle the adapter after every weigh-in**, **Pair with a host identity key**) are ignored, and the log names any you have set. The adapter reset on startup is skipped as well.
- **Scale MAC address** still applies, and is worth setting.
- **Proxy silence before restart** (`proxy_liveness_timeout_min`) applies.

A transport that cannot run with the options you gave stops the add-on with an `ERROR` line that names the option to fix (see [Troubleshooting](#add-on-stops-with-an-error-about-ble_transport)). It never falls back to this host's adapter: you chose not to use it, and with `ha-bluetooth` it is the adapter Home Assistant itself reads from.

### Home Assistant Bluetooth (`ha-bluetooth`)

Nothing else to fill in, and no access token. The add-on subscribes to the advertisements Home Assistant's Bluetooth integration receives from every adapter and proxy it uses, through the Supervisor. That is why the add-on asks for access to the Home Assistant API, shown as a **Home Assistant** badge on its Info page.

- Broadcast scales only: a scale that needs a connection is named in a warning at startup. For those, use one of the other transports.
- An ESPHome node used this way has `bluetooth_proxy:` and is adopted in Home Assistant, the opposite of `esphome-proxy`.
- Check first that Home Assistant hears the scale: open the advertisement monitor above and stand on the scale.
- When the host boots, the add-on starts before Home Assistant itself. Until Home Assistant is up the log shows a few retries, then the add-on connects on its own.

### ESPHome proxy (`esphome-proxy`)

For a scale that needs a connection, through an ESPHome Bluetooth proxy node that Home Assistant has **not** adopted. A node serves its Bluetooth advertisements to one client only, so one that Home Assistant already uses gives this add-on nothing; for such a node use `ha-bluetooth`.

1. Set **Bluetooth transport** to `esphome-proxy`.
2. **ESPHome proxy host**: the node's IP address. A `.local` name works on many networks, an IP address on all.
3. **ESPHome proxy port**: `6053`, unless the device sets another.
4. **ESPHome API encryption key**: the key under `api: encryption: key:` in the device's YAML, 44 characters ending in `=`. Leave it empty only if the device has no API encryption.

A device that still uses the old API password, removed in ESPHome 2026.1, needs custom config. Setting up the node: [ESPHome proxy guide](https://blescalesync.dev/guide/esphome-proxy).

### ESP32 proxy (`mqtt-proxy`)

For a scale that needs a connection, through an ESP32 running the [BLE Scale Sync proxy firmware](https://blescalesync.dev/guide/esp32-proxy). The ESP32 and the add-on talk over MQTT. **ESP32 proxy broker** (`mqtt_proxy_broker`) picks the broker:

- `shared` (default): the broker of the add-on's MQTT options, which is the Mosquitto broker add-on when **Auto-detect MQTT broker** is on. This works even with **Enable MQTT** off. Give the ESP32 a login of its own there, for example a Home Assistant user or an entry under `logins` in the Mosquitto add-on, and put it in `mqtt_user` and `mqtt_password` of the ESP32's `config.json`.
- `embedded`: a broker inside this add-on. Set **Embedded broker port**, **Embedded broker username** and **Embedded broker password**; the ESP32 logs in with them. The broker listens on this host's network, which is why both are required. The Mosquitto add-on usually holds port 1883 already; then pick another port, for example 1884, and set the same `mqtt_port` in the ESP32's `config.json`.

Either way, `mqtt_broker` in the ESP32's `config.json` is this host's IP address, and **ESP32 proxy device ID** and **ESP32 proxy topic prefix** match its `device_id` and `topic_prefix`.

## MQTT Auto-Detection

When **Auto-detect MQTT broker** is enabled, the add-on automatically discovers the Mosquitto add-on broker. No manual MQTT configuration needed.

If you use an external MQTT broker, disable auto-detect and enter the broker URL, username, and password manually.

## Units

**Weight unit** and **Height unit** let you choose metric (kg/cm) or imperial (lbs/in). The selection is applied to the scale readings, the user profile height, and the weight range used for user matching. Defaults are kg and cm.

Changing units after the first reading does not reinterpret existing data. Switch units first, then record a measurement.

## Persistent last known weight

The add-on stores its runtime configuration at `/data/config.yaml` and preserves each user's `last_known_weight` across add-on restarts. This is important for multi-user matching: after the first reading the remembered weight is reused to pick the right user on subsequent scans, even after you restart Home Assistant or the add-on.

If you change the user slug (by renaming the user), the remembered weight does not carry over because the slug is the lookup key.

## Update check

**Check for updates** (`update_check`, on by default) asks `api.blescalesync.dev` for the latest version at most once a day, after a weigh-in, and writes a line to the add-on log when a newer version is out. Only the app version, operating system and CPU architecture are sent, in the `User-Agent` header; no readings, MAC addresses or user data. Turn it off to send nothing. In custom config mode set `update_check: false` in your `config.yaml` instead.

## Home Assistant Sensors

With MQTT and HA auto-discovery enabled, these sensors appear automatically:

- Weight
- Body fat (%)
- Water (%)
- Muscle mass
- Bone mass
- BMI
- BMR (kcal)
- Visceral fat
- Metabolic age
- Impedance (diagnostic)

Weight, muscle mass, and bone mass use the weight unit you selected (kg or lbs).

## Garmin Connect

To upload measurements to Garmin Connect:

1. Enable **Garmin Connect** in the configuration
2. Enter your Garmin email and password
3. Start the add-on

On first start the add-on authenticates with Garmin and stores the OAuth tokens under `/data/garmin-tokens` inside the container. Subsequent runs reuse those tokens, so your password is only used once.

### Retrying a failed upload

**Retry a failed export later** (`retry_failed_exports`, on by default) keeps a
reading whose upload failed and tries again on a later cycle, for up to 72
hours. Only targets that can record a past measurement are retried: Garmin,
InfluxDB, file, Intervals, Runalyze, wger and HealthLog. MQTT and the
notification targets cannot express a past reading, so a failure there is final
and the log says so.

The queue lives in `/data`, so it survives add-on restarts and updates. It
holds body composition and the user name, is written with 0600 permissions and
is deleted as soon as it empties. Turn the option off to write nothing at all.

### Upload timeout

**Garmin upload timeout** (`garmin_upload_timeout_sec`, default 180) caps one
upload attempt; three are made. Raise it, up to 900, if uploads fail with
"timed out" for a measurement that uploads fine later. A dead Garmin then takes
three times as long to give up, and in continuous mode the next scan cycle
waits with it.

### Weight only

Turn on **Upload weight only** (`garmin_weight_only`) to send just the weight to Garmin Connect and leave BMI, body fat, water, bone mass, muscle mass, visceral fat, physique rating, metabolic age and BMR unset. Every other exporter, including the MQTT sensors in Home Assistant, still receives the full body composition.

Garmin Connect calculates its own BMI from the weight and the height in your Garmin profile, so a BMI value may still be shown on the entry — it is Garmin's, not the scale's.

### If your Garmin account uses MFA

Home Assistant add-ons run without an interactive terminal, so the add-on cannot prompt for a 2FA code. If your account has MFA enabled:

1. On a laptop or desktop, clone the repo and run:
   ```bash
   python3 garmin-scripts/setup_garmin.py
   ```
   Enter your email, password, and MFA code when prompted. This writes `garmin_tokens.json` to `~/.garmin_tokens/`.
2. Copy that file into `/share/ble-scale-sync/garmin-tokens/` on the Home Assistant host (use the Samba or File editor add-on).
3. Restart the BLE Scale Sync add-on. On startup it detects the pre-generated token and imports it into `/data/garmin-tokens/`, and says so in the log.

The import only happens while `/data/garmin-tokens/` holds no token yet. A token already in use is never replaced from `/share`, because anything that can write to `/share` could otherwise send your measurements to a different Garmin account. When a different token is waiting in `/share`, the log says it was not imported. To switch to it on purpose, uninstall and reinstall the add-on (this also clears the remembered weights and the queue of failed uploads in `/data`), then start it with the new token in place.

If Garmin also blocks cloud or residential proxy IPs, the same workflow applies: authenticate from a trusted network, then import the token.

If you disable Garmin in the add-on UI, cached tokens are left in place so you can turn it back on without re-authenticating.

### Upgrading from add-on v1.7.x or v1.8.0

Add-on v1.8.1 bumps `garminconnect` to 0.3.x, which uses a new native auth engine and a new token format. Tokens from earlier versions (`oauth1_token.json`, `oauth2_token.json`) are incompatible and are removed automatically on first start. The add-on re-runs `setup_garmin.py` with the email and password you entered in the UI, so for non-MFA accounts no action is needed beyond restarting the add-on. MFA users follow the workaround above with the new single-file token.

## Advanced: Custom Config

The Configuration tab covers the scale, the Bluetooth transport, the primary user profile, MQTT and Garmin Connect. Every other exporter (InfluxDB, Webhook, Ntfy, Telegram, Intervals.icu, Strava, Runalyze, Wger, HealthLog, File), every multi-user setup and the transport settings the tab does not have (several ESPHome proxies, the `source` filter of `ha-bluetooth`, the legacy ESPHome API password) are configured through a custom `config.yaml`. See the [exporters reference](https://blescalesync.dev/exporters) for each one's options.

To use one, enable **Use custom config.yaml** and place your configuration at:

```
/share/ble-scale-sync/config.yaml
```

See [config.yaml.example](https://github.com/KristianP26/ble-scale-sync/blob/main/config.yaml.example) for the full reference.

When custom config is enabled, all other options in the Configuration tab are ignored, the Bluetooth transport options included: the file's `ble.handler` decides, and the log warns if you set a transport in the tab. The one exception is **Proxy silence before restart** (`proxy_liveness_timeout_min`), which the add-on applies on top of your file (the file itself is not modified) when you change it from 30 and the file does not set `ble.proxy_liveness_timeout_min` itself. A value in the file always wins.

### Garmin Connect with custom config

In custom config mode the add-on does not sign in to Garmin for you. Authenticate on another machine as in the MFA workaround above, copy `garmin_tokens.json` into `/share/ble-scale-sync/garmin-tokens/` and restart: the add-on imports it into `/data/garmin-tokens/` (only while no token is stored there yet, as above), which is where every `garmin` exporter without its own `token_dir` looks. A multi-user config with several Garmin accounts needs a separate `token_dir` per account. Only the default directory is imported, so point the others at a folder you can write to, such as `/share/ble-scale-sync/garmin-tokens/<name>`.

Anything under `/share/` can be read and changed by every add-on with share access and by Samba users. That includes the custom `config.yaml` itself, with the Garmin password in it.

### Strava with custom config

A `strava` exporter without its own `token_dir` keeps its tokens in `/data/strava-tokens`, which survives restarts and updates. That matters because Strava issues a new refresh token on every refresh, so a lost token file means authorising again.

### Bluetooth transports with custom config

Set `ble.handler` and its section in the file, as the guides for the [ESP32 proxy](https://blescalesync.dev/guide/esp32-proxy), the [ESPHome proxy](https://blescalesync.dev/guide/esphome-proxy) and [Home Assistant Bluetooth](https://blescalesync.dev/guide/ha-bluetooth) show. For Home Assistant Bluetooth the add-on's own Supervisor access works here too, with no long-lived token:

```yaml
ble:
  handler: ha-bluetooth
  ha_bluetooth:
    url: ws://supervisor/core/websocket
    token: '${SUPERVISOR_TOKEN}'
```

Write the URL out in full: `http://supervisor/core` alone does not reach the websocket.

With `ble_adapter` set in the tab, the adapter reset on startup still runs in custom config mode, whatever the file's transport. Turn off **Reset Bluetooth adapter on startup** if your file uses a proxy.

## Supported Scales

25+ BLE smart scale brands are supported, including Xiaomi (Mi Scale 2), Renpho (Elis 1, FITINDEX, Sencor, QN-Scale), Eufy (incl. P2 / P2 Pro), Yunmai, Beurer, Sanitas, Medisana, Trisa / ADE, and more.

See the [full list](https://blescalesync.dev/guide/supported-scales).

## Troubleshooting

### Add-on exits immediately with `DBusError: ... AccessDenied`

The full error mentions `An AppArmor policy prevents this sender from sending this message`, names `member="Hello"`, and appears before any scanning starts.

The Supervisor's default AppArmor profile does not allow the D-Bus calls this add-on makes to reach BlueZ. Newer add-on versions run unconfined instead, so updating to the latest version fixes it. If you still see this after updating, uninstall and reinstall the add-on so the Supervisor picks up the new manifest.

### Add-on stops with an error about ble_transport

A transport that cannot run stops the add-on with `ERROR:` and the reason, followed by `Not falling back to the built-in Bluetooth adapter`. Fix the option it names, or set **Bluetooth transport** back to `local`:

- `esphome_proxy_host is empty`, or `takes a host name or IP address, not a URL`: enter only the address, such as `192.168.1.50`, without `http://` or a path.
- `esphome_proxy_encryption_key is not a valid ESPHome API key`: copy the whole key from `api: encryption: key:` in the device's YAML. It is 44 characters long and ends in `=`.
- `mqtt_proxy_broker shared, but no MQTT broker is available`: start the Mosquitto broker add-on with **Auto-detect MQTT broker** on, set **MQTT broker URL**, or switch **ESP32 proxy broker** to `embedded`.
- `mqtt_proxy_broker embedded ... needs mqtt_proxy_username and mqtt_proxy_password`: fill in both.
- `cannot contain + or #`: those are MQTT wildcards; use the same plain device ID and topic prefix as the ESP32's `config.json`.
- `the Supervisor gave this add-on no SUPERVISOR_TOKEN`: this should not happen; please open an issue with the log.

### The app restarts on its own

When the app cannot recover inside the running process (for example after ten failed scans in a row, or when a Bluetooth proxy stays silent), it exits on purpose. The add-on then starts it again by itself, without the Supervisor's Watchdog switch: the log shows `BLE Scale Sync exited with code N ...; restart #M in Ns`. The wait starts at 5 seconds and doubles while the app keeps exiting soon after starting, up to 5 minutes. A run of 10 minutes or more resets it. Stopping the add-on stops the app cleanly and does not start it again.

If the log shows a long series of these restarts, the reason is in the lines just above each one.

### Bluetooth adapter reset

The add-on power-cycles the Bluetooth adapter on startup to ensure a clean state. This is enabled by default (**Reset Bluetooth adapter on startup**). If you have other HA Bluetooth integrations that lose connectivity when this add-on restarts, disable the option. With a **Bluetooth transport** other than `local` the reset is skipped, since that transport does not use this host's adapter.

Separately from that startup reset, the add-on also power-cycles the adapter after every connection to the scale (built-in Bluetooth only, not with an ESPHome or ESP32 proxy), to clear a stuck scanning state some Raspberry Pi adapters fall into. **Power-cycle the adapter after every weigh-in** (`preemptive_adapter_reset`) turns that off. Leave it on unless other Home Assistant Bluetooth integrations on the same adapter suffer from the brief drop after each weigh-in. It was not the cause of the Beurer BF915 re-pairing in #417; for a scale that asks to pair again before every weigh-in, see the next section.

### Beurer scale asks to pair again before every weigh-in

Some Beurer scales (the BF915 is confirmed) keep a pairing only from a device that handed over an identity key while pairing, and Linux hands one over only while the Bluetooth adapter has LE privacy turned on, which it does not by default. The pairing then works once and is rejected on the next connect. **Pair with a host identity key (LE privacy)** (`adapter_privacy`) turns privacy on with a key derived from the adapter's address, which stays the same across restarts, reinstalls and reboots.

1. Turn the option on and restart the add-on. The log shows `uses an IRK derived from its address (fingerprint ...)` and `LE privacy is on`.
2. Remove the old pairing once: `bluetoothctl remove AA:BB:CC:DD:EE:FF` in the host shell (or turn on **Re-pair a scale that forgot its pairing**).
3. Weigh in and confirm the pairing on the scale, as you did the first time. Later weigh-ins should not ask again.

Privacy applies to the whole adapter: every Bluetooth LE connection it makes, Home Assistant's own Bluetooth integration included, then uses a random address, and other paired LE devices may need pairing again. If that is a problem, give the add-on its own USB adapter with **BLE adapter** (`ble_adapter`). If LE privacy cannot be turned on, the add-on skips the connect and says why rather than pair without the key.

### No scale found

- Make sure your scale is awake (step on it)
- Check that the Bluetooth adapter is working: enable debug logging and look for "Discovery started" in the logs
- If you have multiple Bluetooth adapters, try setting a specific adapter (e.g., `hci1`)
- If your scale advertises only for a few seconds after you step on it, lower **Rescan delay when no scale was found** (`idle_rescan_delay`); the add-on rescans that many seconds after an idle cycle

### MQTT not connecting

- Check that the Mosquitto add-on is running
- With auto-detect on, the add-on log says at startup whether it found the broker (`MQTT auto-detected: ...`) or why not (the HTTP status from the Supervisor)
- If using an external broker, verify the URL and credentials
- Enable debug logging for detailed MQTT connection info

### Garmin upload failing

- Check that your email and password are correct
- Garmin may require re-authentication after a while; check the logs for auth errors
- Three "Python uploader timed out" lines for one measurement mean Garmin was slow rather than wrong; raise **Garmin upload timeout**

## Links

- [Documentation](https://blescalesync.dev)
- [GitHub](https://github.com/KristianP26/ble-scale-sync)
- [Supported scales](https://blescalesync.dev/guide/supported-scales)
- [Issue tracker](https://github.com/KristianP26/ble-scale-sync/issues)
