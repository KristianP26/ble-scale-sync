"""Host-runnable tests: BleBridge.start_notify() forwards every notification (#501).

aioble 0.6.2 keeps one unread notification per characteristic
(ClientCharacteristic: deque((), 1)), so a notification that arrived before the
notify loop took the previous one replaced it. The Arboleaf CS10G sends its 0xb1
result as three notifications in one burst, and only the last one (no weight)
reached the host. start_notify() now routes the stream into its own FIFO.

The fake below ports aioble's receive path (client.py L319-L421) instead of
mocking notified(): a mock at that level would encode the bug (see GOTCHAS,
"aioble discovery"). Frames are synthetic and only carry the CS10G shape; these
tests check the transport, the scale adapters have their own real fixtures.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
import contextlib
import importlib.util
import io
import os
import sys
import types
import unittest
from collections import deque

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

FLAG_READ = 0x02
FLAG_WRITE = 0x08
FLAG_NOTIFY = 0x10
FLAG_INDICATE = 0x20

UUID_NOTIFY = "0000fff1-0000-1000-8000-00805f9b34fb"
UUID_INDICATE = "0000ffb3-0000-1000-8000-00805f9b34fb"


def _load_bridge():
    """Import the real ble_bridge.py under its own name with host stubs."""
    ble = types.SimpleNamespace(active=lambda *a: True, irq=lambda h: None)
    bt = types.ModuleType("bluetooth")
    bt.BLE = lambda: ble
    for name, value in (
        ("FLAG_READ", FLAG_READ),
        ("FLAG_WRITE", FLAG_WRITE),
        ("FLAG_NOTIFY", FLAG_NOTIFY),
        ("FLAG_WRITE_NO_RESPONSE", 0x04),
        ("FLAG_INDICATE", FLAG_INDICATE),
    ):
        setattr(bt, name, value)
    core = types.ModuleType("aioble.core")
    core.ble_irq = lambda *a: None
    aioble = types.ModuleType("aioble")
    aioble.core = core
    aioble.ADDR_PUBLIC = 0
    aioble.ADDR_RANDOM = 1
    board = types.ModuleType("board")
    board.MAX_SCAN_ENTRIES = 500
    board.AGGRESSIVE_GC = False
    board.DEACTIVATE_BLE_AFTER_SCAN = False
    board.CONNECT_TIMEOUT_MS = 15000
    board.CONNECT_SCAN_MS = 15000
    board.CONNECT_RETRIES = 1

    stubs = {"bluetooth": bt, "aioble": aioble, "aioble.core": core, "board": board}
    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        spec = importlib.util.spec_from_file_location(
            "ble_bridge_notify_queue_under_test", os.path.join(_FIRMWARE_DIR, "ble_bridge.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        for name, value in saved.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value
    return mod


ble_bridge = _load_bridge()


class _Flag:
    """asyncio.ThreadSafeFlag: set() latches, wait() clears it on wake. One
    waiter at a time (a second one hits an assert in MicroPython's IOQueue)."""

    def __init__(self):
        self._event = asyncio.Event()
        self._waiting = False

    def set(self):
        self._event.set()

    def clear(self):
        self._event.clear()

    async def wait(self):
        assert not self._waiting, "second waiter on a ThreadSafeFlag"
        self._waiting = True
        try:
            await self._event.wait()
        finally:
            self._waiting = False
        self._event.clear()


class _Disconnected(Exception):
    """aioble.DeviceDisconnectedError."""


class _Timeout:
    """aioble DeviceTimeout: a timeout turns the cancel into
    asyncio.TimeoutError, a disconnect into DeviceDisconnectedError."""

    def __init__(self, conn, ms):
        self._conn = conn
        self._ms = ms
        self._task = None
        self._handle = None
        self.timed_out = False
        self.disconnected = False

    def __enter__(self):
        self._task = asyncio.current_task()
        self._conn.timeouts.append(self)
        if self._ms is not None:
            delay = self._ms / 1000 * self._conn.time_scale
            self._handle = asyncio.get_running_loop().call_later(delay, self._expire)
        return self

    def _expire(self):
        self.timed_out = True
        self._conn.timeouts_fired += 1
        self._task.cancel()

    def cancel_for_disconnect(self):
        self.disconnected = True
        self._task.cancel()

    def __exit__(self, exc_type, exc, tb):
        if self._handle:
            self._handle.cancel()
        if self in self._conn.timeouts:
            self._conn.timeouts.remove(self)
        if exc_type is asyncio.CancelledError:
            if self.timed_out or self.disconnected:
                self._task.uncancel()
            if self.timed_out:
                raise asyncio.TimeoutError
            if self.disconnected:
                raise _Disconnected
        return False


class _Conn:
    def __init__(self):
        self.connected = True
        self.time_scale = 1.0
        self.timeouts = []
        self.timeouts_fired = 0

    def is_connected(self):
        return self.connected

    def timeout(self, ms):
        return _Timeout(self, ms)

    def drop(self):
        """The link goes down: like device_task, cancel every waiter."""
        self.connected = False
        for t in list(self.timeouts):
            t.cancel_for_disconnect()

    async def disconnect(self):
        self.connected = False


class _AiobleChar:
    """Port of aioble 0.6.2 ClientCharacteristic's notification path
    (client.py L319-L421): a one-slot deque and a flag per stream, a flag that
    wakes only on the 0 -> 1 transition, and a wait that is skipped only while
    more than one entry is queued."""

    def __init__(self, uuid, properties, conn, on_subscribe=None):
        self.uuid = uuid
        self.properties = properties
        self._conn = conn
        self.subscribed = []  # (notify, indicate) per CCCD write
        self._on_subscribe = on_subscribe
        if properties & FLAG_NOTIFY:
            self._notify_event = _Flag()
            self._notify_queue = deque((), 1)
        if properties & FLAG_INDICATE:
            self._indicate_event = _Flag()
            self._indicate_queue = deque((), 1)

    async def subscribe(self, notify=True, indicate=False):
        self.subscribed.append((notify, indicate))
        if self._on_subscribe:
            self._on_subscribe(self)

    async def _notified_indicated(self, queue, event, timeout_ms):
        if len(queue) <= 1:
            with self._conn.timeout(timeout_ms):
                await event.wait()
        return queue.popleft()

    async def notified(self, timeout_ms=None):
        if not (self.properties & FLAG_NOTIFY):
            raise ValueError("Unsupported")
        return await self._notified_indicated(self._notify_queue, self._notify_event, timeout_ms)

    async def indicated(self, timeout_ms=None):
        if not (self.properties & FLAG_INDICATE):
            raise ValueError("Unsupported")
        return await self._notified_indicated(
            self._indicate_queue, self._indicate_event, timeout_ms
        )

    def _on_notify_indicate(self, queue, event, data):
        wake = len(queue) == 0
        queue.append(data)
        if wake:
            event.set()

    # IRQ entry points. They dispatch through the instance, like aioble's
    # _on_notify and _on_indicate, which is what lets an instance attribute
    # replace _on_notify_indicate.
    def irq_notify(self, data):
        self._on_notify_indicate(self._notify_queue, self._notify_event, bytes(data))

    def irq_indicate(self, data):
        self._on_notify_indicate(self._indicate_queue, self._indicate_event, bytes(data))


def _part(n, kind=0xB1):
    """A 45 B CS10G-shaped part: kind, length, parts total, part number."""
    return bytes([kind, 0x2D, 0x03, n]) + bytes(41)


async def _until(predicate, timeout=1.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not predicate():
        if loop.time() > end:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.001)


async def _settled(predicate, timeout=1.0):
    """Wait for the expected outcome, but do not fail here: the assertion that
    follows then shows what was actually forwarded."""
    try:
        await _until(predicate, timeout)
    except AssertionError:
        pass


class _Rig:
    def __init__(self, properties, uuid=UUID_NOTIFY, on_subscribe=None, publish_gate=None):
        self.bridge = ble_bridge.BleBridge()
        self.conn = _Conn()
        self.char = _AiobleChar(uuid, properties, self.conn, on_subscribe)
        self.uuid = uuid
        self.bridge._conn = self.conn
        self.bridge._chars[uuid] = self.char
        self.got = []
        self.publish_gate = publish_gate  # asyncio.Event or None

    async def publish(self, uuid, data):
        self.got.append(data)
        if self.publish_gate is not None and len(self.got) == 1:
            await self.publish_gate.wait()

    async def start(self):
        await self.bridge.start_notify(self.uuid, self.publish)

    async def close(self):
        await self.bridge.disconnect()


class TestBurstIsForwarded(unittest.IsolatedAsyncioTestCase):
    async def test_burst_while_idle_is_forwarded_in_order(self):
        """The reader waits, three parts arrive back to back (the NimBLE task
        delivers a burst before the asyncio task gets the CPU)."""
        rig = _Rig(FLAG_NOTIFY)
        await rig.start()
        await asyncio.sleep(0)
        parts = [_part(1), _part(2), _part(3)]
        for p in parts:
            rig.char.irq_notify(p)
        await _settled(lambda: len(rig.got) >= 3)
        await asyncio.sleep(0.01)
        self.assertEqual(rig.got, parts)
        await rig.close()

    async def test_burst_while_publish_pending_is_forwarded_in_order(self):
        """A publish to MQTT takes several event loop turns, the burst lands in
        between."""
        gate = asyncio.Event()
        rig = _Rig(FLAG_NOTIFY, publish_gate=gate)
        await rig.start()
        b4 = _part(1, kind=0xB4)
        rig.char.irq_notify(b4)
        await _until(lambda: rig.got == [b4])  # publish is now held
        parts = [_part(1), _part(2), _part(3)]
        for p in parts:
            rig.char.irq_notify(p)
        gate.set()
        await _settled(lambda: len(rig.got) >= 4)
        await asyncio.sleep(0.01)
        self.assertEqual(rig.got, [b4] + parts)
        await rig.close()

    async def test_indication_burst_on_indicate_only_char(self):
        """An indicate-only char (Robi S9 FFB3 result, #248) gets the same FIFO."""
        rig = _Rig(FLAG_INDICATE, uuid=UUID_INDICATE)
        await rig.start()
        await asyncio.sleep(0)
        frames = [b"\xaa\x02\x00\xa3\x30\x00\x00\x00", b"\xaa\x02\x00\xa4\x31\x00\x00\x00"]
        for f in frames:
            rig.char.irq_indicate(f)
        await _settled(lambda: len(rig.got) >= 2)
        await asyncio.sleep(0.01)
        self.assertEqual(rig.got, frames)
        self.assertEqual(rig.char.subscribed, [(False, True)])
        await rig.close()


class TestOverflow(unittest.IsolatedAsyncioTestCase):
    async def test_overflow_drops_oldest_and_reports_count(self):
        gate = asyncio.Event()
        rig = _Rig(FLAG_NOTIFY, publish_gate=gate)
        await rig.start()
        frames = [bytes([i]) * 4 for i in range(ble_bridge.NOTIFY_QUEUE_LEN + 4)]
        rig.char.irq_notify(frames[0])
        await _until(lambda: rig.got == [frames[0]])  # publish is now held
        for f in frames[1:]:
            rig.char.irq_notify(f)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            gate.set()
            await _settled(lambda: len(rig.got) >= ble_bridge.NOTIFY_QUEUE_LEN + 1)
            await asyncio.sleep(0.01)
        # 19 queued behind the held one, 16 fit: the 3 oldest go.
        self.assertEqual(rig.got, [frames[0]] + frames[4:])
        self.assertIn("queue full, dropped the 3 oldest notification(s)", out.getvalue())
        await rig.close()


class TestLinkDrop(unittest.IsolatedAsyncioTestCase):
    async def test_frames_before_link_drop_are_forwarded(self):
        rig = _Rig(FLAG_NOTIFY)
        calls = []
        rig.bridge.set_on_disconnect(lambda: calls.append(1))
        await rig.start()
        await asyncio.sleep(0)
        parts = [_part(1), _part(2), _part(3)]
        for p in parts:
            rig.char.irq_notify(p)
        rig.conn.drop()
        await _settled(lambda: len(rig.got) >= 3 and calls)
        await asyncio.sleep(0.01)
        self.assertEqual(rig.got, parts)
        self.assertEqual(calls, [1])
        await rig.close()

    async def test_link_drop_during_publish_ends_the_reader(self):
        """The link goes down while a publish is pending: no wait is armed, so
        aioble has nothing to cancel and the loop must notice it by itself
        instead of idling for 10 s."""
        gate = asyncio.Event()
        rig = _Rig(FLAG_NOTIFY, publish_gate=gate)
        calls = []
        rig.bridge.set_on_disconnect(lambda: calls.append(1))
        await rig.start()
        rig.char.irq_notify(_part(1))
        await _until(lambda: rig.got == [_part(1)])  # publish is now held
        rig.conn.drop()
        gate.set()
        await _until(lambda: calls)  # the 1 s deadline is far below the 10 s idle window
        self.assertEqual(calls, [1])
        self.assertTrue(rig.bridge._notify_tasks[0].done())
        await rig.close()


class TestSubscribe(unittest.IsolatedAsyncioTestCase):
    async def test_kickoff_during_subscribe_is_forwarded(self):
        """A scale may answer the CCCD write at once (QN kickoff). The queue
        must exist before the write."""
        kickoff = b"\x12\x0f\x00\x00"
        rig = _Rig(FLAG_NOTIFY, on_subscribe=lambda ch: ch.irq_notify(kickoff))
        await rig.start()
        await _settled(lambda: rig.got == [kickoff])
        self.assertEqual(rig.got, [kickoff])
        await rig.close()

    async def test_second_start_notify_keeps_one_reader(self):
        rig = _Rig(FLAG_NOTIFY)
        await rig.start()
        await rig.start()
        self.assertEqual(rig.char.subscribed, [(True, False), (True, False)])
        self.assertEqual(len(rig.bridge._notify_tasks), 1)
        rig.char.irq_notify(_part(1))
        await _settled(lambda: len(rig.got) >= 1)
        await asyncio.sleep(0.01)
        self.assertEqual(rig.got, [_part(1)])
        await rig.close()

    async def test_dead_reader_can_be_restarted(self):
        rig = _Rig(FLAG_NOTIFY)
        calls = []

        async def publish(uuid, data):
            calls.append(data)
            if len(calls) == 1:
                raise RuntimeError("publish failed")

        await rig.bridge.start_notify(rig.uuid, publish)
        rig.char.irq_notify(_part(1))
        with contextlib.redirect_stdout(io.StringIO()):
            await _until(lambda: rig.bridge._notify_tasks[0].done())
        await rig.bridge.start_notify(rig.uuid, publish)
        rig.char.irq_notify(_part(2))
        await _settled(lambda: len(calls) >= 2)
        self.assertEqual(calls, [_part(1), _part(2)])
        await rig.close()

    async def test_dual_char_forwards_notifications_only(self):
        """A char with notify AND indicate stays on its notify stream (#248)."""
        rig = _Rig(FLAG_NOTIFY | FLAG_INDICATE)
        await rig.start()
        await asyncio.sleep(0)
        rig.char.irq_indicate(b"\x01")
        rig.char.irq_notify(b"\x10\x20")
        await _settled(lambda: len(rig.got) >= 1)
        await asyncio.sleep(0.01)
        self.assertEqual(rig.got, [b"\x10\x20"])
        self.assertEqual(rig.char.subscribed, [(True, True)])
        await rig.close()

    async def test_notify_characteristic_enables_cccd(self):
        rig = _Rig(FLAG_NOTIFY)
        await rig.start()
        self.assertEqual(rig.char.subscribed, [(True, False)])
        await rig.close()

    async def test_indicate_characteristic_enables_cccd(self):
        rig = _Rig(FLAG_INDICATE, uuid=UUID_INDICATE)
        await rig.start()
        self.assertEqual(rig.char.subscribed, [(False, True)])
        await rig.close()

    async def test_neither_flag_char_is_skipped(self):
        """No CCCD to write and no reader that would raise Unsupported (#248)."""
        rig = _Rig(FLAG_READ, uuid="0000dead-0000-1000-8000-00805f9b34fb")
        await rig.start()
        self.assertEqual(rig.char.subscribed, [])
        self.assertEqual(rig.bridge._notify_tasks, [])
        self.assertNotIn("_on_notify_indicate", vars(rig.char))

    async def test_missing_char_is_noop(self):
        bridge = ble_bridge.BleBridge()
        bridge._conn = _Conn()

        async def publish(_uuid, _data):
            pass

        await bridge.start_notify("0000dead-0000-1000-8000-00805f9b34fb", publish)
        self.assertEqual(bridge._notify_tasks, [])


class TestIdleRearm(unittest.IsolatedAsyncioTestCase):
    async def test_rearms_after_idle_timeout(self):
        """A 10 s idle must re-arm the wait while the link is up: the final
        result frame can lag the live stream (#248)."""
        rig = _Rig(FLAG_INDICATE, uuid=UUID_INDICATE)
        rig.conn.time_scale = 0.0001
        await rig.start()
        await _until(lambda: rig.conn.timeouts_fired >= 2)
        frame = b"\xaa\x02\x00\xa3\x30\x00\x00\x00"
        rig.char.irq_indicate(frame)
        await _settled(lambda: rig.got == [frame])
        self.assertEqual(rig.got, [frame])
        await rig.close()


class TestAiobleHookedVersion(unittest.TestCase):
    def test_aioble_pin_matches_the_hooked_version(self):
        """start_notify() replaces ClientCharacteristic._on_notify_indicate and
        reads its _notify_event and _indicate_event. Another aioble release may
        move them: re-check client.py L319-L421 before bumping the pin."""
        with open(os.path.join(_FIRMWARE_DIR, "mip-packages.txt"), encoding="utf-8") as f:
            specs = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
        self.assertIn(
            "aioble@0.6.2",
            specs,
            "aioble pin changed: re-check client.py L319-L421 (ClientCharacteristic."
            "_on_notify_indicate, _notify_event, _indicate_event) before bumping",
        )


if __name__ == "__main__":
    unittest.main()
