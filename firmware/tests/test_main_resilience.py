"""Host-runnable tests: the firmware must not end up offline or scan-dead.

- The first MQTT connect is retried with backoff (mqtt_as only reconnects after
  a first success), with a reboot as a last resort, instead of dropping to the
  REPL when the board boots before the broker.
- BleBridge.start_streaming() is idempotent and never raises: NimBLE rejects a
  second gap_scan with EALREADY (EBUSY during a connect) as OSError.
- No exception escapes the streaming scan task, since nothing restarts it.
- Two producers ending the same GATT session publish one `disconnected`.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
import importlib.util
import json
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
    _ble_bridge_stub = types.ModuleType("ble_bridge")
    _ble_bridge_stub.BleBridge = lambda: types.SimpleNamespace(
        start_streaming=lambda: None,
        stop_streaming=lambda: None,
        has_pending_scale_mac=lambda macs: False,
        drain_results=lambda: [],
        _raw_results=[],
    )
    sys.modules["ble_bridge"] = _ble_bridge_stub

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

import time as _time  # noqa: E402

if not hasattr(_time, "ticks_ms"):
    _time.ticks_ms = lambda: int(_time.monotonic() * 1000)
    _time.ticks_diff = lambda a, b: a - b

# The real firmware ble_bridge, loaded under its own name: another test module
# may have cached a stub under "ble_bridge".
_spec = importlib.util.spec_from_file_location(
    "ble_bridge_resilience_under_test", os.path.join(_FIRMWARE_DIR, "ble_bridge.py")
)
real_ble_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(real_ble_bridge)

_real_sleep = asyncio.sleep


def _fast_asyncio():
    """asyncio stand-in for main whose sleeps only yield, so loops run fast."""
    fake = types.SimpleNamespace(**{k: getattr(asyncio, k) for k in dir(asyncio) if not k.startswith("__")})

    async def _yield(_t=0):
        await _real_sleep(0)

    fake.sleep = _yield
    fake.sleep_ms = _yield
    return fake


class _NimbleLikeBLE:
    """Models the NimBLE rule the firmware hits: gap_scan while a scan runs
    raises OSError (EALREADY), as MicroPython maps BLE_HS_EALREADY."""

    def __init__(self, fail_starts=0):
        self.scanning = False
        self.starts = 0
        self.fail_starts = fail_starts

    def active(self, *a):
        return True

    def irq(self, handler):
        self.handler = handler

    def gap_scan(self, duration, *a):
        if duration is None:
            self.scanning = False
            return
        if self.fail_starts:
            self.fail_starts -= 1
            raise OSError(16)  # EBUSY
        if self.scanning:
            raise OSError(114)  # EALREADY
        self.scanning = True
        self.starts += 1


class StartStreamingTest(unittest.TestCase):
    def setUp(self):
        self._orig_ble = real_ble_bridge._ble
        self.ble = _NimbleLikeBLE()
        real_ble_bridge._ble = self.ble

    def tearDown(self):
        real_ble_bridge._ble = self._orig_ble

    def test_second_start_is_a_no_op(self):
        bridge = real_ble_bridge.BleBridge()
        bridge.start_streaming()
        bridge.start_streaming()  # used to raise OSError(EALREADY)
        self.assertEqual(self.ble.starts, 1)
        self.assertTrue(bridge.is_streaming())

    def test_start_after_stop_starts_again(self):
        bridge = real_ble_bridge.BleBridge()
        bridge.start_streaming()
        bridge.stop_streaming()
        bridge.start_streaming()
        self.assertEqual(self.ble.starts, 2)
        self.assertTrue(self.ble.scanning)

    def test_refused_start_does_not_raise_and_can_be_retried(self):
        self.ble.fail_starts = 1
        bridge = real_ble_bridge.BleBridge()
        self.assertFalse(bridge.start_streaming())
        self.assertFalse(bridge.is_streaming())
        self.assertTrue(bridge.start_streaming())
        self.assertTrue(bridge.is_streaming())
        self.assertEqual(self.ble.starts, 1)


class _ScriptedClient:
    def __init__(self, failures):
        self.failures = failures
        self.connect_calls = 0
        self.close_calls = 0
        self.published = []

    async def connect(self):
        self.connect_calls += 1
        if self.failures is None or self.connect_calls <= self.failures:
            raise OSError("Wi-Fi connect timed out")

    def close(self):
        self.close_calls += 1

    def isconnected(self):
        return True

    async def publish(self, topic, payload, qos=0, retain=False):
        self.published.append((topic, payload))

    async def subscribe(self, *a):
        return None


class _Reset(Exception):
    pass


class _MainPatch:
    """Swap main's globals for a test and put them back afterwards."""

    def __init__(self, test, **values):
        self.test = test
        self.values = values

    _MISSING = object()

    def __enter__(self):
        # A name main does not define yet is still set, so a test pins the
        # behavior (not the attribute) when run against older firmware.
        self.saved = {k: getattr(main, k, self._MISSING) for k in self.values}
        for k, v in self.values.items():
            setattr(main, k, v)
        return self

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            if v is self._MISSING:
                delattr(main, k)
            else:
                setattr(main, k, v)
        return False


