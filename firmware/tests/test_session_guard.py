"""Host-runnable tests for the GATT session guard in main.py (#296).

Before this guard, a session the host never engaged with parked the scan loop
until the ESP32 was reset: with lazy notify no notify reader runs, and that
reader was the only producer of the disconnect callback.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
import os
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)

# Stub MicroPython-only modules before importing anything from firmware.
sys.modules.setdefault("aioble", types.ModuleType("aioble"))
if "bluetooth" not in sys.modules:
    _bt = types.ModuleType("bluetooth")
    _bt.BLE = lambda: None
    sys.modules["bluetooth"] = _bt

if "board" not in sys.modules:
    _board = types.ModuleType("board")
    _board.HAS_BEEP = False
    _board.HAS_DISPLAY = False
    _board.CONTINUOUS_SCAN = True
    _board.PUBLISH_INTERVAL_MS = 2000
    _board.SCAN_INTERVAL_MS = 5000
    _board.DEACTIVATE_BLE_AFTER_SCAN = False
    _board.GC_INTERVAL = 100
    _board.MAX_SCAN_ENTRIES = 500
    _board.BOARD_NAME = "test"
    _board.on_scan_complete = lambda *a: None
    sys.modules["board"] = _board

if "mqtt_as" not in sys.modules:
    _mqtt_as = types.ModuleType("mqtt_as")
    _mqtt_as.config = {}

    class _FakeMQTTClient:
        def __init__(self, cfg):
            pass

        async def connect(self):
            raise RuntimeError("test stub: not connecting")

    _mqtt_as.MQTTClient = _FakeMQTTClient
    sys.modules["mqtt_as"] = _mqtt_as

if "ble_bridge" not in sys.modules:
    _ble_bridge = types.ModuleType("ble_bridge")
    _ble_bridge.BleBridge = lambda: types.SimpleNamespace(
        start_streaming=lambda: None,
        stop_streaming=lambda: None,
        has_pending_scale_mac=lambda macs: False,
        drain_results=lambda: [],
        _raw_results=[],
    )
    sys.modules["ble_bridge"] = _ble_bridge

import json  # noqa: E402

_config_path = os.path.join(_FIRMWARE_DIR, "config.json")
_config_existed = os.path.exists(_config_path)
_orig_cwd = os.getcwd()
if not _config_existed:
    with open(_config_path, "w") as f:
        json.dump(
            {
                "topic_prefix": "test",
                "device_id": "test",
                "wifi_ssid": "",
                "wifi_password": "",
                "mqtt_broker": "localhost",
                "mqtt_port": 1883,
            },
            f,
        )

os.chdir(_FIRMWARE_DIR)
try:
    import main  # noqa: E402
finally:
    os.chdir(_orig_cwd)
    if not _config_existed:
        os.remove(_config_path)

if not hasattr(asyncio, "sleep_ms"):
    asyncio.sleep_ms = lambda ms: asyncio.sleep(ms / 1000)

# MicroPython's time.ticks_ms / ticks_diff are not in CPython's time module.
import time as _time  # noqa: E402

if not hasattr(_time, "ticks_ms"):
    _time.ticks_ms = lambda: int(_time.monotonic() * 1000)
    _time.ticks_diff = lambda a, b: a - b


class _FakeBridge:
    def __init__(self, connected=True):
        self.connected = connected
        self.disconnect_calls = 0
        self.fired = 0
        self._cb = None
        self.streaming = False

    def is_connected(self):
        return self.connected

    def set_on_disconnect(self, cb):
        self._cb = cb

    def notify_disconnected(self):
        self.fired += 1
        if self._cb:
            self._cb()

    def start_streaming(self):
        self.streaming = True

    def stop_streaming(self):
        self.streaming = False

    async def disconnect(self):
        self.disconnect_calls += 1
        self.connected = False


class _FakeClient:
    def __init__(self):
        self.published = []

    async def publish(self, topic, payload, qos=0):
        self.published.append((topic, payload))

    def isconnected(self):
        return True

    async def subscribe(self, *a):
        return None


class SessionGuardTest(unittest.TestCase):
    def setUp(self):
        self.bridge = _FakeBridge()
        self.client = _FakeClient()
        self._orig_bridge = main.bridge
        self._orig_client = main.client
        self._orig_idle = main.GATT_SESSION_IDLE_MS
        self._orig_max = main.GATT_SESSION_MAX_MS
        main.bridge = self.bridge
        main.client = self.client
        main._pending = []
        main._scan_paused = True
        main._busy = False
        main._gatt_session_task = None
        main._gatt_session_armed = True
        main._last_host_activity = _time.ticks_ms()

    def tearDown(self):
        main.bridge = self._orig_bridge
        main.client = self._orig_client
        main.GATT_SESSION_IDLE_MS = self._orig_idle
        main.GATT_SESSION_MAX_MS = self._orig_max
        main._scan_paused = False
        main._gatt_session_armed = False
        main._gatt_session_task = None

    def test_guard_ends_the_session_when_the_link_is_already_down(self):
        self.bridge.connected = False
        asyncio.run(main._gatt_session_guard())
        self.assertEqual(self.bridge.fired, 1)
        self.assertEqual(main._gatt_session_task, None)

    def test_guard_ends_the_session_when_the_host_never_engages(self):
        main.GATT_SESSION_IDLE_MS = 0  # any elapsed time counts as idle
        main._host_engaged = False
        asyncio.run(main._gatt_session_guard())
        self.assertEqual(self.bridge.fired, 1)

    def test_guard_never_touches_a_session_the_host_engaged_with(self):
        # The host subscribes and writes its handshake, then listens in silence
        # for the rest of the weigh-in. An idle timeout there would abort every
        # working mqtt-proxy reading that takes longer than the idle window.
        main.GATT_SESSION_IDLE_MS = 0
        main._host_engaged = True

        async def scenario():
            task = asyncio.create_task(main._gatt_session_guard())
            await asyncio.sleep(1.3)
            self.assertEqual(self.bridge.fired, 0)
            task.cancel()

        asyncio.run(scenario())

    def test_a_host_command_marks_the_armed_session_as_engaged(self):
        main._gatt_session_armed = True
        main._host_engaged = False
        main.on_message(main.topic("subscribe/0000fff1").encode(), b"", False)
        self.assertTrue(main._host_engaged)

    def test_a_host_command_outside_a_session_does_not_mark_engagement(self):
        main._gatt_session_armed = False
        main._host_engaged = False
        main.on_message(main.topic("connect").encode(), b"{}", False)
        self.assertFalse(main._host_engaged)

    def test_guard_stays_armed_while_the_host_keeps_sending_commands(self):
        main.GATT_SESSION_IDLE_MS = 3000

        async def scenario():
            task = asyncio.create_task(main._gatt_session_guard())
            for _ in range(3):
                await asyncio.sleep(0.4)
                main._last_host_activity = _time.ticks_ms()
            self.assertEqual(self.bridge.fired, 0)
            main._scan_paused = False
            await asyncio.sleep(1.1)
            task.cancel()

        asyncio.run(scenario())
        self.assertEqual(self.bridge.fired, 0)

    def test_guard_exits_when_the_session_ends_normally(self):
        async def scenario():
            main._scan_paused = False
            await main._gatt_session_guard()

        asyncio.run(scenario())
        self.assertEqual(self.bridge.fired, 0)
        self.assertEqual(main._gatt_session_task, None)

    def test_guard_does_not_act_while_a_ble_operation_is_in_flight(self):
        main._busy = True
        main.GATT_SESSION_IDLE_MS = 0
        self.bridge.connected = False

        async def scenario():
            task = asyncio.create_task(main._gatt_session_guard())
            await asyncio.sleep(1.3)
            self.assertEqual(self.bridge.fired, 0)
            task.cancel()

        asyncio.run(scenario())

    def test_arm_session_guard_starts_one_task_only(self):
        async def scenario():
            main._arm_session_guard()
            first = main._gatt_session_task
            main._arm_session_guard()
            self.assertIs(main._gatt_session_task, first)
            self.assertTrue(main._gatt_session_armed)
            main._gatt_session_task.cancel()

        asyncio.run(scenario())

    def test_unexpected_disconnect_clears_the_armed_flag_and_resumes_scanning(self):
        asyncio.run(main.handle_unexpected_disconnect())
        self.assertFalse(main._gatt_session_armed)
        self.assertFalse(main._scan_paused)
        self.assertTrue(self.bridge.streaming)
        self.assertIn((main.topic("disconnected"), ""), self.client.published)

    def test_host_disconnect_clears_the_armed_flag(self):
        asyncio.run(main.handle_disconnect())
        self.assertFalse(main._gatt_session_armed)
        self.assertFalse(main._scan_paused)

    def test_resume_scanning_clears_scan_paused_and_armed_together(self):
        # A resume path that cleared only _scan_paused left the scan loops
        # believing a session was live: scanning then ran underneath the next
        # GATT session and the backstop published a phantom disconnect.
        main._scan_paused = True
        main._gatt_session_armed = True
        main._host_engaged = True
        main._resume_scanning()
        self.assertFalse(main._scan_paused)
        self.assertFalse(main._gatt_session_armed)
        self.assertFalse(main._host_engaged)
        self.assertTrue(self.bridge.streaming)

    def test_a_failed_host_connect_leaves_no_armed_session(self):
        async def scenario():
            self.bridge.connect = None  # attribute error inside handle_connect
            main._gatt_session_armed = True
            main._scan_paused = True
            try:
                await main.handle_connect(b'{"address": "AA:BB:CC:DD:EE:FF"}')
            except Exception:
                pass

        asyncio.run(scenario())
        self.assertFalse(main._gatt_session_armed)
        self.assertFalse(main._scan_paused)

    def test_a_busy_timeout_leaves_the_busy_owner_alone(self):
        # The op holding _busy (here an autonomous connect mid-discovery) owns
        # the scan state. A host connect that gave up waiting used to resume
        # scanning underneath it, reinstalling the scan IRQ handler in the
        # middle of an aioble connect and disarming the live session.
        async def scenario():
            main._busy = True
            main._gatt_session_armed = True
            main._scan_paused = True
            self.bridge.streaming = False
            await main.handle_connect(b'{"address": "AA:BB:CC:DD:EE:FF"}')

        orig = main._wait_not_busy

        async def never_free(*a, **k):
            return False

        main._wait_not_busy = never_free
        try:
            asyncio.run(scenario())
        finally:
            main._wait_not_busy = orig
            main._busy = False

        self.assertTrue(main._gatt_session_armed)
        self.assertTrue(main._scan_paused)
        self.assertFalse(self.bridge.streaming)
        self.assertFalse(main._host_connect_pending)
        errors = [json.loads(p) for t, p in self.client.published if t == main.topic("error")]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["op"], "connect")
        self.assertEqual(errors[0]["address"], "AA:BB:CC:DD:EE:FF")


class BridgeDisconnectTest(unittest.TestCase):
    """BleBridge.notify_disconnected fires the callback at most once."""

    def test_notify_disconnected_fires_once(self):
        sys.path.insert(0, _FIRMWARE_DIR)
        calls = []

        class _Stub:
            _disconnect_fired = False
            _on_disconnect = None

        from ble_bridge import BleBridge  # noqa: PLC0415

        stub = _Stub()
        stub._on_disconnect = lambda: calls.append(1)
        BleBridge.notify_disconnected(stub)
        BleBridge.notify_disconnected(stub)
        self.assertEqual(len(calls), 1)

    def test_is_connected_is_false_without_a_connection(self):
        from ble_bridge import BleBridge  # noqa: PLC0415

        class _Stub:
            _conn = None

        self.assertFalse(BleBridge.is_connected(_Stub()))


if __name__ == "__main__":
    unittest.main()
