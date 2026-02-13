# BLE Scale Sync

![CI](https://github.com/KristianP26/ble-scale-sync/actions/workflows/ci.yml/badge.svg)
![GitHub Release](https://img.shields.io/github/v/release/KristianP26/ble-scale-sync)
![License: GPL-3.0](https://img.shields.io/github/license/KristianP26/ble-scale-sync)
![TypeScript](https://img.shields.io/badge/typescript-%3E%3D5-blue?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker&logoColor=white)


A cross-platform CLI tool that reads body composition data from a **BLE smart scale** and exports it to multiple targets. Supports **23 scale brands** out of the box, works on **Linux** (including Raspberry Pi), **macOS**, and **Windows**.

## Features

- **23 BLE scale brands** supported ([full list below](#supported-scales))
- **5 export targets** — Garmin Connect, MQTT (Home Assistant), Webhook, InfluxDB, Ntfy ([details](docs/exporters.md))
- **Multi-user support** with automatic weight-based identification ([details](docs/multi-user.md))
- **Interactive setup wizard** — `npm run setup`
- **Docker support** — pre-built multi-arch images on GHCR
- **Continuous mode** — always-on for Raspberry Pi deployments

## Why This Exists

Most BLE smart scales measure weight and body impedance over Bluetooth, but their companion apps have no way to sync data to **Garmin Connect**. The only workflow was: open the phone app, wait for it to sync, then manually type the numbers into Garmin. Every single time.

I didn't want to depend on a phone app. So I built this tool. A **Raspberry Pi Zero 2W** sits next to the scale, always on, always listening. Step on the scale, wait a few seconds, and the reading appears in Garmin Connect — **no phone needed, no app, no manual entry**. It just works.

### Recommended Setup

| Component                 | Recommendation                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Single-board computer** | [Raspberry Pi Zero 2W](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/) — cheap, tiny, built-in BLE, low power (~0.4W idle) |
| **Scale**                 | Any supported BLE scale (see list below)                                                                                                |
| **OS**                    | Raspberry Pi OS Lite (headless, no desktop needed)                                                                                      |

## Supported Scales

| Brand / Model                                         |
| ----------------------------------------------------- |
| **QN-Scale** / Renpho / Senssun / Sencor              |
| **Renpho** ES-WBE28                                   |
| **Renpho** ES-26BB                                    |
| **Xiaomi** Mi Scale 2 (MIBCS / MIBFS)                |
| **Yunmai** Signal / Mini / SE                         |
| **Beurer** BF700 / BF710 / BF800                     |
| **Sanitas** SBF70 / SBF75 / SBF72 / SBF73            |
| **Beurer** BF915                                      |
| **Soehnle** Shape200 / Shape100 / Shape50 / Style100  |
| **Medisana** BS430 / BS440 / BS444                    |
| **Trisa** Body Analyze                                |
| **Excelvan** CF369                                    |
| **Hesley** (YunChen)                                  |
| **Inlife** (fatscale)                                 |
| **Digoo** DG-SO38H                                    |
| **Senssun** Fat                                       |
| **ES-CS20M**                                          |
| **Exingtech** Y1                                      |
| **1byone** / Eufy C1 / Eufy P1                        |
| **Active Era** BS-06                                  |
| **MGB** (Swan / Icomon / YG)                          |
| **Hoffen** BS-8107                                    |
| Any **standard BT SIG BCS/WSS** scale                 |

## How It Works

```
┌──────────┐    ┌──────────────┐    ┌─────────────────────────────┐
│          │    │              │    │  ├─ Garmin Connect (Python) │
│   BLE    │    │  BLE + Body  │    │  ├─ MQTT                    │
│  Scale   │───>│ Composition  │───>│  ├─ Webhook (HTTP)          │
│          │    │              │    │  ├─ InfluxDB                │
│          │    │ (TypeScript) │    │  └─ Ntfy (push)             │
└──────────┘    └──────────────┘    └─────────────────────────────┘
```

The app scans for a BLE scale, auto-detects the brand, reads weight + impedance, calculates [body composition metrics](docs/body-composition.md), and dispatches results in parallel to all enabled exporters.

## Quick Start (Docker)

Pre-built multi-arch images are available on GHCR for `linux/amd64`, `linux/arm64`, and `linux/arm/v7`.

**1. Generate `config.yaml` with the interactive wizard:**

```bash
docker run --rm -it \
  --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add 112 \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml \
  ghcr.io/kristianp26/ble-scale-sync:latest setup
```

The wizard walks you through scale discovery, user profiles, and exporter configuration. The generated `config.yaml` is saved to your current directory.

**2. Run the sync:**

```bash
docker run --rm \
  --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add 112 \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml:ro \
  -e CONTINUOUS_MODE=true \
  ghcr.io/kristianp26/ble-scale-sync:latest
```

Or use Docker Compose — copy `docker-compose.example.yml` to `docker-compose.yml`, edit the values, and run:

```bash
docker compose up -d
```

### Docker Requirements

- **Host network** — BLE uses BlueZ via D-Bus, which requires host networking
- **D-Bus socket** — mount `/var/run/dbus` read-only
- **Capabilities** — `NET_ADMIN` and `NET_RAW` for BLE operations
- **Bluetooth group** — add the host's `bluetooth` GID (`getent group bluetooth | cut -d: -f3`, commonly `112`)
- **Garmin tokens** — mount a volume for `/home/node/.garmin_tokens` to persist auth tokens

### Other Docker Commands

```bash
docker run --rm ghcr.io/kristianp26/ble-scale-sync scan      # Discover BLE devices
docker run --rm ghcr.io/kristianp26/ble-scale-sync validate  # Validate config.yaml
docker run --rm ghcr.io/kristianp26/ble-scale-sync help      # Show help
```

## Quick Start (Native)

### Prerequisites

| Platform  | Requirements |
| --------- | ------------ |
| **All**   | [Node.js](https://nodejs.org/) v20+, [Python](https://python.org/) 3.9+ (Garmin only), BLE adapter |
| **Linux** | `sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev build-essential python3-pip` + `sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))` |
| **macOS** | `xcode-select --install` (Xcode CLI tools) |
| **Windows** | [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload) |

### Install & Run

```bash
git clone https://github.com/KristianP26/ble-scale-sync.git
cd ble-scale-sync
npm install

# Python venv (only for Garmin exporter)
python3 -m venv venv
source venv/bin/activate        # On Windows: venv\Scripts\activate
pip install -r requirements.txt

# Configure
npm run setup                   # Interactive wizard

# Run
npm start
```

> **Note:** Modern Linux distributions (Debian 12+, Ubuntu 23.04+, Raspberry Pi OS Bookworm) require a Python virtual environment — the commands above handle this automatically.

## Configuration

The easiest way to configure the app is with the **interactive setup wizard**:

```bash
npm run setup                   # Interactive wizard
npm run setup -- --non-interactive  # Validate + enrich existing YAML (CI-friendly)
```

The wizard walks you through BLE scale discovery, user profiles, exporter selection, runtime settings, and connectivity tests. If `config.yaml` already exists, the wizard offers **edit mode** — pick any section to reconfigure without starting over.

Alternatively, create `config.yaml` manually — see [`config.yaml.example`](config.yaml.example) for an annotated template.

For detailed exporter configuration (all 5 exporters, field tables, full YAML example), see **[docs/exporters.md](docs/exporters.md)**.

### Environment Overrides

| Variable          | Overrides                 |
| ----------------- | ------------------------- |
| `CONTINUOUS_MODE` | `runtime.continuous_mode` |
| `DRY_RUN`         | `runtime.dry_run`         |
| `DEBUG`           | `runtime.debug`           |
| `SCAN_COOLDOWN`   | `runtime.scan_cooldown`   |
| `SCALE_MAC`       | `ble.scale_mac`           |
| `NOBLE_DRIVER`    | `ble.noble_driver`        |

> **Legacy:** `.env` is also supported as a fallback — see `.env.example`.

## Usage

```bash
npm start                           # Single measurement
CONTINUOUS_MODE=true npm start      # Always-on (Raspberry Pi)
DRY_RUN=true npm start              # Read scale, skip exports
npm run scan                        # Discover nearby BLE devices
npm run validate                    # Validate config.yaml
npm start -- --config /path/to/config.yaml  # Custom config path
```

On Windows (PowerShell), set env vars with `$env:VAR="value"; npm start`.

Press **Ctrl+C** once for graceful shutdown in continuous mode, twice to force exit.

For exported metrics and body composition formulas, see **[docs/body-composition.md](docs/body-composition.md)**.

## Troubleshooting

See **[docs/troubleshooting.md](docs/troubleshooting.md)** for full troubleshooting guide.

**Most common issues:**

- **"Permission denied" on Linux** — run `sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))`
- **Scale not found** — step on the scale to wake it up, verify with `npm run scan`
- **Garmin upload fails** — re-run `npm run setup-garmin` to refresh tokens

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, project structure, how to add new scale adapters or exporters, and PR guidelines.

## Credits

### Scale Protocols

BLE protocols were ported from [**openScale**](https://github.com/oliexdev/openScale), an open-source Android app for Bluetooth scales by oliexdev and contributors.

### Garmin Connect Upload

Powered by [**garminconnect**](https://github.com/cyberjunky/python-garminconnect) by cyberjunky (Ron Klinkien) and contributors.

### BLE Libraries

[**node-ble**](https://github.com/chrvadala/node-ble) (Linux), [**@abandonware/noble**](https://github.com/abandonware/noble) (Windows), [**@stoprocent/noble**](https://github.com/stoprocent/noble) (macOS).

## License

GPL-3.0 License — see [LICENSE](LICENSE) for details.
