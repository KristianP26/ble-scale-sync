---
title: Troubleshooting
description: Fixes for BLE Scale Sync problems grouped by symptom, from a scale that is never found to a BlueZ adapter that stops scanning, plus what to attach to an issue.
---

# Troubleshooting

Find the symptom or the exact log line, then work through the fixes in order. Most log lines quoted here appear only in [debug mode](#debug-mode). For general questions, see the [FAQ](/faq).

## Debug Mode

Set `runtime.debug: true` in `config.yaml` (in the Home Assistant add-on, turn on the `debug` option), or set the `DEBUG` environment variable:

```bash
# Docker
docker run ... -e DEBUG=true ghcr.io/kristianp26/ble-scale-sync:latest

# Linux / macOS
DEBUG=true ble-scale-sync

# Windows (PowerShell)
$env:DEBUG="true"; ble-scale-sync
```

The log then shows discovery, advertised services, discovered characteristics and how the scale was matched to an adapter. For one device in detail, run `ble-scale-sync diagnose <MAC>` (`npm run diagnose` from a clone): it prints the scale's services, characteristics and their flags.

### Capture Raw Frames {#capturing-every-frame-for-a-scale-that-is-not-decoded-correctly}

Debug mode logs what the app decided. For a misread scale, or a scale that needs a new protocol, the maintainer needs what the scale actually sent, including frames the adapter rejected:

```bash
BLE_RAW_CAPTURE=true DEBUG=true ble-scale-sync

# Docker
docker run ... -e BLE_RAW_CAPTURE=true -e DEBUG=true ghcr.io/kristianp26/ble-scale-sync:latest
```

Every notification is then logged as hex with the characteristic it arrived on:

```text
[BLE] [RAW] 0000fff100001000800000805f9b34fb (13B): 1f 05 00 02 e6 12 ...
```

The connection stays open 20 seconds past the settled weight, because several scales send body composition after the number stops moving. `BLE_RAW_CAPTURE_HOLD_SEC=40` makes the window longer. Neither variable changes what is exported.

Step on the scale once, wait until it disconnects on its own, and attach the whole log to the issue together with what the scale displayed and what the vendor app recorded for the same weigh-in. Without the known values, a field usually cannot be decoded.

## Scale Not Found

### The scan does not list the scale

1. Step on the scale to wake it up. Most scales advertise only for a few seconds after they light up.
2. Run `ble-scale-sync scan` (`npm run scan` from a clone, or the Docker `scan` command from [Getting Started](/guide/getting-started#docker)) while the scale is on.
3. If you set `ble.scale_mac`, compare it with the address in the scan output.
4. On Linux, check that Bluetooth runs: `sudo systemctl status bluetooth`.
5. <span id="scale-was-found-before-but-now-isn-t-discovered-linux"></span>If the scale was found before and is not any more, restart Bluetooth: `sudo systemctl restart bluetooth`.
6. If you use a noble driver, try the other one. See [noble drivers](/guide/transports#noble-drivers).

If the scale shows up in the scan but is never read, see [Connects but No Reading](#connects-but-no-reading).

### `Permission denied` on Linux {#permission-denied-linux}

The noble drivers open the Bluetooth adapter directly and need the `cap_net_raw` capability. Grant it to Node.js, and run the command again after every Node.js update:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

The default Linux transport, `node-ble`, goes through BlueZ and does not need it.

### The next scan starts a minute later {#why-the-next-scan-is-not-immediate}

In continuous mode the wait before the next scan depends on how the last cycle ended. Failed cycles back off from 5 s up to 60 s, so a long gap means failures, not an ignored setting. The log line before the wait names the cause. The waits and their options are in [the runtime reference](/guide/configuration#runtime).

## Connection Fails or Ends

### `le-connection-abort-by-local` on a Raspberry Pi {#connection-fails-on-raspberry-pi}

BlueZ aborted the connect, most often because the radio link is weak or the scale dropped the stored pairing.

1. Restart Bluetooth with `sudo systemctl restart bluetooth`, then step on the scale again.
2. Move the host or a USB Bluetooth adapter closer to the scale.
3. On a Beurer or Sanitas scale that fails on every connect after the first session, clear the pairing as described in [Every connect fails after the first session](/guide/scales/beurer#every-connect-fails-after-the-first-session).

### `Scale disconnected before reading completed` {#connection-ended}

The connection ended before the reading was complete. With the built-in Linux transport (`ble.handler: auto` without `noble_driver`, or `ble_transport: local` in the add-on) and [debug mode](#debug-mode) on, the log says why BlueZ ended it:

```text
BlueZ: AA:BB:CC:DD:EE:FF disconnected 5.40 s after connect: org.bluez.Reason.Remote (Connection terminated by remote user) - the scale ended it
```

What to do for each reason:

- `org.bluez.Reason.Remote`: the scale ended it. Many scales do that after every weigh-in, so it matters only when it comes before the reading. Stay on the scale until it shows the final result.
- `org.bluez.Reason.Timeout`: the radio link was lost. Shorten the distance, and keep USB 3 devices and ports away from a USB Bluetooth adapter, they interfere at 2.4 GHz.
- `org.bluez.Reason.Local`: this host ended it (this app, BlueZ, the kernel or another Bluetooth program).
- `org.bluez.Reason.Authentication`: the scale refused the stored pairing key. Clear the pairing as described in [Every connect fails after the first session](/guide/scales/beurer#every-connect-fails-after-the-first-session).
- Any other reason: BlueZ does not say which; `btmon` shows the code.

Only BlueZ 5.83 and later (Home Assistant OS 16.2 and later) report the reason. With older BlueZ no such line appears. Debug mode is read when the app opens its D-Bus connection, so after you switch it on in a running app the lines can start one weigh-in later; a restart starts them at once.

The proxy transports end a session on their own after a reading; see [when a session ends](/guide/transports#when-a-session-ends).

## Connects but No Reading

### `Scale connected but sent no reading`

The scale accepted the connection, but no complete reading arrived before the session timed out.

1. Step on the scale barefoot and stay on until the display shows the final result, body composition included.
2. For QN-family scales (Renpho, Arboleaf, FITINDEX and others on the QN protocol), work through [QN scales](/guide/scales/qn).
3. For a Renpho R-MSC04 or an ES-CS20M on service 0x1A10, see [Renpho scales](/guide/scales/renpho).
4. If the reading is wrong rather than missing, make a [raw capture](#capturing-every-frame-for-a-scale-that-is-not-decoded-correctly).

## Pairing

### Beurer or Sanitas Pairing Problems

<span id="beurer-consent-code-rejected-after-a-battery-change"></span><span id="beurer-the-six-digit-passkey-and-the-four-digit-consent-code-are-different-numbers"></span><span id="beurer-bf-405-bf-915-factory-reset-and-deleting-one-user"></span><span id="beurer-every-connect-fails-after-the-first-session"></span><span id="beurer-the-scale-shows-a-pairing-code-again-and-again"></span><span id="beurer-bf915-pair-on-the-display-all-day"></span>These scales need a BLE pairing and a four-digit consent code per user slot. A wrong or lost consent code, a pairing the scale dropped, a passkey to type, or a pairing code that appears again and again each have their own fix in [Beurer and Sanitas pairing](/guide/scales/beurer#pairing).

## Install Issues (npm / npx) {#install-issues}

### `ble-scale-sync: command not found`

The package was installed into a project instead of globally, or the npm global bin directory is not on your `PATH`. Run it through npx, which needs no `PATH` entry:

```bash
npx ble-scale-sync --version
```

Or install it globally and add npm's bin directory to your `PATH`:

```bash
npm install -g ble-scale-sync
npm prefix -g       # Windows: the commands are here; Linux/macOS: in its bin/ subdirectory
```

### `No configuration found` even though config.yaml exists

`config.yaml` and `.env` are read from the directory you run the command in, not from the package. Run the command from the directory that holds them, or pass the path:

```bash
ble-scale-sync --config /path/to/config.yaml
ble-scale-sync validate --config /path/to/config.yaml
```

See [where config.yaml and .env are read from](/guide/configuration#config-location).

### `BLE transport ... needs the npm package ...`

The install completed without the Bluetooth stack you selected, most often `@abandonware/noble`, which compiles from source and needs a C++ toolchain. The message names the package, the install command and the transports that work on your host. Install the package next to the app as in [Adding a BLE stack later](/guide/getting-started#adding-a-ble-stack). On Windows, `ble.noble_driver: stoprocent` uses a prebuilt driver that needs no toolchain, see [noble drivers](/guide/transports#noble-drivers).

### `Node.js ... is older than this release expects` or `... is not supported by this release` {#node-version-warning}

The running Node.js is not one of the versions this release supports (listed in [the standalone prerequisites](/guide/getting-started#standalone)). The app keeps running. Update Node.js the way you installed it (the NodeSource apt repository, nvm or the installer from nodejs.org) and restart the app or its service. `... is not supported by this release` means your Node.js release line is not supported at all, for example an odd-numbered one: install one of the listed versions. The Docker image and the Home Assistant add-on bring their own Node.js; if either shows this line, open an issue.

### Install fails on Raspberry Pi Zero W (first gen)

The first Pi Zero W has an ARMv6 CPU, which is not supported. The Docker image is built for amd64, arm64 and arm/v7 only, and `esbuild`, which the TypeScript runner uses, crashes with `SIGILL` (illegal instruction) on ARMv6. Use a Raspberry Pi Zero 2 W or a Pi 3, 4 or 5 instead, see [recommended hardware](/guide/getting-started#recommended-hardware).

## Docker Issues

### Container exits at startup with `DBusError` and `AccessDenied`

The log names `An AppArmor policy prevents this sender from sending this message` and `member="Hello"`, and the container exits before it scans. Docker's default AppArmor profile has no D-Bus rules, so the host's D-Bus daemon refuses the container. Mounting the D-Bus socket is not enough on those hosts. Run the container unconfined:

```bash
docker run --security-opt apparmor=unconfined ...
```

```yaml
# docker-compose.yml
services:
  ble-scale-sync:
    security_opt:
      - apparmor=unconfined
```

The Home Assistant add-on already runs without an AppArmor profile.

### Container can't find the Bluetooth adapter {#container-can-t-find-ble-adapter}

Compare your command with the one in [Getting Started](/guide/getting-started#docker). The flags most often missing are `--network host` and the D-Bus mount `-v /var/run/dbus:/var/run/dbus:ro`. <span id="wrong-bluetooth-group-gid"></span>The `--group-add` value must be the host's `bluetooth` group ID:

```bash
getent group bluetooth | cut -d: -f3
```

If that prints nothing, the host has no `bluetooth` group; install BlueZ on the host first.

### Container shows `unhealthy` but never restarts

The app writes `/tmp/.ble-scale-sync-heartbeat` every 30 seconds while its event loop runs, whether or not anyone weighs in. The image reports `unhealthy` when that file is older than 5 minutes, so the process froze.

A Docker `restart:` policy acts only when the process exits, not on health status. Swarm, Kubernetes or a sidecar such as [autoheal](https://github.com/willfarrell/docker-autoheal) restart on health. The Home Assistant add-on restarts the app when it exits, see [Persistence](/guide/home-assistant-addon#persistence).

A frozen event loop also stops the [watchdog](#the-app-exits-after-repeated-scan-failures). Restart the container by hand and attach the log from before the freeze to an issue.

## Exporter Issues

### Garmin upload fails

- `Garmin rejected the saved login token (HTTP 401)`: Garmin refused the stored token, and the upload is not retried. Run `ble-scale-sync setup-garmin` (`npm run setup-garmin` from a clone) to log in again.
- `Garmin upload needs Python 3.12 or newer`: install Python 3.12 or newer on the host.
- Login fails from a server: Garmin can block cloud and VPN addresses. Log in from another network and copy the token directory, see [Garmin Connect](/exporters#garmin). In the Home Assistant add-on, see [the MFA workaround](/guide/home-assistant-addon#mfa-workaround).

### MQTT connection hangs or fails

Use `mqtt://` for a plain connection and `mqtts://` for TLS: `mqtt://` on the TLS port 8883 hangs. Then check the broker URL, username and password. See [MQTT](/exporters#mqtt).

## Discovery Stops Working After Hours {#ble-discovery-stops-working-after-hours-bluez-stuck-state}

This applies to the built-in Linux transport (`node-ble` over BlueZ). Symptoms, visible with `DEBUG=true`:

- `startDiscovery failed: Discovery already in progress` and `D-Bus StopDiscovery failed: No discovery started` repeat.
- `Discovery started` succeeds, but the scale is never found, even when you stand on it.
- `Discovery state at start: Discovering=true, our filtered session=no` on every cycle, with no scale found.

It is most common on a Raspberry Pi 3, 4 or Zero 2 W with the on-board Broadcom adapter in continuous mode. The cause is a [BlueZ bug](https://github.com/bluez/bluez/issues/807): after many connect and disconnect cycles, BlueZ reports discovery as running while the controller has stopped scanning.

Fix it in this order:

1. Run `sudo systemctl restart bluetooth` on the host, and restart the container if the app runs in Docker. On Home Assistant OS, reboot the host: **Settings** > **System**, the three-dots menu, **Restart Home Assistant** > **Reboot system**, or run `ha host reboot`. Restarting only Home Assistant does not restart Bluetooth.
2. If it comes back, check that the app can [reset the adapter](#btmgmt-could-not-power-cycle-hci0) and that a restart policy is set for the [watchdog](#the-app-exits-after-repeated-scan-failures).
3. If it keeps coming back, move the Bluetooth work off the Pi with an [ESP32 proxy](/guide/esp32-proxy) or an [ESPHome proxy](/guide/esphome-proxy). Home Assistant recommends the same for this chip ([home-assistant/operating-system#4022](https://github.com/home-assistant/operating-system/issues/4022)).

When discovery does not start, the app restarts it, resets the adapter and finally restarts `bluetoothd` on its own. In Docker one of those steps needs `/dev/rfkill` mapped into the container, as in `docker-compose.example.yml`. `Scan stalled (...)` and `Discovery was already running under a session that is not ours; restarted it under our own session.` in the log are part of that recovery and need no action.

After every connection in continuous mode, the app also resets its D-Bus client and power-cycles the adapter with `btmgmt`, which clears the state before it builds up. `ble.preemptive_adapter_reset: false` turns off only the power-cycle, see [the BLE options](/guide/configuration#ble).

### `btmgmt could not power-cycle hci0`

The `btmgmt` resets need the `CAP_NET_ADMIN` capability. The Docker image gives it to `btmgmt` and the add-on runs as root, so this line comes from a native install running as a normal user. The app carries on without those steps. To enable them, give the capability to `btmgmt` only, not to Node.js:

```bash
sudo setcap cap_net_admin+ep $(which btmgmt)
```

Every local user who can run `btmgmt` can then power the adapter off and change its settings. A `bluez` package upgrade removes the capability; `getcap $(which btmgmt)` shows whether it is still set.

### `BlueZ discovery looks stuck`

`bluetoothd` refuses to stop discovery or does not answer a discovery request at all. Nothing sent over D-Bus clears that, an adapter power-cycle included. The app drops its D-Bus connection and tries the remaining steps, but only a restart of `bluetoothd` fixes it: run `sudo systemctl restart bluetooth`, or reboot the host on Home Assistant OS as in step 1 above.

### `did not complete a Disconnect within 10s`

After a connect that timed out, BlueZ can keep the scale listed as connected (`bluetoothctl info <MAC>` shows `Connected: yes`) although the link is gone. Every later connect then succeeds from BlueZ's own state and never reaches the scale. The cycle ends with `Scale found but not connected`, and the app power-cycles the adapter and checks the link again:

- `Cleared a stale BlueZ connection to <MAC>`: fixed, nothing to do.
- `BlueZ still reports <MAC> as connected after the adapter power-cycle`: only a restart of `bluetoothd` clears it, as in step 1 above. Until then the app repeats the power-cycle for that scale after 10, 20 and 40 minutes and then hourly.

### The app exits after repeated scan failures

That is the watchdog. In continuous mode on the host's own Bluetooth adapter (not a proxy or Home Assistant Bluetooth), after `runtime.watchdog_max_consecutive_failures` failed cycles in a row (default `10`), the app logs `Watchdog triggered: ...` and exits, so Docker or systemd starts it again with a fresh Bluetooth stack. The Docker entrypoint power-cycles the adapter on start. The watchdog arms only after the first successful weigh-in of the process.

Which cycles count depends on the handler:

- Linux built-in Bluetooth (`node-ble`): only cycles with an unhealthy radio (a connect or read failure, or a scan that heard no advertisements at all). A scan that hears other devices but not your scale does not count, and neither does a session in which the scale sent data but no complete reading.
- noble driver (macOS, Windows, or `ble.noble_driver` on Linux): every failed cycle, a scan that did not find the scale included. After one weigh-in, with the default value, ten cycles in a row without the scale exit the app.

The restart needs a supervisor: `restart: unless-stopped` in Compose, `--restart unless-stopped` with `docker run`, or `Restart=always` in a systemd unit. Without one the app stays down; with a noble driver and no supervisor, set the value to `0`.

```yaml
runtime:
  watchdog_max_consecutive_failures: 10 # 0 turns the watchdog off
```

`BLE_WATCHDOG_MAX_FAILURES` overrides the value from the environment. If a wedged D-Bus handle keeps the process from exiting after `Stopped.`, the app force-exits after 5 seconds; `BLE_HARD_EXIT_GRACE_MS` (1000 to 60000) changes that.

### The service hangs and systemd does not restart it

A blocking D-Bus call can freeze the whole event loop, and then the watchdog above cannot run either. Let systemd check the process from outside. In the `[Service]` section of the unit from [Run as a Service](/guide/getting-started#run-as-a-service-linux), replace `Type=simple` with these lines and keep `Restart=always`:

```ini
Type=notify
WatchdogSec=60
NotifyAccess=all
```

The app sends `READY=1` at start and `WATCHDOG=1` every `WatchdogSec / 2` through `systemd-notify`, a child process, which is why `NotifyAccess=all` is needed. If the heartbeat stops for `WatchdogSec`, systemd restarts the unit. Without systemd, `$NOTIFY_SOCKET` is unset and the integration does nothing. It catches a call that freezes the event loop, not a Bluetooth request that never gets an answer.

### Discovery still gets stuck after all of this

Switch away from BlueZ with the `@stoprocent/noble` driver, which talks to the adapter over an HCI socket instead of D-Bus:

```yaml
ble:
  noble_driver: stoprocent
```

It needs the capability from [`Permission denied` on Linux](#permission-denied-linux). The app then has the adapter to itself: `bluetoothctl`, Home Assistant's Bluetooth integration and other Bluetooth programs cannot use it at the same time. The other option is a proxy, see [choose a transport](/guide/transports#choose-a-transport).

## Report an Issue

If none of this helps, [open an issue](https://github.com/KristianP26/ble-scale-sync/issues/new/choose) and attach:

- the log of one failed weigh-in with [debug mode](#debug-mode) on, from the `Version` line at the top to the end of the cycle (mask the MAC address if you like),
- the scale's brand and exact model, and what its display showed,
- the transport (`ble.handler` or the add-on's `ble_transport`), the noble driver if set, and the host (Raspberry Pi model, OS, Docker or add-on),
- for a scale that is misread or not supported, a [raw capture](#capturing-every-frame-for-a-scale-that-is-not-decoded-correctly) and the values the vendor app recorded.
