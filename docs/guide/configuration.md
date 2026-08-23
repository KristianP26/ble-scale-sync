---
title: Configuration
description: Complete config.yaml reference for BLE Scale Sync.
head:
  - - meta
    - name: keywords
      content: ble scale sync config, config.yaml smart scale, setup wizard, scale configuration, garmin exporter config, mqtt exporter config
---

# Configuration

::: tip Using the Home Assistant Add-on?
The add-on is configured through the HA UI, not `config.yaml`. See the [Home Assistant Add-on guide](./home-assistant-addon) for the full option reference.
:::

## Setup Wizard (recommended) {#setup-wizard-recommended}

The fastest way to configure BLE Scale Sync is with the **interactive setup wizard**. It walks you through scale discovery, user profiles, exporter selection, and connectivity tests:

```bash
# Docker (Linux)
docker run --rm -it --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add "$(getent group bluetooth | cut -d: -f3)" -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml ghcr.io/kristianp26/ble-scale-sync:latest setup

# Standalone (Node.js, Linux/macOS/Windows)
npm run setup
```

The wizard generates a complete `config.yaml`. If a config already exists, it offers **edit mode**: pick any section to reconfigure without starting over.

::: tip
You don't need to edit `config.yaml` manually. The wizard handles everything, including BLE scale auto-discovery, Garmin authentication, and exporter connectivity tests.
:::

### Validation

```bash
# Docker
docker run --rm -v ./config.yaml:/app/config.yaml:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest validate

# Standalone (Node.js)
npm run validate
```

## config.yaml Reference {#config-yaml-reference}

If you prefer manual configuration, here's the full reference. See [`config.yaml.example`](https://github.com/KristianP26/ble-scale-sync/blob/main/config.yaml.example) for an annotated template.

### BLE

```yaml
ble:
  scale_mac: 'FF:03:00:13:A1:04'
  # bind_key: '0123456789abcdef0123456789abcdef' # Xiaomi S800 only
  # handler: auto
  # noble_driver: abandonware
  # adapter: hci1
  # force_scale_adapter: 'Hutbit'
  # session_timeout_sec: 20
  # qn_protocol_byte: 0
  # qn_report_byte: 252
```

| Field                 | Required                    | Default        | Description                                                                                                                                                                                                                                        |
| --------------------- | --------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scale_mac`           | Recommended                 | Auto-discovery | MAC address, or a CoreBluetooth UUID on macOS (bare 32-hex as the wizard writes it, or the dashed form). Prevents connecting to a neighbor's scale.                                                                                                |
| `bind_key`            | Xiaomi S800 only            | (none)         | 32-char hex per-device MiBeacon key from the Mi cloud (extract with the community Xiaomi-cloud-tokens-extractor). Decrypts only the device's own FE95 broadcast. Keep it secret; it is a credential.                                               |
| `handler`             | No                          | `auto`         | Transport: `auto` (local radio), `mqtt-proxy` (ESP32 over MQTT), `esphome-proxy` (ESPHome Native API). See below.                                                                                                                                  |
| `noble_driver`        | No                          | OS default     | `abandonware` or `stoprocent`. Overrides the default BLE driver. Only applies when `handler: auto`.                                                                                                                                                |
| `adapter`             | No                          | System default | Linux only. Select a specific Bluetooth adapter (e.g., `hci0`, `hci1`). See below.                                                                                                                                                                 |
| `force_scale_adapter` | No                          | Auto-detect    | Name of the scale protocol adapter to use, bypassing auto-detection. Requires `scale_mac`. See below.                                                                                                                                              |
| `session_timeout_sec` | No                          | `120`          | Seconds of scale silence that end a GATT session (5 to 600); an inbound frame restarts the clock. Native BLE handlers only; ignored on `mqtt-proxy` and `esphome-proxy`. See below.                                                                |
| `qn_protocol_byte`    | No                          | Auto           | QN-family scales only. Protocol byte the handshake echoes back to the scale (0 to 255). Set it when a QN scale runs the whole handshake and then reports nothing, or when its scale-info frame is lost in transit on a proxy transport. See below. |
| `qn_report_byte`      | No                          | `254` (0xFE)   | QN-family scales only. Payload byte of the history-response frame (0 to 255). Try `252` (0xFC) when a QN scale completes the handshake and then reports nothing. See below.                                                                        |
| `mqtt_proxy`          | If `handler: mqtt-proxy`    | (none)         | MQTT proxy connection (`broker_url`, `device_id`, `topic_prefix`, `username`, `password`, `auto_connect`, `embedded_broker_*`). See [ESP32 BLE Proxy](./esp32-proxy).                                                                              |
| `esphome_proxy`       | If `handler: esphome-proxy` | (none)         | ESPHome Native API connection (`host`, `port`, `encryption_key` or `password`, `client_info`). See [ESPHome Bluetooth Proxy](./esphome-proxy).                                                                                                     |

::: warning Forcing a scale adapter
`force_scale_adapter` is an escape hatch for when auto-detection routes your scale to the wrong protocol adapter, which happens with rebadged OEM hardware that shares a vendor service with another brand.

Use the adapter name exactly as it appears in the `Adapters:` line printed at startup:

```yaml
ble:
  scale_mac: '03:B3:EC:91:A2:12'
  force_scale_adapter: 'Hutbit'
