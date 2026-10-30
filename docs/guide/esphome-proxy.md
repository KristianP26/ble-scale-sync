---
title: ESPHome Bluetooth Proxy
description: Read the scale through a stock ESPHome Bluetooth proxy over the Native API, with no custom firmware and no MQTT broker.
---

# ESPHome Bluetooth Proxy

BLE Scale Sync can use an [ESPHome Bluetooth proxy](https://esphome.io/components/bluetooth_proxy.html) as its radio: it connects to the node's Native API on port 6053 and reads broadcast scales from the advertisements and GATT scales through on-demand connections. How this compares with the other transports is under [Choose a transport](/guide/transports#choose-a-transport).

## Requirements

- An ESPHome node with `bluetooth_proxy:` enabled, on ESPHome 2023.5 or newer.
- The node must not be adopted by Home Assistant: a node serves advertisements to one API client at a time. Use a spare ESP32 for BLE Scale Sync, or [Home Assistant Bluetooth](/guide/ha-bluetooth) to share the proxies Home Assistant has.
- A node that runs `bluetooth_proxy:` and little else; keep IR or RF receivers (`remote_receiver:`) on another node.
- TCP port 6053 on the node reachable from BLE Scale Sync.
- The node's API encryption key. ESPHome 2026.1 removed API password authentication; `password` is only for nodes on older firmware.
- BLE Scale Sync in continuous mode, so the Native API connection stays open.

## Configure BLE Scale Sync {#configuring-ble-scale-sync}

```yaml
ble:
  handler: esphome-proxy
  esphome_proxy:
    host: 192.168.1.50 # IP or mDNS name of the ESPHome node
    encryption_key: '${ESPHOME_API_KEY}'
```

| Field | Default | Description |
| --- | --- | --- |
| `host` | (none) | IP address or mDNS name of the node. |
| `port` | `6053` | Native API port. |
| `encryption_key` | (none) | The node's API encryption key. |
| `password` | (none) | Legacy API password for firmware before ESPHome 2026.1; not together with `encryption_key`. |
| `client_info` | `ble-scale-sync` | The client name the node logs. |
| `advertisement_timeout` | `0` (off) | Seconds without any advertisement before a proxy's client is rebuilt, see below. |
| `additional_proxies` | (none) | More nodes, see [Several Proxies](#multiple-esphome-proxies-mesh). |

`encryption_key` is the `api: encryption: key:` value from the node's YAML, 44 characters ending in `=`. If the YAML reads it with `!secret`, copy the value from `secrets.yaml`. `ble-scale-sync setup` (`npm run setup` from a clone) asks for the host, port and key.

```yaml
# ESPHome node YAML
api:
  encryption:
    key: 'YOUR_BASE64_KEY'
```

Restart BLE Scale Sync. The log shows `ESPHome proxy connected at <host>:6053` and `ESPHome ReadingWatcher started, listening for advertisements`.

`advertisement_timeout` rebuilds a proxy's client when it sends no advertisement at all for that many seconds; a working proxy always hears some BLE traffic. Set it to `180` to `600` if your log shows a proxy going silent while the node stays reachable. A rebuild never happens during an open GATT session, and the watchdog stops after three rebuilds that bring no advertisement, which is what happens on a node Home Assistant has adopted.

### Several Proxies {#multiple-esphome-proxies-mesh}

Add more nodes under `additional_proxies`, each with its own `host`, `port` and key. Advertisements from all of them are merged, and a GATT connect goes to the proxy that saw the scale most recently (RSSI breaks ties), with the others as fallbacks.

```yaml
ble:
  handler: esphome-proxy
  esphome_proxy:
    host: proxy1.home
    encryption_key: '${ESPHOME_KEY_1}'
    additional_proxies:
      - host: proxy2.home
        encryption_key: '${ESPHOME_KEY_2}'
```

### Home Assistant Add-on

In the [add-on](/guide/home-assistant-addon#bluetooth-transports), set **Bluetooth transport** to `esphome-proxy` and fill in **ESPHome proxy host** (an IP address is more reliable than a `.local` name), **ESPHome proxy port** and **ESPHome API encryption key**. The legacy password and several proxies need the add-on's custom config mode.

### Docker {#docker-deployment}

The container needs no host network, D-Bus mount or `NET_ADMIN`; `docker-compose.mqtt-proxy.yml` from the repository has no Bluetooth flags, so it works unchanged for this transport.

## How It Works

The node forwards each advertisement it hears to BLE Scale Sync, which matches it against the scale adapters and parses a broadcast reading directly. A GATT scale is connected through the node when it advertises, read, and disconnected; what happens if it is still on after the reading is under [When a session ends](/guide/transports#when-a-session-ends). The ESPHome proxy does not bond, so a scale that needs an encrypted link, such as the Beurer BF720-family scales, can only be read with a local adapter on Linux.

## Troubleshooting

### Connects but Never Sees the Scale ("Only one API subscription is allowed at a time") {#connects-fine-but-never-sees-the-scale-only-one-api-subscription-is-allowed-at-a-time}

The ESPHome device log shows `Only one API subscription is allowed at a time`, and BLE Scale Sync logs `ESPHome proxy connected` but matches no scale. Home Assistant has adopted the node and holds its subscription. Point `esphome_proxy.host` at a node that is not in Home Assistant, or switch to [Home Assistant Bluetooth](/guide/ha-bluetooth).

### Timed Out Connecting to ESPHome Proxy

- Check that the node is reachable: `nc -zv 192.168.1.50 6053`.
- Check that `encryption_key` matches the node's `api: encryption: key:` exactly.
- On ESPHome 2026.1 or newer, `password` does not work: set an encryption key on the node and use `encryption_key`.

### A GATT Scale Connects but Sends No Reading {#gatt-scale-not-read-over-the-proxy}

- An ESP32 has a limited number of GATT connection slots (`bluetooth_proxy` / `esp32_ble_tracker` in its YAML). When every proxy is full, the read is retried on the next advertisement; free a slot or add a proxy under `additional_proxies`.
- The connect goes to the proxy that last saw the scale. If none is close enough, move a proxy nearer.
- With `runtime.debug: true` the log shows an `ESPHome CCCD write ...` line for each characteristic it subscribes to. `ESPHome GATT error: handle 0x.. status=5` (or `15`) right after it means the scale demands an encrypted link, which this transport cannot provide.

### The Scale Is Not Seen, or Only on the Second Weigh-In {#scale-is-only-read-on-the-second-weigh-in}

Step on the scale while `ble-scale-sync scan` runs, so it advertises, and move the proxy closer if it is still not listed. A broadcast scale such as the Mi Scale 2 sends its final frame for a moment only, and the default ESPHome scan listens for 30 ms of every 320 ms. Raise the duty cycle in the node's YAML, flash it and restart BLE Scale Sync:

```yaml
esp32_ble_tracker:
  scan_parameters:
    interval: 320ms
    window: 300ms
    active: true
```
