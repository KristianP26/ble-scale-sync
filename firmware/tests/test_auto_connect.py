"""Host-runnable tests for the autonomous GATT connect helpers in main.py.

The _find_scale_in_raw function lives in main.py and uses the _scale_macs
global. Because main.py has heavy import-time side effects (MQTT, WiFi,
config.json), we test the logic by extracting and exercising the function
directly from module globals.

Run: python -m unittest discover -s firmware/tests
"""

import os
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)

# Stub MicroPython-only modules before importing anything from firmware.
sys.modules["aioble"] = types.ModuleType("aioble")
_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: None
sys.modules["bluetooth"] = _bt

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

# Stub mqtt_as — main.py creates an MQTTClient at import time
_mqtt_as = types.ModuleType("mqtt_as")
_mqtt_as.config = {}


class _FakeMQTTClient:
    def __init__(self, cfg):
        pass

    async def connect(self):
        raise RuntimeError("test stub: not connecting")


_mqtt_as.MQTTClient = _FakeMQTTClient
sys.modules["mqtt_as"] = _mqtt_as

# Stub ble_bridge — main.py creates a BleBridge at import time
_ble_bridge = types.ModuleType("ble_bridge")
_ble_bridge.BleBridge = lambda: types.SimpleNamespace(
    start_streaming=lambda: None,
    stop_streaming=lambda: None,
    has_pending_scale_mac=lambda macs: False,
    drain_results=lambda: [],
    _raw_results=[],
)
sys.modules["ble_bridge"] = _ble_bridge

# Write a minimal config.json for main.py import
import json
import tempfile

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

# main.py opens config.json relative to CWD
os.chdir(_FIRMWARE_DIR)
try:
    import main  # noqa: E402
finally:
    os.chdir(_orig_cwd)
    if not _config_existed:
        os.remove(_config_path)

# main._wait_not_busy awaits asyncio.sleep_ms, which only exists in MicroPython.
import asyncio as _asyncio

if not hasattr(_asyncio, "sleep_ms"):
    _asyncio.sleep_ms = lambda ms: _asyncio.sleep(ms / 1000)


# ─── helpers ─────────────────────────────────────────────────────────────────

_MAC_BYTES = b"\xFF\x03\x00\x53\xD6\x4D"
_MAC_STR = "FF:03:00:53:D6:4D"

_OTHER_MAC_BYTES = b"\xAA\xBB\xCC\xDD\xEE\xFF"
_OTHER_MAC_STR = "AA:BB:CC:DD:EE:FF"

_PUBLIC_MAC_BYTES = b"\x84\xFC\xE6\x53\x06\x1C"
_PUBLIC_MAC_STR = "84:FC:E6:53:06:1C"


def _raw_entry(addr_bytes, addr_type=0, rssi=-50, adv_data=b""):
    """Create a raw IRQ buffer tuple."""
    return (addr_bytes, addr_type, rssi, adv_data)


class TestFindScaleInRaw(unittest.TestCase):
    """_find_scale_in_raw: find first known scale MAC in raw buffer."""

    def setUp(self):
        # Set known scale MACs
        main._scale_macs = {_MAC_STR}

    def tearDown(self):
        main._scale_macs = set()

    def test_empty_buffer(self):
        self.assertIsNone(main._find_scale_in_raw([]))

    def test_no_known_mac(self):
        raw = [_raw_entry(_OTHER_MAC_BYTES)]
        self.assertIsNone(main._find_scale_in_raw(raw))

    def test_known_mac_found(self):
        raw = [_raw_entry(_OTHER_MAC_BYTES), _raw_entry(_MAC_BYTES, addr_type=1)]
        result = main._find_scale_in_raw(raw)
        self.assertIsNotNone(result)
        mac, addr_bytes, addr_type = result
        self.assertEqual(mac, _MAC_STR)
        self.assertEqual(addr_bytes, _MAC_BYTES)
        self.assertEqual(addr_type, 1)

    def test_returns_first_match(self):
        # Both entries are the same FF MAC. The first match is returned, and its
        # controller-reported addr_type is passed through unchanged (#231).
        raw = [_raw_entry(_MAC_BYTES, addr_type=0), _raw_entry(_MAC_BYTES, addr_type=1)]
        result = main._find_scale_in_raw(raw)
        self.assertIsNotNone(result)
        self.assertEqual(result[0], _MAC_STR)
        self.assertEqual(result[1], _MAC_BYTES)
        self.assertEqual(result[2], 0)  # reported type trusted, no override

    def test_empty_scale_macs(self):
        main._scale_macs = set()
        raw = [_raw_entry(_MAC_BYTES)]
        self.assertIsNone(main._find_scale_in_raw(raw))


