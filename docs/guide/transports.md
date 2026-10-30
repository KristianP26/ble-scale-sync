---
title: Bluetooth Transports
description: Which Bluetooth transport and noble driver to use, the ble.handler values, and how a proxy session ends after a reading.
---

# Bluetooth Transports

A transport is the Bluetooth radio BLE Scale Sync reads the scale through: the host's own adapter, or a proxy near the scale that relays it over the network. You select it with `ble.handler` in `config.yaml`, or with **Bluetooth transport** (`ble_transport`) in the [Home Assistant add-on](/guide/home-assistant-addon).

## Choose a Transport

| Your setup | `ble.handler` | Add-on `ble_transport` | Scales |
| --- | --- | --- | --- |
| The host's Bluetooth adapter is in range of the scale | `auto` (default) | `local` (default) | All |
| Home Assistant already hears the scale through any adapter or proxy it uses | `ha-bluetooth` | `ha-bluetooth` | Broadcast only |
| An ESPHome Bluetooth proxy that Home Assistant has not adopted is near the scale | `esphome-proxy` | `esphome-proxy` | Broadcast and GATT, no bonded links |
| An ESP32 with the BLE Scale Sync proxy firmware is near the scale | `mqtt-proxy` | `mqtt-proxy` | Broadcast, and GATT on a PSRAM board |

A broadcast scale sends its weight in its advertisement; the list is under [which scales work](/guide/ha-bluetooth#which-scales-work). Every other scale needs a GATT connection.

Setup for each proxy: [ESP32 BLE Proxy](/guide/esp32-proxy), [ESPHome Bluetooth Proxy](/guide/esphome-proxy), [Home Assistant Bluetooth](/guide/ha-bluetooth).

```yaml
ble:
  handler: esphome-proxy # auto, mqtt-proxy, esphome-proxy or ha-bluetooth
  esphome_proxy:
    host: 192.168.1.50
```

The `BLE_HANDLER` environment variable overrides `ble.handler` ([runtime overrides](/guide/configuration#runtime-overrides)). A proxy handler also needs its config block (`mqtt_proxy`, `esphome_proxy` or `ha_bluetooth`); without it the override is ignored with a warning.

With any proxy handler:

- The host needs no Bluetooth adapter, and the Docker container needs no `--network host`, D-Bus mount or `NET_ADMIN`.
- Run in continuous mode (`runtime.continuous_mode: true` or `CONTINUOUS_MODE=true`). The app keeps the proxy link open and listens all the time, so `runtime.scan_cooldown` and `runtime.idle_rescan_delay` are not used.
- `ble.proxy_liveness_timeout_min` (default 30) applies: if no advertisement arrives for that long, the process exits so its supervisor restarts it.
- Set `ble.scale_mac`, so the proxy reads only your scale.

## Noble Drivers

With `handler: auto` the app picks a Bluetooth stack per operating system. `ble.noble_driver` (or the `NOBLE_DRIVER` environment variable) selects a noble driver instead.

| Stack | Default on | Notes |
| --- | --- | --- |
| `node-ble` | Linux | BlueZ over D-Bus, no native build. Advertised service UUIDs are not visible before a connection |
| `@abandonware/noble` (`noble_driver: abandonware`) | Windows | Builds from source and needs a C++ toolchain |
| `@stoprocent/noble` (`noble_driver: stoprocent`) | macOS | Ships prebuilt binaries for Linux, macOS and Windows |

```yaml
ble:
  noble_driver: stoprocent # or abandonware; leave unset for the OS default
```

- On Linux, install BlueZ (`sudo apt-get install bluetooth bluez`). `node-ble` is used unless `noble_driver` is set.
- On Linux with `node-ble`, set `ble.scale_mac` if your scale is not recognized during a scan: some adapters match only on service UUIDs, which `node-ble` sees after connecting.
- On Linux with a noble driver, Node.js talks to the adapter over a raw HCI socket and needs the capability: `sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))`.
- On macOS there is nothing to install.
- On Windows, the default `@abandonware/noble` needs [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the C++ workload. Without them `npm install` still completes; set `ble.noble_driver: stoprocent` to use the prebuilt driver, which runs on the Windows Bluetooth stack with no extra driver.

The three stacks are optional npm dependencies, so an install completes even where one of them cannot be built, most often `@abandonware/noble` on a host without a C++ toolchain. If the selected stack is missing, the app stops with `BLE transport ... needs the npm package ...`, the install command and the transports that still work on the host. Install the package where the app is installed, as in [Install a Bluetooth stack later](/guide/getting-started#adding-a-ble-stack); under `npx`, install the app and the stack together with `npm install -g`.

## When a Session Ends

On `mqtt-proxy` and `esphome-proxy`, a scale that needs a connection is connected when it advertises, read, and disconnected. If it is still on after the reading, it is connected again on its next advertisement, so a second person who steps on before it switches off is read too.

When nobody steps on, the session ends at the first of these:

- the scale switches off,
- 60 s pass in which the scale sends nothing (status replies, such as a Yunmai's answers to the unlock command, do not count),
- 90 s pass since the session opened.

The log notes this at info level, and it is not an error:

```text
... session opened 0.7 s after the last reading, while the scale was still on, ended without a new weigh-in (...).
```

A scale that stays connectable after its display goes dark, such as the Yunmai Mini 2, is connected again on each advertisement. Each such session that opens within 60 s of the previous one is logged the same way (at debug level after the first). A session that opens later and ends without a reading is reported as a failure. No proxy connection slot is held once the scale is off.

On the host adapter (`auto`), a session that receives nothing for `ble.session_timeout_sec` (default 120 s) ends with `Timed out waiting for a complete scale reading`. See [BLE options](/guide/configuration#ble).
