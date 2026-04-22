---
title: ESPHome Bluetooth Proxy
description: Reuse an existing ESPHome BT proxy instead of deploying a dedicated ESP32 with custom firmware.
head:
  - - meta
    - name: keywords
      content: esphome bluetooth proxy, home assistant ble proxy, esphome ble mesh, reuse esphome, ble-scale-sync esphome, scale via esphome proxy, native api bluetooth
---

# ESPHome Bluetooth Proxy

If you already run an [ESPHome Bluetooth proxy](https://esphome.io/components/bluetooth_proxy.html) mesh for Home Assistant, BLE Scale Sync can reuse it as its BLE radio. No dedicated ESP32 with custom firmware, no MQTT broker plumbing: the server connects to the ESPHome Native API on port 6053 and subscribes to BLE advertisements directly.

::: warning Experimental, Phase 1 (broadcast-only)
The ESPHome proxy transport currently supports **broadcast scales only**. GATT support (connect, subscribe, write) is tracked as phase 2 of [issue #116](https://github.com/KristianP26/ble-scale-sync/issues/116). Until then, scales that require a GATT connection (most Xiaomi Mi Body Composition, Eufy P2/P2 Pro, older Renpho, etc.) are skipped with a warning when they match. See the [supported scales](/guide/supported-scales) page for each scale's broadcast/GATT behavior.
:::

## How it works

```
┌───────┐  BLE   ┌─────────────┐  Native API  ┌────────────────┐
│ Scale │ ─────► │ ESPHome BT  │ ──(6053)──► │ BLE Scale Sync │
└───────┘ advert │   proxy     │              │  Docker/Node   │
                 └─────────────┘              └────────────────┘
```

The ESPHome proxy sees the scale's BLE advertisement, wraps it in a Native API `BluetoothLEAdvertisementResponse`, and forwards it to BLE Scale Sync. The server matches scale adapters against the advertisement (manufacturer data, service UUIDs, local name), parses the broadcast frame, and dispatches the reading to exporters. No local Bluetooth adapter is required on the machine running BLE Scale Sync.

## Requirements

- A running ESPHome device with `bluetooth_proxy:` enabled, on ESPHome **2023.5 or newer** (older firmware used a different BLE event layout that is not handled by this transport)
- Network reachability between BLE Scale Sync and the ESPHome device on TCP port 6053
- Either the ESPHome API encryption key (recommended) or the legacy API password, matching the device's `api:` config

::: tip When to pick this vs the ESP32 MQTT proxy
If you already have ESPHome proxies in your home, start here: zero new hardware. If you don't, the [ESP32 MQTT proxy](/guide/esp32-proxy) supports both broadcast and GATT scales today and has full display/beep feedback UI.
:::

## Configuring BLE Scale Sync

Add the `ble` section to your `config.yaml`:

```yaml
ble:
  handler: esphome-proxy
  esphome_proxy:
    host: ble-proxy.local # IP or mDNS name of the ESPHome device
    port: 6053 # default, matches ESPHome `api.port`
    encryption_key: '${ESPHOME_API_KEY}' # 32-byte base64 PSK from your api: config
    # password: '${ESPHOME_API_PASSWORD}' # legacy plaintext auth, use encryption_key instead
    client_info: ble-scale-sync # visible in ESPHome logs / Home Assistant
```

Restart BLE Scale Sync. In continuous mode the server keeps the Native API connection open, subscribes once, and processes advertisements as they arrive.

### Getting the encryption key

In your ESPHome device YAML:

```yaml
api:
  encryption:
    key: 'Lw1vKZ...YOUR_BASE64_KEY...cG=='
```

Use the exact same key in `esphome_proxy.encryption_key`. If you use `secrets.yaml`, read the key from the rendered device config in Home Assistant or ESPHome Dashboard.

::: tip Wizard
`npm run setup` includes an interactive ESPHome proxy step that prompts for the host, port and authentication choice.
:::

::: warning Security
The Native API without encryption (plaintext password) transmits scale weight and body composition data in the clear. Always prefer `encryption_key` unless you're isolated on a trusted LAN.
:::

## Docker deployment

The ESPHome proxy transport, like the ESP32 MQTT proxy, removes the need for local Bluetooth on the host. The container can run without BlueZ, D-Bus mounts, or `NET_ADMIN`:

```yaml
# docker-compose.esphome-proxy.yml
services:
  ble-scale-sync:
    image: ghcr.io/kristianp26/ble-scale-sync:latest
    container_name: ble-scale-sync
    volumes:
      - ./config.yaml:/app/config.yaml
      - garmin-tokens:/app/garmin-tokens
    environment:
      - CONTINUOUS_MODE=true
    restart: unless-stopped

volumes:
  garmin-tokens:
```

## Troubleshooting

### Timed out connecting to ESPHome proxy

- Check the host and port are reachable: `nc -zv <host> 6053`
- If you use `encryption_key`, make sure it matches the device's `api.encryption.key` exactly (base64, 44 characters ending in `=`)
- If you use `password`, note that newer ESPHome builds remove plaintext auth, switch to `encryption_key`

### "Scale ... requires a GATT connection" / skipped measurements

Phase 1 only handles broadcast scales. Behavior depends on the mode:

- **Single-shot (`npm start`)** fails fast with a descriptive error when a GATT-only scale is matched, so misconfigured setups surface immediately.
- **Continuous (`CONTINUOUS_MODE=true`)** logs a one-time warning per device and keeps running, so a GATT scale passing through range does not crash a multi-scale deployment.

Until phase 2 adds GATT support over Native API, you have three options:

1. Use a [dedicated ESP32 MQTT proxy](/guide/esp32-proxy), it supports GATT today
2. Run BLE Scale Sync on a machine with a local Bluetooth adapter
3. Subscribe to [issue #116](https://github.com/KristianP26/ble-scale-sync/issues/116) for phase 2 progress

### ESPHome logs show "clientInfo: ble-scale-sync"

That's expected. The `client_info` field is how ESPHome identifies who's connected. Change it per-instance in `esphome_proxy.client_info` if you run multiple BLE Scale Sync copies.

### "No recognized scales found" in `npm run scan` over ESPHome

- Step on the scale (or press its button) while the scan runs so it begins advertising
- Move closer to the ESPHome proxy. Scale advertisements are low-power and ESPHome proxies have their own range limits
- Confirm Home Assistant sees the scale's advertisements via the same proxy; if HA also misses them, the proxy itself is out of range
