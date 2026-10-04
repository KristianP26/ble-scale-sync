"""Host-runnable tests: who owns the radio, and when the host gets its answer.

1. Scan state ownership. The autonomous connect (scan task) and the host
   `connect` command (main task) shared `_scan_paused`/`_busy`, and each
   resumed scanning on failure even when the other one had paused it. A host
   connect that waited for an autonomous connect then ran with scanning
   resumed underneath it, a busy timeout restarted the scan IRQ handler in the
   middle of an aioble connect, and a batch board auto-connected while a host
   connect waited, which the host connect then tore down without telling the
   host.
2. Time budget. A host connect could take the 30 s busy wait plus two
   address-type probes plus discovery on the firmware, while the host gives up
   after 30 s (COMMAND_TIMEOUT_MS) and sends `disconnect`.
3. Error correlation. The `error` topic carried a bare string, so the host
   could not tell a failed read from a failed scan from its own connect.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
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

# Another module (test_connect_irq) may have cached a partial board stub that
# main.py cannot import with, so main is imported under a complete one.
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

_ble_bridge = types.ModuleType("ble_bridge")
_ble_bridge.BleBridge = lambda: types.SimpleNamespace()

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

_saved_modules = {name: sys.modules.get(name) for name in ("board", "ble_bridge")}
if "main" not in sys.modules:
    sys.modules["board"] = _board
    sys.modules["ble_bridge"] = _ble_bridge
os.chdir(_FIRMWARE_DIR)
try:
    import main  # noqa: E402
finally:
    os.chdir(_orig_cwd)
    for _name, _mod in _saved_modules.items():
        if _mod is None:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _mod
    if not _config_existed:
        os.remove(_config_path)

if not hasattr(asyncio, "sleep_ms"):
    asyncio.sleep_ms = lambda ms: asyncio.sleep(ms / 1000)

import time as _time  # noqa: E402

if not hasattr(_time, "ticks_ms"):
    _time.ticks_ms = lambda: int(_time.monotonic() * 1000)
    _time.ticks_diff = lambda a, b: a - b

# MicroPython-only; the firmware's error handlers call it.
if not hasattr(sys, "print_exception"):
    sys.print_exception = lambda e: None

SCALE = "AA:AA:AA:AA:AA:01"
HOST_TARGET = "BB:BB:BB:BB:BB:02"


class _Bridge:
    """Bridge double. connect() to SCALE blocks on `gate` and then fails or
    succeeds as configured; any other address connects at once."""

    def __init__(self):
        self.gate = asyncio.Event()
        self.scale_fails = True
        self.streaming = False
        self.stream_starts = 0
        self.connects = []
        self.budgets = []
        self.disconnects = 0
        self.connected = False

    def start_streaming(self):
        self.streaming = True
        self.stream_starts += 1

    def stop_streaming(self):
        self.streaming = False

    def is_streaming(self):
        return self.streaming

    def is_connected(self):
        return self.connected

    def set_on_disconnect(self, cb):
        pass

    def notify_disconnected(self):
        pass

    async def start_notify(self, uuid_str, fn):
        pass

    async def disconnect(self):
        self.disconnects += 1
        self.connected = False

    async def connect(self, address, addr_type=0, budget_ms=None):
        self.connects.append(address)
        self.budgets.append(budget_ms)
        if address == SCALE:
            await self.gate.wait()
            if self.scale_fails:
                raise OSError("scale went away")
        self.connected = True
        return {"chars": []}

    async def read(self, uuid_str):
        raise OSError("read timed out")


class _Client:
    def __init__(self):
        self.published = []

    async def publish(self, t, payload, qos=0, retain=False):
        self.published.append((t, payload))

    async def subscribe(self, *a):
        return None

    def isconnected(self):
        return True

    def topics(self):
        return [t for t, _ in self.published]


class _Base(unittest.TestCase):
    def setUp(self):
        self.saved = {
            name: getattr(main, name)
            for name in (
                "bridge",
                "client",
                "_wait_not_busy",
                "asyncio",
                "time",
                "scan_loop",
                "_connect_with_retry",
            )
        }
        self.saved_continuous = main.board.CONTINUOUS_SCAN
        self.client = _Client()
        main.client = self.client
        main._pending = []
        main._busy = False
        main._scan_paused = False
        main._gatt_session_armed = False
        main._gatt_session_task = None
        main._host_engaged = False
        main._ending_session = False
        main._char_subscribed = True
        main._lazy_notify = True
        main._host_connect_pending = False

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(main, name, value)
        main.board.CONTINUOUS_SCAN = self.saved_continuous
        main._busy = False
        main._scan_paused = False
        main._gatt_session_armed = False
        main._gatt_session_task = None
        main._host_connect_pending = False

    @staticmethod
    async def _cancel_guard():
        task = main._gatt_session_task
        if task is not None:
            task.cancel()
            try:
                await task
            except BaseException:
                pass


class ScanOwnershipTest(_Base):
    def test_failed_autonomous_connect_does_not_unpause_a_waiting_host_connect(self):
        bridge = _Bridge()
        main.bridge = bridge

        async def scenario():
            auto = asyncio.create_task(main._auto_gatt_connect(SCALE, 0))
            await asyncio.sleep(0.01)  # the autonomous connect holds _busy
            host = asyncio.create_task(
                main.handle_connect(json.dumps({"address": HOST_TARGET}).encode())
            )
            await asyncio.sleep(0.01)
            bridge.gate.set()  # autonomous connect fails and resumes ITS scan
            await auto
            await host
            state = (main._scan_paused, bridge.streaming, main._gatt_session_armed)
            await self._cancel_guard()
            return state

        paused, streaming, armed = asyncio.run(scenario())
        # The host session must run with scanning paused and the scan IRQ
        # handler off, or the scan loop restarts streaming under the session.
        self.assertTrue(paused)
        self.assertFalse(streaming)
        self.assertTrue(armed)
        self.assertEqual(bridge.connects, [SCALE, HOST_TARGET])

    def test_autonomous_connect_stands_down_while_a_host_connect_waits(self):
        # Batch board: the scan loop holds _busy for its scan when the host
        # connect arrives, then finds the scale in its results.
        bridge = _Bridge()
        bridge.scale_fails = False
        bridge.gate.set()
        main.bridge = bridge
        main.board.CONTINUOUS_SCAN = False
        main._busy = True  # the batch scan

        async def scenario():
            host = asyncio.create_task(
                main.handle_connect(json.dumps({"address": SCALE}).encode())
            )
            await asyncio.sleep(0.01)
            await main._auto_gatt_connect(SCALE, 0)
            main._busy = False  # the batch loop's finally
            await host
            await self._cancel_guard()

        asyncio.run(scenario())
        self.assertEqual(bridge.connects, [SCALE])
        connected = [json.loads(p) for t, p in self.client.published if t == main.topic("connected")]
        self.assertEqual(len(connected), 1)
        self.assertNotIn("autonomous", connected[0])

    def test_host_connect_ending_a_published_session_reports_its_end(self):
        bridge = _Bridge()
        main.bridge = bridge
        main._scan_paused = True
        main._gatt_session_armed = True  # an autonomous session the host knows

        async def scenario():
            await main.handle_connect(json.dumps({"address": HOST_TARGET}).encode())
            await self._cancel_guard()

        asyncio.run(scenario())
        topics = self.client.topics()
        self.assertIn(main.topic("disconnected"), topics)
        self.assertLess(topics.index(main.topic("disconnected")), topics.index(main.topic("connected")))

    def test_host_disconnect_during_an_autonomous_connect_leaves_it_alone(self):
        bridge = _Bridge()
        bridge.scale_fails = False
        main.bridge = bridge

        async def scenario():
            auto = asyncio.create_task(main._auto_gatt_connect(SCALE, 0))
            await asyncio.sleep(0.01)
            await main.handle_disconnect()
            during = (bridge.disconnects, bridge.stream_starts, main._scan_paused)
            bridge.gate.set()
            await auto
            await self._cancel_guard()
            return during

        disconnects_during, stream_starts_during, paused_during = asyncio.run(scenario())
        # _auto_gatt_connect's own pre-connect disconnect is the only one.
        self.assertEqual(disconnects_during, 1)
        self.assertEqual(stream_starts_during, 0)
        self.assertTrue(paused_during)
        self.assertIn(main.topic("disconnected"), self.client.topics())
        self.assertTrue(main._gatt_session_armed)

    def test_batch_loop_starts_no_scan_while_a_host_connect_waits(self):
        # Guards the refactor: the waiting host connect no longer sets
        # _scan_paused, so the batch loop must stand down on its own.
        bridge = _Bridge()
        scans = []

        async def scan():
            scans.append(1)
            return []

        bridge.scan = scan
        main.bridge = bridge
        main.board.CONTINUOUS_SCAN = False
        main._subs_ready = True
        release = asyncio.Event()

        async def wait_for_release(*a, **k):
            await release.wait()
            return True

        main._wait_not_busy = wait_for_release

        async def scenario():
            host = asyncio.create_task(
                main.handle_connect(json.dumps({"address": HOST_TARGET}).encode())
            )
            await asyncio.sleep(0.01)
            loop = asyncio.create_task(main._batch_scan_loop())
            await asyncio.sleep(0.05)
            seen = len(scans)
            loop.cancel()
            release.set()
            await host
            await self._cancel_guard()
            return seen

        self.assertEqual(asyncio.run(scenario()), 0)


class _Clock:
    def __init__(self):
        self.now = 0

    def ticks_ms(self):
        return self.now

    @staticmethod
    def ticks_diff(a, b):
        return a - b


def _clocked_asyncio(clock):
    """asyncio for main whose sleeps advance the fake clock and only yield."""
    real_sleep = asyncio.sleep
    fake = types.SimpleNamespace(**{k: getattr(asyncio, k) for k in dir(asyncio) if not k.startswith("__")})

    async def sleep_ms(ms):
        clock.now += ms
        await real_sleep(0)

    async def sleep(s):
        await sleep_ms(int(s * 1000))

    fake.sleep_ms = sleep_ms
    fake.sleep = sleep
    return fake


# COMMAND_TIMEOUT_MS in src/ble/handler-mqtt-proxy/topics.ts
SERVER_CONNECT_TIMEOUT_MS = 30000


class HostConnectBudgetTest(_Base):
    def setUp(self):
        super().setUp()
        self.clock = _Clock()
        main.time = self.clock
        main.asyncio = _clocked_asyncio(self.clock)
        self.bridge = _Bridge()
        main.bridge = self.bridge

    def test_busy_answer_arrives_before_the_server_gives_up(self):
        main._busy = True  # never clears

        asyncio.run(main.handle_connect(json.dumps({"address": HOST_TARGET}).encode()))
        self.assertIn(main.topic("error"), self.client.topics())
        # Leave the MQTT round trip room inside the server's window.
        self.assertLessEqual(self.clock.now, SERVER_CONNECT_TIMEOUT_MS - 5000)

    def test_connect_gets_what_the_busy_wait_left_of_the_budget(self):
        main._busy = True

        async def free_after_10s():
            while self.clock.now < 10000:
                await asyncio.sleep(0)
            main._busy = False

        async def scenario():
            freer = asyncio.create_task(free_after_10s())
            await main.handle_connect(json.dumps({"address": HOST_TARGET}).encode())
            await freer
            await self._cancel_guard()

        asyncio.run(scenario())
        self.assertEqual(self.bridge.connects, [HOST_TARGET])
        budget = self.bridge.budgets[0]
        self.assertIsNotNone(budget)
        self.assertLessEqual(self.clock.now + budget, SERVER_CONNECT_TIMEOUT_MS - 5000)
        self.assertGreater(budget, 0)


class ErrorCorrelationTest(_Base):
    def _run_main_with(self, pending):
        async def noop(*a, **k):
            return None

        main._connect_with_retry = noop
        main.scan_loop = noop
        main._pending = list(pending)

        async def scenario():
            task = asyncio.create_task(main.main())
            for _ in range(20):
                await asyncio.sleep(0.01)
                if not main._pending:
                    break
            await asyncio.sleep(0.01)
            task.cancel()
            try:
                await task
            except BaseException:
                pass
            await self._cancel_guard()

        asyncio.run(scenario())
        return [json.loads(p) for t, p in self.client.published if t == main.topic("error")]

    def test_failed_read_names_the_operation_and_characteristic(self):
        main.bridge = _Bridge()
        errors = self._run_main_with([(main.topic("read/0000fff1"), b"")])
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["op"], "read")
        self.assertEqual(errors[0]["uuid"], "0000fff1")
        self.assertIn("read timed out", errors[0]["message"])

    def test_failed_host_connect_names_the_operation_and_address(self):
        bridge = _Bridge()

        async def failing_connect(address, addr_type=0, budget_ms=None):
            raise OSError("peer not found")

        bridge.connect = failing_connect
        main.bridge = bridge
        payload = json.dumps({"address": HOST_TARGET}).encode()
        errors = self._run_main_with([(main.topic("connect"), payload)])
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["op"], "connect")
        self.assertEqual(errors[0]["address"], HOST_TARGET)

    def test_failed_autonomous_connect_is_not_mistaken_for_the_host_connect(self):
        bridge = _Bridge()
        bridge.gate.set()
        main.bridge = bridge
        asyncio.run(main._auto_gatt_connect(SCALE, 0))
        errors = [json.loads(p) for t, p in self.client.published if t == main.topic("error")]
        self.assertEqual(errors[0]["op"], "auto-connect")
        self.assertEqual(errors[0]["address"], SCALE)

    def test_host_connect_answer_carries_the_address(self):
        main.bridge = _Bridge()

        async def scenario():
            await main.handle_connect(json.dumps({"address": HOST_TARGET}).encode())
            await self._cancel_guard()

        asyncio.run(scenario())
        connected = [json.loads(p) for t, p in self.client.published if t == main.topic("connected")]
        self.assertEqual(connected[0]["address"], HOST_TARGET)


if __name__ == "__main__":
    unittest.main()
