---
title: Getting Started
description: Install BLE Scale Sync with Docker, the Home Assistant add-on or Node.js, run the setup wizard and keep it running as a service.
---

# Getting Started

BLE Scale Sync runs on Linux (including Raspberry Pi), macOS and Windows, on any host with a Bluetooth adapter in range of the scale or with a [proxy](#esp32-proxy) near it.

- [Docker](#docker): Linux hosts such as a Raspberry Pi or a NAS. Works with any Home Assistant install through the [MQTT exporter](/exporters#mqtt).
- [Home Assistant add-on](#home-assistant-addon): Home Assistant OS or Supervised.
- [Standalone Node.js](#standalone): Linux, macOS and Windows.

## Recommended Hardware

- A [Raspberry Pi Zero 2 W](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/) (about 15 EUR, built-in Bluetooth) with Raspberry Pi OS Lite, or any Raspberry Pi 3, 4 or 5.
- Any [supported scale](/guide/supported-scales).

The first-generation Raspberry Pi Zero W (ARMv6) is not supported: `npm install` fails with `SIGILL`. See [install fails on Raspberry Pi Zero W](/troubleshooting#install-fails-on-raspberry-pi-zero-w-first-gen).

### Hosts Without Bluetooth {#esp32-proxy}

A host without Bluetooth, or one out of range of the scale, reads it through an ESP32 or ESPHome proxy near the scale, or through the Bluetooth proxies Home Assistant already has. [Bluetooth transports](/guide/transports) compares them.

## Docker (Linux only) {#docker}

The image reads Bluetooth through the host's BlueZ over D-Bus, so it needs a Linux host. On macOS and Windows use the [standalone install](#standalone).

### 1. Configure

Create a directory with the file and folders the container mounts. Docker creates a missing mount source as a directory owned by root, which the container cannot write to.

```bash
mkdir -p ~/ble-scale-sync/garmin-tokens ~/ble-scale-sync/strava-tokens
cd ~/ble-scale-sync
touch config.yaml
```

The container runs as UID 1000, which is the first user on Raspberry Pi OS. If `id -u` prints another number, run `sudo chown -R 1000:1000 ~/ble-scale-sync`.

Run the setup wizard from that directory. It finds the scale, asks for your profile and exporters, signs in to Garmin and Strava, and writes `config.yaml`:

```bash
docker run --rm -it \
  --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add "$(getent group bluetooth | cut -d: -f3)" \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml \
  -v ./garmin-tokens:/app/garmin-tokens \
  -v ./strava-tokens:/app/strava-tokens \
  ghcr.io/kristianp26/ble-scale-sync:latest setup
```

The wizard reports that the empty `config.yaml` cannot be edited and sets up a new one. Its default `token_dir` is `./garmin-tokens` (and `./strava-tokens`), relative to `config.yaml`, which is `/app/garmin-tokens` in the container. If you enter another `token_dir`, mount that path instead.

### 2. Run

```bash
docker run -d --name ble-scale-sync --restart unless-stopped \
  --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add "$(getent group bluetooth | cut -d: -f3)" \
  --device /dev/rfkill \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml \
  -v ./garmin-tokens:/app/garmin-tokens \
  -v ./strava-tokens:/app/strava-tokens \
  -e CONTINUOUS_MODE=true \
  -e TZ="$(timedatectl show -p Timezone --value)" \
  ghcr.io/kristianp26/ble-scale-sync:latest
```

Check the log with `docker logs -f ble-scale-sync`. It shows `BLE Scale Sync (continuous)` at startup, then a `Measurement:` line when you step on the scale.

What the flags do:

- `--network host` and `-v /var/run/dbus:/var/run/dbus:ro`: access to BlueZ through the host's system D-Bus.
- `--cap-add NET_ADMIN --cap-add NET_RAW`: raw Bluetooth operations.
- `--group-add "$(getent group bluetooth | cut -d: -f3)"`: the host's `bluetooth` group ID. Keep the quotes: if the group does not exist, Docker reports it instead of failing later with an unclear D-Bus error.
- `--device /dev/rfkill`: lets the app power-cycle the adapter when BlueZ gets stuck. Optional.
- `-e TZ=...`: the host's time zone. Without it the container runs in UTC, and the Intervals.icu and wger exporters file a weigh-in made shortly after midnight under the previous day.

`config.yaml` is mounted as a single file, so the files the app keeps next to it (the export retry queue, the replay check state, the stored weigh-in marks and the update check date) stay inside the container and are lost when it is re-created, for example on an update. The tokens are safe in their mounted directories.

To use Docker Compose instead:

1. Copy `docker-compose.example.yml` from the repository to `docker-compose.yml` in this directory.
2. In a `.env` next to it, set `BLUETOOTH_GID=` to the output of `getent group bluetooth | cut -d: -f3`.
3. Replace the volume `garmin-tokens:/home/node/.garmin_tokens` with `./garmin-tokens:/app/garmin-tokens`, add `./strava-tokens:/app/strava-tokens`, and set `TZ` to your time zone.
4. Run `docker compose up -d`.

### Other Commands

The image takes the same subcommands as the [standalone commands](#commands):

```bash
docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW \
  --group-add "$(getent group bluetooth | cut -d: -f3)" -v /var/run/dbus:/var/run/dbus:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest scan      # list nearby BLE devices

docker run --rm -v ./config.yaml:/app/config.yaml:ro \
  ghcr.io/kristianp26/ble-scale-sync:latest validate  # check config.yaml
```

## Home Assistant Add-on {#home-assistant-addon}

The add-on needs Home Assistant OS or Supervised; **Settings** > **About** shows your install type. On Home Assistant Container or Core, use [Docker](#docker) with the [MQTT exporter](/exporters#mqtt).

[![Add BLE Scale Sync repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKristianP26%2Fble-scale-sync)

Installation, options and Garmin setup are in the [Home Assistant add-on guide](/guide/home-assistant-addon).

## Standalone (Node.js) {#standalone}

### Prerequisites

- [Node.js](https://nodejs.org/) 22.23.4 or later 22.x, 24.22.1 or later 24.x, or 26.12.1 or later.
- A Bluetooth adapter. On Linux, install BlueZ: `sudo apt-get install bluetooth bluez`.
- On Windows, [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the C++ workload, or the prebuilt driver `ble.noble_driver: stoprocent`. See [Noble drivers](/guide/transports#noble-drivers).
- For Garmin Connect only: Python 3.12 or newer (`python3 --version`), and on Debian or Raspberry Pi OS the `python3-venv` package.

### Install from npm (no clone) {#install-from-npm}

Install the `ble-scale-sync` command and create a directory for its config:

```bash
npm install -g ble-scale-sync       # with sudo if npm reports EACCES
mkdir -p ~/ble-scale-sync && cd ~/ble-scale-sync
```

`config.yaml` and `.env` are read from the directory you run the command in. Keep both in this directory and always start the app from there.

To try the app without installing it, run `npx ble-scale-sync setup` and then `npx ble-scale-sync` in that directory. The Garmin and service steps below need the global install.

### Install from a clone

For contributing, or to run code that is not released yet:

```bash
git clone https://github.com/KristianP26/ble-scale-sync.git
cd ble-scale-sync
npm install
```

The clone directory holds `config.yaml`, and the commands are npm scripts, see [Commands](#commands).

### Install the Garmin Dependencies {#garmin-from-npm}

Skip this step if you do not use Garmin Connect. The wizard signs in to Garmin with a Python script, so install its packages first. Raspberry Pi OS and Debian refuse a system-wide `pip install`, so use a virtual environment in the app directory:

```bash
cd ~/ble-scale-sync              # from a clone: the clone directory
python3 -m venv venv
source venv/bin/activate         # Windows: venv\Scripts\activate
pip install -r "$(npm root -g)/ble-scale-sync/requirements.txt"   # from a clone: pip install -r requirements.txt
```

The app finds Python as `python3` or `python` on `PATH`. Activate the virtual environment before you run the app by hand; the [service](#run-as-a-service-linux) puts it on `PATH` itself.

### Configure

```bash
ble-scale-sync setup   # from a clone: npm run setup
```

The wizard finds the scale, asks for your profile and exporters, signs in to Garmin and Strava, and writes `config.yaml` in the current directory. To write it by hand, see [Configuration](/guide/configuration).

To sign in to Garmin again later, for example after a password change:

```bash
ble-scale-sync setup-garmin --all-users   # from a clone: npm run setup-garmin -- --all-users
```

It uses the accounts and `token_dir` from `config.yaml`; `--user <name>` signs in one user.

### Run

```bash
ble-scale-sync                       # one reading, then exit
CONTINUOUS_MODE=true ble-scale-sync  # keep running
DRY_RUN=true ble-scale-sync          # read the scale, skip exports
```

From a clone the same three are `npm start`, `CONTINUOUS_MODE=true npm start` and `DRY_RUN=true npm start`. Step on the scale: a reading logs a `Measurement:` line with the weight. Press **Ctrl+C** to stop continuous mode.

### Commands

From an install the commands are subcommands, from a clone they are npm scripts:

| From an install | From a clone | What it does |
| --- | --- | --- |
| `ble-scale-sync` | `npm start` | Run the sync flow |
| `ble-scale-sync setup` | `npm run setup` | Interactive setup wizard |
| `ble-scale-sync setup-garmin --all-users` | `npm run setup-garmin -- --all-users` | Garmin Connect sign-in for the users in `config.yaml` |
| `ble-scale-sync setup-strava` | `npm run setup-strava` | Strava OAuth token setup |
| `ble-scale-sync scan` | `npm run scan` | Discover nearby BLE devices |
| `ble-scale-sync diagnose MAC` | `npm run diagnose -- MAC` | BLE diagnostic dump of this host's radio; on a proxy transport only with `--native` |
| `ble-scale-sync validate` | `npm run validate` | Validate `config.yaml` and exit |
| `ble-scale-sync --help` | `npm start -- --help` | Command list and environment overrides |
| `ble-scale-sync --version` | - | Print the version |

`--config <path>` points the run command, `validate`, `setup`, `scan` and `diagnose` at another `config.yaml`, see [where config.yaml is read from](/guide/configuration#config-location).

### Install a Bluetooth Stack Later {#adding-a-ble-stack}

If the app says a Bluetooth stack package is missing, install it next to the app:

```bash
npm install -g @stoprocent/noble    # next to a global ble-scale-sync install
```

Under `npx` the cache directory is discarded between runs, so install the app with the stack instead: `npm install -g ble-scale-sync @stoprocent/noble`.

### Run as a Service (Linux)

1. Find your user name with `id -un`. Raspberry Pi OS has no default `pi` user: it is the user you created in Raspberry Pi Imager or at first boot.
2. For an npm install, find the command's path with `command -v ble-scale-sync`.
3. Create `/etc/systemd/system/ble-scale.service`, with `YOUR_USER` replaced and `ExecStart` set to the path from step 2:

   ```ini
   [Unit]
   Description=BLE Scale Sync
   After=network.target bluetooth.target
   # Keep restarting after repeated BLE or network failures instead of giving up
   # after the default 5 starts in 10 s.
   StartLimitIntervalSec=0

   [Service]
   Type=simple
   User=YOUR_USER
   # The directory that holds config.yaml (for a clone: the clone directory)
   WorkingDirectory=/home/YOUR_USER/ble-scale-sync
   # The leading "-" lets the service start when there is no .env
   EnvironmentFile=-/home/YOUR_USER/ble-scale-sync/.env
   Environment="CONTINUOUS_MODE=true"
   # venv/bin first, so the Garmin exporter finds its Python packages
   Environment="PATH=/home/YOUR_USER/ble-scale-sync/venv/bin:/usr/local/bin:/usr/bin:/bin"
   # npm install: the path from step 2
   ExecStart=/usr/bin/ble-scale-sync
   # Clone: the compiled build instead
   # ExecStart=/usr/bin/node dist/index.js
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

4. From a clone, build the app with `npm run build`, and again after every `git pull`.
5. Start the service and enable it at boot:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now ble-scale.service
   ```

Check it with `journalctl -u ble-scale.service -f`: it logs `BLE Scale Sync (continuous)` at startup.

## Next Steps {#what-s-next}

- [Configuration](/guide/configuration): every `config.yaml` option.
- [Exporters](/exporters): Garmin Connect, MQTT and the other targets.
- [Multi-user](/multi-user): several people on one scale.
- [Troubleshooting](/troubleshooting): when the scale is not found or no reading arrives.
