---
title: Pi Zero W Deployment
description: Deploy BLE Scale Sync on a Raspberry Pi Zero W (v1.1) with Docker.
---

# Pi Zero W Deployment

The Raspberry Pi Zero W v1.1 uses an ARMv6 processor. The standard GHCR image works on ARMv7+ and ARM64, but ARMv6 requires building the image locally and transferring it to the Pi.

## Prerequisites

### On your dev machine (Linux/WSL2/macOS)

- Docker with [buildx](https://docs.docker.com/buildx/install/) (included with Docker Desktop)
- QEMU user-static (for cross-architecture emulation)

### On the Pi Zero W

- **Raspberry Pi OS Lite (Bookworm, 32-bit)** — flashed via [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
- **Docker Engine v28** (the last version to support 32-bit armhf)
- SSH access and WiFi configured

## Install Docker on the Pi

Docker's official packages don't support ARMv6, but the Raspbian `bookworm` repository has working builds. Even if the Pi runs Bookworm natively, you need to pin Docker's apt source to `bookworm` explicitly since Docker hasn't published packages for newer Raspbian suites.

```bash
# Install Docker via the convenience script
curl -fsSL https://get.docker.com | sh

# Add your user to the docker group (log out and back in after)
sudo usermod -aG docker $USER

# Verify Docker is running
sudo docker info
```

If `apt update` fails with 404 errors on the Docker repository, pin it to bookworm:

```bash
sudo sed -i 's/trixie/bookworm/g' /etc/apt/sources.list.d/docker.list
sudo apt-get update
```

::: warning Docker v28 is the last 32-bit release
Docker Engine v29+ drops 32-bit armhf entirely. Pin to v28 if your package manager tries to upgrade:
```bash
sudo apt-mark hold docker-ce docker-ce-cli containerd.io
```
:::

## Build the image (on your dev machine)

Run these commands from the `ble-scale-sync` repo root:

```bash
# One-time: register QEMU handlers for cross-arch emulation
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes

# One-time: create a buildx builder with multi-arch support
docker buildx create --name armbuilder --use

# Build the ARMv6 image and export as a tar file
docker buildx build \
  --platform linux/arm/v6 \
  -t ble-scale-sync:armv6 \
  -o type=docker,dest=ble-scale-sync-armv6.tar .
```

The build takes 10-20 minutes under QEMU emulation. The resulting tar is ~250-400 MB.

## Transfer to the Pi

```bash
scp ble-scale-sync-armv6.tar pi@<pi-hostname-or-ip>:~/
```

## Deploy on the Pi

### Load the image

```bash
docker load -i ~/ble-scale-sync-armv6.tar
```

### Create your config

If you don't already have a `config.yaml`, run the setup wizard:

```bash
docker run --rm -it \
  --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml \
  ble-scale-sync:armv6 setup
```

### Run with Docker Compose (recommended)

Create a `docker-compose.yml`:

```yaml
services:
  ble-scale-sync:
    image: ble-scale-sync:armv6
    container_name: ble-scale-sync
    network_mode: host
    cap_add:
      - NET_ADMIN
      - NET_RAW
    volumes:
      - ./config.yaml:/app/config.yaml:ro
      - /var/run/dbus:/var/run/dbus:ro
      # Garmin auth tokens (if using Garmin export)
      - garmin-tokens:/home/node/.garmin_tokens
    environment:
      - CONTINUOUS_MODE=true
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'

volumes:
  garmin-tokens:
```

```bash
docker compose up -d
docker logs -f ble-scale-sync
```

### Run with `docker run`

```bash
docker run -d --name ble-scale-sync \
  --restart unless-stopped \
  --network host \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  -v /var/run/dbus:/var/run/dbus:ro \
  -v ./config.yaml:/app/config.yaml:ro \
  -v garmin-tokens:/home/node/.garmin_tokens \
  -e CONTINUOUS_MODE=true \
  ble-scale-sync:armv6
```

## Updating

When a new version is released, rebuild and retransfer:

```bash
# On dev machine (from repo root after git pull)
docker buildx build \
  --platform linux/arm/v6 \
  -t ble-scale-sync:armv6 \
  -o type=docker,dest=ble-scale-sync-armv6.tar .

scp ble-scale-sync-armv6.tar pi@<pi-hostname-or-ip>:~/

# On the Pi
docker load -i ~/ble-scale-sync-armv6.tar
docker compose down && docker compose up -d
```

## Troubleshooting

### "Illegal instruction" on startup

This means the image was built for ARMv7+, not ARMv6. Verify you built with `--platform linux/arm/v6`.

### BlueZ/D-Bus permission errors

Ensure the D-Bus socket is mounted and capabilities are set:
```bash
# Check D-Bus is running on the host
sudo systemctl status dbus

# Find your bluetooth group GID
getent group bluetooth | cut -d: -f3
```

If needed, add `--group-add <GID>` to your run command (commonly `112`).

### Container health check failing

The health check expects a heartbeat file updated within 5 minutes. Check logs for BLE connection issues:
```bash
docker logs --tail 50 ble-scale-sync
```

### Slow performance

The Pi Zero W has a single-core 1 GHz ARM11 CPU. Startup takes 15-30 seconds (vs ~2 seconds on a Pi 4). This is normal. Once running, the event loop is idle most of the time waiting for BLE advertisements.
