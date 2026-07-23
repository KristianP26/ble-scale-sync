"""Host-runnable test: BleBridge.connect() restores aioble's IRQ handler (#231).

The streaming scan installs the firmware's own _ble.irq() handler on the shared
bluetooth.BLE() singleton. aioble registers its dispatcher only once at import
and never restores it, so connect() must hand the IRQ back to aioble before
calling device.connect(), or _IRQ_PERIPHERAL_CONNECT is dropped and the connect
times out.

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


class _MockBLE:
    def __init__(self):
        self.current_irq = None

    def active(self, value=None):
        return True

    def irq(self, handler):
        self.current_irq = handler

    def gap_scan(self, *args):
        pass


_mock_ble = _MockBLE()

_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: _mock_ble
_bt.FLAG_READ = 0x02
_bt.FLAG_WRITE = 0x08
_bt.FLAG_NOTIFY = 0x10
_bt.FLAG_WRITE_NO_RESPONSE = 0x04
_bt.FLAG_INDICATE = 0x20
sys.modules["bluetooth"] = _bt


# aioble dispatcher sentinel: connect() must install THIS on the BLE singleton.
def _aioble_ble_irq(event, data):  # noqa: ARG001
    return None


_captured = {}


class _DiscoveryState:
    """Models aioble's single per-connection `_discover` slot. aioble allows
    only one discovery (services OR characteristics) in flight per connection;
    starting a second while one is unfinished raises ValueError (#231 fix 8)."""

    def __init__(self):
        self.active = None


class _AsyncDiscover:
    """Models aioble's ClientDiscover: an async iterator (async for), NOT a
    coroutine. It claims the connection's single discovery slot on first
    iteration and releases it on exhaustion, mirroring aioble's _start /
    StopAsyncIteration handling. Wrapping it in asyncio.wait_for raised
    'TypeError: coroutine expected' (#231 fix 7); nesting two of them raised
    'ValueError: Discovery in progress' (#231 fix 8)."""

    def __init__(self, state, items):
        self._state = state
        self._items = list(items)
        self._i = 0
        self._started = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._started:
            if self._state.active is not None:
                raise ValueError("Discovery in progress")
            self._state.active = self
            self._started = True
        if self._i >= len(self._items):
            self._state.active = None
            raise StopAsyncIteration
        item = self._items[self._i]
        self._i += 1
        return item


class _FakeChar:
    def __init__(self, uuid, properties):
        self.uuid = uuid
        self.properties = properties


class _SubscribableFakeChar:
    """Models aioble's ClientCharacteristic subscribe/notified/indicated surface.
    Records whether subscribe() was awaited and with which CCCD flags, counts
    notified()/indicated() calls, and mirrors aioble's _check(): notified()
    requires FLAG_NOTIFY and indicated() requires FLAG_INDICATE, else both raise
    ValueError("Unsupported") (#248). With *_data set, the matching read returns
    it once; otherwise it blocks until cancelled so subscribe-only tests can
    assert without the loop racing ahead (#231)."""

    def __init__(
        self, uuid, properties, indicate_data=None, notify_data=None,
        timeouts_before_data=0,
    ):
        self.uuid = uuid
        self.properties = properties
        self.subscribed = []  # list of (notify, indicate) tuples
        self.notified_calls = 0
        self.indicated_calls = 0
        self._indicate_data = indicate_data
        self._notify_data = notify_data
        # Number of leading reads that raise asyncio.TimeoutError (10s idle)
        # before data is delivered, mirroring aioble's DeviceTimeout (#248).
        self._timeouts = timeouts_before_data

    async def subscribe(self, notify=True, indicate=False):
        self.subscribed.append((notify, indicate))

    def _maybe_timeout(self):
        if self._timeouts > 0:
            self._timeouts -= 1
            raise asyncio.TimeoutError

    async def notified(self, timeout_ms=None):
        self.notified_calls += 1
        if not (self.properties & _bt.FLAG_NOTIFY):
            raise ValueError("Unsupported")
        self._maybe_timeout()
        if self._notify_data is not None:
            data, self._notify_data = self._notify_data, None
            return data
        await asyncio.Event().wait()

    async def indicated(self, timeout_ms=None):
        self.indicated_calls += 1
        if not (self.properties & _bt.FLAG_INDICATE):
            raise ValueError("Unsupported")
        self._maybe_timeout()
        if self._indicate_data is not None:
            data, self._indicate_data = self._indicate_data, None
            return data
        await asyncio.Event().wait()


class _FakeService:
    def __init__(self, state, chars):
        self._state = state
        self._chars = chars

    def characteristics(self):
        # aioble returns an async iterator sharing the connection's single
        # discovery slot, not a coroutine.
        return _AsyncDiscover(self._state, self._chars)


class _FakeConn:
    def __init__(self):
        self._state = _DiscoveryState()

    def services(self):
        # aioble returns an async iterator here, not a coroutine. Empty by
        # default so the IRQ/addr-type tests keep asserting {"chars": []}.
        return _AsyncDiscover(self._state, [])

    async def disconnect(self):
        pass

    def is_connected(self):
        return True


class _FakeConnWithChars:
    """One service with two characteristics. Proves connect() drains services()
    before discovering characteristics; the slot-aware mock raises
    'Discovery in progress' if connect() nests the two discoveries (#231)."""

    def __init__(self):
        self.disconnected = False
        self._state = _DiscoveryState()

    def services(self):
        notify_char = _FakeChar("0000fff1-0000-1000-8000-00805f9b34fb", _bt.FLAG_NOTIFY | _bt.FLAG_READ)
        write_char = _FakeChar("0000fff2-0000-1000-8000-00805f9b34fb", _bt.FLAG_WRITE_NO_RESPONSE)
        service = _FakeService(self._state, [notify_char, write_char])
        return _AsyncDiscover(self._state, [service])

    async def disconnect(self):
        self.disconnected = True

    def is_connected(self):
        return True


class _FakeConnTwoServices:
    """Two services, each with one characteristic. Guards that the discovery
    slot is released between services, so characteristics() for the second
    service does not raise 'Discovery in progress' (#231 fix 8)."""

    def __init__(self):
        self.disconnected = False
        self._state = _DiscoveryState()

    def services(self):
        char_a = _FakeChar("0000fff1-0000-1000-8000-00805f9b34fb", _bt.FLAG_NOTIFY)
        char_b = _FakeChar("00002a9d-0000-1000-8000-00805f9b34fb", _bt.FLAG_READ)
        service_a = _FakeService(self._state, [char_a])
        service_b = _FakeService(self._state, [char_b])
        return _AsyncDiscover(self._state, [service_a, service_b])

    async def disconnect(self):
        self.disconnected = True

    def is_connected(self):
        return True


class _FakeDevice:
    def __init__(self, addr_type, addr_bytes):
        self._addr_type = addr_type

    async def connect(self, timeout_ms=None, scan_duration_ms=None):
        # Snapshot which IRQ handler owns the singleton at connect time.
        _captured["irq_at_connect"] = _mock_ble.current_irq
        _captured["addr_type"] = self._addr_type
        return _FakeConn()


_aioble_core = types.ModuleType("aioble.core")
_aioble_core.ble_irq = _aioble_ble_irq

_aioble = types.ModuleType("aioble")
_aioble.core = _aioble_core
_aioble.ADDR_PUBLIC = 0
_aioble.ADDR_RANDOM = 1
_aioble.Device = _FakeDevice
sys.modules["aioble"] = _aioble
sys.modules["aioble.core"] = _aioble_core

_board = types.ModuleType("board")
_board.MAX_SCAN_ENTRIES = 500
_board.AGGRESSIVE_GC = False
_board.DEACTIVATE_BLE_AFTER_SCAN = False
_board.CONNECT_TIMEOUT_MS = 15000
_board.CONNECT_SCAN_MS = 15000
_board.CONNECT_RETRIES = 1
sys.modules["board"] = _board

# Another test module (test_auto_connect) stubs sys.modules["ble_bridge"] with a
# SimpleNamespace that has no connect(). When the whole suite is discovered in one
# process that stub may already be cached, so drop it to force a real import of the
# firmware module under the stubs installed above.
sys.modules.pop("ble_bridge", None)
import ble_bridge  # noqa: E402


class TestConnectRestoresAiobleIrq(unittest.IsolatedAsyncioTestCase):
    """connect() must reclaim the BLE IRQ for aioble after a streaming scan (#231)."""

    async def test_irq_restored_before_connect(self):
        _captured.clear()
        bridge = ble_bridge.BleBridge()

        # Streaming scan installs the firmware's scan-only handler, clobbering
        # aioble's dispatcher (the production bug's precondition).
        bridge.start_streaming()
        self.assertIsNot(_mock_ble.current_irq, _aioble_core.ble_irq)

        await bridge.connect("FF:03:00:53:D6:4D", 1)

        # By the time aioble's Device.connect() ran, aioble's dispatcher must own
        # the IRQ, otherwise _IRQ_PERIPHERAL_CONNECT is dropped and it times out.
        self.assertIs(_captured["irq_at_connect"], _aioble_core.ble_irq)
        self.assertEqual(_captured["addr_type"], 1)  # reported type (1) probed first

    async def test_public_scale_probes_reported_type_first(self):
        # Regression for #231: the QN-Scale advertises as public (addr_type=0).
        # connect() must probe the reported type (public=0) first, not force
        # random from the FF MAC bits, or it never matches the advertiser.
        _captured.clear()
        bridge = ble_bridge.BleBridge()
        bridge.start_streaming()
        await bridge.connect("FF:03:00:53:D6:4D", 0)
        self.assertEqual(_captured["addr_type"], 0)


class TestConnectFallbackTriesOppositeType(unittest.IsolatedAsyncioTestCase):
    """connect() falls back to the opposite address type on any connect failure,
    not only a TimeoutError. A re-entry after a wrong-type timeout surfaced a
    TypeError, which previously stranded the connect on one type (#231)."""

    async def test_opposite_type_tried_after_non_timeout_error(self):
        attempts = []

        class _FailFirstDevice:
            def __init__(self, addr_type, addr_bytes):
                self._addr_type = addr_type

            async def connect(self, timeout_ms=None, scan_duration_ms=None):
                attempts.append(self._addr_type)
                if len(attempts) == 1:
                    raise TypeError("coroutine expected")
                return _FakeConn()

        orig_device = _aioble.Device
        _aioble.Device = _FailFirstDevice
        try:
            bridge = ble_bridge.BleBridge()
            result = await bridge.connect("84:FC:E6:53:06:1C", 0)
        finally:
            _aioble.Device = orig_device

        # Public reported -> probe order (0, 1). The first attempt (0) raises a
        # non-timeout TypeError; the fallback (1) must still run and succeed.
        self.assertEqual(attempts, [0, 1])
        self.assertEqual(result, {"chars": []})


class TestConnectDiscoversCharsViaAsyncFor(unittest.IsolatedAsyncioTestCase):
    """connect() must drive aioble's async-iterator services()/characteristics()
    with `async for`. Wrapping the iterator in asyncio.wait_for raised
    'TypeError: coroutine expected' and stranded the autonomous connect (#231)."""

    async def test_discovery_yields_mapped_characteristics(self):
        conn = _FakeConnWithChars()

        class _DeviceReturningConn:
            def __init__(self, addr_type, addr_bytes):
                self._addr_type = addr_type

            async def connect(self, timeout_ms=None, scan_duration_ms=None):
                return conn

        orig_device = _aioble.Device
        _aioble.Device = _DeviceReturningConn
        try:
            bridge = ble_bridge.BleBridge()
            result = await bridge.connect("84:FC:E6:53:06:1C", 0)
        finally:
            _aioble.Device = orig_device

        uuids = [c["uuid"] for c in result["chars"]]
        self.assertEqual(
            uuids,
            [
                "0000fff100001000800000805f9b34fb",
                "0000fff200001000800000805f9b34fb",
            ],
        )
        # Property bitmask -> string list mapping is preserved.
        by_uuid = {c["uuid"]: c["properties"] for c in result["chars"]}
        self.assertEqual(
            sorted(by_uuid["0000fff100001000800000805f9b34fb"]),
            ["notify", "read"],
        )
        self.assertEqual(
            by_uuid["0000fff200001000800000805f9b34fb"],
            ["write-without-response"],
        )
        # The discovered chars are cached on the bridge for start_notify().
        self.assertIn("0000fff100001000800000805f9b34fb", bridge._chars)

    async def test_discovery_releases_slot_between_services(self):
        # Two services discovered sequentially: characteristics() for the second
        # service must not raise "Discovery in progress", i.e. connect() drains
        # services() fully before discovering any characteristics (#231 fix 8).
        conn = _FakeConnTwoServices()

        class _DeviceReturningConn:
            def __init__(self, addr_type, addr_bytes):
                self._addr_type = addr_type

            async def connect(self, timeout_ms=None, scan_duration_ms=None):
                return conn

        orig_device = _aioble.Device
        _aioble.Device = _DeviceReturningConn
        try:
            bridge = ble_bridge.BleBridge()
            result = await bridge.connect("84:FC:E6:53:06:1C", 0)
        finally:
            _aioble.Device = orig_device

        uuids = [c["uuid"] for c in result["chars"]]
        self.assertEqual(
            uuids,
            [
                "0000fff100001000800000805f9b34fb",
                "00002a9d00001000800000805f9b34fb",
            ],
        )


class TestStartNotifySubscribesCccd(unittest.IsolatedAsyncioTestCase):
    """start_notify() must write the CCCD via char.subscribe() before waiting
    on char.notified(). Without this, the peripheral never sends notifications,
    the loop times out with an empty error, and the QN handshake stalls (#231)."""

    async def test_notify_characteristic_enables_cccd(self):
        bridge = ble_bridge.BleBridge()
        char = _SubscribableFakeChar(
            "0000fff1-0000-1000-8000-00805f9b34fb", _bt.FLAG_NOTIFY
        )
        bridge._chars[char.uuid] = char
        bridge._conn = _FakeConn()

        async def publish_fn(_uuid, _data):
            pass

        await bridge.start_notify(char.uuid, publish_fn)
        self.assertEqual(char.subscribed, [(True, False)])
        # Clean up the background notify loop.
        await bridge.disconnect()

    async def test_indicate_characteristic_enables_cccd(self):
        bridge = ble_bridge.BleBridge()
        char = _SubscribableFakeChar(
            "00002a9d-0000-1000-8000-00805f9b34fb", _bt.FLAG_INDICATE
        )
        bridge._chars[char.uuid] = char
        bridge._conn = _FakeConn()

        async def publish_fn(_uuid, _data):
            pass

        await bridge.start_notify(char.uuid, publish_fn)
        self.assertEqual(char.subscribed, [(False, True)])
        await bridge.disconnect()

    async def test_indicate_only_char_read_via_indicated(self):
        """An indicate-only char (Robi S9 FFB3 result) must be read with
        indicated(); the old code called notified() which raises
        Unsupported, killing the loop before the A3 frame arrived (#248)."""
        bridge = ble_bridge.BleBridge()
        char = _SubscribableFakeChar(
            "0000ffb3-0000-1000-8000-00805f9b34fb",
            _bt.FLAG_INDICATE,
            indicate_data=b"\xaa\x02\x00\xa3\x30\x00\x00\x00",
        )
        bridge._chars[char.uuid] = char
        bridge._conn = _FakeConn()

        got = []
        done = asyncio.Event()

        async def publish_fn(uuid, data):
            got.append((uuid, data))
            done.set()

        await bridge.start_notify(char.uuid, publish_fn)
        await asyncio.wait_for(done.wait(), 1.0)
        self.assertGreaterEqual(char.indicated_calls, 1)
        self.assertEqual(char.notified_calls, 0)  # notify queue never touched
        self.assertEqual(got, [(char.uuid, b"\xaa\x02\x00\xa3\x30\x00\x00\x00")])
        await bridge.disconnect()

    async def test_read_rearms_after_timeout(self):
        """A 10s idle raises asyncio.TimeoutError; the loop must re-arm and keep
        reading while connected, not die and drop a late final frame (#248)."""
        bridge = ble_bridge.BleBridge()
        char = _SubscribableFakeChar(
            "0000ffb3-0000-1000-8000-00805f9b34fb",
            _bt.FLAG_INDICATE,
            indicate_data=b"\xaa\x02\x00\xa3\x30\x00\x00\x00",
            timeouts_before_data=1,
        )
        bridge._chars[char.uuid] = char
        bridge._conn = _FakeConn()

        got = []
        done = asyncio.Event()

        async def publish_fn(uuid, data):
            got.append((uuid, data))
            done.set()

        await bridge.start_notify(char.uuid, publish_fn)
        await asyncio.wait_for(done.wait(), 1.0)
        self.assertGreaterEqual(char.indicated_calls, 2)  # timed out once, then delivered
        self.assertEqual(got, [(char.uuid, b"\xaa\x02\x00\xa3\x30\x00\x00\x00")])
        await bridge.disconnect()

    async def test_dual_notify_indicate_char_read_via_notified(self):
        """A char exposing BOTH notify and indicate is drained via notified()
        (streaming push, no per-frame ATT confirmation). Locks the design
        choice so a refactor cannot silently flip it to indicated() (#248)."""
        bridge = ble_bridge.BleBridge()
        char = _SubscribableFakeChar(
            "0000fff1-0000-1000-8000-00805f9b34fb",
            _bt.FLAG_NOTIFY | _bt.FLAG_INDICATE,
            notify_data=b"\x10\x20",
        )
        bridge._chars[char.uuid] = char
        bridge._conn = _FakeConn()

        got = []
        done = asyncio.Event()

        async def publish_fn(uuid, data):
            got.append((uuid, data))
            done.set()

        await bridge.start_notify(char.uuid, publish_fn)
        await asyncio.wait_for(done.wait(), 1.0)
        self.assertGreaterEqual(char.notified_calls, 1)
        self.assertEqual(char.indicated_calls, 0)
        self.assertEqual(got, [(char.uuid, b"\x10\x20")])
        await bridge.disconnect()

    async def test_neither_flag_char_is_skipped(self):
        """A char with neither notify nor indicate must not be subscribed and
        must not spawn a read task that would raise Unsupported (#248 guard)."""
        bridge = ble_bridge.BleBridge()
        char = _SubscribableFakeChar(
            "0000dead-0000-1000-8000-00805f9b34fb", _bt.FLAG_READ
        )
        bridge._chars[char.uuid] = char
        bridge._conn = _FakeConn()

        async def publish_fn(_uuid, _data):
            pass

        await bridge.start_notify(char.uuid, publish_fn)
        self.assertEqual(char.subscribed, [])
        self.assertEqual(bridge._notify_tasks, [])
        # No disconnect() cleanup needed: the guard returns before any read task
        # is spawned, so there is nothing to cancel.

    async def test_missing_char_is_noop(self):
        bridge = ble_bridge.BleBridge()
        bridge._conn = _FakeConn()

        async def publish_fn(_uuid, _data):
            pass

        # Should not raise or create a task.
        await bridge.start_notify("0000dead-0000-1000-8000-00805f9b34fb", publish_fn)
        self.assertEqual(bridge._notify_tasks, [])


if __name__ == "__main__":
    unittest.main()
