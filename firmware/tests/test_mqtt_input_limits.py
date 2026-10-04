"""Host-runnable tests: MQTT commands cannot stall the firmware's main loop.

- `beep` took freq, duration and repeat from the payload unchecked. beep.py
  builds the whole tone in RAM (4 bytes per sample at 8 kHz, so 60 s is
  1.92 MB) and I2S.write blocks the event loop for the length of the tone.
- `screenshot` publishes about 113 QoS 1 chunks and waits for each PUBACK. The
  main loop handles no other command meanwhile, including the write/ and
  read/ commands of a live GATT session, so it is refused while a BLE
  connection is being made or is up.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
import importlib.util
import os
import sys
import types
import unittest
from unittest import mock

from _main_loader import FIRMWARE_DIR, VALID_CONFIG, load_main

_SAMPLE_RATE = 8000


def _load_beep():
    board = types.ModuleType("board")
    board.HAS_BEEP = True
    board.BEEP_PINS = {"sck": 0, "ws": 1, "sd": 2}
    with mock.patch.dict(sys.modules, {"board": board}):
        spec = importlib.util.spec_from_file_location(
            "beep_under_test", os.path.join(FIRMWARE_DIR, "beep.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    return mod


class _RecordingI2S:
    def __init__(self):
        self.written = 0
        self.writes = 0

    def write(self, buf):
        self.written += len(buf)
        self.writes += 1


class BeepLimitsTest(unittest.TestCase):
    def setUp(self):
        self.beep = _load_beep()
        self.i2s = _RecordingI2S()
        self.beep._i2s = self.i2s

    def _played_ms(self):
        return self.i2s.written * 1000 // (_SAMPLE_RATE * 4)

    def test_server_beeps_are_played_unchanged(self):
        # The patterns src/runtime/processor.ts sends.
        self.beep.beep(600, 150, 3)
        self.assertEqual(self._played_ms(), 3 * 150 + 2 * 400)
        self.i2s.written = 0
        self.beep.beep(1200, 200, 2)
        self.assertEqual(self._played_ms(), 2 * 200 + 400)
        self.i2s.written = 0
        self.beep.beep()
        self.assertEqual(self._played_ms(), 200)

    def test_long_duration_is_capped(self):
        self.beep.beep(1000, 60000, 1)
        self.assertLessEqual(self._played_ms(), self.beep.MAX_DURATION_MS)
        self.assertLessEqual(self.beep.MAX_DURATION_MS, 1000)

    def test_repeat_is_capped(self):
        self.beep.beep(1000, 100, 1000)
        tones = (self.i2s.writes + 1) // 2
        self.assertLessEqual(tones, self.beep.MAX_REPEAT)
        self.assertLessEqual(self.beep.MAX_REPEAT, 5)

    def test_worst_case_blocks_for_a_few_seconds_at_most(self):
        self.beep.beep(50000, 60000, 1000)
        self.assertLessEqual(self._played_ms(), 3000)

    def test_zero_or_negative_values_play_nothing_harmful(self):
        self.beep.beep(1000, -5, -5)
        self.assertLessEqual(self._played_ms(), self.beep.MAX_DURATION_MS)

    def test_frequency_is_kept_below_nyquist(self):
        captured = []
        real = self.beep._generate_tone
        self.beep._generate_tone = lambda f, d: captured.append(f) or real(f, d)
        self.beep.beep(50000, 10, 1)
        self.assertLessEqual(captured[0], _SAMPLE_RATE // 2)


class _FakeDisplay:
    def __init__(self):
        self.reads = 0

    def framebuffer(self, _index):
        self.reads += 1
        return bytearray(4096 * 3)


class ScreenshotGuardTest(unittest.TestCase):
    def setUp(self):
        self.display = _FakeDisplay()
        self.main = load_main(
            VALID_CONFIG,
            HAS_DISPLAY=True,
            display_dev=self.display,
            DISPLAY_WIDTH=480,
            DISPLAY_HEIGHT=480,
        )
        fast = types.SimpleNamespace(**{k: getattr(asyncio, k) for k in dir(asyncio) if not k.startswith("__")})

        async def _no_wait(_ms=0):
            pass

        fast.sleep_ms = _no_wait
        self.main.asyncio = fast

    def _chunks(self):
        return [t for t, _ in self.main.client.published if t.startswith(self.main.topic("screenshot/"))]

    def _errors(self):
        return [m for t, m in self.main.client.published if t == self.main.topic("error")]

    def test_screenshot_is_sent_when_the_radio_is_idle(self):
        asyncio.run(self.main.handle_screenshot())
        self.assertEqual(self.display.reads, 1)
        # info, three 4 KB chunks, done
        self.assertEqual(len(self._chunks()), 5)

    def test_screenshot_is_refused_during_a_gatt_session(self):
        self.main._scan_paused = True
        asyncio.run(self.main.handle_screenshot())
        self.assertEqual(self.display.reads, 0)
        self.assertEqual(self._chunks(), [])
        self.assertEqual(len(self._errors()), 1)
        self.assertIn('"op": "screenshot"', self._errors()[0])

    def test_transfer_stops_when_an_autonomous_connect_starts(self):
        main = self.main
        real_publish = main.client.publish

        async def publish(topic, msg, retain=False, qos=0):
            await real_publish(topic, msg, retain=retain, qos=qos)
            if topic == main.topic("screenshot/0"):
                main._busy = True  # the scan task took the radio meanwhile

        main.client.publish = publish
        asyncio.run(main.handle_screenshot())
        self.assertNotIn(main.topic("screenshot/1"), self._chunks())
        self.assertNotIn(main.topic("screenshot/done"), self._chunks())
        self.assertEqual(len(self._errors()), 1)

    def test_screenshot_is_refused_while_a_connect_is_running(self):
        for flag in ("_busy", "_host_connect_pending"):
            with self.subTest(flag=flag):
                self.main.client.published.clear()
                self.main._scan_paused = False
                self.main._busy = False
                self.main._host_connect_pending = False
                setattr(self.main, flag, True)
                asyncio.run(self.main.handle_screenshot())
                self.assertEqual(self.display.reads, 0)
                self.assertEqual(self._chunks(), [])


if __name__ == "__main__":
    unittest.main()
