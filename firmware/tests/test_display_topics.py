"""Host-runnable tests: the payloads of the display topics are bounded.

A display board shows the readings and export results the server sends on
display/reading and display/result. The payloads come from whoever can publish
on those topics, so the firmware checks what reaches the LVGL labels: text is
cut to a screen's worth, "#" (an LVGL recolor tag) is removed, the row count is
capped and a weight that is not a plausible number is an error instead of a
crash in the UI.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
import contextlib
import io
import json
import sys
import types
import unittest

from _main_loader import VALID_CONFIG, load_main

# MicroPython-only; the main loop's error handler calls it.
if not hasattr(sys, "print_exception"):
    sys.print_exception = lambda e: None


class _Ui:
    def __init__(self):
        self.calls = []

    def init(self):
        pass

    def on_wifi_change(self, connected):
        pass

    def on_mqtt_change(self, connected):
        pass

    def check_timeout(self):
        pass

    def on_reading(self, *args):
        self.calls.append(("reading",) + args)

    def on_result(self, *args):
        self.calls.append(("result",) + args)


def _load(has_display=True, **cfg):
    config = dict(VALID_CONFIG)
    config.update(cfg)
    main = load_main(config, HAS_DISPLAY=has_display)
    main.time = types.SimpleNamespace(ticks_ms=lambda: 1000, ticks_diff=lambda a, b: a - b)
    main.ui = _Ui()
    return main


def _run_loop(main, pending):
    """Run main() until it has handled `pending`; return (ui calls, errors, stdout)."""

    async def noop(*a, **k):
        return None

    async def yield_for_a_tick(_ms=0):
        await asyncio.sleep(0)

    fast = types.SimpleNamespace(
        **{k: getattr(asyncio, k) for k in dir(asyncio) if not k.startswith("__")}
    )
    fast.sleep_ms = yield_for_a_tick
    main.asyncio = fast
    main._connect_with_retry = noop
    main.scan_loop = noop
    main._connection_monitor = noop
    published = []

    async def publish(topic, msg, retain=False, qos=0):
        published.append((topic, msg))

    main.client.publish = publish
    main._pending = [(main.topic(name), json.dumps(body).encode()) for name, body in pending]

    async def scenario():
        task = asyncio.create_task(main.main())
        for _ in range(8):
            await asyncio.sleep(0.01)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        asyncio.run(scenario())
    errors = [json.loads(m) for t, m in published if t == main.topic("error")]
    return main.ui.calls, errors, out.getvalue()


def _show(pending, **cfg):
    calls, errors, _ = _run_loop(_load(**cfg), pending)
    return calls, errors


class DisplayPayloadTest(unittest.TestCase):
    def test_a_normal_result_reaches_the_screen_unchanged(self):
        body = {
            "slug": "alice",
            "name": "Alice",
            "weight": 61.4,
            "exports": [{"name": "garmin", "ok": True}, {"name": "mqtt", "ok": False}],
        }
        calls, errors = _show([("display/result", body)])
        self.assertEqual(errors, [])
        self.assertEqual(calls, [("result", "alice", "Alice", 61.4, body["exports"])])

    def test_a_normal_reading_reaches_the_screen_unchanged(self):
        body = {
            "slug": "alice",
            "name": "Alice",
            "weight": 61.4,
            "impedance": 480,
            "exporters": ["garmin", "mqtt"],
        }
        calls, errors = _show([("display/reading", body)])
        self.assertEqual(errors, [])
        self.assertEqual(calls, [("reading", "alice", "Alice", 61.4, 480, ["garmin", "mqtt"])])

    def test_long_text_and_long_lists_are_cut(self):
        body = {
            "slug": "s",
            "name": "n" * 10000,
            "weight": 70,
            "exports": [{"name": "x" * 500, "ok": True}] * 1000,
        }
        calls, _ = _show([("display/result", body)])
        _kind, _slug, name, _weight, rows = calls[0]
        self.assertEqual(len(name), 40)
        self.assertEqual(len(rows), 16)
        self.assertEqual(len(rows[0]["name"]), 40)

    def test_the_exporter_names_of_a_reading_are_cut_too(self):
        body = {"name": "a", "weight": 70, "exporters": ["x" * 500] * 1000}
        calls, _ = _show([("display/reading", body)])
        exporters = calls[0][5]
        self.assertEqual(len(exporters), 16)
        self.assertEqual(len(exporters[0]), 40)

    def test_the_colour_tag_character_is_removed_everywhere(self):
        result = {"name": "#FF0000 boo#", "weight": 70, "exports": [{"name": "#00FF00 x#", "ok": True}]}
        reading = {"name": "#FF0000 boo#", "weight": 70, "exporters": ["#00FF00 x#"]}
        for topic, body, rows_at in (
            ("display/result", result, 4),
            ("display/reading", reading, 5),
        ):
            with self.subTest(topic=topic):
                calls, _ = _show([(topic, body)])
                self.assertNotIn("#", calls[0][2])
                first = calls[0][rows_at][0]
                self.assertNotIn("#", first["name"] if isinstance(first, dict) else first)

    def test_a_bad_weight_is_an_error_and_never_reaches_the_screen(self):
        for weight in ("heavy", None, True, -1, 1e9, float("nan"), [1]):
            with self.subTest(weight=weight):
                calls, errors = _show([("display/reading", {"name": "a", "weight": weight})])
                self.assertEqual(calls, [])
                self.assertEqual(len(errors), 1)
                self.assertIn("weight must be a number from 0 to 1000", errors[0]["message"])

    def test_a_payload_that_is_not_an_object_is_an_error(self):
        for body in ([1, 2, 3], "text", 5):
            with self.subTest(body=body):
                calls, errors = _show([("display/reading", body)])
                self.assertEqual(calls, [])
                self.assertEqual(len(errors), 1)
                self.assertIn("display payload must be a JSON object", errors[0]["message"])

    def test_a_row_that_is_not_an_object_is_blanked(self):
        calls, _ = _show([("display/result", {"name": "a", "weight": 1, "exports": [5, None, "x"]})])
        self.assertEqual(calls[0][4], [{"name": "", "ok": False}] * 3)


if __name__ == "__main__":
    unittest.main()