class InitialConnectRetryTest(unittest.TestCase):
    def setUp(self):
        for name, value in (("HAS_DISPLAY", False), ("GC_INTERVAL", 100), ("BOARD_NAME", "test")):
            if not hasattr(main.board, name):
                setattr(main.board, name, value)

    def _run_main(self, client, timeout=0.5, reset=None):
        async def _no_scan_loop():
            return None

        values = dict(
            client=client,
            scan_loop=_no_scan_loop,
            asyncio=_fast_asyncio(),
            CONNECT_RETRY_START_MS=1,
            CONNECT_RETRY_MAX_MS=4,
        )
        if reset is not None:
            values["_hard_reset"] = reset
            values["CONNECT_RESET_AFTER"] = 3
        with _MainPatch(self, **values):
            asyncio.run(asyncio.wait_for(main.main(), timeout))

    def test_first_connect_failure_is_retried_instead_of_crashing(self):
        client = _ScriptedClient(failures=2)
        # main() runs forever once connected, so a timeout means it survived.
        with self.assertRaises(asyncio.TimeoutError):
            self._run_main(client)
        self.assertEqual(client.connect_calls, 3)
        self.assertEqual(client.close_calls, 2)

    def test_board_reboots_after_repeated_failures(self):
        client = _ScriptedClient(failures=None)

        def reset():
            raise _Reset()

        with self.assertRaises(_Reset):
            self._run_main(client, reset=reset)
        self.assertEqual(client.connect_calls, 3)


class _SlowBridge:
    """Bridge double whose disconnect yields, so two handlers can interleave."""

    def __init__(self):
        self.streaming = False
        self.start_calls = 0
        self.fail_starts = 0
        self.drains = 0

    async def disconnect(self):
        await _real_sleep(0.01)

    def start_streaming(self):
        self.start_calls += 1
        if self.fail_starts:
            self.fail_starts -= 1
            return False
        self.streaming = True
        return True

    def stop_streaming(self):
        self.streaming = False

    def is_streaming(self):
        return self.streaming

    def has_pending_scale_mac(self, macs):
        return False

    def drain_results(self):
        self.drains += 1
        return []

    def is_connected(self):
        return False


