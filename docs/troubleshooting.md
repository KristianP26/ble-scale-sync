---
title: Troubleshooting
description: Common issues, debug tips, and solutions for BLE Scale Sync.
head:
  - - meta
    - name: keywords
      content: bluetooth scale not found, ble troubleshooting linux, bluez docker, raspberry pi bluetooth issues, scale not connecting, dbus bluetooth error, noble ble error
---

# Troubleshooting

For general questions that are not about a specific error (supported scales, Garmin 2FA, privacy, multi-user, deployment choices), start with the [FAQ](/faq).

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

### BLE discovery stops working after hours (BlueZ stuck state)

**Symptoms** (visible with `DEBUG=true`):

- Repeated `startDiscovery failed: Discovery already in progress` and `D-Bus StopDiscovery failed: No discovery started`
- Or `Discovery started` logs succeed, but the scale is never found even after stepping on it
- Common on Raspberry Pi 3 / 4 / Zero 2W with the on-board Broadcom adapter under continuous-mode load

**Cause.** A [known BlueZ bug](https://github.com/bluez/bluez/issues/807) (also tracked at [bluez/bluer#47](https://github.com/bluez/bluer/issues/47)): after repeated GATT connect/disconnect cycles, BlueZ's `Discovering` property desyncs from the HCI controller. The daemon reports active discovery, but the controller is no longer running LE scan.

::: warning Hardware/firmware limitation, not just software
On Pi 3/4 Broadcom on-board chips, this is a kernel/firmware-level issue that even much larger projects have given up on fixing in software — see [home-assistant/operating-system#4022](https://github.com/home-assistant/operating-system/issues/4022) and [home-assistant/core#142656](https://github.com/home-assistant/core/issues/142656), both closed as **Not Planned** with HA recommending a Bluetooth proxy as the workaround. The recovery tiers below clear the wedge on most setups but not all of them.
:::

**Recommended long-term fix: Bluetooth proxy.** The most reliable way to run BLE Scale Sync on a Pi long-term is to bypass the on-board Bluetooth entirely — run an external [ESP32 BLE proxy](/guide/esp32-proxy) (≈€8 board, communicates over MQTT) or reuse an existing [ESPHome BT proxy](/guide/esphome-proxy). Both eliminate the host BlueZ stack from the BLE path completely.

**Automatic in-process recovery.** The app already:

- Resets its D-Bus client after every GATT operation in continuous mode
- Runs a preemptive `btmgmt power off/on` cycle after every GATT operation to clear zombie controller state before it accumulates
- Escalates through 6 recovery tiers when `StartDiscovery` fails (D-Bus `StopDiscovery`, adapter power-cycle, btmgmt reset, rfkill block/unblock, `systemctl restart bluetooth`)

**Auto-restart watchdog (continuous mode).** When in-process recovery is not enough — typically Pi 3/4 Broadcom firmware lock-up — a watchdog exits the process after `runtime.watchdog_max_consecutive_failures` consecutive scan failures (default `10`, ≈30 min). With Docker `restart: unless-stopped` the container restarts cleanly, the entrypoint resets the BT adapter, and the controller is typically unwedged. The watchdog only arms after the first successful weigh-in in the process lifetime, so it does not restart-loop the container if the scale is offline (vacation) or `scale_mac` is misconfigured.

```yaml
runtime:
  watchdog_max_consecutive_failures: 10  # default; 0 = disabled
```

```bash
# Or env override
docker run ... -e BLE_WATCHDOG_MAX_FAILURES=10 ghcr.io/kristianp26/ble-scale-sync:latest
```

**Docker compose tip.** Make sure `/dev/rfkill` is mapped so Tier 5 recovery is available:

```yaml
devices:
  - /dev/rfkill:/dev/rfkill
```

**Last-resort escape hatch: switch away from BlueZ.** If BlueZ keeps getting stuck despite the above, bypass it entirely by using the `@stoprocent/noble` driver (HCI socket directly, no D-Bus):

```yaml
ble:
  noble_driver: stoprocent
```

Or set `NOBLE_DRIVER=stoprocent` as an environment variable. Trade-off: the app takes exclusive HCI access, so you cannot run `bluetoothctl`, Home Assistant's Bluetooth integration, or any other BLE consumer on the same adapter at the same time.

On the host you can also verify BlueZ state manually:

```bash
bluetoothctl show | grep Discovering
sudo systemctl restart bluetooth   # manual recovery
```
