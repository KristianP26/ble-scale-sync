"""ESP32 BLE-to-MQTT bridge — transparent proxy, zero scale-specific logic.

Scans autonomously in a loop; connect/disconnect/write/read are command-driven.
Board-specific tuning (scan interval, GC, BLE/WiFi coexistence) is read from
the board abstraction layer.
"""

import json
import asyncio
import gc
import time
import board
from mqtt_as import MQTTClient, config as mqtt_config
from ble_bridge import BleBridge

if board.HAS_BEEP:
    from beep import beep

if board.HAS_DISPLAY:
    import ui

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

# Scale MAC detection for instant beep
_scale_macs = set()
_last_beep_time = 0


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
    global _scale_macs
    t = topic_bytes.decode() if isinstance(topic_bytes, (bytes, bytearray)) else topic_bytes
    if t == topic("config"):
        try:
            data = json.loads(msg)
            _scale_macs = set(data.get("scales", []))
            print(f"Config: {len(_scale_macs)} scale MAC(s)")
            if board.HAS_DISPLAY:
                ui.on_config_update(data.get("users", []))
                ui.on_scale_macs_update(len(_scale_macs) > 0)
        except Exception as e:
            print(f"Bad config payload: {e}")
        return
    _pending.append((t, msg))


async def on_connect(client_ref):
    """Re-subscribe to command topics after every (re)connect."""
    global _char_subscribed, _subs_ready
    _subs_ready = False
    await client_ref.subscribe(topic("connect"), 0)
    await client_ref.subscribe(topic("disconnect"), 0)
    await client_ref.subscribe(topic("config"), 0)
    await client_ref.subscribe(topic("beep"), 0)
    if board.HAS_DISPLAY:
        await client_ref.subscribe(topic("display/reading"), 0)
        await client_ref.subscribe(topic("display/result"), 0)
        await client_ref.subscribe(topic("screenshot"), 0)
    # Re-subscribe write/read wildcards if a BLE device is connected
    if _char_subscribed:
        await client_ref.subscribe(topic("write/#"), 0)
        await client_ref.subscribe(topic("read/#"), 0)
    _subs_ready = True
    if board.HAS_DISPLAY:
        ui.on_mqtt_change(True)
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
    global _busy, _subs_ready, _last_beep_time
    _last_scan_time = 0

    while True:
        # Wait for MQTT to be connected and subscriptions ready
        while not (client.isconnected() and _subs_ready):
            await asyncio.sleep(1)

        # Skip if a GATT connection is active or another BLE op is in progress
        if _scan_paused or _busy:
            await asyncio.sleep(1)
            continue

        # Minimum interval between scans (board-specific)
        now = time.ticks_ms()
        if time.ticks_diff(now, _last_scan_time) < board.SCAN_INTERVAL_MS:
            await asyncio.sleep_ms(500)
            continue

        _busy = True
        try:
            gc.collect()
            print(f"Scanning... (free: {gc.mem_free()})")
            # On shared-radio boards, BLE disrupts WiFi — mark subs stale
            if board.DEACTIVATE_BLE_AFTER_SCAN:
                _subs_ready = False
            results = await bridge.scan()
            gc.collect()
            print(f"Scan done: {len(results)} devices (free: {gc.mem_free()})")
            if board.HAS_DISPLAY:
                ui.on_scan_tick(len(results))
            # Beep/display if a known scale MAC is present (60s debounce)
            if _scale_macs and time.ticks_diff(time.ticks_ms(), _last_beep_time) > 60000:
                for r in results:
                    if r["address"] in _scale_macs:
                        _last_beep_time = time.ticks_ms()
                        print(f"Scale detected: {r['address']}")
                        if board.HAS_BEEP:
                            beep()
                        if board.HAS_DISPLAY:
                            ui.on_scale_detected(r["address"])
                        break
            # On shared-radio boards, wait for mqtt_as to reconnect after BLE disruption
            if board.DEACTIVATE_BLE_AFTER_SCAN:
                for _ in range(30):
                    if client.isconnected() and _subs_ready:
                        break
                    if client.isconnected() and not _subs_ready:
                        # Connection survived the scan — subscriptions still valid
                        _subs_ready = True
                        break
                    await asyncio.sleep(1)
            board.on_scan_complete(results, bool(_scale_macs))
            await client.publish(topic("scan/results"), json.dumps(results), qos=0)
            print("Results published")
            if board.HAS_DISPLAY:
                ui.on_publish_tick()
        except Exception as e:
            try:
                await publish_error(f"Scan failed: {e}")
            except Exception:
                print(f"Scan error: {e}")
        finally:
            # If MQTT survived the (possibly failed) scan, subscriptions are still valid
            if client.isconnected() and not _subs_ready:
                _subs_ready = True
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

        bridge.set_on_disconnect(lambda: _pending.append(("__ble_disconnected__", b"")))
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


