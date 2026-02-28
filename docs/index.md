---
layout: home

hero:
  name: BLE Scale Sync
  text: Automatic body composition sync
  tagline: Cross-platform CLI for Linux, macOS & Windows. Read weight & impedance from 23 BLE smart scales and export to Garmin Connect, Strava, Home Assistant, InfluxDB, Webhooks, Ntfy & local files. No phone app needed.
  image:
    src: /logo.svg
    alt: BLE Scale Sync
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/KristianP26/ble-scale-sync

features:
  - icon: "\u2696\uFE0F"
    title: 23 Scale Brands
    details: Xiaomi, Renpho, Eufy, Yunmai, Beurer, Sanitas, Medisana, and more. Auto-detection out of the box.
    link: /guide/supported-scales
    linkText: See all scales
  - icon: "\uD83D\uDCE4"
    title: 7 Export Targets
    details: Garmin Connect &bull; Strava &bull; MQTT (Home Assistant) &bull; InfluxDB &bull; Webhook &bull; Ntfy &bull; File (CSV/JSONL)
    link: /exporters
    linkText: Configure exporters
  - icon: "\uD83E\uDDE0"
    title: 10 Body Metrics
    details: BIA-based body composition from weight + impedance.
    link: /body-composition
    linkText: See formulas
  - icon: "\uD83D\uDC65"
    title: Multi-User
    details: Automatic weight-based identification with per-user exporters.
    link: /multi-user
    linkText: Learn more
  - icon: "\uD83D\uDCBB"
    title: Cross-Platform
    details: Runs natively on Linux, macOS & Windows. Docker images available for Linux.
    link: /guide/getting-started
    linkText: Install guide
  - icon: "\uD83D\uDCE1"
    title: ESP32 BLE Proxy
    details: Use a cheap ESP32 as a remote Bluetooth radio over MQTT. No BLE adapter needed on the server. Optional display board for live status.
    link: /guide/esp32-proxy
    linkText: Proxy setup guide
  - icon: "\uD83E\uDDD9"
    title: Setup Wizard
    details: Interactive CLI wizard that discovers scales, configures exporters, tests connectivity, and generates your config.yaml.
    link: /guide/configuration
    linkText: Configuration guide
  - icon: "\uD83D\uDD12"
    title: Private & Self-Hosted
    details: Your data stays on your device. No vendor cloud, no account, no tracking. Fully open source.
    link: /alternatives
    linkText: Compare alternatives
---

## Quick Start

### Option 1: Docker (Linux)

```bash
# Configure
docker run --rm -it --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add 112 -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml \
  -v garmin-tokens:/app/garmin-tokens \
  ghcr.io/kristianp26/ble-scale-sync:latest setup

# Run (continuous mode, auto-restart)
docker run -d --restart unless-stopped --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add 112 -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml:ro \
  -v garmin-tokens:/app/garmin-tokens \
  -e CONTINUOUS_MODE=true \
  ghcr.io/kristianp26/ble-scale-sync:latest
```

Ideal for Raspberry Pi and headless servers. Your data never leaves your network.

### Option 2: Native (Linux, macOS, Windows)

```bash
git clone https://github.com/KristianP26/ble-scale-sync.git
cd ble-scale-sync && npm install
npm run setup    # interactive wizard: scale discovery, user profile, exporters
CONTINUOUS_MODE=true npm start   # always-on, listens for scale indefinitely
```

Requires Node.js v20+ and a BLE adapter. For always-on deployments, create a systemd service:

::: details Example: /etc/systemd/system/ble-scale.service
```ini
[Unit]
Description=BLE Scale Sync
After=network.target bluetooth.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/ble-scale-sync
EnvironmentFile=/home/pi/ble-scale-sync/.env
Environment="CONTINUOUS_MODE=true"
Environment="PATH=/home/pi/ble-scale-sync/venv/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now ble-scale.service
```
:::

::: tip Raspberry Pi Zero 2W
The ideal setup: a [~15€ single-board computer](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/) with built-in BLE, always on, always listening. Step on the scale and your data appears in Garmin Connect within seconds. No phone needed. Note: the original Pi Zero W (ARMv6) is [not supported](/troubleshooting#install-fails-on-raspberry-pi-zero-w-first-gen).
:::

::: tip Two ways to connect your scale
**Local BLE** (Options 1 & 2): the server has a Bluetooth adapter and talks to the scale directly. Needs BlueZ/D-Bus on Linux, or native BLE on macOS/Windows.

**Remote BLE via ESP32**: a cheap ~8€ ESP32 board sits near the scale and relays BLE data over WiFi/MQTT. The server needs no Bluetooth at all, which makes Docker deployment much simpler (no `NET_ADMIN`, no D-Bus mounts). See the [ESP32 BLE Proxy guide](/guide/esp32-proxy).
:::

<div style="text-align: center; margin-top: 2rem;">

[Full Getting Started Guide &rarr;](/guide/getting-started)

</div>