class TestFindScaleTrustsScanAddrType(unittest.TestCase):
    """_find_scale_in_raw passes the controller-reported addr_type through
    unchanged. The FF scale advertises as public and must connect as public; the
    earlier random-forcing override was the #231 bug."""

    def setUp(self):
        main._scale_macs = {_MAC_STR, _PUBLIC_MAC_STR}

    def tearDown(self):
        main._scale_macs = set()

    def test_ff_mac_reported_public_stays_public(self):
        # FF starts with 0xFF, but the controller reports it public (TxAdd=0) and
        # the host-initiated path connects it as public successfully, so the
        # reported type must win. Forcing random here was the bug (#231).
        raw = [_raw_entry(_MAC_BYTES, addr_type=0)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 0)

    def test_ff_mac_reported_random_stays_random(self):
        raw = [_raw_entry(_MAC_BYTES, addr_type=1)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 1)

    def test_public_oui_mac_reported_public_stays_public(self):
        raw = [_raw_entry(_PUBLIC_MAC_BYTES, addr_type=0)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 0)

    def test_public_oui_mac_reported_random_stays_random(self):
        raw = [_raw_entry(_PUBLIC_MAC_BYTES, addr_type=1)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 1)


class TestAutoConnectConfig(unittest.TestCase):
    """_auto_connect flag parsing from config topic."""

    def test_default_is_true(self):
        # Reset to default
        main._auto_connect = True
        self.assertTrue(main._auto_connect)

    def test_opt_out_sets_false(self):
        main._auto_connect = True
        # Simulate config message
        main._auto_connect = False  # as on_message would set it
        self.assertFalse(main._auto_connect)

    def test_missing_field_defaults_true(self):
        # data.get("autoConnect", True) should default to True
        data = {"scales": ["AA:BB:CC:DD:EE:FF"]}
        main._auto_connect = data.get("autoConnect", True)
        self.assertTrue(main._auto_connect)

    def test_explicit_true(self):
        data = {"scales": [], "autoConnect": True}
        main._auto_connect = data.get("autoConnect", True)
        self.assertTrue(main._auto_connect)

    def test_explicit_false(self):
        data = {"scales": [], "autoConnect": False}
        main._auto_connect = data.get("autoConnect", True)
        self.assertFalse(main._auto_connect)


class TestLazyNotifyConfig(unittest.TestCase):
    """_lazy_notify capability flag parsing from the config topic (#231).

    The host advertises lazy_notify so the firmware enables BLE notify only on a
    per-char subscribe command (host-ordered). Absent flag = eager (old host)."""

    def setUp(self):
        self._orig_lazy = main._lazy_notify
        self._orig_scale_macs = set(main._scale_macs)
        self._orig_auto_connect = main._auto_connect

    def tearDown(self):
        main._lazy_notify = self._orig_lazy
        main._scale_macs = self._orig_scale_macs
        main._auto_connect = self._orig_auto_connect

    def test_default_is_false(self):
        main._lazy_notify = False
        self.assertFalse(main._lazy_notify)

    def test_missing_field_defaults_false(self):
        data = {"scales": ["AA:BB:CC:DD:EE:FF"]}
        main._lazy_notify = data.get("lazy_notify", False)
        self.assertFalse(main._lazy_notify)

    def test_explicit_true(self):
        data = {"scales": [], "lazy_notify": True}
        main._lazy_notify = data.get("lazy_notify", False)
        self.assertTrue(main._lazy_notify)

    def test_explicit_false(self):
        data = {"scales": [], "lazy_notify": False}
        main._lazy_notify = data.get("lazy_notify", False)
        self.assertFalse(main._lazy_notify)

    def test_global_exists_with_default(self):
        # The module must define _lazy_notify at import time so on_message can
        # assign it and the connect handlers can read it.
        self.assertTrue(hasattr(main, "_lazy_notify"))

    def test_on_message_parses_lazy_notify_true(self):
        # Drive the REAL production parse path: on_message must read lazy_notify
        # off the config topic and set the global. This pins the actual wire to
        # global assignment so a regression that deletes the parse line in
        # on_message is caught here, not only by the behavioral enable tests.
        main._lazy_notify = False
        payload = json.dumps({"scales": [], "lazy_notify": True})
        main.on_message(main.topic("config"), payload, False)
        self.assertTrue(main._lazy_notify)

    def test_on_message_defaults_lazy_notify_false_when_absent(self):
        # Old host sends no flag; on_message must default the global to False.
        main._lazy_notify = True
        payload = json.dumps({"scales": ["AA:BB:CC:DD:EE:FF"]})
        main.on_message(main.topic("config"), payload, False)
        self.assertFalse(main._lazy_notify)

    def test_on_message_parses_lazy_notify_false_explicit(self):
        main._lazy_notify = True
        payload = json.dumps({"scales": [], "lazy_notify": False})
        main.on_message(main.topic("config"), payload, False)
        self.assertFalse(main._lazy_notify)


