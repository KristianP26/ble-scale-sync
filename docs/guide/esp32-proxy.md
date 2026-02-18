---
title: ESP32 BLE Proxy
description: Use an ESP32 as a remote BLE-to-MQTT bridge for headless or Docker deployments.
---

# ESP32 BLE Proxy

Use a cheap ESP32 board as a remote Bluetooth radio, communicating over MQTT. This lets you run BLE Scale Sync on machines without local Bluetooth — headless servers, Docker containers, or devices where the built-in radio has poor range.

The ESP32 is a **transparent BLE-to-MQTT bridge** with zero scale-specific logic. All scale protocol handling, user matching, and body composition calculation stays in BLE Scale Sync.

## How It Works

```
┌─────────┐   BLE    ┌──────────┐   MQTT   ┌────────────────┐
│  Scale   │ ──────── │  ESP32   │ ──────── │ BLE Scale Sync │
└─────────┘          └──────────┘          └────────────────┘
                    MicroPython              Docker / Node.js
```

1. BLE Scale Sync sends a **scan** command to the ESP32 via MQTT
2. The ESP32 performs a BLE scan and publishes discovered devices
3. BLE Scale Sync identifies the scale and either:
   - **Broadcast scales**: reads weight directly from the advertisement data (no connection)
   - **GATT scales**: instructs the ESP32 to connect, subscribe to notifications, and forward data
4. BLE Scale Sync computes body composition and dispatches to exporters

## Supported Boards

Any ESP32 board running MicroPython with BLE support works. Tested on:

| Board | Notes |
|-------|-------|
| M5Stack Atom Echo (ESP32-PICO) | Tiny, no PSRAM, ~100 KB free RAM — works fine |
| ESP32-DevKitC | Standard dev board, plenty of RAM |
| ESP32-S3 | Supported by MicroPython, BLE + WiFi |

::: warning Not compatible
ESP32-C3 and ESP32-C6 boards use a different BLE stack in MicroPython and have not been tested. Classic ESP32 and ESP32-S3 are recommended.
:::

## Requirements

