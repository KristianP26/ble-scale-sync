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

# Guard against concurrent BLE operations. Whoever sets it owns the radio and
# the scan state until it clears it; nobody else may pause or resume scanning
# meanwhile.
_busy = False

# Pause autonomous scanning when a GATT connection is active. Set only by the
# path that holds _busy for the connect (or by the live session it created),
# so only that path or the session's end may resume scanning.
_scan_paused = False

# True while a host `connect` command waits for _busy. The scan loops stand
# down (no new scan, no autonomous connect) instead of the waiting command
# pausing scanning itself: a pause set by a path that does not own the radio
# was cleared by the other path's failure handler, and the reverse.
_host_connect_pending = False

# Total time a host-initiated connect may take on the firmware, from taking
# the command off the queue to publishing `connected` or `error`, busy wait
# included. The host gives up after COMMAND_TIMEOUT_MS (30 s,
# src/ble/handler-mqtt-proxy/topics.ts) and then sends `disconnect`, so an
# answer later than that kills a session that just succeeded. 5 s are left for
# the MQTT round trip over the shared 2.4 GHz radio.
HOST_CONNECT_BUDGET_MS = getattr(board, "HOST_CONNECT_BUDGET_MS", 25000)
# The busy wait must leave the connect at least this much of the budget.
HOST_CONNECT_MIN_MS = 5000

# GATT session guard (#296). A session the host never engages with used to park
# the scan loop until the ESP32 was reset: with lazy notify no notify reader is
# running, and the notify reader is the only thing that reported a dead link.
GATT_SESSION_IDLE_MS = getattr(board, "GATT_SESSION_IDLE_MS", 20000)
GATT_SESSION_MAX_MS = getattr(board, "GATT_SESSION_MAX_MS", 180000)
_gatt_session_task = None
# Set the moment a 'connected' event is published, cleared when the session ends.
_gatt_session_armed = False
# True once the host has sent any command for the current session. A host that
# has engaged is then silent by design while it waits for notifications, so the
# idle timeout must never apply to it, only to a session nobody ever answered.
_host_engaged = False
_last_host_activity = 0
# True while a handler is ending the current GATT session, so a second producer
# of the same end (the scan loop backstop) stands down instead of resuming twice.
_ending_session = False

# Set True after on_connect finishes re-subscribing (avoids race with isconnected)
_subs_ready = False

# Pending commands set by the sync callback, processed in the async main loop
_pending = []

# Scale MAC detection for instant beep
_scale_macs = set()
_last_beep_time = 0

# Autonomous GATT connect: ESP32 connects itself when a known scale MAC
# appears in a scan, eliminating the MQTT round-trip latency (#201).
_auto_connect = True  # opt-out via config topic {"autoConnect": false}

# Known scale MACs the host reads from their advertisements (#422). They stay in
# _scale_macs for beep and early flush, but are never auto-connected: a
# connected scale stops advertising, and the host would only drop the session.
# Absent key (old host) means empty, so nothing changes.
_passive_macs = set()

# Lazy host-ordered notify enable (#231): when the host advertises
# lazy_notify=True on the config topic, BLE notify is enabled only on a per-char
# subscribe/<uuid> command (after the host has subscribed to notify/<uuid>), so
# the QN/Renpho ES-CS20M spontaneous 0x12 kickoff frame is never lost. Absent
# flag (old host) keeps today's eager enable, so there is no regression.
_lazy_notify = False


def topic(suffix):
    return f"{BASE}/{suffix}"


# ─── MQTT config ──────────────────────────────────────────────────────────────

mqtt_config["ssid"] = cfg["wifi_ssid"]
mqtt_config["wifi_pw"] = cfg["wifi_password"]

mqtt_config["server"] = cfg["mqtt_broker"]
mqtt_config["port"] = cfg["mqtt_port"]
mqtt_config["client_id"] = DEVICE_ID
mqtt_config["will"] = (topic("status"), "offline", True, 1)
# 60s keepalive (broker tolerates ~90s without a ping): a GATT connect
# attempt can starve WiFi for tens of seconds on the shared 2.4GHz radio,
# so a tighter value drops the MQTT link mid-connect (#201).
mqtt_config["keepalive"] = 60
mqtt_config["clean"] = True
mqtt_config["queue_len"] = 0  # callback mode


