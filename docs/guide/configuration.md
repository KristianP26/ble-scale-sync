---
title: Configuration
description: Complete config.yaml reference for BLE Scale Sync.
---

# Configuration

## Setup Wizard (recommended) {#setup-wizard-recommended}

The fastest way to configure BLE Scale Sync is with the **interactive setup wizard**. It walks you through scale discovery, user profiles, exporter selection, and connectivity tests:

```bash
# Docker (Linux)
docker run --rm -it --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  -v ./config.yaml:/app/config.yaml ghcr.io/kristianp26/ble-scale-sync:latest setup

# Native (Linux, macOS, Windows)
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

# Native
npm run validate
```

## config.yaml Reference {#config-yaml-reference}

If you prefer manual configuration, here's the full reference. See [`config.yaml.example`](https://github.com/KristianP26/ble-scale-sync/blob/main/config.yaml.example) for an annotated template.

### BLE

```yaml
ble:
  scale_mac: 'FF:03:00:13:A1:04'
  # noble_driver: abandonware
```

| Field | Required | Default | Description |
|---|---|---|---|
| `scale_mac` | Recommended | Auto-discovery | MAC address or CoreBluetooth UUID (macOS). Prevents connecting to a neighbor's scale. |
| `noble_driver` | No | OS default | `abandonware` or `stoprocent` — override the default BLE driver |

### Scale

```yaml
scale:
  weight_unit: kg
  height_unit: cm
```

| Field | Required | Default | Description |
|---|---|---|---|
| `weight_unit` | No | `kg` | `kg` or `lbs` — display only, calculations always use kg |
| `height_unit` | No | `cm` | `cm` or `in` — for height input in user profiles |

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

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | — | Display name |
| `slug` | No | Auto-generated | Unique ID (lowercase, hyphens) for MQTT topics, InfluxDB tags |
| `height` | Yes | — | Height in configured unit |
| `birth_date` | Yes | — | ISO date (`YYYY-MM-DD`) |
| `gender` | Yes | — | `male` or `female` |
| `is_athlete` | No | `false` | Adjusts [body composition](/body-composition#athlete-mode) formulas |
| `weight_range` | No | — | `{ min, max }` in kg — required for [multi-user](/multi-user) |
| `last_known_weight` | No | `null` | Auto-updated after each measurement |
| `exporters` | No | — | [Per-user exporter](/multi-user#per-user-exporters) overrides |

### Exporters

```yaml
global_exporters:
  - type: garmin
    email: '${GARMIN_EMAIL}'
    password: '${GARMIN_PASSWORD}'
```

Shared by all users unless a user defines their own `exporters` list. See [Exporters](/exporters) for all 5 targets and their configuration fields.

### Runtime

```yaml
runtime:
  continuous_mode: false
  scan_cooldown: 30
  dry_run: false
  debug: false
```

| Field | Required | Default | Description |
|---|---|---|---|
| `continuous_mode` | No | `false` | Keep scanning in a loop (for always-on deployments) |
| `scan_cooldown` | No | `30` | Seconds between scans (5–3600) |
| `dry_run` | No | `false` | Read scale + compute body comp, skip exports |
| `debug` | No | `false` | Verbose BLE logging |

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

| Variable | Overrides |
|---|---|
| `CONTINUOUS_MODE` | `runtime.continuous_mode` |
| `DRY_RUN` | `runtime.dry_run` |
| `DEBUG` | `runtime.debug` |
| `SCAN_COOLDOWN` | `runtime.scan_cooldown` |
| `SCALE_MAC` | `ble.scale_mac` |
| `NOBLE_DRIVER` | `ble.noble_driver` |

::: details Legacy .env support
If `config.yaml` doesn't exist, the app falls back to `.env` configuration. See `.env.example` in the repository. When both files exist, `config.yaml` takes priority.
:::
