# BLE Scale Sync

![CI](https://github.com/KristianP26/ble-scale-sync/actions/workflows/ci.yml/badge.svg)
![GitHub Release](https://img.shields.io/github/v/release/KristianP26/ble-scale-sync)
![License: GPL-3.0](https://img.shields.io/github/license/KristianP26/ble-scale-sync?v=2)
![TypeScript](https://img.shields.io/badge/typescript-%3E%3D5-blue?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker&logoColor=white)

A cross-platform CLI tool that reads body composition data from **24+ BLE smart scales** and exports to **Garmin Connect**, **Strava**, **MQTT** (Home Assistant), **InfluxDB**, **Webhooks**, **Ntfy**, and **local files** (CSV/JSONL). No phone app needed. Your data stays on your device.

**[Documentation](https://blescalesync.dev)** · **[Getting Started](https://blescalesync.dev/guide/getting-started)** · **[Supported Scales](https://blescalesync.dev/guide/supported-scales)** · **[Exporters](https://blescalesync.dev/exporters)** · **[FAQ](https://blescalesync.dev/faq)**

## Why This Exists

Most BLE smart scales measure weight and body impedance over Bluetooth, but their companion apps have no way to sync data to **Garmin Connect**. The only workflow was: open the phone app, wait for it to sync, then manually type the numbers into Garmin. Every single time.

I didn't want to depend on a phone app. So I built this tool. A **Raspberry Pi Zero 2W** sits next to the scale, always on, always listening. Step on the scale, wait a few seconds, and the reading appears in Garmin Connect - **no phone needed, no app, no manual entry**. It just works.

If you can't have a Pi next to your scale, a cheap **ESP32 proxy** can sit nearby and relay BLE data over WiFi to a Docker server anywhere on your network. See the [ESP32 BLE proxy guide](https://blescalesync.dev/guide/esp32-proxy).

## Quick Start

### Docker (Linux)

```bash
# Configure
docker run --rm -it --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add 112 -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml \
  -v ./garmin-tokens:/app/garmin-tokens \
  ghcr.io/kristianp26/ble-scale-sync:latest setup

# Run (continuous mode, auto-restart)
docker run -d --restart unless-stopped --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add 112 --device /dev/rfkill \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml:ro \
  -v ./garmin-tokens:/app/garmin-tokens:ro \
  -e CONTINUOUS_MODE=true \
  ghcr.io/kristianp26/ble-scale-sync:latest
```

Ideal for Raspberry Pi, NAS, and headless servers. Works alongside any Home Assistant install (Container, Core, OS) via MQTT auto-discovery.

### Home Assistant Add-on

If you run Home Assistant **OS** or **Supervised**, one click is all it takes:

[![Add BLE Scale Sync repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKristianP26%2Fble-scale-sync)

The badge opens your Home Assistant instance, confirms the repository, and shows BLE Scale Sync in the Add-on Store ready to install.

<details>
<summary>Prefer manual steps?</summary>

1. **Settings** > **Add-ons** > **Add-on Store** > three-dot menu > **Repositories**
2. Add `https://github.com/KristianP26/ble-scale-sync` and install **BLE Scale Sync**

</details>

The add-on handles config through the UI, auto-detects the Mosquitto broker for Home Assistant auto-discovery, and bootstraps Garmin tokens on first start. See the [Home Assistant Add-on guide](https://blescalesync.dev/guide/home-assistant-addon) for the full option reference, MFA workaround, and custom config mode.

> **Note:** Add-ons are not available on **HA Container** or **HA Core** installs (no Supervisor). Use the Docker method above instead. Sensors still appear in HA via MQTT auto-discovery.

### Standalone (Node.js, Linux/macOS/Windows)

Runs natively on all major desktop and server operating systems. No containers required.

```bash
git clone https://github.com/KristianP26/ble-scale-sync.git
cd ble-scale-sync && npm install
npm run setup                       # interactive wizard
CONTINUOUS_MODE=true npm start      # always-on
```

Requires Node.js v22+ and a BLE adapter. See the **[full install guide](https://blescalesync.dev/guide/getting-started)** for prerequisites and systemd service setup.

## Features

- **[24+ scale brands](https://blescalesync.dev/guide/supported-scales).** Xiaomi (Mi Scale 2 passive broadcast), Renpho (Elis 1, FITINDEX, Sencor, QN-Scale), Eufy, Yunmai, Beurer, Sanitas, Medisana, and more.
- **[7 export targets](https://blescalesync.dev/exporters).** Garmin Connect, Strava, MQTT (Home Assistant), InfluxDB, Webhook, Ntfy, File (CSV/JSONL).
- **[10 body metrics](https://blescalesync.dev/body-composition).** BIA-based body composition from weight + impedance.
- **[Multi-user](https://blescalesync.dev/multi-user).** Automatic weight-based identification with per-user exporters.
- **Historical sync.** Replays a scale's onboard cache of offline measurements with their original timestamps to exporters that support back-dating (Garmin Connect, InfluxDB, File).
- **[Interactive setup wizard](https://blescalesync.dev/guide/configuration).** Scale discovery, exporter config, connectivity tests.
- **[BLE diagnostic tool](https://blescalesync.dev/troubleshooting).** `npm run diagnose` for detailed BLE troubleshooting.
- **[Home Assistant Add-on](https://blescalesync.dev/guide/home-assistant-addon).** One-click install via My Home Assistant badge, MQTT auto-discovery, UI-driven config, Garmin token bootstrap, and MFA workaround.
- **[ESP32 BLE proxy](https://blescalesync.dev/guide/esp32-proxy).** Use a remote ESP32 as a BLE radio over MQTT, with a built-in embedded broker for zero-config setup, simplified Docker deployment, and optional display.
- **[ESPHome Bluetooth proxy](https://blescalesync.dev/guide/esphome-proxy).** Reuse an existing ESPHome BT proxy mesh (Home Assistant) as a BLE radio via Native API (experimental, broadcast-only in phase 1).
- **BLE adapter selection.** `ble.adapter: hci1` for multi-adapter setups (Linux).
- **Broadcast mode.** Supports non-connectable scales that only advertise weight via BLE advertisements.
- **Linux stability hardening.** Auto-recovery for the BlueZ "stuck discovery" state via a consecutive-failure watchdog, plus optional [systemd `Type=notify`](https://blescalesync.dev/troubleshooting#ble-discovery-stops-working-after-hours-bluez-stuck-state) integration for whole-loop freezes.
- **Update check.** Optional, anonymous version check after each measurement (opt-out via `update_check: false`); see the [auto update guide](https://blescalesync.dev/guide/auto-update) for Watchtower, systemd timer, and HA add-on recipes.
- **Cross-platform.** Linux (Docker + native), macOS, Windows.
- **Private.** Your data stays on your device, no vendor cloud.

## Credits

- **Scale protocols** - many adapters ported from [openScale](https://github.com/oliexdev/openScale) (oliexdev and contributors); Eufy P2 / P2 Pro ported from [bdr99/eufylife-ble-client](https://github.com/bdr99/eufylife-ble-client); QN-Scale / FITINDEX and a few others reverse-engineered in this project
- **Garmin upload** - powered by [garminconnect](https://github.com/cyberjunky/python-garminconnect) by cyberjunky
- **BLE** - [node-ble](https://github.com/chrvadala/node-ble) (Linux), [@abandonware/noble](https://github.com/abandonware/noble) (Windows), [@stoprocent/noble](https://github.com/stoprocent/noble) (macOS)
- **ESP32 proxy** - [mqtt_as](https://github.com/peterhinch/micropython-mqtt) by peterhinch, [aioble](https://github.com/micropython/micropython-lib/tree/master/micropython/bluetooth/aioble)

## Contributors

<table><tr>
<td align="center"><a href="https://github.com/KristianP26"><img src="https://avatars.githubusercontent.com/u/28766334?v=4" width="60" height="60" alt="KristianP26"><br><sub>KristianP26</sub></a></td>
<td align="center"><a href="https://github.com/APIUM"><img src="https://avatars.githubusercontent.com/u/9067013?v=4" width="60" height="60" alt="APIUM"><br><sub>APIUM</sub></a></td>
<td align="center"><a href="https://github.com/marcelorodrigo"><img src="https://avatars.githubusercontent.com/u/443962?v=4" width="60" height="60" alt="marcelorodrigo"><br><sub>marcelorodrigo</sub></a></td>
<td align="center"><a href="https://github.com/fromport"><img src="https://avatars.githubusercontent.com/u/5751308?v=4" width="60" height="60" alt="fromport"><br><sub>fromport</sub></a></td>
</tr></table>

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, project structure, and how to add new scale adapters or exporters.

## License

GPL-3.0. See [LICENSE](LICENSE) for details.

## Star History

<a href="https://www.star-history.com/?repos=KristianP26%2Fble-scale-sync&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=KristianP26/ble-scale-sync&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=KristianP26/ble-scale-sync&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=KristianP26/ble-scale-sync&type=date&legend=top-left" />
 </picture>
</a>
