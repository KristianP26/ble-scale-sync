---
title: Home Assistant Add-on
description: Install and configure the BLE Scale Sync add-on on Home Assistant OS or Supervised, including Bluetooth transports, Garmin with MFA, custom config and persistent data.
---

# Home Assistant Add-on

The add-on runs BLE Scale Sync on Home Assistant OS and Supervised installs. It builds its config from the add-on options, finds the Mosquitto broker and publishes every metric as an MQTT auto-discovery sensor. Home Assistant 2026.2 and later shows add-ons as apps, under **Settings** > **Apps**.

## Install

[![Add BLE Scale Sync repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKristianP26%2Fble-scale-sync)

1. Click the badge, or add `https://github.com/KristianP26/ble-scale-sync` under **Settings** > **Apps** > **Install app** > three-dot menu > **Repositories**.
2. Open **BLE Scale Sync** in the store and click **Install**.
3. If you have no MQTT broker yet, install and start the **Mosquitto broker** add-on.

Images exist for amd64, aarch64 and armv7. The add-on uses `host_network`, `host_dbus` and the `NET_ADMIN` and `NET_RAW` capabilities to reach the host's Bluetooth adapter through BlueZ, and runs without AppArmor, whose default profile blocks the D-Bus calls BlueZ needs.

## First Weigh-In {#quick-start}

1. On the **Configuration** tab, fill in the user profile (name, height, birth date, gender), and leave **Enable MQTT** and **Auto-detect MQTT broker** on.
2. Leave **Scale MAC address** empty for the first weigh-in.
3. If this host's Bluetooth adapter is out of range of the scale, or the host has none, pick another **Bluetooth transport** ([below](#bluetooth-transports)).
4. Start the add-on on the **Info** tab and step on the scale.
5. Copy the scale's address from the `Auto-discovered:` or `Matched:` line of the log into **Scale MAC address** and restart the add-on, so it never reads a neighbor's scale.

The sensors appear under **Settings** > **Devices & services** > **MQTT** after the first reading; the list is under [Home Assistant sensors](/exporters#home-assistant-sensors).

## Bluetooth Transports

**Bluetooth transport** (`ble_transport`) picks the radio: `local` (default, this host's adapter), `ha-bluetooth`, `esphome-proxy` or `mqtt-proxy`. [Choose a transport](/guide/transports#choose-a-transport) compares them; [Home Assistant Bluetooth](/guide/ha-bluetooth#home-assistant-add-on), [ESPHome proxy](/guide/esphome-proxy#home-assistant-add-on) and [ESP32 proxy](/guide/esp32-proxy#home-assistant-add-on) each have an add-on section.

With any transport but `local`:

- the options that steer this host's adapter (`ble_adapter`, `auto_clear_stale_bond`, `preemptive_adapter_reset`, `adapter_privacy`, `pairing_retry_max_min`) are left out of the config, and the log names any you set;
- the adapter reset at startup is skipped;
- `scan_cooldown`, `idle_rescan_delay` and `no_reading_rescan_delay` do nothing, since the add-on listens all the time.

A transport that cannot run with the options given stops the add-on with an `ERROR` line naming the option to fix; it never falls back to the host adapter.

## Options {#configuration-reference}

The add-on writes `/data/config.yaml` from these options on every start, so a change applies after a restart. The third column names the `config.yaml` key each option sets.

### Scale and Bluetooth {#scale-and-ble}

| Option                            | Default           | `config.yaml` key and details                                                  |
| --------------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| `scale_mac`                       | empty             | `ble.scale_mac`, [BLE](/guide/configuration#ble)                               |
| `ble_transport`                   | `local`           | `ble.handler`, [Bluetooth transports](#bluetooth-transports)                   |
| `ble_adapter`                     | empty             | `ble.adapter`, `local` only                                                    |
| `reset_bluetooth`                 | `true`            | Add-on only: power-cycles the adapter at startup, `local` only                 |
| `force_scale_adapter`             | empty             | `ble.force_scale_adapter`, needs `scale_mac`                                   |
| `qn_protocol_byte`, `qn_report_byte`, `qn_weight_ack`, `qn_user_key`, `qn_a4_prelude`, `qn_time_sync_long`, `qn_config_long`, `qn_result_ack` | empty | `ble.qn_*`, [QN scales](/guide/scales/qn) |
| `rmsc04_profile_byte`             | empty             | `ble.rmsc04_profile_byte`, [Renpho scales](/guide/scales/renpho)               |
| `auto_clear_stale_bond`           | `false`           | `ble.auto_clear_stale_bond`, [Beurer scales](/guide/scales/beurer)             |
| `preemptive_adapter_reset`        | `true`            | `ble.preemptive_adapter_reset`, `local` only                                   |
| `adapter_privacy`                 | `false`           | `ble.adapter_privacy`, [Beurer scales](/guide/scales/beurer#pairing)           |
| `pairing_retry_max_min`           | `60`              | `ble.pairing_retry_max_min`, [Beurer scales](/guide/scales/beurer#pairing)     |
| `esphome_proxy_host`, `esphome_proxy_port`, `esphome_proxy_encryption_key` | empty, `6053`, empty | `ble.esphome_proxy`, [ESPHome proxy](/guide/esphome-proxy) |
| `mqtt_proxy_broker`               | `shared`          | `shared` uses the MQTT options below, `embedded` a broker in the add-on        |
| `mqtt_proxy_device_id`, `mqtt_proxy_topic_prefix` | `esp32-ble-proxy`, `ble-proxy` | `ble.mqtt_proxy`, [ESP32 proxy](/guide/esp32-proxy#home-assistant-add-on) |
| `mqtt_proxy_embedded_broker_port`, `mqtt_proxy_username`, `mqtt_proxy_password` | `1883`, empty, empty | Embedded broker only; username and password are required there |
| `proxy_liveness_timeout_min`      | `30`              | `ble.proxy_liveness_timeout_min`, proxy transports only                        |

### Units and User {#user-profile}

| Option                                | Default       | `config.yaml` key and details                                                   |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| `weight_unit`                         | `kg`          | `scale.weight_unit`, the unit of the log and notifications                      |
| `height_unit`                         | `cm`          | `scale.height_unit`, the unit of `user_height`                                  |
| `display_unit`                        | `weight_unit` | `scale.display_unit`, the unit on the scale's own display                       |
| `user_name`, `user_height`, `user_birth_date`, `user_gender`, `user_is_athlete` | `Default`, `170`, `1990-01-01`, `male`, `false` | The first entry of `users`, [Users](/guide/configuration#users) |
| `user_weight_min`, `user_weight_max`  | `40`, `150`   | `weight_range`, always in kg                                                    |
| `user_estimate_body_composition`      | `true`        | `estimate_body_composition`, [Users](/guide/configuration#users)                |
| `out_of_range`                        | `warn`        | `out_of_range`, [Out-of-range readings](/guide/configuration#out-of-range-readings) |

Calculations use kg and cm whatever the units are, and MQTT sends masses in kg; to see pounds in Home Assistant, change the unit in the sensor's settings.

### MQTT and Garmin {#mqtt-auto-detection}

| Option                            | Default                  | `config.yaml` key and details                                                    |
| --------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `mqtt_enabled`                    | `true`                   | Adds the `mqtt` exporter, [MQTT](/exporters#mqtt)                                |
| `mqtt_auto`                       | `true`                   | Takes the broker and login from the Mosquitto add-on, see below                  |
| `mqtt_broker_url`, `mqtt_username`, `mqtt_password` | empty  | `broker_url`, `username`, `password`; used when auto-detection is off or fails   |
| `mqtt_topic`                      | `scale/body-composition` | `topic`                                                                          |
| `mqtt_ha_discovery`               | `true`                   | `ha_discovery`                                                                   |
| `mqtt_ha_device_name`             | `BLE Scale`              | `ha_device_name`                                                                 |
| `garmin_enabled`                  | `false`                  | Adds the `garmin` exporter, [Garmin Connect](#garmin-connect)                    |
| `garmin_email`, `garmin_password` | empty                    | `email`, `password`                                                              |
| `garmin_weight_only`              | `false`                  | `weight_only`, [Garmin](/exporters#garmin)                                       |
| `garmin_upload_timeout_sec`       | `180`                    | `upload_timeout_sec`, [Garmin](/exporters#garmin)                                |

With `mqtt_auto` on, the add-on reads the broker address and login from the Supervisor and logs `MQTT auto-detected: mqtt://core-mosquitto:1883`. If the Mosquitto add-on is missing or the Supervisor refuses, the log gives the HTTP status and the add-on uses the manual MQTT options.

### Runtime

| Option                    | Default | `config.yaml` key and details                                                         |
| ------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `scan_cooldown`           | `30`    | `runtime.scan_cooldown`, `local` only, [Runtime](/guide/configuration#runtime)        |
| `idle_rescan_delay`       | `5`     | `runtime.idle_rescan_delay`, `local` only                                             |
| `no_reading_rescan_delay` | `0`     | `runtime.no_reading_rescan_delay`, `local` only                                       |
| `retry_failed_exports`    | `true`  | `runtime.retry_failed_exports`; the queue is kept in `/data`                          |
| `debug`                   | `false` | `runtime.debug`, verbose log for issue reports                                        |
| `update_check`            | `true`  | `update_check`, [Update check](/guide/configuration#update-check)                     |
| `custom_config`           | `false` | Uses your own file instead of these options, [Custom config mode](#custom-config-mode) |

## Garmin Connect

1. Turn on **Enable Garmin Connect** and enter your Garmin email and password.
2. Start the add-on.

On the first start the add-on signs in with these credentials and saves the token in `/data/garmin-tokens/`; later starts reuse it. The log says `Garmin authentication successful`. When you turn Garmin off, the token stays, so turning it on again needs no new sign-in.

### Sign In to Garmin with MFA {#mfa-workaround}

The add-on has no terminal to type an MFA code into. If your Garmin account uses MFA, or Garmin blocks your Home Assistant host's IP address, create the token on another computer:

1. On a computer with Docker, or with BLE Scale Sync and Python 3.12 installed, run `setup-garmin` as in [Garmin authentication](/exporters#garmin-authentication) and enter the MFA code when asked.
2. Copy `garmin_tokens.json` from the token directory it wrote to into `/share/ble-scale-sync/garmin-tokens/` on the Home Assistant host, for example with the Samba share or File editor add-on.
3. Restart the add-on. The log shows `IMPORTING a Garmin token from /share/ble-scale-sync/garmin-tokens/garmin_tokens.json`.

The import runs only while `/data/garmin-tokens/` holds no token, because anything that can write to `/share` could otherwise redirect your measurements to another Garmin account. A different token waiting in `/share` is not imported, and the log says so. To switch accounts, reinstall the add-on, which also clears the remembered weights and the retry queue in `/data`, and import again.

## Custom Config Mode

The options cover one user, MQTT and Garmin Connect. For several users, any other exporter, or transport settings the options lack (several ESPHome proxies, the `source` filter of `ha-bluetooth`, the legacy ESPHome API password), turn on `custom_config` and put a full `config.yaml` at `/share/ble-scale-sync/config.yaml`. [config.yaml.example](https://github.com/KristianP26/ble-scale-sync/blob/main/config.yaml.example) and the [config.yaml reference](/guide/configuration#config-yaml-reference) show every key.

- The add-on copies the file at startup. The live reload watches that copy, so after editing the file under `/share`, restart the add-on.
- The other options are ignored, the transport options included: the file's `ble.handler` decides. The log warns about a `ble` or transport option you left set. Two exceptions: `proxy_liveness_timeout_min` is applied on top of the file unless the file sets `ble.proxy_liveness_timeout_min`, and `ble_adapter` with `reset_bluetooth` controls the adapter reset at startup.
- The add-on does not sign in to Garmin. Import a token as in [Sign in to Garmin with MFA](#mfa-workaround); it lands in `/data/garmin-tokens`, where every `garmin` exporter without its own `token_dir` looks. Only that default directory is imported, so give further Garmin accounts a `token_dir` you can write to, such as `/share/ble-scale-sync/garmin-tokens/<name>`.
- A `strava` exporter without its own `token_dir` keeps its tokens in `/data/strava-tokens`, which survives restarts and updates.
- In this mode the adapter reset at startup runs only when `ble_adapter` is set. Turn off `reset_bluetooth` if your file uses a proxy.
- For Home Assistant Bluetooth, the add-on's own Supervisor access works without a long-lived token. Write the URL in full; `http://supervisor/core` alone does not reach the websocket:

```yaml
ble:
  handler: ha-bluetooth
  ha_bluetooth:
    url: ws://supervisor/core/websocket
    token: '${SUPERVISOR_TOKEN}'
```

::: warning Files in /share are readable by other add-ons
Every add-on with share access and every Samba user can read and change files under `/share/`, including a custom `config.yaml` with passwords in it.
:::

## Test a Development Build {#testing-a-development-build}

Fixes reach the `dev` branch before a release. Adding the repository as `https://github.com/KristianP26/ble-scale-sync#dev` gives you the dev branch's add-on options and `run.sh`, but `build.yaml` pins the application image to the last release on both branches, so the application code is still the released one. An option that appears only in the dev UI therefore does nothing.

To run unreleased application code, run the Docker image `ghcr.io/kristianp26/ble-scale-sync:dev` outside the Supervisor, with the flags from [Docker](/guide/getting-started#docker). Every push to `dev` updates it and also publishes an immutable `dev-<sha>` tag. You lose MQTT auto-detection and the Supervisor integration.

When you report back, paste the `Version` line from the top of the log; on a dev image it ends with `(image dev @ <commit>)`.

## Restarts and Stored Data {#persistence}

If the app exits on its own, for example after repeated Bluetooth failures, the add-on starts it again after a short, growing delay; the Supervisor's Watchdog switch is not needed.

| Path                                   | Content                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/data/config.yaml`                    | The generated config, rewritten on every start with each user's `last_known_weight` kept                 |
| `/data/garmin-tokens/`                 | Garmin token                                                                                             |
| `/data/strava-tokens/`                 | Strava tokens of a `strava` exporter without its own `token_dir`                                         |
| `/data/.*`                             | Retry queue, de-duplication marks, last live weigh-ins for the [replay check](/exporters#replay-check), update check date |
| `/share/ble-scale-sync/config.yaml`    | Your file for [custom config mode](#custom-config-mode)                                                  |
| `/share/ble-scale-sync/garmin-tokens/` | A Garmin token to import ([Sign in to Garmin with MFA](#mfa-workaround))                                             |

`/data` survives restarts and updates and is cleared when you uninstall the add-on. The remembered weight is stored per user slug, so renaming the user starts over.

## Limitations {#limitations-and-roadmap}

- The options cover a single user. For several users or per-user exporters use [custom config mode](#custom-config-mode).
- HACS cannot install the add-on, since HACS does not distribute Supervisor add-ons. Add the repository as under [Install](#install).

## Troubleshooting

- No scale found: turn on `debug`, step on the scale and look for it in the log; see [Troubleshooting](/troubleshooting) and [Supported Scales](/guide/supported-scales).
- MQTT entities do not appear: check that the Mosquitto add-on runs, that the log shows `MQTT auto-detected`, and that a reading was exported; discovery happens with the first reading.
- The add-on exits with `DBusError` and `AccessDenied`: reinstall the add-on so the Supervisor applies its manifest; see [Docker issues](/troubleshooting#docker-issues).
- A Beurer scale asks to pair again or shows a code over and over: [Beurer scales](/guide/scales/beurer).
- Discovery stops after hours: [BlueZ stuck state](/troubleshooting#ble-discovery-stops-working-after-hours-bluez-stuck-state).
- The add-on stops with `ERROR:` about a transport: fix the option the line names; the add-on's Documentation tab lists each message.
