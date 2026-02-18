"""ESP32 BLE-to-MQTT bridge — transparent proxy, zero scale-specific logic.

Scans autonomously in a loop; connect/disconnect/write/read are command-driven.
BLE operations temporarily disrupt WiFi on ESP32 (shared 2.4 GHz radio); the
bridge deactivates BLE after each scan so WiFi can recover.
"""

import json
import asyncio
import gc
import time
from mqtt_as import MQTTClient, config as mqtt_config
from ble_bridge import BleBridge
# Load config
with open("config.json") as f:
    cfg = json.load(f)

PREFIX = cfg["topic_prefix"]
DEVICE_ID = cfg["device_id"]
BASE = f"{PREFIX}/{DEVICE_ID}"

bridge = BleBridge()

# Track whether per-char write/read wildcard topics are subscribed
_char_subscribed = False

# Guard against concurrent BLE operations
_busy = False

# Pause autonomous scanning when a GATT connection is active
_scan_paused = False

# Set True after on_connect finishes re-subscribing (avoids race with isconnected)
_subs_ready = False

# Pending commands set by the sync callback, processed in the async main loop
_pending = []


def topic(suffix):
    return f"{BASE}/{suffix}"


# ─── MQTT config ──────────────────────────────────────────────────────────────

mqtt_config["ssid"] = cfg["wifi_ssid"]
mqtt_config["wifi_pw"] = cfg["wifi_password"]

mqtt_config["server"] = cfg["mqtt_broker"]
mqtt_config["port"] = cfg["mqtt_port"]
mqtt_config["client_id"] = DEVICE_ID
mqtt_config["will"] = (topic("status"), "offline", True, 1)
mqtt_config["keepalive"] = 30
mqtt_config["clean"] = True
mqtt_config["queue_len"] = 0  # callback mode


def on_message(topic_bytes, msg, retained):
    """Sync callback — queue the command for async processing."""
    t = topic_bytes.decode() if isinstance(topic_bytes, (bytes, bytearray)) else topic_bytes
    _pending.append((t, msg))


async def on_connect(client_ref):
    """Re-subscribe to command topics after every (re)connect."""
    global _char_subscribed, _subs_ready
    _subs_ready = False
    await client_ref.subscribe(topic("connect"), 0)
    await client_ref.subscribe(topic("disconnect"), 0)
    # Re-subscribe write/read wildcards if a BLE device is connected
    if _char_subscribed:
        await client_ref.subscribe(topic("write/#"), 0)
        await client_ref.subscribe(topic("read/#"), 0)
    _subs_ready = True
    await client_ref.publish(topic("status"), "online", retain=True, qos=1)
    print(f"BLE-MQTT bridge ready: {BASE}")


mqtt_config["subs_cb"] = on_message
mqtt_config["connect_coro"] = on_connect

if cfg.get("mqtt_user"):
    mqtt_config["user"] = cfg["mqtt_user"]
if cfg.get("mqtt_password"):
    mqtt_config["password"] = cfg["mqtt_password"]

client = MQTTClient(mqtt_config)


async def publish_error(message):
    """Publish an error message so the host doesn't hang waiting for a response."""
    try:
        await client.publish(topic("error"), message, qos=0)
    except Exception:
        pass
    print(f"Error: {message}")


# ─── Autonomous scan loop ────────────────────────────────────────────────────