class SessionEndTest(unittest.TestCase):
    def setUp(self):
        self.bridge = _SlowBridge()
        self.client = _ScriptedClient(failures=0)
        self.patch = _MainPatch(self, bridge=self.bridge, client=self.client)
        self.patch.__enter__()
        main._scan_paused = True
        main._gatt_session_armed = True
        main._gatt_session_task = None
        main._busy = False
        main._ending_session = False
        self._orig_continuous = main.board.CONTINUOUS_SCAN
        main.board.CONTINUOUS_SCAN = True

    def tearDown(self):
        self.patch.__exit__()
        main.board.CONTINUOUS_SCAN = self._orig_continuous
        main._scan_paused = False
        main._gatt_session_armed = False
        main._gatt_session_task = None
        main._ending_session = False

    def _disconnected_count(self):
        return sum(1 for t, _p in self.client.published if t == main.topic("disconnected"))

    def test_concurrent_unexpected_disconnects_end_the_session_once(self):
        # The main loop handling a queued disconnect and the scan loop backstop
        # can both run handle_unexpected_disconnect for the same session.
        async def scenario():
            await asyncio.gather(
                main.handle_unexpected_disconnect(), main.handle_unexpected_disconnect()
            )

        asyncio.run(scenario())
        self.assertEqual(self._disconnected_count(), 1)
        self.assertEqual(self.bridge.start_calls, 1)
        self.assertFalse(main._scan_paused)

    def test_queued_disconnect_after_host_disconnect_is_dropped(self):
        # Scale drops the link after its last frame and the host sends
        # disconnect: the stale queued event must not resume a second time.
        async def scenario():
            await main.handle_disconnect()
            await main.handle_unexpected_disconnect()

        asyncio.run(scenario())
        self.assertEqual(self._disconnected_count(), 1)
        self.assertEqual(self.bridge.start_calls, 1)

    def test_unexpected_disconnect_of_a_live_session_still_ends_it(self):
        asyncio.run(main.handle_unexpected_disconnect())
        self.assertEqual(self._disconnected_count(), 1)
        self.assertFalse(main._scan_paused)
        self.assertFalse(main._gatt_session_armed)
        self.assertTrue(self.bridge.streaming)


class StreamingLoopSurvivesErrorsTest(unittest.TestCase):
    def setUp(self):
        self.bridge = _SlowBridge()
        self.bridge.streaming = True
        self.client = _ScriptedClient(failures=0)
        self._orig_interval = getattr(main.board, "PUBLISH_INTERVAL_MS", None)
        main.board.PUBLISH_INTERVAL_MS = 250
        main._subs_ready = True
        main._scan_paused = True
        main._gatt_session_armed = True
        main._gatt_session_task = None
        main._busy = False
        main._ending_session = False

    def tearDown(self):
        main.board.PUBLISH_INTERVAL_MS = self._orig_interval
        main._subs_ready = False
        main._scan_paused = False
        main._gatt_session_armed = False
        main._ending_session = False

    def test_backstop_exception_does_not_kill_the_scan_task(self):
        calls = []

        async def failing_backstop():
            calls.append(1)
            if len(calls) == 1:
                raise OSError(114)
            main._scan_paused = False
            main._gatt_session_armed = False

        with _MainPatch(
            self,
            bridge=self.bridge,
            client=self.client,
            asyncio=_fast_asyncio(),
            handle_unexpected_disconnect=failing_backstop,
        ):
            # The loop never returns; a timeout means it is still alive. Before
            # the fix the OSError escaped and ended the task.
            with self.assertRaises(asyncio.TimeoutError):
                asyncio.run(asyncio.wait_for(main._streaming_scan_loop(), 0.3))

        self.assertEqual(len(calls), 2)
        self.assertGreater(self.bridge.drains, 0, "scanning never resumed after the error")

    def test_loop_restarts_a_scan_that_failed_to_start(self):
        main._scan_paused = False
        main._gatt_session_armed = False
        self.bridge.streaming = False
        self.bridge.fail_starts = 1  # the loop's own first start is refused

        with _MainPatch(self, bridge=self.bridge, client=self.client, asyncio=_fast_asyncio()):
            with self.assertRaises(asyncio.TimeoutError):
                asyncio.run(asyncio.wait_for(main._streaming_scan_loop(), 0.2))

        self.assertTrue(self.bridge.streaming)
        self.assertGreater(self.bridge.drains, 0)


if __name__ == "__main__":
    unittest.main()