```

Two things to know. The forced adapter claims **every** device it is shown, which is why `scale_mac` is required: the MAC is what keeps it aimed at your scale. And an unknown name fails at startup with the list of valid ones rather than being ignored.

If you need this, please [open an issue](https://github.com/KristianP26/ble-scale-sync/issues) with your scale's advertisement, so detection can be fixed for everyone and you can drop the override.
:::

::: tip QN scales that connect but never send a weight (`qn_protocol_byte`)

The QN protocol family (Renpho, Arboleaf, FITINDEX, GE and several rebadges) echoes a protocol byte back to the scale in every configuration command, and the firmware revisions disagree about which value they accept. The wrong value is not an error: the scale acknowledges the entire handshake and then simply never streams a weight, which looks exactly like nobody standing on it.

The scale-info frame length picks the default, and it is right for every unit reported so far. Some firmware wants its own byte rather than 0 or 255: an ES-CS20M that reports 21 needs 21, and the full 0 to 255 range is accepted, so try the value your scale reports before assuming it is a binary choice.

```yaml
ble:
  qn_protocol_byte: 0 # or 255; if neither works, the byte your scale reports (an ES-CS20M reporting 21 needs 21)
```

The debug log states which value is in use. When the scale-info frame arrives:

```
QN: scale info (19B, dialect=es26m), factor=10, proto=0xff
```

On a proxy transport that loses the scale-info frame, that line never prints; look for the fallback line instead, which shows the byte the handshake ran with:

```
QN: fallback: no 0x12 received, running handshake with proto=0x15
```

If a value makes your scale work, please say so in an issue with the model and that line: the default is set from the models we have evidence for, and yours may change it.

:::

::: tip QN scales that still report nothing (`qn_report_byte`)

If `qn_protocol_byte` did not help, there is one more byte worth trying, and it is a separate one.

When the scale asks for its configuration (`0x21`), the handshake answers with a history-response frame:

```
a0 0d 04 fe 00 00 00 00 00 00 00 00 <checksum>
                ^^
```

That `fe` comes from openScale, which took it from a capture of an ES-30M and labels it only as a payload byte. Vendor-app captures of two other scales in the family send `fc` in the same position: a GE CS 10 G and an Arboleaf QN-Scale on firmware V39. Both captures are of sessions where the vendor app completed a weigh-in, on scales where this app sees the whole handshake acknowledged and then nothing.

What the byte actually selects is not known. Both reporters read it as choosing between a live weight stream and the stored-history path, which fits their symptoms, but openScale receives live weight frames while sending `fe`, so that reading cannot be the whole story. The default therefore stays where the evidence is:

```yaml
ble:
  qn_report_byte: 252 # 0xFC, the value both vendor-app captures send
