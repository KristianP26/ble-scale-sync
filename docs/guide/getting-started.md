---
title: Getting Started
description: Install and run BLE Scale Sync with Docker or Node.js.
---

# Getting Started

BLE Scale Sync runs on any device with BLE support — Linux (including Raspberry Pi), macOS, and Windows.

## Docker (Linux only) {#docker}

::: warning Linux only
Docker requires a Linux host (including Raspberry Pi). It uses BlueZ via D-Bus for BLE access, which is not available on macOS or Windows Docker. For those platforms, use the [native install](#native).
:::

### 1. Configure

Run the setup wizard to create `config.yaml`:

```bash
docker run --rm -it \
  --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add 112 \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml \
  ghcr.io/kristianp26/ble-scale-sync:latest setup
```

### 2. Run

```bash
docker run -d --restart unless-stopped \
  --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add 112 \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml:ro \
  -e CONTINUOUS_MODE=true \
  ghcr.io/kristianp26/ble-scale-sync:latest
```

Or use Docker Compose — copy `docker-compose.example.yml` to `docker-compose.yml`:

```bash
docker compose up -d
```

### Other commands

```bash
docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add 112 -v /var/run/dbus:/var/run/dbus:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest scan      # Discover BLE devices

docker run --rm -v ./config.yaml:/app/config.yaml:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest validate   # Validate config
```

::: details Why these Docker flags?
| Flag | Why |
|---|---|
| `--network host` | BLE uses BlueZ via D-Bus, which requires host networking |
| `-v /var/run/dbus:/var/run/dbus:ro` | Access to the system D-Bus socket |
| `--cap-add NET_ADMIN --cap-add NET_RAW` | BLE operations require raw network access |
| `--group-add <GID>` | Bluetooth group GID — run `getent group bluetooth \| cut -d: -f3` (commonly `112`) |
:::

## Native (Linux, macOS, Windows) {#native}

### Prerequisites

| Platform | Requirements |
|---|---|
| **All** | [Node.js](https://nodejs.org/) v20+, BLE adapter |
| **Linux** | `sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev build-essential` |
| **macOS** | `xcode-select --install` (Xcode CLI tools) |
| **Windows** | [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload) |

::: details Garmin Connect requires Python 3.9+
```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```
:::

On Linux, grant BLE capabilities to Node.js:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

### Install

```bash
git clone https://github.com/KristianP26/ble-scale-sync.git
cd ble-scale-sync
npm install
```

### Configure

```bash
npm run setup
```

The wizard creates `config.yaml` with your scale, user profile, and exporter settings. See [Configuration](./configuration) for manual setup.

### Run

```bash
npm start                       # Single measurement
CONTINUOUS_MODE=true npm start  # Always-on (Raspberry Pi)
DRY_RUN=true npm start          # Read scale, skip exports
```

Press **Ctrl+C** for graceful shutdown in continuous mode.

### Run as a service (Linux)

For always-on deployments (e.g. Raspberry Pi), create a systemd service:

::: details Example: /etc/systemd/system/ble-scale.service
```ini
[Unit]
Description=BLE Scale Sync
After=network.target bluetooth.target
# Disable the default restart rate limit (5 starts per 10s).
# Without this, systemd stops restarting the service after repeated
# BLE or network failures -- on a headless device this means silent
# downtime until you notice and manually intervene.
StartLimitIntervalSec=0

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
:::

```bash
sudo systemctl enable --now ble-scale.service
```

## Recommended Hardware

| Component | Recommendation |
|---|---|
| **Single-board computer** | [Raspberry Pi Zero 2W](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/) — $15, built-in BLE, ~0.4W idle |
| **Scale** | Any [supported BLE scale](./supported-scales) |
| **OS** | Raspberry Pi OS Lite (headless) |

::: tip
The Raspberry Pi Zero 2W is the ideal deployment target. It's cheap, tiny, always on, and has built-in Bluetooth. Step on the scale and your data appears in Garmin Connect within seconds — no phone needed.
:::

## What's Next?

- [Configuration](./configuration) — config.yaml reference
- [Supported Scales](./supported-scales) — all 23 brands
- [Exporters](/exporters) — configure export targets
