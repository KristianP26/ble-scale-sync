---
title: ESP32 BLE Proxy
description: Use an ESP32 as a remote BLE-to-MQTT bridge for headless or Docker deployments.
---

# ESP32 BLE Proxy

Use a cheap ESP32 board as a remote Bluetooth radio, communicating over MQTT. This lets you run BLE Scale Sync on machines without local Bluetooth - headless servers, Docker containers, or devices where the built-in radio has poor range.

The ESP32 scans autonomously for BLE advertisements and publishes results over MQTT. BLE Scale Sync matches scale adapters against the scan data, identifies users by weight, computes body composition, and dispatches to exporters. For scales that require a GATT connection, the server sends connect/write/read commands back to the ESP32 over MQTT. All scale-specific logic stays on the server.

## How It Works

```
┌─────────┐   BLE    ┌──────────┐   MQTT   ┌────────────────┐
│  Scale   │ ──────── │  ESP32   │ ──────── │ BLE Scale Sync │
└─────────┘  advert  └──────────┘          └────────────────┘
             + GATT  MicroPython              Docker / Node.js
```

**Broadcast scales** (weight in BLE advertisements):

1. The ESP32 continuously scans for BLE advertisements (~every 10s)
2. Scan results (names, services, manufacturer data) are published to MQTT
3. BLE Scale Sync reads weight from broadcast advertisement data
4. Body composition is computed and dispatched to exporters
5. Feedback (beep, display updates) is sent back to the ESP32 via MQTT

**GATT scales** (notification-based readings):

1. A matched adapter has no broadcast data — the server sends a `connect` command
2. The ESP32 connects to the scale, discovers characteristics, and reports them
3. The server subscribes to notification topics and sends write commands (e.g. unlock)
4. Scale readings arrive as notifications, forwarded to the server via MQTT
5. The server sends a `disconnect` command when the reading is complete

Both **broadcast scales** (weight embedded in BLE advertisements) and **GATT scales** (requiring a connection for notification-based readings) are supported. When a matched adapter has no broadcast data, the proxy automatically falls back to a GATT connection through the ESP32.

## Supported Boards

Any ESP32 board running MicroPython with BLE support works. Tested on:

| Board                          | Notes                                                                 |
| ------------------------------ | --------------------------------------------------------------------- |
| M5Stack Atom Echo (ESP32-PICO) | Tiny, no PSRAM, ~100 KB free RAM, I2S buzzer for beep feedback        |
| ESP32-S3-DevKitC               | Standard dev board, plenty of RAM                                     |
| Guition ESP32-S3-4848S040      | 480x480 RGB display, shows scan status and export results via LVGL UI |

The board is auto-detected from the chip family. Set `"board"` in `config.json` to override (e.g. `"guition_4848"` for the display board, `"atom_echo"` for the Atom Echo).

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
  "board": null,
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
# Full flash: erase -> MicroPython -> libraries -> app
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

