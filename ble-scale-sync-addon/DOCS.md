# BLE Scale Sync

Read body composition data from BLE smart scales and export to Home Assistant (MQTT auto-discovery), Garmin Connect, and more.

## Quick Start

1. Install the add-on
2. In the **Configuration** tab, set your **Scale MAC address** (or leave empty for auto-discovery)
3. Fill in your **user profile** (height, birth date, gender)
4. **MQTT** is enabled by default with auto-detection from the Mosquitto add-on
5. Start the add-on

Your scale measurements will appear as Home Assistant sensors automatically.

## Finding Your Scale MAC

1. Start the add-on with debug logging enabled
2. Step on your scale to wake it up
3. Check the add-on logs for discovered devices
4. Copy the MAC address and paste it into the Scale MAC field

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

The Configuration tab covers the scale, the primary user profile, MQTT and Garmin Connect. Every other exporter (InfluxDB, Webhook, Ntfy, Telegram, Intervals.icu, Strava, Runalyze, Wger, HealthLog, File), every multi-user setup and the alternative BLE transports are configured through a custom `config.yaml`. See the [exporters reference](https://blescalesync.dev/exporters) for each one's options.

To use one, enable **Use custom config.yaml** and place your configuration at:

```
/share/ble-scale-sync/config.yaml
```

See [config.yaml.example](https://github.com/KristianP26/ble-scale-sync/blob/main/config.yaml.example) for the full reference.

When custom config is enabled, all other options in the Configuration tab are ignored, with one exception: **Proxy silence before restart** (`proxy_liveness_timeout_min`) only does anything with a proxy transport, which needs custom config, so the add-on applies it on top of your file (the file itself is not modified) when you change it from 30 and the file does not set `ble.proxy_liveness_timeout_min` itself. A value in the file always wins.

### Garmin Connect with custom config

In custom config mode the add-on does not sign in to Garmin for you. Authenticate on another machine as in the MFA workaround above, copy `garmin_tokens.json` into `/share/ble-scale-sync/garmin-tokens/` and restart: the add-on imports it into `/data/garmin-tokens/` (only while no token is stored there yet, as above), which is where every `garmin` exporter without its own `token_dir` looks. A multi-user config with several Garmin accounts needs a separate `token_dir` per account. Only the default directory is imported, so point the others at a folder you can write to, such as `/share/ble-scale-sync/garmin-tokens/<name>`.

Anything under `/share/` can be read and changed by every add-on with share access and by Samba users. That includes the custom `config.yaml` itself, with the Garmin password in it.

### Strava with custom config

A `strava` exporter without its own `token_dir` keeps its tokens in `/data/strava-tokens`, which survives restarts and updates. That matters because Strava issues a new refresh token on every refresh, so a lost token file means authorising again.

### Alternative BLE transports (no host Bluetooth needed)

If your Home Assistant host has no Bluetooth adapter, or its built-in radio gets stuck under continuous-mode load, custom config mode unlocks two BLE-free transport options shipped in 1.10.0:

- **[ESP32 BLE Proxy](https://blescalesync.dev/guide/esp32-proxy)** (`ble.handler: mqtt-proxy`) — relay BLE over MQTT from a ~8€ ESP32 board placed near your scale. Includes an embedded MQTT broker so you do not need to install Mosquitto.
- **[ESPHome Bluetooth proxy](https://blescalesync.dev/guide/esphome-proxy)** (`ble.handler: esphome-proxy`, experimental, broadcast-only) — reuse an existing ESPHome BT proxy mesh you already run for Home Assistant.

Both transports work without `host_dbus` or any host Bluetooth at all.

## Supported Scales

25+ BLE smart scale brands are supported, including Xiaomi (Mi Scale 2), Renpho (Elis 1, FITINDEX, Sencor, QN-Scale), Eufy (incl. P2 / P2 Pro), Yunmai, Beurer, Sanitas, Medisana, Trisa / ADE, and more.

See the [full list](https://blescalesync.dev/guide/supported-scales).

## Troubleshooting

### Add-on exits immediately with `DBusError: ... AccessDenied`

The full error mentions `An AppArmor policy prevents this sender from sending this message`, names `member="Hello"`, and appears before any scanning starts.

The Supervisor's default AppArmor profile does not allow the D-Bus calls this add-on makes to reach BlueZ. Newer add-on versions run unconfined instead, so updating to the latest version fixes it. If you still see this after updating, uninstall and reinstall the add-on so the Supervisor picks up the new manifest.

### The app restarts on its own

When the app cannot recover inside the running process (for example after ten failed scans in a row, or when a Bluetooth proxy stays silent), it exits on purpose. The add-on then starts it again by itself, without the Supervisor's Watchdog switch: the log shows `BLE Scale Sync exited with code N ...; restart #M in Ns`. The wait starts at 5 seconds and doubles while the app keeps exiting soon after starting, up to 5 minutes. A run of 10 minutes or more resets it. Stopping the add-on stops the app cleanly and does not start it again.

If the log shows a long series of these restarts, the reason is in the lines just above each one.

### Bluetooth adapter reset

The add-on power-cycles the Bluetooth adapter on startup to ensure a clean state. This is enabled by default (**Reset Bluetooth adapter on startup**). If you have other HA Bluetooth integrations that lose connectivity when this add-on restarts, disable the option.

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
