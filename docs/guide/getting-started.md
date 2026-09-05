---
title: Getting Started
description: Install and run BLE Scale Sync with Docker, the Home Assistant add-on, or natively on Node.js.
head:
  - - meta
    - name: keywords
      content: ble scale setup, smart scale raspberry pi, docker bluetooth scale, install ble scale sync, garmin scale sync, esp32 ble proxy setup
---

# Getting Started

BLE Scale Sync runs on any device with BLE support: Linux (including Raspberry Pi), macOS, and Windows. If your server has no Bluetooth adapter, you can use a cheap [ESP32 as a remote BLE radio](#esp32-proxy) over WiFi.

Pick the install method that fits your setup:

| Method                                         | Best for                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Docker](#docker)                              | Linux / Raspberry Pi / NAS. Works alongside any Home Assistant install (Container, Core, OS) via MQTT |
| [Home Assistant Add-on](#home-assistant-addon) | Home Assistant **OS** or **Supervised** only                                                          |
| [Standalone (Node.js)](#standalone)            | All operating systems (Linux, macOS, Windows). No containers required.                                |
| [ESP32 BLE Proxy](#esp32-proxy)                | Server has no Bluetooth. Pair with any method above                                                   |

## Docker (Linux only) {#docker}

::: warning Linux only
Docker requires a Linux host (including Raspberry Pi). It uses BlueZ via D-Bus for BLE access, which is not available on macOS or Windows Docker. For those platforms, use the [standalone install](#standalone).
:::

### 1. Configure

Run the setup wizard to create `config.yaml`:

```bash
docker run --rm -it \
  --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add "$(getent group bluetooth | cut -d: -f3)" \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml \
  -v ./garmin-tokens:/app/garmin-tokens \
  ghcr.io/kristianp26/ble-scale-sync:latest setup
```

### 2. Run

```bash
docker run -d --restart unless-stopped \
  --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add "$(getent group bluetooth | cut -d: -f3)" \
  --device /dev/rfkill \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml:ro \
  -v ./garmin-tokens:/app/garmin-tokens \
  -e CONTINUOUS_MODE=true \
  ghcr.io/kristianp26/ble-scale-sync:latest
```

Or use Docker Compose. Copy `docker-compose.example.yml` to `docker-compose.yml`:

```bash
docker compose up -d
```

### Other commands

```bash
docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add "$(getent group bluetooth | cut -d: -f3)" -v /var/run/dbus:/var/run/dbus:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest scan      # Discover BLE devices

docker run --rm -v ./config.yaml:/app/config.yaml:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest validate   # Validate config
```

::: tip Garmin tokens permission fix
If Docker creates the `garmin-tokens/` directory automatically, it may be owned by root. The container runs as a non-root user and will fail to write tokens. Fix with:

```bash
sudo chown -R $(id -u):$(id -g) ./garmin-tokens
```

:::

::: details Why these Docker flags?
| Flag | Why |
|---|---|
| `--network host` | BLE uses BlueZ via D-Bus, which requires host networking |
| `-v /var/run/dbus:/var/run/dbus:ro` | Access to the system D-Bus socket |
| `--cap-add NET_ADMIN --cap-add NET_RAW` | BLE operations require raw network access |
| `--device /dev/rfkill` | Enables RF-level adapter recovery when BlueZ gets stuck (recommended) |
| `--group-add "$(getent group bluetooth \| cut -d: -f3)"` | Bluetooth group GID, resolved on your host. Commonly `112` on Debian/Ubuntu and `103` on Raspberry Pi OS. Keep the quotes: if the group does not exist, docker reports it instead of failing later with an unclear D-Bus error |
:::

## Home Assistant Add-on {#home-assistant-addon}

::: warning Home Assistant OS / Supervised only
Add-ons require the Home Assistant Supervisor, which is only present on **HA OS** and **HA Supervised** installations. If you run **HA Container** (Docker) or **HA Core** (Python venv), the **Add-on Store does not exist** in your UI; use the [Docker](#docker) method above and the [MQTT exporter](/exporters#mqtt) instead. Sensors still appear in HA via MQTT auto-discovery exactly the same way.

To check your install type: **Settings → About**.
:::

The easiest path on Home Assistant OS or Supervised. One click adds the repository, then configure through the UI and every metric shows up automatically as an MQTT auto-discovery sensor.

[![Add BLE Scale Sync repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKristianP26%2Fble-scale-sync)

The badge uses [My Home Assistant](https://www.home-assistant.io/integrations/my/) to open your instance, confirm the repository, and land on the Add-on Store with **BLE Scale Sync** visible. Click **Install**, fill in your user profile on the **Configuration** tab, then start the add-on from the **Info** tab.

::: details Prefer manual steps?

1. **Settings** > **Add-ons** > **Add-on Store** > three-dot menu > **Repositories**.
2. Add the repository URL:

   ```
   https://github.com/KristianP26/ble-scale-sync
   ```

3. Refresh the store, install **BLE Scale Sync**, fill in your user profile on the **Configuration** tab, then start the add-on from the **Info** tab.
   :::

See the [Home Assistant Add-on guide](./home-assistant-addon) for the full option reference, Garmin setup (including MFA), custom config mode, and troubleshooting.

## Standalone (Node.js) {#standalone}

Runs natively on **Linux, macOS, and Windows**: no containers, no Supervisor required. The right pick for non-Linux hosts, hosts where Docker is not an option, or when you want to run BLE Scale Sync directly with `npm start`.

### Prerequisites

| Platform    | Requirements                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **All**     | [Node.js](https://nodejs.org/) v22+, BLE adapter                                                                                                                                                                                                                                      |
| **Linux**   | `sudo apt-get install bluetooth bluez` (the default `node-ble` transport is pure JavaScript over BlueZ D-Bus)                                                                                                                                                                          |
| **macOS**   | Nothing extra: the default `@stoprocent/noble` transport ships prebuilt binaries                                                                                                                                                                                                      |
| **Windows** | Nothing extra to start. The default transport, `@abandonware/noble`, builds from source and needs [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload); without them the install still completes and you switch to the prebuilt driver with `ble.noble_driver: stoprocent` |

::: tip
The three BLE stacks are optional dependencies. `npm install` completes even when one of them cannot be built, and the app names the missing package and the remaining transports if you select one that is not installed.
:::

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

### Install from npm (no clone) {#install-from-npm}

The published package ships a single command, `ble-scale-sync`. Run it straight from npx, or install it once and keep it on your PATH:

```bash
npx ble-scale-sync setup        # interactive wizard, writes ./config.yaml
npx ble-scale-sync              # single measurement
```

```bash
npm install -g ble-scale-sync   # or install it permanently
ble-scale-sync setup
```

`config.yaml` and `.env` are read from **the directory you run the command in**, so keep the two together and always run from that directory. Nothing is stored inside the package.

::: warning
Both files are read from the same directory, whichever one holds them. A `.env` left over in the directory you happen to be standing in is the `.env` the app will use.
:::

### Install from a clone

The right pick for contributing, or for running a version that is not released yet:

```bash
git clone https://github.com/KristianP26/ble-scale-sync.git
cd ble-scale-sync
npm install
```

### Commands

The same commands exist in both shapes. From a clone they are npm scripts, from an install they are subcommands:

| From an install                | From a clone              | What it does                                     |
| ------------------------------ | ------------------------- | ------------------------------------------------ |
| `ble-scale-sync`               | `npm start`               | Run the sync flow                                 |
| `ble-scale-sync setup`         | `npm run setup`           | Interactive setup wizard                          |
| `ble-scale-sync setup-garmin`  | `npm run setup-garmin`    | Garmin Connect authentication (needs Python 3.9+) |
| `ble-scale-sync setup-strava`  | `npm run setup-strava`    | Strava OAuth token setup                          |
| `ble-scale-sync scan`          | `npm run scan`            | Discover nearby BLE devices                       |
| `ble-scale-sync diagnose MAC`  | `npm run diagnose -- MAC` | BLE diagnostic dump                               |

`diagnose` tests this host's own Bluetooth radio through Noble. If `ble.handler` is set to a proxy transport (`esphome-proxy`, `mqtt-proxy`, `ha-bluetooth`), it says so and stops, because there is no local radio in that setup for it to check. Use `scan` and `start`, which both go through the configured transport, or pass `--native` to test the local radio anyway.
| `ble-scale-sync validate`      | `npm run validate`        | Validate `config.yaml` and exit                   |
| `ble-scale-sync --help`        | `npm start -- --help`     | Command list and environment overrides            |
| `ble-scale-sync --version`     | -                         | Print the version                                 |

`--config <path>` is accepted by the run path, by `validate` and by `setup`. The Docker image takes the same words: `docker run ... ghcr.io/kristianp26/ble-scale-sync:latest scan`.

### Configure

```bash
ble-scale-sync setup   # from a clone: npm run setup
```

The wizard creates `config.yaml` with your scale, user profile, and exporter settings. See [Configuration](./configuration) for manual setup.

### Run

```bash
ble-scale-sync                       # Single measurement
CONTINUOUS_MODE=true ble-scale-sync  # Always-on (Raspberry Pi)
DRY_RUN=true ble-scale-sync          # Read scale, skip exports
```

From a clone the same three are `npm start`, `CONTINUOUS_MODE=true npm start` and `DRY_RUN=true npm start`.

Press **Ctrl+C** for graceful shutdown in continuous mode.

### Garmin Connect from an npm install {#garmin-from-npm}

The Garmin exporter runs a Python script that ships inside the package, so its Python dependencies have to be installed once:

```bash
pip install -r "$(npm root -g)/ble-scale-sync/requirements.txt"
ble-scale-sync setup-garmin
```

`ble-scale-sync setup-garmin --all-users` authenticates every Garmin user in `config.yaml`, and `--user <name>` does one of them.

### Adding a BLE stack later {#adding-a-ble-stack}

The three BLE stacks are optional dependencies, so an install completes even where one of them cannot be built. If you select a transport that is not installed, the app names the missing package and the transports you still have. Install it where the app itself lives:

```bash
npm install -g @stoprocent/noble    # for a global ble-scale-sync install
```

Under `npx` there is nowhere to install it, because the cache directory is thrown away between runs. Install the app itself instead: `npm install -g ble-scale-sync @stoprocent/noble`.

### Run as a service (Linux)

For always-on deployments (e.g. Raspberry Pi), create a systemd service:

::: details Example: /etc/systemd/system/ble-scale.service

```ini
[Unit]
Description=BLE Scale Sync
After=network.target bluetooth.target
# Disable the default restart rate limit (5 starts per 10s).
# Without this, systemd stops restarting the service after repeated
# BLE or network failures; on a headless device this means silent
# downtime until you notice and manually intervene.
StartLimitIntervalSec=0

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/ble-scale-sync
EnvironmentFile=/home/pi/ble-scale-sync/.env
Environment="CONTINUOUS_MODE=true"
Environment="PATH=/home/pi/ble-scale-sync/venv/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

:::

```bash
npm run build                # compile to dist/ (the service runs plain node)
sudo systemctl enable --now ble-scale.service
```

## ESP32 BLE Proxy {#esp32-proxy}

No Bluetooth on your server? Use a cheap ESP32 board (~8€) as a remote BLE radio. The ESP32 sits near the scale, scans for BLE advertisements, and relays data over WiFi/MQTT. The server needs no Bluetooth adapter at all.

This also simplifies Docker deployments: no `NET_ADMIN`, no `--group-add`, no D-Bus mounts.

### Quick setup

1. Flash MicroPython and the proxy script onto an ESP32 (see [ESP32 BLE Proxy guide](./esp32-proxy) for details)
2. Point the ESP32 at your MQTT broker
3. Configure BLE Scale Sync to use the MQTT proxy:

```yaml
# config.yaml
ble:
  handler: mqtt-proxy
  mqtt_proxy:
    broker_url: mqtt://your-broker:1883
```

4. Run with the simplified Docker compose:

```bash
# No BlueZ, no D-Bus, no NET_ADMIN needed
docker compose -f docker-compose.mqtt-proxy.yml up -d
```

Or set the handler via environment variable:

```bash
BLE_HANDLER=mqtt-proxy npm start
```

::: tip
The ESP32 proxy supports both broadcast scales (weight from BLE advertisements) and GATT scales (notification-based readings via remote connect/read/write commands over MQTT). See the full [ESP32 BLE Proxy guide](./esp32-proxy) for hardware options, flashing instructions, and MQTT topic reference.
:::

## Recommended Hardware

| Component                 | Recommendation                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Single-board computer** | [Raspberry Pi Zero 2W](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/): ~15€, built-in BLE, ~0.4W idle |
| **Scale**                 | Any [supported BLE scale](./supported-scales)                                                                       |
| **OS**                    | Raspberry Pi OS Lite (headless)                                                                                     |

::: tip
The Raspberry Pi Zero 2W is the ideal deployment target. It's cheap, tiny, always on, and has built-in Bluetooth. Step on the scale and your data appears in Garmin Connect within seconds, no phone needed.
:::

::: danger Pi Zero W (first gen) is not supported
The original Raspberry Pi Zero W has an ARMv6 CPU. Key dependencies (`esbuild`, used by the TypeScript runner) do not provide ARMv6 binaries, so `npm install` will fail with a `SIGILL` (illegal instruction) error. This is an upstream toolchain limitation with no workaround. Use a **Pi Zero 2W** (ARMv7/64-bit) or any **Pi 3/4/5** instead.
:::

## What's Next?

- [Configuration](./configuration): config.yaml reference
- [Supported Scales](./supported-scales): full adapter list
- [Exporters](/exporters): configure export targets
- [ESP32 BLE Proxy](./esp32-proxy): remote BLE via WiFi/MQTT
- [FAQ](/faq): common questions on privacy, 2FA, multi-user, and body composition accuracy