::: tip ESP32-S3-4848 (display board)
This board requires custom LVGL MicroPython firmware. See [PORTING.md](https://github.com/KristianP26/ble-scale-sync/blob/main/PORTING.md) for build instructions:

```bash
cd drivers && ./build.sh guition_4848
```

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
    device_id: esp32-ble-proxy # must match config.json
    topic_prefix: ble-proxy # must match config.json
    # username: myuser                # optional, if broker requires auth
    # password: '${MQTT_PASSWORD}'    # optional
```

Then restart BLE Scale Sync. In continuous mode, the server maintains a persistent MQTT connection and reacts to scan results as they arrive - no polling delay.

::: tip Reusing your MQTT exporter broker
If you already have an MQTT exporter configured, the ESP32 proxy can use the same broker. Just make sure `device_id` and `client_id` don't collide.
:::

::: warning Security
The default `mqtt://` URL transmits data in plaintext, including body weight and composition data. On untrusted networks, use `mqtts://` with a TLS-enabled broker.
:::

## Firmware Files

```
firmware/
  config.json.example       # WiFi + MQTT config template
  flash.sh                  # One-command flash script
  boot.py                   # Stub - WiFi managed by mqtt_as
  main.py                   # MQTT dispatch + autonomous scan loop
  ble_bridge.py             # BLE scanning via aioble
  beep.py                   # I2S buzzer driver (boards with HAS_BEEP)
  board.py                  # Board auto-detection dispatch
  board_atom_echo.py        # Atom Echo config (no PSRAM, I2S beep)
  board_esp32_s3.py         # Generic ESP32-S3 config
  board_guition_4848.py     # Guition 4848 config (LVGL display)
  panel_init_guition_4848.py # ST7701S panel init sequence data
  ui.py                     # LVGL display UI (boards with HAS_DISPLAY)
  requirements.txt          # MicroPython library dependencies
```

### What the firmware does

- **Autonomous scanning**: scans for BLE advertisements in a continuous loop (interval is board-specific, ~2-10s)
- **Scale detection**: beeps when a known scale MAC is seen (MACs registered by the server after adapter matching)
- **Radio management**: on shared-radio boards (ESP32-PICO), deactivates BLE after each scan so WiFi can recover
- **Display UI** (4848 board): shows WiFi/MQTT/BLE status, scan activity, user match results, and export outcomes
- **Config sync**: receives scale MAC list and user info from the server for local feedback

### MQTT Topics

All topics are prefixed with `{topic_prefix}/{device_id}/` (default: `ble-proxy/esp32-ble-proxy/`).

| Topic                  | Direction       | Payload                                                   |
| ---------------------- | --------------- | --------------------------------------------------------- |
| `status`               | ESP32 -> Server | `"online"` / `"offline"` (retained, LWT)                  |
| `error`                | ESP32 -> Server | Error message string                                      |
| `scan/results`         | ESP32 -> Server | JSON array of discovered devices                          |
| `config`               | Server -> ESP32 | `{"scales": ["AA:BB:..."], "users": [...]}` (retained)    |
| `beep`                 | Server -> ESP32 | `""` or `{"freq": 1000, "duration": 200, "repeat": 1}`    |
| `display/reading`      | Server -> ESP32 | `{"slug", "name", "weight", "impedance", "exporters"}`    |
| `display/result`       | Server -> ESP32 | `{"slug", "name", "weight", "exports": [{"name", "ok"}]}` |
| `connect`              | Server -> ESP32 | `{"address": "AA:BB:...", "addr_type": 0}`                |
| `connected`            | ESP32 -> Server | `{"chars": [{"uuid": "...", "properties": [...]}]}`       |
| `disconnect`           | Server -> ESP32 | (any)                                                     |
| `disconnected`         | ESP32 -> Server | (empty)                                                   |
| `notify/{uuid}`        | ESP32 -> Server | Raw binary (characteristic notification)                  |
| `write/{uuid}`         | Server -> ESP32 | Raw binary (characteristic write)                         |
| `read/{uuid}`          | Server -> ESP32 | (empty, triggers read)                                    |
| `read/{uuid}/response` | ESP32 -> Server | Raw binary (read result)                                  |

## Troubleshooting

### ESP32 shows "online" but scans find nothing

- Move the ESP32 closer to the scale. Small boards like the Atom Echo have limited BLE range.
- Some scales only advertise while actively measuring (display lit up). Step on the scale during a scan cycle.

### WiFi won't reconnect after BLE scan

On shared-radio boards (ESP32-PICO), the firmware deactivates BLE after each scan to free the 2.4 GHz radio. If WiFi still fails:

- Check that your WiFi router is on a 2.4 GHz band (5 GHz won't work with ESP32)
- Try reducing `SCAN_DURATION_MS` in the board config

ESP32-S3 boards have hardware radio coexistence and don't need BLE deactivation.

### Scan timeout (30s) on first scan after boot

The first scan after boot may take longer because the ESP32 needs to establish the WiFi connection. Subsequent scans are faster (~8-10 seconds).

### Out of memory on ESP32-PICO / Atom Echo

Boards without PSRAM have ~100 KB free after boot. If you see `MemoryError`:

- The firmware already deduplicates scan results and runs `gc.collect()` aggressively
- Reduce `SCAN_DURATION_MS` in `board_atom_echo.py` to find fewer devices
- Avoid running other MicroPython code alongside the bridge