```

With debug logging on, a session running an overridden byte says so:

```
QN: history response byte forced to 0xfc (default 0xfe)
```

If `252` makes your scale produce a weight, please say so in an issue with the model, the dialect from the `QN: scale info` line and that log line. Two confirmations on different firmware would be enough to move the default.

:::

::: tip Shortening the session (`session_timeout_sec`)
Some scales will not run a standalone weigh-in while a host holds the GATT session open. The Beurer BF500 is the clearest example: it displays `APP` and waits, so only a measurement taken **between** sessions is picked up.

By default a session ends after 120 seconds without a notification from the scale. On a scale like this, that is 120 seconds out of every cycle in which stepping on it achieves nothing. Shortening the session, and lengthening the gap after it, frees the scale for most of the cycle:

```yaml
ble:
  session_timeout_sec: 20
runtime:
  scan_cooldown: 60
  watchdog_max_consecutive_failures: 0
```

Two costs, both real:

- **More Bluetooth adapter resets.** Every read that ends in a timeout triggers one, and shorter sessions mean more timeouts per hour. On a Raspberry Pi that is noticeable.
- **The failure watchdog trips sooner.** A session that times out counts as a failed cycle, so shorter sessions reach `watchdog_max_consecutive_failures` (default 10) in proportionally less time, and the process exits for the supervisor to restart. On a scale where waiting between weigh-ins is normal, raise that limit or set it to `0` to disable it, as above.

This option applies to the native BLE handlers only. On `mqtt-proxy` and `esphome-proxy` the watcher waits for a weigh-in indefinitely by design, and the value is ignored.
:::

::: tip BLE adapter selection (Linux only)
If your device has multiple Bluetooth adapters, you can choose which one BLE Scale Sync uses. By default, the first adapter (`hci0`) is used.

List your adapters:

```bash
hciconfig
# or
btmgmt info
```

For example, a Raspberry Pi with a built-in adapter (`hci0`) and a USB dongle (`hci1`):

```yaml
ble:
  adapter: hci1 # use the USB dongle for scale scanning
```

This lets you dedicate one adapter to BLE Scale Sync while keeping the other free for other tasks (e.g., Home Assistant Bluetooth proxy). This option is ignored on macOS and Windows, where the OS manages adapter selection.
:::

### Scale

```yaml
scale:
  weight_unit: kg
  height_unit: cm
```

| Field         | Required | Default | Description                                              |
| ------------- | -------- | ------- | -------------------------------------------------------- |
| `weight_unit` | No       | `kg`    | `kg` or `lbs`. Display only; calculations always use kg. |
| `height_unit` | No       | `cm`    | `cm` or `in`. Used for height input in user profiles.    |

### Users

At least one user is required. For multi-user setups, see [Multi-User Support](/multi-user).

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

| Field               | Required | Default        | Description                                                              |
| ------------------- | -------- | -------------- | ------------------------------------------------------------------------ |
| `name`              | Yes      | (none)         | Display name                                                             |
| `slug`              | No       | Auto-generated | Unique ID (lowercase, hyphens) for MQTT topics, InfluxDB tags            |
| `height`            | Yes      | (none)         | Height in configured unit                                                |
| `birth_date`        | Yes      | (none)         | ISO date (`YYYY-MM-DD`)                                                  |
| `gender`            | Yes      | (none)         | `male` or `female`                                                       |
| `is_athlete`        | No       | `false`        | Adjusts [body composition](/body-composition#athlete-mode) formulas      |
| `weight_range`      | No       | (none)         | `{ min, max }` in kg. Required for [multi-user](/multi-user) deployments |
| `last_known_weight` | No       | `null`         | Auto-updated after each measurement                                      |
| `exporters`         | No       | (none)         | [Per-user exporter](/multi-user#per-user-exporters) overrides            |
| `beurer_pin`        | Beurer   | (none)         | Consent code the Beurer BF7xx / BF9xx scale was paired with              |
| `beurer_user_index` | No       | `1`            | Scale user slot the consent code belongs to                              |
| `beurer_provision`  | No       | `false`        | Write this profile into a Beurer scale that has no stored user           |

### Exporters

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

Shared by all users unless a user defines their own `exporters` list. See [Exporters](/exporters) for all 11 targets and their configuration fields.

### Runtime

```yaml
runtime:
  continuous_mode: false
  scan_cooldown: 30
  dry_run: false
  debug: false
  watchdog_max_consecutive_failures: 10
  watch_config: true