def on_message(topic_bytes, msg, retained):
    """Sync callback — queue the command for async processing."""
    global _scale_macs, _auto_connect, _lazy_notify, _last_host_activity, _host_engaged
    global _passive_macs
    t = topic_bytes.decode() if isinstance(topic_bytes, (bytes, bytearray)) else topic_bytes
    if t == topic("config"):
        try:
            data = json.loads(msg)
            _scale_macs = set(data.get("scales", []))
            _auto_connect = data.get("autoConnect", True)
            _lazy_notify = data.get("lazy_notify", False)
            passive = data.get("passive", [])
            # A list only: set() of a stray string would split it into characters.
            _passive_macs = set(passive) if isinstance(passive, list) else set()
            # One f-string rather than two adjacent ones: the simplest form for
            # MicroPython's parser, like every other print in this file.
            print(f"Config: {len(_scale_macs)} scale MAC(s), {len(_passive_macs)} passive, autoConnect={_auto_connect}, lazyNotify={_lazy_notify}")
            if board.HAS_DISPLAY:
                ui.on_config_update(data.get("users", []))
                ui.on_scale_macs_update(len(_scale_macs) > 0)
        except Exception as e:
            print(f"Bad config payload: {e}")
        return
    # Any host command counts as engagement with the current GATT session (#296).
    _last_host_activity = time.ticks_ms()
    if _gatt_session_armed:
        _host_engaged = True
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
    # Subscribe the per-char notify-enable wildcard unconditionally (NOT gated on
    # _char_subscribed like write/# and read/#): the host publishes subscribe/<uuid>
    # right after the connected event, so gating it would reintroduce an ordering
    # race. The topic is idle until a GATT connect happens (#231).
    await client_ref.subscribe(topic("subscribe/#"), 0)
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


def _is_ip_literal(host):
    return ":" in host or all(c in "0123456789." for c in host)


def mqtt_tls_settings(c, read_file):
    """Return (ssl, ssl_params) for mqtt_as from the config.json keys below.

    mqtt_tls          true: wrap the broker socket in TLS (default false).
    mqtt_ca_file      file on the device holding the CA (PEM or one DER cert)
                      that signed the broker certificate. With it the broker is
                      verified; without it the link is encrypted but anyone on
                      the path can impersonate the broker.
    mqtt_tls_hostname name to verify and send as SNI (default: mqtt_broker),
                      for a broker reached by IP whose certificate has a name.

    mqtt_as passes ssl_params to ssl.wrap_socket(). On the mbedtls esp32 port
    only CERT_REQUIRED validates anything, and it needs server_hostname.
    """
    tls = c.get("mqtt_tls") is True
    ca_file = c.get("mqtt_ca_file")
    if not tls:
        if ca_file:
            # A CA with TLS off would look configured while every byte,
            # password included, still went out in plaintext.
            raise ValueError("config.json: mqtt_ca_file is set but mqtt_tls is not true")
        return False, {}
    host = c.get("mqtt_tls_hostname") or c["mqtt_broker"]
    params = {}
    if ca_file:
        import ssl

        try:
            cadata = read_file(ca_file)
        except OSError as e:
            # Never fall back to an unverified link the user did not ask for.
            raise OSError(f"config.json: mqtt_ca_file {ca_file} cannot be read: {e}")
        params["cert_reqs"] = ssl.CERT_REQUIRED
        params["cadata"] = cadata
        params["server_hostname"] = host
    else:
        print("MQTT TLS without mqtt_ca_file: encrypted, but the broker is not verified")
        # SNI must be a name (RFC 6066), so an IP literal is left out.
        if not _is_ip_literal(host):
            params["server_hostname"] = host
    return True, params


def _read_device_file(path):
    with open(path, "rb") as f:
        return f.read()


mqtt_config["ssl"], mqtt_config["ssl_params"] = mqtt_tls_settings(cfg, _read_device_file)

client = MQTTClient(mqtt_config)


def error_payload(message, op, address=None, uuid=None):
    """JSON body for the error topic, so the host can tell whose error it is.

    `op` names the operation that failed: connect (host command), auto-connect,
    scan, subscribe, write, read or command. `address` (the MAC) and `uuid`
    (the characteristic) are included when the operation has one. A host that
    predates this format shows the whole JSON text as the error message.
    """
    body = {"op": op, "message": message}
    if address:
        body["address"] = address
    if uuid:
        body["uuid"] = uuid
    return json.dumps(body)


