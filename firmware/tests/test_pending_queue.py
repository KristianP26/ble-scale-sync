"""Host-runnable tests for the MQTT message callback and the command queue in main.py.

mqtt_as calls `on_message` inside its reader task and catches only OSError
around it. Any other exception ends that task, and the link then looks alive
until the keepalive check reconnects it (derived from the mqtt_as ping
interval, not measured on a board). So the callback must never raise, whatever
a peer sends.

A retained message is a replay the broker repeats at every reconnect. The host
retains only `config`, so a retained command can only come from another
publisher, a buggy or misconfigured one.

The command queue holds what the host sent while the main loop is busy with a
slow command (a connect takes up to 25 s). It is bounded by a command count
and a payload byte budget, so a flood on the command topics cannot eat the
heap of a board that has about 85 KB.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
import contextlib
import io
import types
import unittest

from _main_loader import VALID_CONFIG, load_main

CONFIG_PAYLOAD = b'{"scales": ["AA:BB:CC:DD:EE:FF"]}'


def _fake_time():
    return types.SimpleNamespace(ticks_ms=lambda: 1000, ticks_diff=lambda a, b: a - b)


class _Base(unittest.TestCase):
    def setUp(self):
        self.main = load_main(VALID_CONFIG)
        # CPython's time module has no ticks_ms.
        self.main.time = _fake_time()

    def send(self, suffix, payload=b"", retained=False):
        self.main.on_message(self.main.topic(suffix).encode(), payload, retained)


class CallbackTest(_Base):
    def test_a_topic_that_is_not_utf8_does_not_raise(self):
        # MicroPython raises UnicodeError for the same bytes (CPython: its subclass).
        self.main.on_message(b"\xff\xfe\xfd", b"", False)
        self.send("write/0000fff1", b"x")
        self.assertEqual(len(self.main._pending), 1)

    def test_a_failing_queue_does_not_raise_and_the_next_command_is_queued(self):
        class Exploding(list):
            fail = True

            def append(self, item):
                if self.fail:
                    raise MemoryError()
                super().append(item)

        pending = Exploding()
        self.main._pending = pending
        self.send("write/0000fff1", b"x")
        self.assertEqual(list(pending), [])
        pending.fail = False
        self.send("write/0000fff1", b"y")
        self.assertEqual(len(pending), 1)

    def test_the_drop_is_reported_without_topic_or_payload(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.main.on_message(b"\xff\xfe\xfd", b"secret", False)
        self.assertIn("MQTT message dropped", out.getvalue())
        self.assertNotIn("secret", out.getvalue())

    def test_a_retained_command_is_not_queued_but_a_live_one_is(self):
        self.send("connect", b'{"address": "AA:BB:CC:DD:EE:FF"}', retained=True)
        self.assertEqual(self.main._pending, [])
        self.send("connect", b'{"address": "AA:BB:CC:DD:EE:FF"}', retained=False)
        self.assertEqual(len(self.main._pending), 1)

    def test_a_retained_config_still_applies(self):
        self.send("config", CONFIG_PAYLOAD, retained=True)
        self.assertEqual(self.main._scale_macs, {"AA:BB:CC:DD:EE:FF"})


class CommandQueueTest(_Base):
    def test_a_flood_is_bounded(self):
        for _ in range(10000):
            self.send("write/0000fff1", b"x" * 20)
        self.assertLessEqual(len(self.main._pending), self.main.MAX_PENDING_COMMANDS)
        self.assertLess(len(self.main._pending), 10000)

    def test_the_oldest_commands_stay_in_order_and_the_newest_are_dropped(self):
        cap = self.main.MAX_PENDING_COMMANDS
        for i in range(cap + 5):
            self.send("write/u%d" % i)
        topics = [t for t, _ in self.main._pending]
        self.assertEqual(topics, [self.main.topic("write/u%d" % i) for i in range(cap)])
        self.assertEqual(self.main._pending_dropped, 5)

    def test_payload_bytes_are_budgeted(self):
        for _ in range(10):
            self.send("write/0000fff1", b"x" * 1000)
        held = sum(len(m) for _, m in self.main._pending)
        self.assertLessEqual(held, self.main.MAX_PENDING_BYTES)
        self.assertGreater(self.main._pending_dropped, 0)

    def test_one_message_over_the_budget_is_refused(self):
        self.send("write/0000fff1", b"x" * (self.main.MAX_PENDING_BYTES + 1))
        self.assertEqual(self.main._pending, [])
        self.assertEqual(self.main._pending_dropped, 1)

    def test_a_legit_burst_fits(self):
        # Guard against a cap set too low: 3 subscribes, 8 handshake writes, a
        # disconnect, a beep and 2 display messages (a display board takes them).
        self.main = load_main(VALID_CONFIG, HAS_DISPLAY=True)
        self.main.time = _fake_time()
        for i in range(3):
            self.send("subscribe/0000ff%02d" % i)
        for _ in range(8):
            self.send("write/0000fff1", b"\xf7\x00\x00\x00")
        self.send("disconnect")
        self.send("beep", b'{"freq": 600, "duration": 150, "repeat": 3}')
        self.send("display/reading", b"{}" * 200)
        self.send("display/result", b"{}" * 250)
        self.assertEqual(len(self.main._pending), 15)
        self.assertEqual(self.main._pending_dropped, 0)

    def test_a_refused_command_is_not_session_engagement(self):
        main = self.main
        main._gatt_session_armed = True
        for i in range(main.MAX_PENDING_COMMANDS):
            self.send("write/u%d" % i)
        main._host_engaged = False
        self.send("write/late")
        self.assertFalse(main._host_engaged)

    def test_an_accepted_command_is_session_engagement(self):
        self.main._gatt_session_armed = True
        self.main._host_engaged = False
        self.send("write/0000fff1", b"x")
        self.assertTrue(self.main._host_engaged)

    def test_the_own_read_answer_is_not_queued_but_a_read_request_is(self):
        self.send("read/0000fff1/response", b"x" * 20)
        self.assertEqual(self.main._pending, [])
        self.send("read/0000fff1")
        self.assertEqual(len(self.main._pending), 1)

    def test_the_link_lost_marker_bypasses_the_cap(self):
        main = self.main
        for i in range(main.MAX_PENDING_COMMANDS):
            self.send("write/u%d" % i)
        callbacks = []

        class Bridge:
            def stop_streaming(self):
                pass

            def start_streaming(self):
                pass

            async def disconnect(self):
                pass

            async def connect(self, address, addr_type=0, budget_ms=None):
                return {"chars": []}

            async def start_notify(self, uuid_str, fn):
                pass

            def set_on_disconnect(self, cb):
                callbacks.append(cb)

        class Client:
            async def publish(self, *a, **k):
                pass

            async def subscribe(self, *a, **k):
                pass

        main.bridge = Bridge()
        main.client = Client()
        main._arm_session_guard = lambda: None
        asyncio.run(main.handle_connect(b'{"address": "AA:BB:CC:DD:EE:FF"}'))
        self.assertEqual(len(callbacks), 1)
        callbacks[0]()
        self.assertEqual(main._pending[-1][0], "__ble_disconnected__")


class DrainReportTest(unittest.TestCase):
    def test_the_main_loop_reports_the_drops_once_after_the_queue_drained(self):
        main = load_main(VALID_CONFIG)
        main.time = _fake_time()

        async def noop(*a, **k):
            return None

        async def yield_for_a_tick(_ms=0):
            # A coroutine that never yields would starve the test's own task.
            await asyncio.sleep(0)

        fast = types.SimpleNamespace(
            **{k: getattr(asyncio, k) for k in dir(asyncio) if not k.startswith("__")}
        )
        fast.sleep_ms = yield_for_a_tick
        main.asyncio = fast
        main._connect_with_retry = noop
        main.scan_loop = noop
        main._pending_dropped = 7
        out = io.StringIO()

        async def scenario():
            task = asyncio.create_task(main.main())
            for _ in range(5):
                await asyncio.sleep(0.01)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        with contextlib.redirect_stdout(out):
            asyncio.run(scenario())
        self.assertEqual(out.getvalue().count("were dropped"), 1, out.getvalue())
        self.assertIn("Command queue drained, 7 command(s) were dropped", out.getvalue())
        self.assertEqual(main._pending_dropped, 0)

    def test_the_first_refusal_prints_one_line_and_a_flood_does_not_repeat_it(self):
        main = load_main(VALID_CONFIG)
        main.time = _fake_time()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            for _ in range(200):
                main.on_message(main.topic("write/0000fff1").encode(), b"x" * 100, False)
        self.assertEqual(out.getvalue().count("Command queue limit reached"), 1, out.getvalue())


if __name__ == "__main__":
    unittest.main()
