#!/usr/bin/env python3
"""Capture a screenshot from the ESP32 display via MQTT.

Usage:
    BROKER=<host> [MQTT_PORT=1883] [MQTT_USER=... MQTT_PASSWORD=...] \\
    [BASE=ble-proxy/esp32-ble-proxy] python3 firmware/tools/capture_screenshot.py [output.png]

Triggers a screenshot, receives RGB565 data over MQTT, converts to PNG.
Waits patiently for chunks that arrive between BLE scan WiFi drops.
The ESP32 refuses the request while a BLE connection is in progress.
"""

import os
import sys
import struct
import time

# ── Configuration (environment variables) ──────────────
# BROKER is the broker the ESP32 uses (mqtt_broker in its config.json).
# MQTT_USER / MQTT_PASSWORD are needed whenever the broker requires a login,
# e.g. the app's embedded broker on a LAN interface.
BROKER = os.environ.get("BROKER")
MQTT_PORT = os.environ.get("MQTT_PORT", "1883")
MQTT_USER = os.environ.get("MQTT_USER")
MQTT_PASSWORD = os.environ.get("MQTT_PASSWORD")
BASE = os.environ.get("BASE", "ble-proxy/esp32-ble-proxy")
OUTPUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/screenshot.png"

W, H = 480, 480
EXPECTED_SIZE = W * H * 2  # RGB565


def main():
    if not BROKER:
        sys.exit("Set BROKER to the MQTT broker host the ESP32 uses (mqtt_broker in its config.json)")
    try:
        port = int(MQTT_PORT)
    except ValueError:
        sys.exit(f"MQTT_PORT must be a number, got {MQTT_PORT!r}")

    import paho.mqtt.client as mqtt

    CHUNK_SIZE = 4096
    n_chunks = (EXPECTED_SIZE + CHUNK_SIZE - 1) // CHUNK_SIZE  # 113
    chunks = {}

    def on_message(client, userdata, msg):
        t = msg.topic
        if t.startswith(f"{BASE}/screenshot/"):
            try:
                idx = int(t.split("/")[-1])
                chunks[idx] = msg.payload
            except ValueError:
                pass  # info, done — ignore

    client = mqtt.Client()
    client.on_message = on_message
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    client.connect(BROKER, port)
    client.subscribe(f"{BASE}/screenshot/#", qos=1)
    client.loop_start()

    for attempt in range(1, 4):
        client.publish(f"{BASE}/screenshot", "", qos=1)
        print(f"Screenshot triggered (attempt {attempt}), waiting for {n_chunks} chunks...")

        timeout = time.time() + 45
        last_count = 0
        while time.time() < timeout:
            time.sleep(1)
            count = len(chunks)
            if count != last_count:
                print(f"  {count}/{n_chunks} chunks received...")
                last_count = count
            if count >= n_chunks:
                break
        if len(chunks) >= n_chunks:
            break
        missing = [i for i in range(n_chunks) if i not in chunks]
        print(f"  Missing {len(missing)} chunks, retrying...")

    client.loop_stop()
    client.disconnect()

    missing = [i for i in range(n_chunks) if i not in chunks]
    if missing:
        print(f"Missing {len(missing)} chunks: {missing[:20]}...")
        sys.exit(1)

    print(f"All {n_chunks} chunks received!")

    # Reassemble
    raw = b""
    for i in range(n_chunks):
        raw += chunks[i]

    print(f"Total size: {len(raw)} bytes (expected {EXPECTED_SIZE})")

    # Convert RGB565 to RGB888 PNG
    pixels = []
    for i in range(0, len(raw), 2):
        v = struct.unpack("<H", raw[i:i+2])[0]
        r = ((v >> 11) & 0x1F) << 3
        g = ((v >> 5) & 0x3F) << 2
        b = (v & 0x1F) << 3
        pixels.extend([r, g, b])

    from PIL import Image
    img = Image.frombytes("RGB", (W, H), bytes(pixels))
    img.save(OUTPUT)
    print(f"Saved to {OUTPUT}")


if __name__ == "__main__":
    main()