class _RecordingBridge:
    """Minimal bridge double that records start_notify(uuid, fn) calls so a test
    can assert whether the connect handlers enabled notify eagerly or not (#231).
    Models just the surface main.handle_connect / _auto_gatt_connect touch."""

    def __init__(self):
        self.started = []  # list of uuid_str passed to start_notify

    def stop_streaming(self):
        pass

    def start_streaming(self):
        pass

    async def disconnect(self):
        pass

    async def connect(self, address, addr_type=0):
        return {
            "chars": [
                {"uuid": "0000fff100001000800000805f9b34fb", "properties": ["notify"]},
                {"uuid": "0000fff200001000800000805f9b34fb", "properties": ["write"]},
            ]
        }

    async def start_notify(self, uuid_str, publish_fn):
        self.started.append(uuid_str)

    def set_on_disconnect(self, cb):
        pass


class _NoopClient:
    """Async client double: subscribe/publish record their topics (and otherwise
    no-op) so the connect handlers can run on a host without a broker AND a test
    can assert which topics were subscribed/published (#231)."""

    def __init__(self):
        self.subscribed = []  # list of subscribed topics
        self.published = []  # list of published topics

    async def subscribe(self, topic, qos=0):
        self.subscribed.append(topic)

    async def publish(self, topic, payload, qos=0, retain=False):
        self.published.append(topic)

    def isconnected(self):
        return True


class TestLazyNotifyEnable(unittest.IsolatedAsyncioTestCase):
    """handle_connect / _auto_gatt_connect must NOT eager-enable notify when
    _lazy_notify is set, and handle_subscribe must enable a single char on
    demand. The eager (old-host) path must still enable on connect (#231)."""

    def setUp(self):
        self._orig_bridge = main.bridge
        self._orig_client = main.client
        self._orig_lazy = main._lazy_notify
        self._orig_char_sub = main._char_subscribed
        self._orig_continuous = main.board.CONTINUOUS_SCAN
        main.bridge = _RecordingBridge()
        main.client = _NoopClient()
        main._char_subscribed = True  # skip the write/read wildcard subscribe path
        main.board.CONTINUOUS_SCAN = False

    def tearDown(self):
        main.bridge = self._orig_bridge
        main.client = self._orig_client
        main._lazy_notify = self._orig_lazy
        main._char_subscribed = self._orig_char_sub
        main.board.CONTINUOUS_SCAN = self._orig_continuous
        main._busy = False
        main._scan_paused = False

    async def test_handle_connect_eager_when_flag_absent(self):
        main._lazy_notify = False
        import json as _json
        await main.handle_connect(_json.dumps({"address": "84:FC:E6:53:06:1C", "addr_type": 0}))
        # Old-host behavior: notify enabled eagerly for the one notify char.
        self.assertEqual(main.bridge.started, ["0000fff100001000800000805f9b34fb"])

    async def test_handle_connect_does_not_eager_enable_when_lazy(self):
        main._lazy_notify = True
        import json as _json
        await main.handle_connect(_json.dumps({"address": "84:FC:E6:53:06:1C", "addr_type": 0}))
        # Lazy: connect publishes chars but enables NO notify until a subscribe cmd.
        self.assertEqual(main.bridge.started, [])

    async def test_auto_connect_does_not_eager_enable_when_lazy(self):
        main._lazy_notify = True
        await main._auto_gatt_connect("84:FC:E6:53:06:1C", 0)
        self.assertEqual(main.bridge.started, [])

    async def test_handle_subscribe_enables_named_char(self):
        main._lazy_notify = True
        # Connect first so bridge has chars (the recording bridge ignores them,
        # but this mirrors the real ordering).
        await main._auto_gatt_connect("84:FC:E6:53:06:1C", 0)
        self.assertEqual(main.bridge.started, [])
        await main.handle_subscribe("0000fff100001000800000805f9b34fb")
        self.assertEqual(main.bridge.started, ["0000fff100001000800000805f9b34fb"])

    async def test_lazy_connect_still_publishes_connected(self):
        # The fix only DEFERS notify; the connect publish (chars -> host) must be
        # unchanged in lazy mode. Pin it so a regression that drops the connected
        # publish when lazy is caught by the firmware suite (#231).
        main._lazy_notify = True
        await main._auto_gatt_connect("84:FC:E6:53:06:1C", 0)
        self.assertEqual(main.bridge.started, [])  # notify deferred
        self.assertIn(main.topic("connected"), main.client.published)

    async def test_on_connect_subscribes_subscribe_wildcard(self):
        # on_connect must subscribe the per-char notify-enable wildcard so the
        # firmware is ready for subscribe/<uuid> after a connect (#231). With a
        # char already subscribed, write/# and read/# are also (re)subscribed.
        await main.on_connect(main.client)
        self.assertIn(main.topic("subscribe/#"), main.client.subscribed)


