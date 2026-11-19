"""Host-runnable tests for the MQTT message callback and the command queue in main.py.

mqtt_as calls `on_message` inside its reader task and catches only OSError
around it. Any other exception ends that task, and the link then looks alive
until the keepalive check reconnects it (derived from the mqtt_as ping
interval, not measured on a board). So the callback must never raise, whatever
a peer sends.

Run: python -m unittest discover -s firmware/tests
"""

import contextlib
import io
import types
import unittest

from _main_loader import VALID_CONFIG, load_main

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


if __name__ == "__main__":
    unittest.main()
