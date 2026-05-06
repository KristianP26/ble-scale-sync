---
title: Multi-User Support
description: Automatic weight-based user identification, drift detection, and per-user exporter configuration.
head:
  - - meta
    - name: keywords
      content: multi user smart scale, family scale sync, automatic user detection, weight matching, shared scale garmin, per user garmin strava
---

# Multi-User Support

When multiple users are configured, the app automatically identifies who stepped on the scale based on the measured weight. The [setup wizard](/guide/configuration#setup-wizard-recommended) walks you through adding users and setting weight ranges — no manual YAML editing needed.

## How It Works

1. Someone steps on the scale
2. The app reads the weight and identifies the user by their weight range
3. Body composition is calculated using that user's profile (height, age, gender, athlete mode)
4. Data is exported to that user's configured exporters
5. `last_known_weight` is updated in `config.yaml` for better future matching

Each user defines a `weight_range` so the app knows who's who:

```yaml
users:
  - name: Alice
    weight_range: { min: 50, max: 70 }
    last_known_weight: null
  - name: Bob
    weight_range: { min: 75, max: 100 }
    last_known_weight: 85.5
```

## Weight Matching

The app uses a 4-tier priority system to identify users:

| Priority | Condition | Behavior |
|---|---|---|
| 1 | Single user | Always matches (warns if weight is outside range) |
| 2 | Exact range match | One user's range contains the weight |
| 3 | Overlapping ranges | Multiple matches — tiebreak by `last_known_weight` proximity, then config order |
| 4 | No range match | Closest `last_known_weight` |

If no match is found, the `unknown_user` strategy decides what happens:

| Strategy | Behavior |
|---|---|
| `nearest` (default) | Picks the closest range midpoint (with a warning) |
| `log` | Logs a warning and skips |
| `ignore` | Silently skips |

## Drift Detection

After matching, the app checks if the weight falls in the **outer 10%** of the user's range. If it does, a warning is logged — so you can adjust the range before mismatches start happening.

For example, if Alice's range is 50–70 kg and she weighs 68.5 kg, the app warns that she's near the upper boundary.

## Automatic Weight Tracking

After each measurement, the matched user's `last_known_weight` is automatically updated in `config.yaml`. This improves matching accuracy over time, especially when ranges overlap. Updates are debounced (5s) and skipped for changes under 0.5 kg.

## Per-User Exporters

By default, all users share `global_exporters`. If a user needs different export targets (e.g., separate Garmin accounts), define `exporters` on that user — it completely replaces `global_exporters` for them:

```yaml
users:
  - name: Alice
    # ...
    exporters:
      - type: garmin
        email: 'alice@example.com'
        password: '${ALICE_GARMIN_PASSWORD}'

  - name: Bob
    # ...
    exporters:
      - type: garmin
        email: 'bob@example.com'
        password: '${BOB_GARMIN_PASSWORD}'

global_exporters:
  - type: influxdb
    # ... shared by users without their own exporters list
```

### Exporter behavior in multi-user mode

| Exporter | What changes |
|---|---|
| **MQTT** | Publishes to `{topic}/{slug}`, per-user HA device + LWT |
| **InfluxDB** | Adds `user={slug}` tag to line protocol |
| **Webhook** | Adds `user_name` + `user_slug` fields to JSON |
| **Ntfy** | Prepends `[{name}]` to notification |
| **Garmin** | One account per user via per-user exporter config |

## Live Config Reload

In **continuous mode**, edits to `config.yaml` are detected automatically and applied before the next scan cycle. No restart, no manual signal. Works on Linux, macOS, and Windows. The config is re-validated before applying; if validation fails, the previous config is kept and an error is logged.

Hot-swappable on edit:

- Exporter list (per-user and `global_exporters`)
- User profiles (`name`, `slug`, `height`, `birth_date`, `gender`, `is_athlete`, `weight_range`, `last_known_weight`)
- `scale.weight_unit`, `scale.height_unit`
- `unknown_user` strategy
- `runtime.dry_run`, `runtime.debug`, `runtime.scan_cooldown`
- `ble.scale_mac`
- `update_check`

Restart-required (the change is detected and logged with a warning, but only takes effect after restart): `ble.handler`, `ble.adapter`, `ble.noble_driver`, all `ble.mqtt_proxy.*` fields, all `ble.esphome_proxy.*` fields, `runtime.continuous_mode`, `runtime.watchdog_max_consecutive_failures`, switching between single-user (1 user) and multi-user (>1).

To opt out (e.g. on a flaky network filesystem) and rely solely on the `SIGHUP` flow:

```yaml
runtime:
  watch_config: false
```

`SIGHUP` still works as a manual fallback on Linux/macOS:

```bash
kill -HUP $(pgrep -f "ble-scale-sync")
```
