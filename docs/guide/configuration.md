---
title: Configuration
description: Reference for every config.yaml key, its default, the environment overrides and which changes apply without a restart.
---

# Configuration

Every key of `config.yaml` with its default. The Home Assistant add-on is configured in its own UI instead, see the [Home Assistant Add-on guide](./home-assistant-addon).

## Setup Wizard (recommended) {#setup-wizard-recommended}

The wizard writes a complete `config.yaml`: scale discovery, units, users, exporters, Garmin and Strava sign-in and exporter connectivity tests. Run it with `ble-scale-sync setup`, `npm run setup` from a clone, or the Docker command in [Getting Started](/guide/getting-started#docker).

With an existing `config.yaml` the wizard offers edit mode: a menu of sections, each prompt starting from the current value. **Review & Save** lists every setting that changes with its old and new value, with passwords, tokens and topics masked. Saving keeps the comments and key order of the file. **Quit without saving** writes nothing and exits with code 1.

When you type a password or token, the wizard offers to move it to the `.env` next to `config.yaml` and write a reference such as `${GARMIN_PASSWORD}` instead (see [Secret references](#secret-references)). Existing `.env` lines are never changed. Inside a Docker container the offer defaults to no, because a `.env` written there is lost when the container exits unless you mount it.

Keys the wizard does not ask about, such as `display_unit`, `unknown_user` and the scale-specific `ble` keys, are set by hand.

### Validation

```bash
# Docker
docker run --rm -v ./config.yaml:/app/config.yaml:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest validate

# Standalone (npm install or npx)
npx ble-scale-sync validate

# Standalone (from a clone)
npm run validate
```

`validate` runs the same checks as `start`, including that `ble.force_scale_adapter` names a known adapter and comes with `ble.scale_mac`. Every problem is reported in one pass.

## Config File Location {#config-location}

- Docker: `/app/config.yaml`, mounted from the host. The image's default command takes no `--config`, so mount the file at that path. Home Assistant add-on: `/data`.
- Everywhere else: the working directory first, then the package install directory. Under `npx` the package lives in a temporary cache, so run the command from the directory that holds your `config.yaml`.
- `config.yaml` and `.env` always come from the same directory.
- `--config <path>` sets the file for the run path, `validate`, `setup`, `scan` and `diagnose`, and the `.env` next to it is read. A path that does not exist is an error.

## config.yaml Reference {#config-yaml-reference}

[`config.yaml.example`](https://github.com/KristianP26/ble-scale-sync/blob/main/config.yaml.example) is an annotated template.

### File Version

```yaml
version: 1
```

| Key       | Default | Description                                                 |
| --------- | ------- | ----------------------------------------------------------- |
| `version` | (none)  | Required. Config schema version, must be `1`. The wizard writes it. |
| `docker.mode` | `pull` | Accepted and ignored. |

### BLE

```yaml
ble:
  scale_mac: 'FF:03:00:13:A1:04'
```

| Key                          | Default        | Description |
| ---------------------------- | -------------- | ----------- |
| `scale_mac`                  | (none)         | MAC address of your scale, or its CoreBluetooth UUID on macOS. Without it the app connects to the first supported scale it finds, which can be a neighbor's. |
| `bind_key`                   | (none)         | Xiaomi S800 and S400 only. 32-character hex MiBeacon key from the Mi cloud, needed to decrypt the broadcast. Keep it secret. See [Supported Scales](./supported-scales). |
| `handler`                    | `auto`         | Transport: `auto` (this host's Bluetooth), `mqtt-proxy`, `esphome-proxy` or `ha-bluetooth`. See [Choosing a transport](./transports). |
| `noble_driver`               | OS default     | `abandonware` or `stoprocent`. Only with `handler: auto`. See [noble drivers](./transports#noble-drivers). |
| `adapter`                    | System default | Linux only. Bluetooth adapter to use, such as `hci1`. `btmgmt info` lists them. |
| `force_scale_adapter`        | Auto-detect    | Name of a scale protocol adapter, exactly as in the `Adapters:` line at startup, to bypass detection. Requires `scale_mac`, because a forced adapter claims every device. An unknown name fails at startup. Report the misdetection in an issue. |
| `session_timeout_sec`        | `120`          | Seconds of scale silence that end a GATT session, 5 to 600. A session also ends after three times this value. Host adapter, and `mqtt-proxy` outside continuous mode. See [when a session ends](./transports#when-a-session-ends). |
| `auto_clear_stale_bond`      | `false`        | Delete a pairing key the scale has forgotten and pair again, only on evidence that the scale refused the key. Linux built-in Bluetooth only. See [Beurer and Sanitas](./scales/beurer). |
| `pairing_retry_max_min`      | `60`           | Longest wait in minutes, 0 to 1440, before asking again for a pairing nobody accepted on the scale. `0` asks on every scan. Linux built-in Bluetooth, continuous mode only; a single run asks once. See [Beurer and Sanitas](./scales/beurer). |
| `preemptive_adapter_reset`   | `true`         | Power-cycle the adapter with `btmgmt` after every GATT session, against a stuck-discovery state on some Raspberry Pi adapters. Linux built-in Bluetooth only. See [Troubleshooting](/troubleshooting#ble-discovery-stops-working-after-hours-bluez-stuck-state). |
| `adapter_privacy`            | `false`        | Turn on LE privacy on the whole adapter, so pairing hands the scale a host identity key. For Beurer scales that ask for a new pairing before every weigh-in. Linux built-in Bluetooth only. See [Beurer and Sanitas](./scales/beurer#pairing). |
| `proxy_liveness_timeout_min` | `30`           | Minutes without any advertisement, from any device, after which a proxy transport is treated as stuck and the process exits for its supervisor to restart it. `0` disables. Proxy transports only. |
| `mqtt_proxy`                 | (none)         | Required with `handler: mqtt-proxy`. See [ESP32 BLE Proxy](./esp32-proxy). |
| `esphome_proxy`              | (none)         | Required with `handler: esphome-proxy`. See [ESPHome Bluetooth Proxy](./esphome-proxy). |
| `ha_bluetooth`               | (none)         | Required with `handler: ha-bluetooth`. See [Home Assistant Bluetooth](./ha-bluetooth). |

#### Scale-Family Keys

These keys change what the app sends to one family of scales. Leave them unset unless the scale page tells you to try one.

| Key                   | Default     | Description |
| --------------------- | ----------- | ----------- |
| `qn_protocol_byte`    | (none)      | QN scales. Protocol byte the handshake echoes, 0 to 255. See [QN scales](./scales/qn). |
| `qn_report_byte`      | (none)      | QN scales. Deletes the user slots this mask selects on the scale, 0 to 255, on every connection. See [QN scales](./scales/qn). |
| `qn_weight_ack`       | Per dialect | QN scales. Send the weight anchor and acknowledge live weight frames. See [QN scales](./scales/qn). |
| `qn_user_key`         | (none)      | QN scales with a scale-info frame of 18 bytes or longer. User key of the profile frame, 1 to 9999. See [QN scales](./scales/qn). |
| `qn_user_slot`        | (none)      | QN scales with a scale-info frame of 18 bytes or longer. User slot of the profile frame, 1 to 8, only with `qn_user_key`. Experimental. See [QN scales](./scales/qn#user-slot). |
| `qn_time_sync_long`   | `false`     | QN scales. Send the 9-byte time-sync frame with the host's UTC offset. See [QN scales](./scales/qn). |
| `qn_config_long`      | `false`     | QN scales. Send the 10-byte config frame. See [QN scales](./scales/qn). |
| `qn_a4_prelude`       | `false`     | QN scales. Send two extra `0xA4` frames the vendor app sends. They overwrite data the scale keeps for its first user. See [QN scales](./scales/qn). |
| `qn_result_ack`       | `false`     | QN scales with a 19-byte scale-info frame. Send the end-of-measurement frame. Experimental. See [QN scales](./scales/qn). |
| `rmsc04_profile_byte` | (none)      | Renpho R-MSC04. One profile byte as two hex digits in quotes, to export the scale's own body fat. Personal. See [Renpho](./scales/renpho). |

### Scale

```yaml
scale:
  weight_unit: kg
```

| Key            | Default       | Description |
| -------------- | ------------- | ----------- |
| `weight_unit`  | `kg`          | `kg` or `lbs`. Unit of weights in the log and in notification texts. Calculations, `weight_range` and exported values stay in kg. |
| `height_unit`  | `cm`          | `cm` or `in`. Unit of `users[].height`. |
| `display_unit` | `weight_unit` | Unit to show on the scale's own display: `weight_unit`, `kg`, `lbs` or `st`. Only QN scales and the Active Era BS-06 adapter are told; other scales ignore it. |

### Unknown User

```yaml
unknown_user: nearest
```

| Key            | Default   | Description |
| -------------- | --------- | ----------- |
| `unknown_user` | `nearest` | What happens to a reading no user matches, with several users and no `last_known_weight` yet: `nearest` (the user whose `weight_range` midpoint is closest), `log` (logged, not exported) or `ignore`. See [Multi-User](/multi-user). |

### Out-of-Range Readings

```yaml
out_of_range: skip
```

| Key            | Default | Description |
| -------------- | ------- | ----------- |
| `out_of_range` | `warn`  | What happens to a reading no user's `weight_range` covers. `warn` logs and exports it; `skip` logs it and stops before the exporters and the `last_known_weight` update. `skip` suits a household with several users. See [Multi-User](/multi-user). |

### Users

At least one user is required.

```yaml
users:
  - name: Alice
    slug: alice
    height: 168
    birth_date: '1995-03-20'
    gender: female
    is_athlete: false
    weight_range: { min: 50, max: 75 }
```

| Key                         | Default | Description |
| --------------------------- | ------- | ----------- |
| `name`                      | (none)  | Required. Display name. |
| `slug`                      | (none)  | Required. Unique ID of lowercase letters, digits and hyphens, used in MQTT topics, InfluxDB tags and file names. The wizard derives it from the name. |
| `height`                    | (none)  | Required. Height in `scale.height_unit`. |
| `birth_date`                | (none)  | Required. `YYYY-MM-DD`, a real date not in the future. |
| `gender`                    | (none)  | Required. `male` or `female`. |
| `is_athlete`                | (none)  | Required. `true` or `false`. See [athlete mode](/body-composition#athlete-mode). |
| `weight_range`              | (none)  | Required. `{ min, max }` in kg. Matches readings to users and gives the weight anchor some scales need. See [Multi-User](/multi-user). |
| `last_known_weight`         | (none)  | Updated after each reading. Used for matching, as the weight anchor and by the [replay check](/exporters#historical-readings). |
| `exporters`                 | (none)  | Exporters for this user only. See [per-user exporters](/multi-user#per-user-exporters). |
| `estimate_body_composition` | `true`  | `false`: a weigh-in without measured body composition exports no body fat, water, bone mass, muscle mass, visceral fat or physique rating instead of an estimate. See [Exporters](/exporters#weigh-ins-without-body-composition). |
| `beurer_pin`                | (none)  | Beurer and Sanitas scales with a consent code, 0 to 9999. Read from the first user. See [Beurer and Sanitas](./scales/beurer). |
| `beurer_user_index`         | `1`     | User slot on the scale that the consent code belongs to. |
| `beurer_provision`          | `false` | Write this profile into a Beurer scale that has no stored user. |
| `beurer_register_new_user`  | `false` | Create a new user record on the scale, once. See [Beurer and Sanitas](./scales/beurer). |

The weight and time of each user's last live weigh-in are kept in `.last-live-weigh-ins.json` next to `config.yaml`, for the [replay check](/exporters#historical-readings).

### Exporters

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

`global_exporters` apply to every user. An exporter in a user's own `exporters` list is added for that user, and one of a type that is also global replaces the global one for that user. Every exporter and its fields are on [Exporters](/exporters).

### Runtime

```yaml
runtime:
  continuous_mode: true
```

| Key                                 | Default | Description |
| ----------------------------------- | ------- | ----------- |
| `continuous_mode`                   | `false` | Keep scanning in a loop instead of exiting after one reading. |
| `scan_cooldown`                     | `30`    | Seconds to wait after a successful reading, 5 to 3600. Host adapter only; at least 25 s on Linux built-in Bluetooth. |
| `idle_rescan_delay`                 | `5`     | Seconds to wait after a cycle that found no scale while the adapter was healthy, 0 to 3600. Linux built-in Bluetooth only. |
| `no_reading_rescan_delay`           | `0`     | Minimum seconds to wait, 0 to 3600, after a session in which the scale answered and then sent nothing until it timed out. Nothing is scanned or retried during the wait. Linux built-in Bluetooth, continuous mode only. See [Beurer and Sanitas](./scales/beurer). |
| `retry_failed_exports`              | `true`  | Keep a reading whose export failed and retry it about 15 minutes, 1, 6, 24 and 71 hours later, up to 50 readings. Only exporters that can record a past measurement are retried. See [Exporters](/exporters#historical-readings). |
| `dry_run`                           | `false` | Read the scale and compute body composition, export nothing. |
| `debug`                             | `false` | Verbose logging, including BLE frames. |
| `watchdog_max_consecutive_failures` | `10`    | In continuous mode on the host adapter, exit after this many failed scan cycles in a row so the supervisor restarts the app. With a noble driver a scan that did not find the scale counts too. `0` disables. See [Troubleshooting](/troubleshooting#the-app-exits-after-repeated-scan-failures). |
| `watch_config`                      | `true`  | Reload `config.yaml` when it changes, in continuous mode. `false` leaves `SIGHUP` as the only trigger. See [Live Config Reload](#live-config-reload). |

In continuous mode the next scan waits `scan_cooldown` after a reading and `idle_rescan_delay` after a cycle that found no scale. After a failure, or a session that timed out, it waits 5 s, doubling up to 60 s while failures continue, or `no_reading_rescan_delay` when that is longer. The log line names the case, such as `No scale found, rescanning in 5s... (Device not found)`. The proxy transports listen all the time and use none of these waits.

The retry queue is `.export-retry-queue.jsonl` next to `config.yaml`, mode 0600, deleted when empty. In Docker it is lost when the container is re-created, see [Run](/guide/getting-started#_2-run).

### Update Check

```yaml
update_check: false
```

| Key            | Default | Description |
| -------------- | ------- | ----------- |
| `update_check` | `true`  | After a measurement, at most once per UTC day, ask `api.blescalesync.dev/version` for the latest version. Off when `CI=true`. |

The request sends only the User-Agent `ble-scale-sync/<version> (<platform>; <arch>)`. The date of the last check is kept in `.update-check-state.json` next to `config.yaml`. The anonymous totals are public at [stats.blescalesync.dev](https://stats.blescalesync.dev).

## Live Config Reload

In continuous mode the app reloads `config.yaml` when the file changes and applies it before the next scan cycle, on Linux, macOS and Windows. An invalid file is not applied: the previous config stays and the log says why. A change to a key that needs a restart is logged with `Restart required for this field to take effect.`

| Key | Applies | Note |
| --- | ------- | ---- |
| `users` (every field, adding and removing users) | Reload | |
| `global_exporters`, `users[].exporters` | Reload | |
| `scale.*`, `unknown_user`, `out_of_range`, `update_check` | Reload | |
| `runtime.dry_run`, `debug`, `scan_cooldown`, `idle_rescan_delay` | Reload | |
| `runtime.no_reading_rescan_delay` | Reload | From the next session without a reading; a wait already running is not shortened. |
| `ble.scale_mac`, `bind_key`, `session_timeout_sec` | Reload | |
| `ble.auto_clear_stale_bond`, `pairing_retry_max_min`, `preemptive_adapter_reset` | Reload | |
| `ble.qn_*`, `ble.rmsc04_profile_byte` | Reload | |
| `ble.proxy_liveness_timeout_min` | Reload | From the next advertisement wait. |
| `ble.handler`, `adapter`, `noble_driver`, `adapter_privacy`, `force_scale_adapter` | Restart | |
| `ble.mqtt_proxy.*`, `ble.esphome_proxy.*`, `ble.ha_bluetooth.*` | Restart | Every field. |
| `runtime.continuous_mode`, `retry_failed_exports`, `watchdog_max_consecutive_failures`, `watch_config` | Restart | |

A reload also reads `.env` again, so a changed secret applies without a restart.

In Docker with `config.yaml` mounted as a single file, an edit made in place is picked up. A tool that saves by writing a new file and renaming it, such as `sed -i` and some editors, replaces the file on the host while the container keeps the old one; only a container restart (`docker restart ble-scale-sync`) picks that up.

To reload by hand on Linux or macOS, also with `watch_config: false`, send `SIGHUP` to the app:

```bash
sudo systemctl kill -s HUP ble-scale   # systemd service
docker kill -s HUP ble-scale-sync      # Docker
kill -HUP NODE_PID                     # any other node process
```

## Environment Variables

### Secret references

Any value can be a `${ENV_VAR}` reference, taken from the environment or from the `.env` next to `config.yaml`. Loading fails if a referenced variable is not set. A reference that is the whole value also works for numbers and booleans (`port: ${MQTT_PORT}`). Write `$${...}` for a literal `${...}`. Variables set in the real environment win over `.env`.

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

### Runtime overrides

These variables override `config.yaml` when they are set in the real environment, such as Docker `-e` or Compose `environment:`. When a `config.yaml` exists, an override set only in `.env` is ignored with a warning. Each override is logged without its value.

| Variable                    | Overrides                                            |
| --------------------------- | ---------------------------------------------------- |
| `CONTINUOUS_MODE`           | `runtime.continuous_mode`                            |
| `DRY_RUN`                   | `runtime.dry_run`                                    |
| `DEBUG`                     | `runtime.debug`                                      |
| `SCAN_COOLDOWN`             | `runtime.scan_cooldown`                              |
| `BLE_HANDLER`               | `ble.handler`                                        |
| `BLE_WATCHDOG_MAX_FAILURES` | `runtime.watchdog_max_consecutive_failures`          |
| `SCALE_MAC`                 | `ble.scale_mac`                                      |
| `NOBLE_DRIVER`              | `ble.noble_driver`                                   |
| `BLE_ADAPTER`               | `ble.adapter`                                        |

An empty or invalid value is ignored, the value from `config.yaml` stays and the log says so. Booleans accept `true`/`false`, `yes`/`no`, `on`/`off` and `1`/`0`. `BLE_HANDLER` takes a proxy handler only when that proxy is configured in `config.yaml`.

`BLE_RETRY_BASE_DELAY_MS` sets the base wait in ms between the attempts of one export call (default `1000`). It does not change the [retry queue](#runtime).

::: details Legacy .env support
Without a `config.yaml` the app reads its whole configuration from `.env`, see `.env.example` in the repository. When both exist, the configuration comes from `config.yaml` and `.env` only supplies the `${VAR}` references.
:::