async def handle_unexpected_disconnect():
    """Handle unexpected BLE peripheral disconnect — notify TS, resume scanning."""
    global _char_subscribed, _scan_paused
    print("BLE peripheral disconnected unexpectedly")
    await bridge.disconnect()
    _char_subscribed = False
    _scan_paused = False
    await client.publish(topic("disconnected"), "", qos=0)


async def handle_write(uuid_str, payload):
    """Write data to a BLE characteristic."""
    await bridge.write(uuid_str, payload)


async def handle_read(uuid_str):
    """Read from a BLE characteristic and publish response."""
    data = await bridge.read(uuid_str)
    await client.publish(topic(f"read/{uuid_str}/response"), data, qos=0)


# ─── Connection monitor (display boards only) ────────────────────────────────

if board.HAS_DISPLAY:
    import network
    _wlan = network.WLAN(network.STA_IF)

    async def _connection_monitor():
        """Poll WiFi/MQTT status every 2s and update UI indicators."""
        prev_wifi = False
        prev_mqtt = False
        while True:
            wifi_now = _wlan.isconnected()
            mqtt_now = client.isconnected()
            if wifi_now != prev_wifi:
                ui.on_wifi_change(wifi_now)
                prev_wifi = wifi_now
            if mqtt_now != prev_mqtt:
                ui.on_mqtt_change(mqtt_now)
                prev_mqtt = mqtt_now
            await asyncio.sleep(2)


# ─── Main loop ────────────────────────────────────────────────────────────────

async def main():
    print(f"Board: {board.BOARD_NAME}")
    if board.HAS_DISPLAY:
        ui.init()
        asyncio.create_task(_connection_monitor())
    await client.connect()
    if board.HAS_DISPLAY:
        ui.on_wifi_change(True)
        ui.on_mqtt_change(True)
    # Start autonomous BLE scan loop
    asyncio.create_task(scan_loop())
    gc_counter = 0

    while True:
        while _pending:
            t, msg = _pending.pop(0)
            try:
                if t == "__ble_disconnected__":
                    await handle_unexpected_disconnect()
                elif t == topic("connect"):
                    await handle_connect(msg)
                elif t == topic("disconnect"):
                    await handle_disconnect()
                elif t == topic("beep"):
                    if board.HAS_BEEP:
                        if msg:
                            d = json.loads(msg)
                            beep(d.get("freq", 1000), d.get("duration", 200), d.get("repeat", 1))
                        else:
                            beep()
                elif t == topic("display/reading"):
                    if board.HAS_DISPLAY:
                        d = json.loads(msg)
                        ui.on_reading(
                            d.get("slug", ""),
                            d.get("name", ""),
                            d.get("weight", 0),
                            d.get("impedance"),
                            d.get("exporters", []),
                        )
                elif t == topic("display/result"):
                    if board.HAS_DISPLAY:
                        d = json.loads(msg)
                        ui.on_result(
                            d.get("slug", ""),
                            d.get("name", ""),
                            d.get("weight", 0),
                            d.get("exports", []),
                        )
                elif t == topic("screenshot"):
                    if board.HAS_DISPLAY:
                        try:
                            # Read directly from DMA framebuffer (not LVGL snapshot)
                            fb = board.display_dev.framebuffer(0)
                            if fb:
                                raw = bytes(fb)
                                gc.collect()
                                # Publish in 4KB chunks over MQTT
                                CHUNK = 4096
                                total = len(raw)
                                n_chunks = (total + CHUNK - 1) // CHUNK
                                await client.publish(topic("screenshot/info"), json.dumps({
                                    "w": 480, "h": 480, "fmt": "rgb565", "size": total, "chunks": n_chunks
                                }), qos=1)
                                for i in range(n_chunks):
                                    chunk = raw[i * CHUNK : (i + 1) * CHUNK]
                                    await client.publish(topic(f"screenshot/{i}"), chunk, qos=1)
                                    await asyncio.sleep_ms(20)
                                await client.publish(topic("screenshot/done"), str(n_chunks), qos=1)
                                print(f"Screenshot sent: {n_chunks} chunks")
                                gc.collect()
                            else:
                                print("Screenshot failed")
                        except Exception as e:
                            import sys
                            sys.print_exception(e)
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
        if gc_counter >= board.GC_INTERVAL:
            gc.collect()
            gc_counter = 0
        if board.HAS_DISPLAY:
            ui.check_timeout()


asyncio.run(main())
