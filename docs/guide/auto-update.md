---
title: Auto Updates
description: Update BLE Scale Sync automatically or on a schedule in the Home Assistant add-on, Docker Compose, an npm install and a systemd install from a clone.
---

# Auto Updates

The app logs `Update available: ...` when a newer release exists, but it never installs one. To turn that check off, see [Update check](/guide/configuration#update-check). Releases are listed in the [changelog](/changelog).

## Home Assistant Add-on

### Manual Updates (default)

A new version shows an **Update** button under **Settings** > **Apps** > **BLE Scale Sync**. The Supervisor pulls the new image and restarts the add-on; options and `/data` are kept.

### Automatic Updates

1. Open **Settings** > **Apps** > **BLE Scale Sync**.
2. Turn on **Auto update**.
3. Keep the backup toggle on in the update dialog, so the Supervisor makes a partial backup before each update. Whether that toggle starts on is set under **Settings** > **System** > **Backups**.

The Supervisor then installs new versions during its daily update check and restarts the add-on.

In custom config mode an update replaces the image and leaves `/share/ble-scale-sync/config.yaml` as it is. Read the [changelog](/changelog) for config changes before you turn on unattended updates.

## Docker Compose

An update re-creates the container, which drops the files the app keeps next to a single-file `config.yaml` mount, the export retry queue included. See [Run](/guide/getting-started#_2-run).

### Systemd Timer

A timer that pulls the image and restarts the stack needs no extra container. Create `/etc/systemd/system/ble-scale-sync-update.service`, with `WorkingDirectory` set to the directory of your `docker-compose.yml`:

```ini
[Unit]
Description=Pull latest ble-scale-sync image and restart the stack
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/home/YOUR_USER/ble-scale-sync
ExecStart=/usr/bin/docker compose pull
ExecStart=/usr/bin/docker compose up -d
```

and `/etc/systemd/system/ble-scale-sync-update.timer`:

```ini
[Unit]
Description=Daily ble-scale-sync image update

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
```

Enable it and check the next run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ble-scale-sync-update.timer
systemctl list-timers ble-scale-sync-update
```

### Watchtower {#watchtower-with-label-opt-in}

[Watchtower](https://github.com/containrrr/watchtower) restarts a container when a newer image is pushed. The upstream project was archived in December 2025 and receives no more updates. If you run it, opt in only this container with a label, and add the sidecar next to your existing service:

```yaml
services:
  ble-scale-sync:
    # ... your existing service
    labels:
      - 'com.centurylinklabs.watchtower.enable=true'

  watchtower:
    image: containrrr/watchtower
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_LABEL_ENABLE=true # touch only labelled containers
      - WATCHTOWER_CLEANUP=true # remove the old image after an update
      - WATCHTOWER_POLL_INTERVAL=86400 # check once a day
      - WATCHTOWER_INCLUDE_RESTARTING=true # also update a container stuck in a restart loop
```

To get a notification instead of an update, add `WATCHTOWER_MONITOR_ONLY=true`, `WATCHTOWER_NOTIFICATIONS=shoutrrr` and `WATCHTOWER_NOTIFICATION_URL=ntfy://ntfy.sh/YOUR_TOPIC` to the `watchtower` environment.

## npm Install

Update the global install and restart the service:

```bash
npm install -g ble-scale-sync@latest
sudo systemctl restart ble-scale.service
```

## Systemd Install from a Clone {#raspberry-pi-systemd-source-deployment}

For a clone that runs as `ble-scale.service` (see [Run as a service](/guide/getting-started#run-as-a-service-linux)), a timer can fast-forward `main`, rebuild and restart the service. `main` can hold code that is not released yet; to stay on releases, [pin a tag](#pinning-a-version) instead.

### Update Script

Create `/home/YOUR_USER/ble-scale-sync/scripts/auto-update.sh` and make it executable with `chmod +x`:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /home/YOUR_USER/ble-scale-sync

git fetch --quiet origin main
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date ($LOCAL)."
  exit 0
fi

echo "Updating from $LOCAL to $REMOTE..."

# Fast-forward only: refuse divergent history to protect local edits
git merge --ff-only origin/main

# Full install when the lockfile changed: the build needs TypeScript, a devDependency
if git diff --name-only "$LOCAL" "$REMOTE" | grep -qE '^(package(-lock)?\.json)$'; then
  npm ci
fi

# tsc stops the script on a type error, so the service is not restarted; dist/ is already rewritten
npm run build

# Stops the old process and starts the new build; if it fails to start,
# Restart=always in ble-scale.service keeps retrying
sudo systemctl restart ble-scale.service

echo "Updated to $REMOTE."
```

The `sudo systemctl restart` line needs passwordless sudo for that command.

### Timer

```ini
# /etc/systemd/system/ble-scale-sync-update.service
[Unit]
Description=Update ble-scale-sync from main and restart service
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=YOUR_USER
ExecStart=/home/YOUR_USER/ble-scale-sync/scripts/auto-update.sh
```

```ini
# /etc/systemd/system/ble-scale-sync-update.timer
[Unit]
Description=Weekly ble-scale-sync git pull

[Timer]
OnCalendar=Sun 04:30
Persistent=true
RandomizedDelaySec=30min

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ble-scale-sync-update.timer
```

This runs every Sunday at 04:30 local time, up to 30 minutes later. If the script fails before the restart (diverged history, failed install or build), the service keeps running the old build, and the error is in `journalctl -u ble-scale-sync-update.service`.

## Pinning a Version

To upgrade only by hand, pin a release instead of `latest`.

Docker: image tags are the version without the `v`. `X.Y.Z` pins one release, `X.Y` follows its patch releases.

```yaml
image: ghcr.io/kristianp26/ble-scale-sync:X.Y.Z
```

Install from a clone: check out a release tag, then rebuild.

```bash
cd /home/YOUR_USER/ble-scale-sync
git fetch --tags
git checkout vX.Y.Z
npm ci && npm run build
```

The Home Assistant add-on always runs the image of its own version; keep **Auto update** off to stay on it. With a pinned version, leave the update timer off; the update check still tells you when a release is out.

## Safety Checklist Before Enabling Unattended Updates

- `config.yaml` (and `/data` on Home Assistant, or your Docker volumes) is backed up off the device.
- Your scale works on the current version, with no open [issue](https://github.com/KristianP26/ble-scale-sync/issues) for your hardware.
- You read the [changelog](/changelog) from time to time; releases can add or rename config fields.
- Exporter tokens (Garmin, Strava) are in a volume that survives a re-created container.
- Something alerts you when the service stops, such as a check on `/tmp/.ble-scale-sync-heartbeat`, a Home Assistant notification or the ntfy exporter.