```

| Field                               | Required | Default | Description                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continuous_mode`                   | No       | `false` | Keep scanning in a loop (for always-on deployments)                                                                                                                                                                                                                                                                    |
| `scan_cooldown`                     | No       | `30`    | Seconds between scans (5-3600). On the native BLE handler in continuous mode, after a successful read the app sleeps at least 25 s regardless of this setting so it does not reconnect while the scale is still advertising (post-disconnect grace, [#143](https://github.com/KristianP26/ble-scale-sync/issues/143)). |
| `dry_run`                           | No       | `false` | Read scale + compute body comp, skip exports                                                                                                                                                                                                                                                                           |
| `debug`                             | No       | `false` | Verbose BLE logging                                                                                                                                                                                                                                                                                                    |
| `watchdog_max_consecutive_failures` | No       | `10`    | In continuous mode on Linux: exit after this many consecutive scan failures so Docker `restart: unless-stopped` can recover from a stuck BlueZ controller (0 = disabled). See [Troubleshooting](/troubleshooting#ble-discovery-stops-working-after-hours-bluez-stuck-state).                                           |
| `watch_config`                      | No       | `true`  | Auto-reload `config.yaml` on edit (continuous mode only). Set to `false` to disable and rely on `SIGHUP` only. See [Live Config Reload](/multi-user#live-config-reload).                                                                                                                                               |

### Update Check

```yaml
update_check: true
```

| Field          | Required | Default | Description                                                        |
| -------------- | -------- | ------- | ------------------------------------------------------------------ |
| `update_check` | No       | `true`  | Check for newer versions after each measurement (max once per 24h) |

After each successful measurement, the app sends a single GET request to `api.blescalesync.dev/version`. Only the app version, OS, and architecture are sent via the User-Agent header. No personal data is collected. Automatically disabled when `CI=true`.

Anonymous aggregated statistics are visible at [stats.blescalesync.dev](https://stats.blescalesync.dev).

## Environment Variables

### Secret references

YAML values support `${ENV_VAR}` syntax for passwords and tokens. The variable must be defined in the environment or in a `.env` file; loading fails if a reference is undefined.

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

### Runtime overrides

These environment variables always override `config.yaml` values, useful for Docker `-e` flags:

| Variable                    | Overrides                                   |
| --------------------------- | ------------------------------------------- |
| `CONTINUOUS_MODE`           | `runtime.continuous_mode`                   |
| `DRY_RUN`                   | `runtime.dry_run`                           |
| `DEBUG`                     | `runtime.debug`                             |
| `SCAN_COOLDOWN`             | `runtime.scan_cooldown`                     |
| `BLE_WATCHDOG_MAX_FAILURES` | `runtime.watchdog_max_consecutive_failures` |
| `SCALE_MAC`                 | `ble.scale_mac`                             |
| `NOBLE_DRIVER`              | `ble.noble_driver`                          |
| `BLE_ADAPTER`               | `ble.adapter`                               |

::: details Legacy .env support
If `config.yaml` doesn't exist, the app falls back to `.env` configuration. See `.env.example` in the repository. When both files exist, `config.yaml` takes priority.
:::