async def scan_loop():
    """Continuously scan for BLE devices and publish results."""
    global _busy, _subs_ready
    _last_scan_time = 0

    while True:
        # Wait for MQTT to be connected and subscriptions ready
        while not (client.isconnected() and _subs_ready):
            await asyncio.sleep(1)

        # Skip if a GATT connection is active or another BLE op is in progress
        if _scan_paused or _busy:
            await asyncio.sleep(1)
            continue

        # Minimum 5s between scans
        now = time.ticks_ms()
        if time.ticks_diff(now, _last_scan_time) < 5000:
            await asyncio.sleep_ms(500)
            continue

        _busy = True
        try:
            gc.collect()
            print(f"Scanning... (free: {gc.mem_free()})")
            _subs_ready = False
            results = await bridge.scan()
            gc.collect()
            print(f"Scan done: {len(results)} devices (free: {gc.mem_free()})")
            # Wait for mqtt_as to reconnect after BLE radio disruption.
            # If the connection survived (didn't drop), on_connect won't fire,
            # so _subs_ready stays False. Detect this and restore it.
            for _ in range(30):
                if client.isconnected() and _subs_ready:
                    break
                if client.isconnected() and not _subs_ready:
                    # Connection survived the scan — subscriptions still valid
                    _subs_ready = True
                    break
                await asyncio.sleep(1)
            await client.publish(topic("scan/results"), json.dumps(results), qos=0)
            print("Results published")
        except Exception as e:
            try:
                await publish_error(f"Scan failed: {e}")
            except Exception:
                print(f"Scan error: {e}")
        finally:
            _last_scan_time = time.ticks_ms()
            _busy = False


# ─── Command handlers ─────────────────────────────────────────────────────────

async def handle_connect(payload):
    """Connect to a BLE device, discover chars, start notify forwarding."""
    global _char_subscribed, _busy, _scan_paused
    _scan_paused = True  # Pause autonomous scanning
    # Wait for any in-progress scan to finish (max 30s)
    for _ in range(60):
        if not _busy:
            break
        await asyncio.sleep_ms(500)
    if _busy:
        _scan_paused = False
        await publish_error("Busy — another BLE operation is in progress")
        return
    _busy = True
    try:
        data = json.loads(payload)
        address = data["address"]
        addr_type = data.get("addr_type", 0)  # 0 = public, 1 = random

        # Disconnect any existing connection first
        await bridge.disconnect()

        result = await bridge.connect(address, addr_type)

        if not _char_subscribed:
            await client.subscribe(topic("write/#"), 0)
            await client.subscribe(topic("read/#"), 0)
            _char_subscribed = True

        for char_info in result["chars"]:
            if "notify" in char_info["properties"]:
                uuid_str = char_info["uuid"]

                def make_publish_fn(u):
                    async def publish_fn(_source_uuid, data):
                        await client.publish(topic(f"notify/{u}"), data, qos=0)
                    return publish_fn

                await bridge.start_notify(uuid_str, make_publish_fn(uuid_str))

        await client.publish(topic("connected"), json.dumps(result), qos=0)
    except Exception as e:
        _scan_paused = False  # Resume scanning on connect failure
        raise e
    finally:
        _busy = False


async def handle_disconnect():
    """Disconnect from BLE device and resume autonomous scanning."""
    global _char_subscribed, _scan_paused
    await bridge.disconnect()
    _char_subscribed = False
    _scan_paused = False  # Resume autonomous scanning
    await client.publish(topic("disconnected"), "", qos=0)


async def handle_write(uuid_str, payload):
    """Write data to a BLE characteristic."""
    await bridge.write(uuid_str, payload)


async def handle_read(uuid_str):
    """Read from a BLE characteristic and publish response."""
    data = await bridge.read(uuid_str)
    await client.publish(topic(f"read/{uuid_str}/response"), data, qos=0)


# ─── Main loop ────────────────────────────────────────────────────────────────

async def main():
    await client.connect()
    # Start autonomous BLE scan loop
    asyncio.create_task(scan_loop())
    gc_counter = 0

    while True:
        while _pending:
            t, msg = _pending.pop(0)
            try:
                if t == topic("connect"):
                    await handle_connect(msg)
                elif t == topic("disconnect"):
                    await handle_disconnect()
                elif t.startswith(topic("write/")):
                    uuid_str = t[len(topic("write/")):]
                    await handle_write(uuid_str, msg)
                elif t.startswith(topic("read/")):
                    suffix = t[len(topic("read/")):]
                    if "/response" not in suffix:
                        await handle_read(suffix)
            except Exception as e:
                await publish_error(str(e))

        await asyncio.sleep_ms(50)
        gc_counter += 1
        if gc_counter >= 200:  # ~10 seconds
            gc.collect()
            gc_counter = 0


asyncio.run(main())