async def publish_error(message, op="command", address=None, uuid=None):
    """Publish an error message so the host doesn't hang waiting for a response."""
    try:
        await client.publish(topic("error"), error_payload(message, op, address, uuid), qos=0)
    except Exception:
        pass


def describe_exc(e):
    """Readable exception text. MicroPython's str() is empty for many built-in
    exceptions (e.g. asyncio.TimeoutError), so fall back to the type name —
    otherwise the host only sees a blank "ESP32 error:" (#201)."""
    return str(e) or type(e).__name__
    print(f"Error: {message}")


def _error_context(t, msg):
    """(op, address, uuid) for an error raised while handling command topic t."""
    if t == topic("connect"):
        try:
            return "connect", json.loads(msg).get("address"), None
        except Exception:
            return "connect", None, None
    for op in ("subscribe", "write", "read"):
        prefix = topic(op + "/")
        if t.startswith(prefix):
            return op, None, t[len(prefix):]
    return "command", None, None


async def _wait_not_busy(max_iters=60, sleep_ms=500):
    """Wait up to max_iters*sleep_ms for an in-flight BLE op to clear (#231).

    Returns True if _busy is clear (free to proceed), False if it stayed set.
    """
    for _ in range(max_iters):
        if not _busy:
            return True
        await asyncio.sleep_ms(sleep_ms)
    return not _busy


# ─── Autonomous scan loop ────────────────────────────────────────────────────

def _check_scale_beep(results):
    """Beep/display if a known scale MAC is present (60s debounce)."""
    global _last_beep_time
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


def _auto_connect_allowed(mac):
    """True if the ESP32 may autonomously connect to this MAC (#201, #422)."""
    return _auto_connect and mac in _scale_macs and mac not in _passive_macs


def _find_scale_in_raw(raw_results):
    """Find the first known scale MAC in the raw IRQ buffer.

    Returns (mac, addr_bytes, addr_type) or None. Non-destructive peek used by the
    autonomous connect logic to skip the MQTT round-trip (#201).

    The controller-reported addr_type (the advertising PDU TxAdd bit) is
    authoritative and is passed through unchanged. An earlier build forced
    addr_type=1 whenever addr[0] & 0xC0 == 0xC0 on the theory that an FF address
    must be random static, but a public address may use any bytes and cheap scale
    SoCs advertise arbitrary public addresses that also start with 0xFF, so that
    override connected the QN-Scale as random and it never matched the public
    advertiser (#231).
    """
    for addr_bytes, addr_type, _rssi, _raw in raw_results:
        mac = ":".join("%02X" % b for b in addr_bytes)
        # A passive scale is skipped, not returned: a GATT scale later in the
        # same buffer must still get its connect (#422).
        if mac in _scale_macs and mac not in _passive_macs:
            print(f"Auto-connect: found known scale {mac} in raw buffer (addr_type={addr_type})")
            return mac, addr_bytes, addr_type
    return None


async def _gatt_session_guard():
    """End a GATT session the host never finishes, so scanning resumes (#296).

    Gives up when the link is already down, when no host command has arrived for
    GATT_SESSION_IDLE_MS, or when the session outlives GATT_SESSION_MAX_MS. The
    recovery path is the existing unexpected-disconnect handler, reached through
    the same callback the notify loop uses.
    """
    global _gatt_session_task
    started = time.ticks_ms()
    try:
        while _scan_paused:
            await asyncio.sleep_ms(1000)
            # A BLE operation is in flight; it owns the session for now.
            if _busy:
                continue
            if not _scan_paused:
                return
            now = time.ticks_ms()
            reason = None
            if not bridge.is_connected():
                reason = "link is down"
            elif (
                not _host_engaged
                and time.ticks_diff(now, _last_host_activity) > GATT_SESSION_IDLE_MS
            ):
                # Only a session the host never answered. Once it has subscribed
                # and written its handshake it just listens, often for the whole
                # weigh-in, so an idle timeout there would kill working setups.
                reason = f"host never engaged within {GATT_SESSION_IDLE_MS}ms"
            elif time.ticks_diff(now, started) > GATT_SESSION_MAX_MS:
                reason = f"session exceeded {GATT_SESSION_MAX_MS}ms"
            if reason:
                print(f"GATT session guard: {reason}, ending session and resuming scan")
                bridge.notify_disconnected()
                return
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"GATT session guard error: {describe_exc(e)}")
    finally:
        _gatt_session_task = None


