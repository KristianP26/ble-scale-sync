---
title: Auto Updates
description: Keep BLE Scale Sync up to date automatically on Home Assistant, Docker Compose, and Raspberry Pi systemd deployments.
head:
  - - meta
    - name: keywords
      content: ble scale sync auto update, watchtower docker, home assistant addon auto update, raspberry pi unattended update, docker pull cron, systemd timer update
---

# Auto Updates

BLE Scale Sync ships with an anonymous update check that logs when a newer release is available, but it does not install the update for you. This page lists the recommended way to automate actual updates for each deployment target. Pick the section that matches your setup.

::: tip
New releases are announced on the [releases page](https://github.com/KristianP26/ble-scale-sync/releases) and in the [changelog](/changelog). The update check runs at most once every 24 hours and can be disabled with `update_check: false` in `config.yaml`.
:::

## Home Assistant Add-on

The Home Assistant Supervisor manages add-on updates. There are two modes, both configured from the HA UI without editing any files.

### Manual updates (default)

When a new version is published, the Supervisor shows an **Update** banner in:

- **Settings** > **Add-ons** > **BLE Scale Sync**
- **Settings** > **Updates** (aggregated view for core, OS, and add-ons)

Click **Update** and the Supervisor pulls the new image, restarts the add-on, and keeps your options and `/data` volume intact. No further action is needed.

### Automatic updates

1. Open **Settings** > **Add-ons** > **BLE Scale Sync**.
2. Toggle **Auto update** on.
3. Optional but recommended: keep the backup toggle enabled on the update dialog so the Supervisor creates a partial backup before each upgrade. You can set the default preference in **Settings** > **System** > **Backups**.

With **Auto update** on, the Supervisor picks up new versions during its daily update check (same schedule as HA core updates) and restarts the add-on unattended.

::: warning
If you run the add-on in custom config mode (`custom_config: true` with a file at `/share/ble-scale-sync/config.yaml`), auto updates still replace the container image but leave your custom YAML untouched. Review the [changelog](/changelog) for breaking schema changes before enabling unattended updates.
:::

## Docker Compose

For self-managed Docker and Docker Compose setups, the simplest option is [Watchtower](https://containrrr.dev/watchtower/), a small sidecar that watches the container registry and restarts your container when a newer image is pushed to `ghcr.io/kristianp26/ble-scale-sync:latest`.

### Watchtower with label opt-in

Add a label to the `ble-scale-sync` service and a second `watchtower` service. The `WATCHTOWER_LABEL_ENABLE=true` flag makes Watchtower ignore every other container on the host, which is the safe default on a machine running other workloads.

```yaml
services:
  ble-scale-sync:
    image: ghcr.io/kristianp26/ble-scale-sync:latest
    container_name: ble-scale-sync
    network_mode: host
    cap_add:
      - NET_ADMIN
      - NET_RAW
    group_add:
      - '112'
    volumes:
      - ./config.yaml:/app/config.yaml
      - /var/run/dbus:/var/run/dbus:ro
      - ./garmin-tokens:/app/garmin-tokens
    environment:
      - CONTINUOUS_MODE=true
    restart: unless-stopped
    labels:
      - 'com.centurylinklabs.watchtower.enable=true'

  watchtower:
    image: containrrr/watchtower
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_LABEL_ENABLE=true
      - WATCHTOWER_CLEANUP=true
      - WATCHTOWER_POLL_INTERVAL=86400
      - WATCHTOWER_INCLUDE_RESTARTING=true
      - TZ=Europe/Bratislava
```

What each environment variable does:

- `WATCHTOWER_LABEL_ENABLE=true` only touches containers that set `com.centurylinklabs.watchtower.enable=true`.
- `WATCHTOWER_CLEANUP=true` removes the old image after a successful upgrade so the SD card does not fill up.
- `WATCHTOWER_POLL_INTERVAL=86400` polls once per day.
- `WATCHTOWER_INCLUDE_RESTARTING=true` still upgrades the container if it is stuck in a restart loop.

Apply the stack:

```bash
docker compose pull
docker compose up -d
```

### Monitor-only mode (notify, do not update)

If you want Watchtower to report new versions but keep the upgrade manual, switch the sidecar into monitor-only mode and point notifications at Ntfy (the same service the app can already use as an exporter):

```yaml
environment:
  - WATCHTOWER_LABEL_ENABLE=true
  - WATCHTOWER_MONITOR_ONLY=true
  - WATCHTOWER_NOTIFICATIONS=shoutrrr
  - WATCHTOWER_NOTIFICATION_URL=ntfy://ntfy.sh/my-topic
```

### Cron-based alternative (no sidecar)

If a Watchtower container feels like too much, a systemd timer that pulls and restarts works just as well and uses no background memory:

```ini
# /etc/systemd/system/ble-scale-sync-update.service
[Unit]
Description=Pull latest ble-scale-sync image and restart the stack
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/home/pi/ble-scale-sync
ExecStart=/usr/bin/docker compose pull
ExecStart=/usr/bin/docker compose up -d
```

```ini
# /etc/systemd/system/ble-scale-sync-update.timer
[Unit]
Description=Daily ble-scale-sync image update

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
```

Enable the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ble-scale-sync-update.timer
systemctl list-timers ble-scale-sync-update
```

## Raspberry Pi systemd (source deployment)

If you cloned the repo directly on the Pi and run it as `ble-scale.service`, a systemd timer can keep `main` fast-forwarded and restart the service on new commits.

### Update script

Create `/home/pi/ble-scale-sync/scripts/auto-update.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /home/pi/ble-scale-sync

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

# Reinstall only if package.json or package-lock.json changed
if git diff --name-only "$LOCAL" "$REMOTE" | grep -qE '^(package(-lock)?\.json)$'; then
  npm ci --omit=dev
fi

# Cheap sanity gate before restart
npx tsc --noEmit

# Restart; systemd keeps the previous unit running if the new one fails to boot
sudo systemctl restart ble-scale.service

echo "Updated to $REMOTE."
```

```bash
chmod +x /home/pi/ble-scale-sync/scripts/auto-update.sh
```

### Systemd timer

```ini
# /etc/systemd/system/ble-scale-sync-update.service
[Unit]
Description=Update ble-scale-sync from main and restart service
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=pi
ExecStart=/home/pi/ble-scale-sync/scripts/auto-update.sh
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

Enable the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ble-scale-sync-update.timer
```

This runs every Sunday at 04:30 local time with up to 30 minutes of jitter, which lines up well with the weekly reboot recommended in the Pi setup guide.

::: tip
`git merge --ff-only` fails fast if local commits diverge from upstream. When the update script exits non-zero, the service keeps running the old code and a journal entry lands in `journalctl -u ble-scale-sync-update.service`.
:::

## Pinning a version

If you want predictability over freshness, pin to a specific release tag instead of `latest` and upgrade by hand when a new version is announced.

Docker and Home Assistant Add-on custom registry:

```yaml
image: ghcr.io/kristianp26/ble-scale-sync:v1.10.1
```

Raspberry Pi source deployment:

```bash
cd /home/pi/ble-scale-sync
git fetch --tags
git checkout v1.10.1
```

With a pinned version, skip the auto-update timer entirely and rely on the in-app update check to nudge you when it is time to upgrade.

## Safety checklist before enabling unattended updates

- [ ] `config.yaml` (and `/data` on HA, or your Docker volumes) is backed up off-device.
- [ ] Your scale adapter is already stable on the current version, with no open issue affecting your hardware in the [issue tracker](https://github.com/KristianP26/ble-scale-sync/issues).
- [ ] You scan the [changelog](/changelog) at least occasionally. Minor versions can add config fields; major versions may rename them.
- [ ] Exporter auth tokens (Garmin, Strava) live in a volume that survives container restart.
- [ ] You monitor the service with the heartbeat file at `/tmp/.ble-scale-sync-heartbeat`, an HA notification, or the Ntfy exporter, so a failed update does not go unnoticed for days.

If any of those is missing, keep updates manual until the guardrails are in place.
