"""Host-runnable tests: the 60 s "scale detected" debounce survives ticks_ms wrap.

MicroPython's ticks_diff() returns a signed value in +-TICKS_PERIOD/2, and the
ESP32 port wraps ticks_ms at 2**30 ms, so half a period is about 6.2 days.
_check_scale_beep compared ticks_diff(now, last_beep) > 60000, which turns
negative once the last beep is more than ~6.2 days old: a scale weighed again
after a week away got no beep and no SCALE_DETECTED screen for up to another
6.2 days. The previous host tests stubbed ticks_diff as plain subtraction,
which never wraps, so this file uses the real wrap arithmetic.

Run: python -m unittest discover -s firmware/tests
"""

import types
import unittest

from _main_loader import VALID_CONFIG, load_main

_TICKS_PERIOD = 1 << 30
_TICKS_MAX = _TICKS_PERIOD - 1
_TICKS_HALFPERIOD = _TICKS_PERIOD // 2

_DAY_MS = 24 * 60 * 60 * 1000
_MAC = "AA:BB:CC:DD:EE:FF"


class _WrappingTicks:
    """ticks_ms/ticks_diff with the semantics of MicroPython's ESP32 port."""

    def __init__(self, start_ms):
        self.elapsed = start_ms

    def ticks_ms(self):
        return self.elapsed & _TICKS_MAX

    @staticmethod
    def ticks_diff(end, start):
        return ((end - start + _TICKS_HALFPERIOD) & _TICKS_MAX) - _TICKS_HALFPERIOD


class ScaleBeepDebounceTest(unittest.TestCase):
    def setUp(self):
        self.main = load_main(VALID_CONFIG, HAS_BEEP=True)
        self.beeps = []
        self.main.beep = lambda *a, **k: self.beeps.append(a)
        self.main._scale_macs = {_MAC}
        self.clock = _WrappingTicks(5 * _DAY_MS)
        self.main.time = types.SimpleNamespace(
            ticks_ms=self.clock.ticks_ms, ticks_diff=self.clock.ticks_diff
        )

    def _seen(self):
        self.main._check_scale_beep([{"address": _MAC}])

    def test_first_sighting_after_boot_beeps(self):
        # ticks_ms starts near 0 at boot, and a "last beep" of 0 used to
        # swallow every sighting of the first minute.
        self.clock.elapsed = 10_000
        self._seen()
        self.assertEqual(len(self.beeps), 1)

    def test_second_sighting_within_a_minute_is_debounced(self):
        self._seen()
        self.clock.elapsed += 30_000
        self._seen()
        self.assertEqual(len(self.beeps), 1)

    def test_sighting_after_a_minute_beeps_again(self):
        self._seen()
        self.clock.elapsed += 61_000
        self._seen()
        self.assertEqual(len(self.beeps), 2)

    def test_sighting_after_a_week_without_weighing_beeps(self):
        self._seen()
        self.clock.elapsed += 7 * _DAY_MS
        self._seen()
        self.assertEqual(len(self.beeps), 2)

    def test_sighting_after_ten_days_without_weighing_beeps(self):
        self._seen()
        self.clock.elapsed += 10 * _DAY_MS
        self._seen()
        self.assertEqual(len(self.beeps), 2)

    def test_scan_results_without_the_scale_expire_an_old_mark(self):
        # Scan results arrive every few seconds, scale or not; once the minute
        # is over the mark is gone, so no later wrap can bring it back.
        self._seen()
        beeped_at = self.clock.elapsed
        for _ in range(3):
            self.clock.elapsed += 40_000
            self.main._check_scale_beep([{"address": "11:22:33:44:55:66"}])
        # One full wrap plus 30 s after the beep, where a kept mark would read
        # as only 30 s old again.
        self.clock.elapsed = beeped_at + _TICKS_PERIOD + 30_000
        self._seen()
        self.assertEqual(len(self.beeps), 2)


if __name__ == "__main__":
    unittest.main()