def _arm_session_guard():
    """Start the session guard for the session just published to the host."""
    global _gatt_session_task, _gatt_session_armed, _last_host_activity, _host_engaged
    _gatt_session_armed = True
    _host_engaged = False
    _last_host_activity = time.ticks_ms()
    if _gatt_session_task is None:
        _gatt_session_task = asyncio.create_task(_gatt_session_guard())


def _resume_scanning():
    """Leave the GATT session state and restart autonomous scanning.

    Clearing `_scan_paused` without clearing `_gatt_session_armed` would leave
    the scan loops believing a session is live, so these always move together
    (#296).
    """
    global _scan_paused, _gatt_session_armed, _host_engaged
    _scan_paused = False
    _gatt_session_armed = False
    _host_engaged = False
    if board.CONTINUOUS_SCAN:
        bridge.start_streaming()


async def _auto_gatt_connect(mac, addr_type):
    """Autonomously connect to a known scale and publish the connected event.

    This eliminates the MQTT round-trip that previously caused the scale to
    power off before the ESP32 could connect (#201). The host receives the
    same 'connected' payload as with a host-initiated connect, so the adapter
    protocol handshake is unchanged.
    """
    global _char_subscribed, _busy, _scan_paused
    # A host connect waiting for the radio goes first: connecting here would
    # only be torn down by it, leaving the host a session it never hears end.
    # A paused scan means a session (or its connect) already owns the radio.
    if _host_connect_pending or _scan_paused:
        print(f"Auto-connect: skipped for {mac}, a host connect or session owns the radio")
        return
    _scan_paused = True

    if board.CONTINUOUS_SCAN:
        bridge.stop_streaming()
        print(f"Auto-connect: stopped streaming scan for {mac}")

    _busy = True
    try:
        await bridge.disconnect()
        print(f"Auto-connecting to {mac} (addr_type={addr_type})...")
        result = await bridge.connect(mac, addr_type)
        print(f"Auto-connect: BLE connected to {mac}, discovering chars...")

        if not _char_subscribed:
            await client.subscribe(topic("write/#"), 0)
            await client.subscribe(topic("read/#"), 0)
            _char_subscribed = True

        if not _lazy_notify:
            for char_info in result["chars"]:
                if "notify" in char_info["properties"]:
                    uuid_str = char_info["uuid"]
                    await bridge.start_notify(uuid_str, make_publish_fn(uuid_str))
                    print(f"Auto-connect: notify enabled for {uuid_str}")

        bridge.set_on_disconnect(lambda: _pending.append(("__ble_disconnected__", b"")))

        # Mark the response as autonomous so the host can distinguish it
        result["autonomous"] = True
        result["address"] = mac
        await client.publish(topic("connected"), json.dumps(result), qos=0)
        _arm_session_guard()
        print(f"Auto-connect to {mac} succeeded, {len(result['chars'])} chars published to host")
    except Exception as e:
        import sys

        sys.print_exception(e)
        print(f"Auto-connect failed for {mac}: {describe_exc(e)}")
        _resume_scanning()
        if board.CONTINUOUS_SCAN:
            print(f"Auto-connect: resumed streaming scan after failure")
        await publish_error(
            f"Auto-connect failed for {mac}: {describe_exc(e)}", "auto-connect", address=mac
        )
    finally:
        _busy = False


async def _streaming_scan_loop():
    """Continuous indefinite scan with periodic drain+publish (ESP32-S3).

    Nothing restarts this task, so no exception may escape it: one escaping the
    backstop or the auto-connect path used to end scanning for good while the
    status topic still said online. Each cycle runs under its own try.
    """
    # Wait for initial MQTT connection
    while not (client.isconnected() and _subs_ready):
        await asyncio.sleep(1)

    bridge.start_streaming()

    while True:
        try:
            await _streaming_scan_cycle()
        except Exception as e:
            print(f"Streaming scan cycle error: {describe_exc(e)}")
            try:
                await publish_error(f"Scan cycle failed: {describe_exc(e)}", "scan")
            except Exception:
                pass
            await asyncio.sleep(1)


