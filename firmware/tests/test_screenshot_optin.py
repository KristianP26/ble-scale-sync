"""Host-runnable tests: the framebuffer dump is answered only when config.json asks for it.

A screenshot request makes a display board publish what its panel shows (user
names, last weights) in about 113 QoS 1 chunks, and holds the main loop while
it does. Anyone who can publish on the command topics could ask for it, so the
firmware answers only with "screenshot": true in config.json. The only consumer
is firmware/tools/capture_screenshot.py.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
import types
import unittest

from _main_loader import VALID_CONFIG, load_main


class _Display:
    def __init__(self):
        self.reads = 0

    def framebuffer(self, _index):
        self.reads += 1
        return bytearray(4096 * 3)


class _Recorder:
    def __init__(self):
        self.subscribed = []
        self.published = []

    async def subscribe(self, topic, qos=0):
        self.subscribed.append(topic)

    async def publish(self, topic, msg, retain=False, qos=0):
        self.published.append((topic, msg))


def _load(has_display=True, **cfg):
    config = dict(VALID_CONFIG)
    config.update(cfg)
    main = load_main(
        config,
        HAS_DISPLAY=has_display,
        display_dev=_Display(),
        DISPLAY_WIDTH=480,
        DISPLAY_HEIGHT=480,
    )
    main.ui = types.SimpleNamespace(on_mqtt_change=lambda c: None)
    main.time = types.SimpleNamespace(ticks_ms=lambda: 1000, ticks_diff=lambda a, b: a - b)
    return main


def _subscriptions(main):
    recorder = _Recorder()
    asyncio.run(main.on_connect(recorder))
    return recorder.subscribed


class ScreenshotOptInTest(unittest.TestCase):
    def test_screenshot_is_not_subscribed_by_default(self):
        main = _load()
        self.assertNotIn(main.topic("screenshot"), _subscriptions(main))

    def test_screenshot_true_subscribes(self):
        main = _load(screenshot=True)
        self.assertIn(main.topic("screenshot"), _subscriptions(main))

    def test_the_display_topics_are_unaffected(self):
        main = _load()
        subs = _subscriptions(main)
        self.assertIn(main.topic("display/reading"), subs)
        self.assertIn(main.topic("display/result"), subs)

    def test_a_headless_board_subscribes_to_no_screenshot_even_when_asked(self):
        main = _load(has_display=False, screenshot=True)
        self.assertNotIn(main.topic("screenshot"), _subscriptions(main))

    def test_a_screenshot_message_is_not_queued_when_off_but_is_when_on(self):
        off = _load()
        off.on_message(off.topic("screenshot").encode(), b"", False)
        self.assertEqual(off._pending, [])
        on = _load(screenshot=True)
        on.on_message(on.topic("screenshot").encode(), b"", False)
        self.assertEqual(len(on._pending), 1)

    def test_a_screenshot_already_in_the_queue_is_not_served_when_off(self):
        main = _load()

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
        main.ui = types.SimpleNamespace(
            init=lambda: None,
            on_wifi_change=lambda c: None,
            on_mqtt_change=lambda c: None,
            check_timeout=lambda: None,
        )
        main._pending = [(main.topic("screenshot"), b"")]

        async def scenario():
            task = asyncio.create_task(main.main())
            for _ in range(5):
                await asyncio.sleep(0.01)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        asyncio.run(scenario())
        self.assertEqual(main.board.display_dev.reads, 0)

    def test_a_quoted_flag_is_refused(self):
        with self.assertRaises(ValueError) as ctx:
            _load(screenshot="true")
        self.assertIn("screenshot", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