class TestWaitNotBusy(unittest.IsolatedAsyncioTestCase):
    """_wait_not_busy: serialize host connect against an in-flight BLE op (#231)."""

    async def test_returns_true_when_free(self):
        main._busy = False
        self.assertTrue(await main._wait_not_busy(max_iters=3, sleep_ms=1))

    async def test_returns_false_when_stays_busy(self):
        main._busy = True
        try:
            self.assertFalse(await main._wait_not_busy(max_iters=2, sleep_ms=1))
        finally:
            main._busy = False

    async def test_returns_true_when_busy_clears(self):
        main._busy = True

        async def _clear():
            await _asyncio.sleep(0.002)
            main._busy = False

        task = _asyncio.ensure_future(_clear())
        try:
            self.assertTrue(await main._wait_not_busy(max_iters=50, sleep_ms=1))
        finally:
            main._busy = False
            await task


class TestPassiveScales(unittest.TestCase):
    """Advertisement-read scales from config.passive are never auto-connected (#422)."""

    def setUp(self):
        self._orig = (
            set(main._scale_macs),
            set(main._passive_macs),
            main._auto_connect,
            main._lazy_notify,
        )

    def tearDown(self):
        main._scale_macs, main._passive_macs, main._auto_connect, main._lazy_notify = self._orig

    def _config(self, data):
        main.on_message(main.topic("config"), json.dumps(data).encode(), False)

    def test_on_message_parses_passive(self):
        self._config({"scales": [_MAC_STR, _OTHER_MAC_STR], "passive": [_MAC_STR]})
        self.assertEqual(main._passive_macs, {_MAC_STR})

    def test_on_message_defaults_passive_empty_when_absent(self):
        # Old host: no key, so a previously learned set must not survive.
        main._passive_macs = {_MAC_STR}
        self._config({"scales": [_MAC_STR]})
        self.assertEqual(main._passive_macs, set())

    def test_on_message_ignores_a_non_list_passive(self):
        self._config({"scales": [_MAC_STR], "passive": _MAC_STR})
        self.assertEqual(main._passive_macs, set())

    def test_find_scale_skips_passive_and_returns_the_gatt_scale(self):
        self._config({"scales": [_MAC_STR, _OTHER_MAC_STR], "passive": [_MAC_STR]})
        raw = [_raw_entry(_MAC_BYTES), _raw_entry(_OTHER_MAC_BYTES, addr_type=0)]
        result = main._find_scale_in_raw(raw)
        self.assertIsNotNone(result)
        self.assertEqual(result[0], _OTHER_MAC_STR)

    def test_find_scale_returns_none_when_only_passive_present(self):
        self._config({"scales": [_MAC_STR], "passive": [_MAC_STR]})
        self.assertIsNone(main._find_scale_in_raw([_raw_entry(_MAC_BYTES)]))

    def test_auto_connect_allowed(self):
        self._config({"scales": [_MAC_STR, _OTHER_MAC_STR], "passive": [_MAC_STR]})
        self.assertFalse(main._auto_connect_allowed(_MAC_STR))
        self.assertTrue(main._auto_connect_allowed(_OTHER_MAC_STR))
        self.assertFalse(main._auto_connect_allowed(_PUBLIC_MAC_STR))
        self._config(
            {"scales": [_MAC_STR, _OTHER_MAC_STR], "passive": [_MAC_STR], "autoConnect": False}
        )
        self.assertFalse(main._auto_connect_allowed(_OTHER_MAC_STR))

    def test_passive_scale_still_beeps(self):
        # _check_scale_beep keys on _scale_macs only, so a passive scale keeps
        # its instant beep.
        self._config({"scales": [_MAC_STR], "passive": [_MAC_STR]})
        orig_time, orig_beep = main.time, main._last_beep_time
        # MicroPython's tick helpers, stubbed on a stand-in so the real time
        # module is left untouched.
        main.time = types.SimpleNamespace(ticks_ms=lambda: 10**9, ticks_diff=lambda a, b: a - b)
        main._last_beep_time = 0
        try:
            main._check_scale_beep([{"address": _MAC_STR}])
            self.assertEqual(main._last_beep_time, 10**9)
        finally:
            main.time, main._last_beep_time = orig_time, orig_beep


if __name__ == "__main__":
    unittest.main()