async def _streaming_scan_cycle():
    """One wait, flush and publish cycle of the streaming scan loop."""
    # Wait for MQTT to be connected and subscriptions ready
    while not (client.isconnected() and _subs_ready):
        await asyncio.sleep(1)

    if _scan_paused:
        # Backstop for a paused scan with no guard running: only ever true
        # for a session that was published to the host, so it cannot fire
        # in the window where a connect has paused scanning but not yet
        # taken _busy (#296).
        if _gatt_session_armed and _gatt_session_task is None and not _busy:
            await handle_unexpected_disconnect()
        await asyncio.sleep(1)
        return

    # A start that failed (the controller refused gap_scan) left the bridge
    # not streaming; retry here rather than waiting for the next GATT session.
    if not bridge.is_streaming():
        if not bridge.start_streaming():
            await asyncio.sleep(1)
            return

    # Wait out the publish interval, but flush early the instant a known
    # scale MAC shows up in the scan buffer: a stepped-on scale stays
    # connectable only briefly, so shaving the batching delay matters (#201).
    waited = 0
    while waited < board.PUBLISH_INTERVAL_MS:
        await asyncio.sleep_ms(250)
        waited += 250
        if _scan_paused:
            break
        if _scale_macs and bridge.has_pending_scale_mac(_scale_macs):
            # Autonomous connect: ESP32 connects itself immediately,
            # eliminating the MQTT round-trip (#201).
            if _auto_connect:
                found = _find_scale_in_raw(bridge._raw_results)
                if found:
                    mac, _addr_bytes, addr_type = found
                    print(f"Auto-connect: scale {mac} detected after {waited}ms, connecting immediately")
                    # A stepped-on GATT-only scale stays connectable only
                    # briefly, so reach gap_connect with minimal delay (#231).
                    # Snapshot scan results synchronously before stop_streaming
                    # clears the raw buffer, but defer the awaited MQTT publish
                    # (a WiFi round-trip) until AFTER the connect attempt.
                    try:
                        results = bridge.drain_results()
                        _check_scale_beep(results)
                        board.on_scan_complete(results, bool(_scale_macs))
                    except Exception:
                        results = []
                    await _auto_gatt_connect(mac, addr_type)
                    try:
                        await client.publish(topic("scan/results"), json.dumps(results), qos=0)
                    except Exception:
                        pass
                    break
            # If auto-connect is disabled, just break to flush results
            # as before (host-initiated connect path).
            break

    if _scan_paused:
        return

    try:
        results = bridge.drain_results()
        gc.collect()
        print(f"Streaming scan: {len(results)} devices (free: {gc.mem_free()})")
        if board.HAS_DISPLAY:
            ui.on_scan_tick(len(results))
        _check_scale_beep(results)
        board.on_scan_complete(results, bool(_scale_macs))
        await client.publish(topic("scan/results"), json.dumps(results), qos=0)
        if board.HAS_DISPLAY:
            ui.on_publish_tick()
    except Exception as e:
        try:
            await publish_error(f"Scan publish failed: {describe_exc(e)}", "scan")
        except Exception:
            print(f"Scan error: {e}")


async def _batch_scan_loop():
    """Periodic scan-stop-publish cycle (Atom Echo / shared radio)."""
    global _busy, _subs_ready
    _last_scan_time = 0

    while True:
        # Wait for MQTT to be connected and subscriptions ready
        while not (client.isconnected() and _subs_ready):
            await asyncio.sleep(1)

        # Skip if a GATT connection is active, another BLE op is in progress,
        # or a host connect is waiting for the radio
        if _scan_paused or _busy or _host_connect_pending:
            # Same backstop as the streaming loop (#296).
            if _scan_paused and _gatt_session_armed and _gatt_session_task is None and not _busy:
                # Nothing restarts this task, so the backstop must not let an
                # exception escape it (same reasoning as the streaming loop).
                try:
                    await handle_unexpected_disconnect()
                except Exception as e:
                    print(f"Scan backstop error: {describe_exc(e)}")
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
            _check_scale_beep(results)
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
            # Autonomous connect for batch-mode boards: if a known scale MAC
            # appeared in the scan results, connect immediately (#201).
            if _auto_connect and _scale_macs:
                for r in results:
                    if _auto_connect_allowed(r["address"]):
                        print(f"Auto-connect (batch): scale {r['address']} found in scan results")
                        await _auto_gatt_connect(r["address"], r.get("addr_type", 0))
                        break
        except Exception as e:
            try:
                await publish_error(f"Scan failed: {describe_exc(e)}", "scan")
            except Exception:
                print(f"Scan error: {e}")
        finally:
            # If MQTT survived the (possibly failed) scan, subscriptions are still valid
            if client.isconnected() and not _subs_ready:
                _subs_ready = True
            _last_scan_time = time.ticks_ms()
            _busy = False


