#!/usr/bin/env python3
"""Capture a screenshot from the ESP32 display via MQTT.

Usage:
    python3 firmware/tools/capture_screenshot.py [output.png]

Triggers a screenshot, receives RGB565 data over MQTT, converts to PNG.
Waits patiently for chunks that arrive between BLE scan WiFi drops.
"""

import os
import sys
import struct
import time

# ── Configuration ───────────────────────────────────────
# Override via environment variables, or edit these defaults.
BROKER = os.environ.get("BROKER", "10.1.1.15")
BASE = os.environ.get("BASE", "ble-proxy/esp32-ble-proxy")
OUTPUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/screenshot.png"

W, H = 480, 480
EXPECTED_SIZE = W * H * 2  # RGB565


def main():
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
    client.connect(BROKER)
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
