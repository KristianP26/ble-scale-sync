---
title: Troubleshooting
description: Common issues, debug tips, and solutions for BLE Scale Sync.
---

# Troubleshooting

## BLE / Scale Issues

### Scale not found

- **Step on the scale** to wake it up — most scales go to sleep after a few seconds of inactivity.
- Verify with `npm run scan` (or the Docker `scan` command) that your scale is visible.
- If using `scale_mac`, double-check the address matches the scan output.
- On Linux, make sure Bluetooth is running: `sudo systemctl status bluetooth`

### Connection fails on Raspberry Pi

The app automatically stops BLE discovery before connecting, which resolves most `le-connection-abort-by-local` errors. If connections still fail:

```bash
sudo systemctl restart bluetooth
```

Then step on the scale and try again.

### Scale was found before but now isn't discovered (Linux)

BlueZ can sometimes stop reporting previously-seen devices. Restart Bluetooth and try again:

```bash
sudo systemctl restart bluetooth
```

### Permission denied (Linux)

Grant BLE capabilities to Node.js:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

You need to re-run this after every Node.js update.

### Windows BLE issues

- The default driver (`@abandonware/noble`) works with the native Windows Bluetooth stack -- no special setup needed.
- If using `NOBLE_DRIVER=stoprocent`, install the WinUSB driver via [Zadig](https://zadig.akeo.ie/).
- Run your terminal as Administrator if you get permission errors.

### Switching the BLE handler

BLE Scale Sync ships with three BLE handlers. If you're having connection issues, try a different one by adding this to your `config.yaml`:

```yaml
ble:
  noble_driver: stoprocent   # or: abandonware
```

| Handler | Platforms | Notes |
|---------|-----------|-------|
| `node-ble` (default on Linux) | Linux only | Uses BlueZ D-Bus. Most reliable on Raspberry Pi. Service UUIDs not available during scan (only after connecting). |
| `@abandonware/noble` (default on Windows) | Linux, Windows | Mature driver. Uses WinRT on Windows. |
| `@stoprocent/noble` (default on macOS) | Linux, macOS, Windows | Newer driver. Exposes service UUIDs during scan. On Windows, requires the [WinUSB driver](https://zadig.akeo.ie/). |

If your scale is not being recognized during scan but you know its MAC address, set `scale_mac` in `config.yaml` -- the adapter will match post-connect using GATT service UUIDs regardless of the handler.

## Exporter Issues

### Garmin upload fails

- Re-run the [setup wizard](/guide/configuration#setup-wizard-recommended) or `npm run setup-garmin` to refresh tokens.
- Check that your Garmin credentials are correct.
- Garmin may block requests from cloud/VPN IPs — try authenticating from a different network, then copy `~/.garmin_tokens/` to your target machine.

### MQTT connection hangs or fails

- Make sure you're using the right protocol: `mqtt://` for plain, `mqtts://` for TLS. Using `mqtt://` on a TLS port (8883) will hang.
- Check your broker URL, username, and password.

## Debug Mode

Set `debug: true` in `config.yaml` or use the environment variable to see detailed BLE logs:

```bash
# Docker
docker run ... -e DEBUG=true ghcr.io/kristianp26/ble-scale-sync:latest

# Linux / macOS
DEBUG=true npm start

# Windows (PowerShell)
$env:DEBUG="true"; npm start
```

This shows BLE discovery details, advertised services, discovered characteristics, and UUID matching.

## Platform Issues

### Install fails on Raspberry Pi Zero W (first gen)

The original Pi Zero W has an ARMv6 CPU, which is **not supported**. The `esbuild` binary (used by the TypeScript runner `tsx`) requires ARMv7 or later and will crash with `SIGILL` (illegal instruction) on ARMv6. This affects both native installs and Docker.

**Solution:** Use a [Raspberry Pi Zero 2W](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/) (~$15, ARMv7/64-bit) or any Pi 3/4/5.

## Docker Issues

### Container can't find BLE adapter

Make sure you're passing all required flags — see [Getting Started](/guide/getting-started#docker) for the full command. The most common mistake is forgetting `--network host` or the D-Bus volume mount.

### Wrong Bluetooth group GID

The `--group-add` value must match your system's Bluetooth group. Find it with:

```bash
getent group bluetooth | cut -d: -f3
```

Common values: `112` (Debian/Ubuntu), `108` (Arch).