async def scan_loop():
    """Entry point — dispatches to streaming or batch scan loop."""
    if board.CONTINUOUS_SCAN:
        await _streaming_scan_loop()
    else:
        await _batch_scan_loop()


# ─── Command handlers ─────────────────────────────────────────────────────────

def make_publish_fn(u):
    """Forward notifications from char `u` to notify/<u> (qos 0), as today."""
    async def publish_fn(_source_uuid, data):
        await client.publish(topic(f"notify/{u}"), data, qos=0)
    return publish_fn


async def handle_subscribe(uuid_str):
    """Enable BLE notify on one characteristic on host command (#231 lazy mode).

    The host publishes subscribe/<uuid> AFTER it has subscribed to the MQTT
    notify/<uuid> topic, so the firmware-triggered kickoff frame (QN 0x12) always
    has a listener. Mirrors native char.subscribe() ordering over the proxy."""
    await bridge.start_notify(uuid_str, make_publish_fn(uuid_str))
    print(f"Subscribe: notify enabled for {uuid_str}")


async def handle_connect(payload):
    """Connect to a BLE device, discover chars, start notify forwarding."""
    global _char_subscribed, _busy, _scan_paused, _host_connect_pending
    started = time.ticks_ms()
    try:
        address = json.loads(payload).get("address")
    except Exception:
        address = None

    # Serialize against an in-flight BLE op. On continuous boards the autonomous
    # connect path (#201) holds _busy while it runs; without this wait a
    # host-initiated fallback connect (#231) re-enters aioble on the same bridge
    # concurrently, which can abort the connect mid-flight. Scanning is NOT
    # paused while waiting: the op holding _busy owns the scan state, and its
    # failure handler resuming the scan would silently undo a pause set here.
    # _host_connect_pending makes the scan loops stand down instead. The wait
    # leaves the connect at least HOST_CONNECT_MIN_MS of the host's budget.
    wait_ms = HOST_CONNECT_BUDGET_MS - HOST_CONNECT_MIN_MS
    _host_connect_pending = True
    try:
        free = await _wait_not_busy(max_iters=max(1, wait_ms // 500))
    finally:
        _host_connect_pending = False
    if not free:
        # Nothing of the busy op's state is touched: it still owns the radio.
        await publish_error("Busy: another BLE operation is in progress", "connect", address)
        return

    # From here until _busy is set there is no await, so no other task can
    # slip in between the wait and taking ownership.
    _scan_paused = True  # Pause autonomous scanning
    if board.CONTINUOUS_SCAN:
        bridge.stop_streaming()

    _busy = True
    try:
        data = json.loads(payload)
        address = data["address"]
        addr_type = data.get("addr_type", 0)  # 0 = public, 1 = random

        # Disconnect any existing connection first. A session the host was
        # told about ends here, so tell it, or it waits for that session's
        # `disconnected` forever (e.g. an autonomous connect that won the
        # race against this command).
        replacing = _gatt_session_armed
        await bridge.disconnect()
        if replacing:
            _char_subscribed = False
            print("Host connect: ending the current GATT session first")
            await client.publish(topic("disconnected"), "", qos=0)

        budget_ms = HOST_CONNECT_BUDGET_MS - time.ticks_diff(time.ticks_ms(), started)
        result = await bridge.connect(address, addr_type, budget_ms=budget_ms)

        if not _char_subscribed:
            await client.subscribe(topic("write/#"), 0)
            await client.subscribe(topic("read/#"), 0)
            _char_subscribed = True

        if not _lazy_notify:
            for char_info in result["chars"]:
                if "notify" in char_info["properties"]:
                    uuid_str = char_info["uuid"]
                    await bridge.start_notify(uuid_str, make_publish_fn(uuid_str))

        bridge.set_on_disconnect(lambda: _pending.append(("__ble_disconnected__", b"")))
        # The address lets the host match this answer to its own command.
        result["address"] = address
        await client.publish(topic("connected"), json.dumps(result), qos=0)
        _arm_session_guard()
    except Exception as e:
        _resume_scanning()  # Resume scanning on connect failure
        raise e
    finally:
        _busy = False


async def handle_disconnect():
    """Disconnect from BLE device and resume autonomous scanning.

    Always answers the host. While it runs, the scan loop backstop and a queued
    unexpected disconnect stand down (see handle_unexpected_disconnect).
    """
    global _char_subscribed, _ending_session
    if _busy:
        # A scan or an autonomous connect owns the radio and has not published
        # a session yet, so there is nothing of the host's to end. Tearing the
        # link down and restarting the scan here used to reinstall the scan IRQ
        # handler in the middle of that connect. Answer and leave it alone.
        print("Host disconnect while a BLE op is in flight: nothing to end")
        await client.publish(topic("disconnected"), "", qos=0)
        return
    _ending_session = True
    try:
        await bridge.disconnect()
        _char_subscribed = False
        _resume_scanning()  # Resume autonomous scanning
        await client.publish(topic("disconnected"), "", qos=0)
    finally:
        _ending_session = False


async def handle_unexpected_disconnect():
    """Handle unexpected BLE peripheral disconnect, notify the host, resume scanning.

    Two producers can report the end of one session: the queued disconnect
    callback (notify loop or session guard) handled by the main loop, and the
    scan loop backstop. The second one, or one arriving after the session was
    already ended, is a no-op, so the host gets one `disconnected` per session.
    """
    global _char_subscribed, _ending_session
    if _ending_session or not _scan_paused:
        return
    _ending_session = True
    try:
        print("BLE peripheral disconnected unexpectedly")
        await bridge.disconnect()
        _char_subscribed = False
        _resume_scanning()
        await client.publish(topic("disconnected"), "", qos=0)
    finally:
        _ending_session = False


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


# ─── Initial connect ──────────────────────────────────────────────────────────

# mqtt_as reconnects on its own only after the first connect has succeeded; a
# failed first connect raises OSError and is never retried by the library. A
# board that boots before the router or broker (power cut, broker started by
# the Node app) would otherwise drop to the REPL and stay offline until reset.
CONNECT_RETRY_START_MS = 5000
CONNECT_RETRY_MAX_MS = 60000
# Safety net for a radio stuck in a bad state: reboot after this many failed
# attempts in a row (with the backoff above, at least about ten minutes).
CONNECT_RESET_AFTER = 15


def _hard_reset():
    import machine

    machine.reset()


async def _connect_with_retry():
    """First MQTT connect with exponential backoff, then a reboot as last resort."""
    delay = CONNECT_RETRY_START_MS
    attempt = 0
    while True:
        attempt += 1
        try:
            await client.connect()
            if attempt > 1:
                print(f"MQTT connected after {attempt} attempts")
            return
        except Exception as e:
            print(f"MQTT connect attempt {attempt} failed: {describe_exc(e)}")
        if attempt >= CONNECT_RESET_AFTER:
            print(f"MQTT unreachable after {attempt} attempts, rebooting")
            _hard_reset()
        # Same clean slate the library's own reconnect loop starts from: close
        # the socket and drop the WiFi association, so the next connect() brings
        # both up again from scratch.
        try:
            client.close()
        except Exception:
            pass
        print(f"Retrying MQTT connect in {delay // 1000}s")
        await asyncio.sleep_ms(delay)
        delay = min(delay * 2, CONNECT_RETRY_MAX_MS)


# ─── Main loop ────────────────────────────────────────────────────────────────

async def main():
    print(f"Board: {board.BOARD_NAME}")
    if board.HAS_DISPLAY:
        ui.init()
        asyncio.create_task(_connection_monitor())
    await _connect_with_retry()
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
                                    "w": board.DISPLAY_WIDTH, "h": board.DISPLAY_HEIGHT, "fmt": "rgb565", "size": total, "chunks": n_chunks
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
                elif t.startswith(topic("subscribe/")):
                    uuid_str = t[len(topic("subscribe/")):]
                    await handle_subscribe(uuid_str)
                elif t.startswith(topic("write/")):
                    uuid_str = t[len(topic("write/")):]
                    await handle_write(uuid_str, msg)
                elif t.startswith(topic("read/")):
                    suffix = t[len(topic("read/")):]
                    if "/response" not in suffix:
                        await handle_read(suffix)
            except Exception as e:
                import sys

                sys.print_exception(e)
                op, address, uuid = _error_context(t, msg)
                await publish_error(describe_exc(e), op, address, uuid)

        await asyncio.sleep_ms(50)
        gc_counter += 1
        if gc_counter >= board.GC_INTERVAL:
            gc.collect()
            gc_counter = 0
        if board.HAS_DISPLAY:
            ui.check_timeout()


if __name__ == "__main__":
    asyncio.run(main())