- An ESP32 board (see above)
- WiFi network accessible by both the ESP32 and BLE Scale Sync
- An MQTT broker (e.g. [Mosquitto](https://mosquitto.org/))
- USB cable for initial flashing

### Host tools (install once)

```bash
pip install esptool mpremote
```

## Flashing the Firmware

### 1. Configure

Copy the example config and edit your WiFi and MQTT settings:

```bash
cd firmware/
cp config.json.example config.json
```

Edit `config.json`:

```json
{
  "wifi_ssid": "MyNetwork",
  "wifi_password": "secret",
  "mqtt_broker": "192.168.1.100",
  "mqtt_port": 1883,
  "mqtt_user": null,
  "mqtt_password": null,
  "device_id": "esp32-ble-proxy",
  "topic_prefix": "ble-proxy"
}
```

### 2. Flash

Connect the ESP32 via USB and run the flash script:

```bash
# Full flash: erase → MicroPython → libraries → app
./flash.sh

# Or just re-upload the app (fast iteration)
./flash.sh --app-only

# Or just reinstall MicroPython libraries
./flash.sh --libs-only
```

The script auto-detects the serial port. Override with `PORT=/dev/ttyACM0 ./flash.sh` if needed.

::: tip Atom Echo / ESP32-PICO
Some boards need a slower baud rate. If flashing fails, edit `BAUD=115200` in `flash.sh`.
:::

### 3. Verify

Check the serial console to confirm WiFi and MQTT connection:

```bash
mpremote connect /dev/ttyUSB0 repl
```

You should see:
```
BLE-MQTT bridge ready: ble-proxy/esp32-ble-proxy
```

Or check the MQTT status topic:

```bash
mosquitto_sub -h <broker-ip> -t 'ble-proxy/esp32-ble-proxy/status'
# Should print: online
```

## Configuring BLE Scale Sync

Add the `ble` section to your `config.yaml`:

```yaml
ble:
  handler: mqtt-proxy
  mqtt_proxy:
    broker_url: 'mqtt://192.168.1.100:1883'
    device_id: esp32-ble-proxy        # must match config.json
    topic_prefix: ble-proxy           # must match config.json
    # username: myuser                # optional, if broker requires auth
    # password: '${MQTT_PASSWORD}'    # optional
```

Then restart BLE Scale Sync. It will connect to the MQTT broker and use the ESP32 for all BLE operations.

::: tip Reusing your MQTT exporter broker
If you already have an MQTT exporter configured, the ESP32 proxy can use the same broker. Just make sure `device_id` and `client_id` don't collide.
:::

::: warning Security
The default `mqtt://` URL transmits data in plaintext, including body weight and composition data. On untrusted networks, use `mqtts://` with a TLS-enabled broker.
:::

## Firmware Files

```
firmware/
  config.json.example   # WiFi + MQTT config template
  flash.sh              # One-command flash script
  boot.py               # Stub — WiFi managed by mqtt_as
  main.py               # MQTT command dispatch loop
  ble_bridge.py         # BLE scan/connect/notify via raw BLE + aioble
  requirements.txt      # MicroPython library dependencies
```

### What the firmware does

- **Scan**: performs a BLE scan, parses advertisement data (names, services, manufacturer data), publishes JSON results
- **Connect**: connects to a BLE device, discovers GATT services/characteristics, reports them
- **Notify**: subscribes to BLE notifications and forwards them as MQTT messages
- **Read/Write**: proxies GATT read and write operations
- **Radio management**: deactivates BLE after scanning so WiFi can recover (they share the 2.4 GHz radio on ESP32)

### MQTT Topics

All topics are prefixed with `{topic_prefix}/{device_id}/` (default: `ble-proxy/esp32-ble-proxy/`).

| Topic | Direction | Payload |
|-------|-----------|---------|
| `status` | ESP32 → App | `"online"` / `"offline"` (retained, LWT) |
| `error` | ESP32 → App | Error message string (command failures) |
| `scan/start` | App → ESP32 | `""` (trigger scan) |
| `scan/results` | ESP32 → App | JSON array of discovered devices |
| `connect` | App → ESP32 | `{"address": "AA:BB:CC:DD:EE:FF", "addr_type": 0}` |
| `connected` | ESP32 → App | `{"chars": [{"uuid": "...", "properties": [...]}]}` |
| `disconnect` | App → ESP32 | `""` |
| `disconnected` | ESP32 → App | `""` |
| `notify/{uuid}` | ESP32 → App | Raw bytes (BLE notification data) |
| `write/{uuid}` | App → ESP32 | Raw bytes |
| `read/{uuid}` | App → ESP32 | `""` (trigger read) |
| `read/{uuid}/response` | ESP32 → App | Raw bytes |

## Troubleshooting

### ESP32 shows "online" but scans find nothing

- Move the ESP32 closer to the scale. Small boards like the Atom Echo have limited BLE range.
- Some scales only advertise while actively measuring (display lit up). Step on the scale during a scan cycle.

### WiFi won't reconnect after BLE scan

The firmware deactivates BLE after each scan to free the shared 2.4 GHz radio. If WiFi still fails:
- Check that your WiFi router is on a 2.4 GHz band (5 GHz won't work with ESP32)
- Try reducing scan duration in `ble_bridge.py` (`duration_ms` parameter)

### Scan timeout (30s) on first scan after boot

The first scan after boot may take longer because the ESP32 needs to establish the WiFi connection. Subsequent scans are faster (~8–10 seconds).

### Out of memory on ESP32-PICO / Atom Echo

Boards without PSRAM have ~100 KB free after boot. If you see `MemoryError`:
- The firmware already deduplicates scan results and runs `gc.collect()` aggressively
- Reduce `duration_ms` in the scan method to find fewer devices
- Avoid running other MicroPython code alongside the bridge
