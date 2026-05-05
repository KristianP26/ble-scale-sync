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
  --group-add 112 -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml ghcr.io/kristianp26/ble-scale-sync:latest setup

# Standalone (Node.js — Linux, macOS, Windows)
npm run setup
```

The wizard generates a complete `config.yaml`. If a config already exists, it offers **edit mode** — pick any section to reconfigure without starting over.

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
  # noble_driver: abandonware
  # adapter: hci1
```

| Field          | Required    | Default        | Description                                                                           |
| -------------- | ----------- | -------------- | ------------------------------------------------------------------------------------- |
| `scale_mac`    | Recommended | Auto-discovery | MAC address or CoreBluetooth UUID (macOS). Prevents connecting to a neighbor's scale. |
| `noble_driver` | No          | OS default     | `abandonware` or `stoprocent`. Overrides the default BLE driver.                      |
| `adapter`      | No          | System default | Linux only. Select a specific Bluetooth adapter (e.g., `hci0`, `hci1`). See below.    |

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

### Exporters

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

Shared by all users unless a user defines their own `exporters` list. See [Exporters](/exporters) for all 7 targets and their configuration fields.

### Runtime

```yaml
runtime:
  continuous_mode: false
  scan_cooldown: 30
  dry_run: false
  debug: false
  watchdog_max_consecutive_failures: 10
```

| Field                               | Required | Default | Description                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continuous_mode`                   | No       | `false` | Keep scanning in a loop (for always-on deployments)                                                                                                                                                                                                                                                                    |
| `scan_cooldown`                     | No       | `30`    | Seconds between scans (5–3600). On the native BLE handler in continuous mode, after a successful read the app sleeps at least 25 s regardless of this setting so it does not reconnect while the scale is still advertising (post-disconnect grace, [#143](https://github.com/KristianP26/ble-scale-sync/issues/143)). |
| `dry_run`                           | No       | `false` | Read scale + compute body comp, skip exports                                                                                                                                                                                                                                                                           |
| `debug`                             | No       | `false` | Verbose BLE logging                                                                                                                                                                                                                                                                                                    |
| `watchdog_max_consecutive_failures` | No       | `10`    | In continuous mode on Linux: exit after this many consecutive scan failures so Docker `restart: unless-stopped` can recover from a stuck BlueZ controller (0 = disabled). See [Troubleshooting](/troubleshooting#ble-discovery-stops-working-after-hours-bluez-stuck-state).                                           |

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

YAML values support `${ENV_VAR}` syntax for passwords and tokens. The variable must be defined in the environment or in a `.env` file — loading fails if a reference is undefined.

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
