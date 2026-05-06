---
title: Home Assistant Add-on
description: Install BLE Scale Sync as a Home Assistant add-on, read measurements from Bluetooth smart scales, and expose them as HA sensors via MQTT auto-discovery.
head:
  - - meta
    - name: keywords
      content: home assistant ble scale, hassio bluetooth scale, home assistant addon, mqtt auto discovery, ble scale sync hassio, smart scale home assistant, hacs bluetooth scale
---

# Home Assistant Add-on

BLE Scale Sync ships as a native Home Assistant add-on for Home Assistant OS and Supervised installations. The add-on generates a working config from the UI, auto-detects the Mosquitto broker, exposes every metric as an MQTT auto-discovery sensor, and can optionally upload to Garmin Connect.

## Install

[![Add BLE Scale Sync repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKristianP26%2Fble-scale-sync)

The badge above uses [My Home Assistant](https://www.home-assistant.io/integrations/my/) to open your instance, confirm the repository, and drop you on the Add-on Store with **BLE Scale Sync** visible. Click **Install**, then head to the **Configuration** tab and fill in your scale MAC and user profile. Start the add-on from the **Info** tab. The Supervisor pulls the arm64 / armv7 / amd64 image to match your host.

::: details Prefer manual steps?

1. **Settings** > **Add-ons** > **Add-on Store**.
2. Three-dot menu > **Repositories** and add:

   ```
   https://github.com/KristianP26/ble-scale-sync
   ```

3. Refresh the store. **BLE Scale Sync** appears under the new repository.
4. Click **Install**, then open the **Configuration** tab and fill in your scale MAC and user profile. Start the add-on from the **Info** tab.
   :::

::: tip
The add-on requires `host_network`, `host_dbus`, and the `NET_ADMIN` / `NET_RAW` capabilities to access the host Bluetooth adapter through BlueZ. The Supervisor grants these automatically.
:::

## Quick start

Minimal config for a single-user Renpho / Xiaomi / Eufy scale with MQTT and Home Assistant auto-discovery:

1. Install the **Mosquitto broker** add-on (if you do not already run an MQTT broker) and start it.
2. In the BLE Scale Sync config:
   - Leave **Scale MAC address** empty for auto-discovery, or paste the MAC you found with the `scan` command.
   - Fill **User profile** (name, height, birth date, gender).
   - Leave **MQTT enabled** and **MQTT auto-detect** on. The add-on reads the Mosquitto broker details from the Supervisor API, so no broker URL or credentials are needed.
3. Start the add-on and step on the scale. Within a few minutes new sensors appear under **Settings** > **Devices & Services** > **MQTT**.

The exposed sensors cover weight, body fat, water, muscle mass, bone mass, BMI, BMR, visceral fat, metabolic age, and impedance.

## Configuration reference

All options live under the **Configuration** tab. The add-on regenerates `/data/config.yaml` on every restart, so changes here take effect on the next start.

### Scale and BLE

| Option            | Default              | Notes                                                                                                                                                   |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scale_mac`       | empty                | Leave empty for auto-discovery. Set to a specific MAC like `AA:BB:CC:DD:EE:FF` to skip scanning. Required for scales with non-unique advertised names.  |
| `ble_adapter`     | empty (uses default) | Set to `hci0`, `hci1`, ... on hosts with multiple Bluetooth adapters.                                                                                   |
| `reset_bluetooth` | `true`               | Runs `btmgmt power off/on` at startup. Leave on unless you run other HA Bluetooth integrations that lose connectivity when the adapter is power-cycled. |

### Unit preferences

| Option        | Default | Allowed     |
| ------------- | ------- | ----------- |
| `weight_unit` | `kg`    | `kg`, `lbs` |
| `height_unit` | `cm`    | `cm`, `in`  |

The CLI and exporters display weights and heights in your chosen unit; all internal math stays in kg / cm.

### User profile

| Option                                | Default      | Notes                                                          |
| ------------------------------------- | ------------ | -------------------------------------------------------------- |
| `user_name`                           | `Default`    | Display name used in logs and HA entity names.                 |
| `user_height`                         | `170`        | In the unit chosen above.                                      |
| `user_birth_date`                     | `1990-01-01` | `YYYY-MM-DD`. Used for age-based BMR and physique rating.      |
| `user_gender`                         | `male`       | `male` or `female`.                                            |
| `user_is_athlete`                     | `false`      | Shifts body fat formulas for athletic body types.              |
| `user_weight_min` / `user_weight_max` | `40` / `150` | Used by the multi-user matcher to filter implausible readings. |

### MQTT

| Option                            | Default                  | Notes                                                                                                                                      |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `mqtt_enabled`                    | `true`                   | Enable the MQTT exporter.                                                                                                                  |
| `mqtt_auto`                       | `true`                   | Auto-detect the Mosquitto add-on broker via the Supervisor API. Overrides manual URL / credentials when the Mosquitto add-on is installed. |
| `mqtt_broker_url`                 | empty                    | Manual broker URL, e.g. `mqtt://192.168.1.50:1883` or `mqtts://...`. Only used when `mqtt_auto` is off or auto-detection fails.            |
| `mqtt_username` / `mqtt_password` | empty                    | Credentials for the manual broker.                                                                                                         |
| `mqtt_topic`                      | `scale/body-composition` | Base topic. Payload is published to this topic; HA discovery entities use `homeassistant/sensor/<topic>/...`.                              |
| `mqtt_ha_discovery`               | `true`                   | Publish auto-discovery entities under `homeassistant/`. Disable if you want raw MQTT only.                                                 |
| `mqtt_ha_device_name`             | `BLE Scale`              | Device name grouping the entities in HA.                                                                                                   |

### Garmin Connect

| Option                             | Default | Notes                                                                                                                                  |
| ---------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `garmin_enabled`                   | `false` | Enable the Garmin Connect exporter.                                                                                                    |
| `garmin_email` / `garmin_password` | empty   | Garmin credentials. On first start the add-on runs `setup_garmin.py` to authenticate and saves OAuth tokens to `/data/garmin-tokens/`. |

If your account uses MFA, see [MFA workaround](#mfa-workaround) below.

### Runtime

| Option          | Default | Notes                                                                                                                          |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `scan_cooldown` | `30`    | Seconds to wait between scan cycles in continuous mode. Range: 5-3600.                                                         |
| `debug`         | `false` | Enable verbose BLE logs. Useful when opening an issue.                                                                         |
| `custom_config` | `false` | Ignore UI options entirely and use `/share/ble-scale-sync/config.yaml` instead. See [Custom config mode](#custom-config-mode). |

## MQTT auto-detection

When `mqtt_auto: true` and the Mosquitto add-on is running on the same host, BLE Scale Sync pulls the broker URL, username, and password from the Supervisor API (`GET /services/mqtt`) and wires the MQTT exporter automatically. You will see a line like this in the logs:

```
[ble-scale-sync] MQTT auto-detected: mqtt://core-mosquitto:1883
```

If the Mosquitto add-on is not installed or the API call fails, the add-on falls back to whatever you set in `mqtt_broker_url` / `mqtt_username` / `mqtt_password`.

## Garmin Connect

To upload measurements to Garmin Connect:

1. Enable **Garmin Connect** and enter your email and password in the Configuration tab.
2. Start the add-on.
3. On first start the add-on runs `python3 garmin-scripts/setup_garmin.py --from-config /data/config.yaml`. If authentication succeeds, OAuth tokens are saved under `/data/garmin-tokens/` and subsequent runs reuse them without re-entering the password.

### MFA workaround

Home Assistant add-ons run without an interactive terminal, so the add-on cannot prompt for a 2FA code. If your account has MFA enabled:

1. On a laptop or desktop, clone the repo and run `python3 garmin-scripts/setup_garmin.py`. Enter email, password, and MFA code when prompted. This writes `garmin_tokens.json` to `~/.garmin_tokens/`.
2. Copy that file to `/share/ble-scale-sync/garmin-tokens/` on the Home Assistant host. The Samba and File editor add-ons both expose `/share/` for easy uploads.
3. Restart BLE Scale Sync. On startup the add-on detects the pre-generated token and imports it into `/data/garmin-tokens/`.

The same workflow applies if Garmin is blocking your HA host's IP as a data-centre / VPN address: authenticate from a trusted network and import the tokens.

## Custom config mode

For multi-user setups or exporters the UI does not cover (InfluxDB, Webhook, Ntfy, Strava, File), flip `custom_config: true` and drop a full `config.yaml` at:

```
/share/ble-scale-sync/config.yaml
```

The add-on copies that file verbatim into the runtime location on each start. See [config.yaml.example](https://github.com/KristianP26/ble-scale-sync/blob/main/config.yaml.example) for the full schema.

Custom config mode still benefits from `last_known_weight` persistence (see below) but the add-on does not auto-run Garmin authentication; you handle that yourself by pre-seeding `/share/ble-scale-sync/garmin-tokens/`.

## Persistence

Everything that should survive add-on restarts lives under `/data/` inside the container, which the Supervisor maps to persistent storage:

| Path                   | Purpose                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/data/config.yaml`    | The merged runtime config. Regenerated from UI options on every start, with `last_known_weight` preserved per user. |
| `/data/garmin-tokens/` | Garmin OAuth tokens produced by first authentication.                                                               |

User-supplied files live under `/share/ble-scale-sync/`:

| Path                                   | Purpose                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `/share/ble-scale-sync/config.yaml`    | Custom config (used when `custom_config: true`).                           |
| `/share/ble-scale-sync/garmin-tokens/` | Optional pre-generated Garmin tokens imported on startup (MFA workaround). |

## Troubleshooting

### No scale found

1. Step on the scale to wake it up. Most scales go to sleep after a few seconds.
2. Run the **scan** command from a terminal on the HA host:

   ```bash
   docker run --rm -it --network host --cap-add NET_ADMIN --cap-add NET_RAW \
     --group-add 112 -v /var/run/dbus:/var/run/dbus:ro \
     ghcr.io/kristianp26/ble-scale-sync:latest scan
   ```

3. If the scale is visible, paste its MAC into the **Scale MAC address** field.
4. If multiple Bluetooth adapters are attached, set **BLE adapter** to the one facing the scale (`hci1`, etc.).

### MQTT entities do not appear

1. Open the Mosquitto add-on logs and confirm it is running and accepting connections.
2. Enable `debug: true` in the BLE Scale Sync add-on and restart. Look for `[ble-scale-sync] MQTT auto-detected: ...` at startup.
3. Check that the scale actually produced a measurement; HA auto-discovery entities are published on the first successful reading.

### Garmin "No such file or directory: oauth1_token.json"

Fixed in v1.7.5. Make sure the add-on is on that version or newer. If it still fails, your account likely uses MFA. See [MFA workaround](#mfa-workaround).

### Garmin "'Garmin' object has no attribute 'garth'"

Fixed in v1.8.1. The `garminconnect` library released 0.3.0 on 2026-04-02 which removed the `garth` attribute. The add-on now uses the new native auth API and automatically strips incompatible legacy token files on startup, then re-authenticates from the credentials you entered. If you still see this error, upgrade to v1.8.1 or newer and restart the add-on. MFA users also need to regenerate the MFA token (single `garmin_tokens.json` file now, no more `oauth1/oauth2_token.json`).

### BlueZ discovery gets stuck after hours

Known upstream BlueZ bug on Broadcom adapters (`bluez/bluez#807`). See the general [troubleshooting page](/troubleshooting#ble-discovery-stops-working-after-hours-bluez-stuck-state) for the full recovery behaviour the app implements. The add-on already has `/dev/rfkill` and `CAP_NET_ADMIN` available for the recovery tiers.

## Limitations and roadmap

- The UI is scoped to a single user. For multi-user / per-user-exporter setups, use [custom config mode](#custom-config-mode).
- The add-on has not yet been submitted to the [HACS](https://hacs.xyz/) default repository. For now, add the GitHub URL as a custom repository.
- A dedicated Home Assistant notification exporter (persistent notifications or Companion app push) is planned.

Source, issue tracker, and changelog live at [github.com/KristianP26/ble-scale-sync](https://github.com/KristianP26/ble-scale-sync).
