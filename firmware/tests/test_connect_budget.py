"""Host-runnable tests: BleBridge.connect(budget_ms=...) never outlives the host.

On an ESP32-S3 a scale with a misreported address type cost a full 15 s probe
on the wrong type, up to 15 s on the right one and up to 10 s of discovery.
The host waits 30 s for `connected`, then gives up and sends `disconnect`, so a
connect that succeeded after that was torn down and the weigh-in lost. With a
budget every attempt is clamped to what is left, leaving room for discovery.

Run: python -m unittest discover -s firmware/tests
"""

import asyncio
import importlib.util
import os
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


class _Clock:
    def __init__(self):
        self.now = 0

    def ticks_ms(self):
        return self.now

    @staticmethod
    def ticks_diff(a, b):
        return a - b


class _Discover:
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class _Conn:
    def services(self):
        return _Discover()

    async def disconnect(self):
        pass

    def is_connected(self):
        return True


def _load_bridge():
    """Import the real ble_bridge.py under its own name with S3-like stubs."""
    ble = types.SimpleNamespace(active=lambda *a: True, irq=lambda h: None)
    bt = types.ModuleType("bluetooth")
    bt.BLE = lambda: ble
    for name, value in (
        ("FLAG_READ", 0x02),
        ("FLAG_WRITE", 0x08),
        ("FLAG_NOTIFY", 0x10),
        ("FLAG_WRITE_NO_RESPONSE", 0x04),
        ("FLAG_INDICATE", 0x20),
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
            "ble_bridge_budget_under_test", os.path.join(_FIRMWARE_DIR, "ble_bridge.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        for name, value in saved.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value
    return mod, aioble


class ConnectBudgetTest(unittest.TestCase):
    def setUp(self):
        self.mod, self.aioble = _load_bridge()
        self.clock = _Clock()
        self.mod.time = self.clock
        self.calls = []
        clock, calls = self.clock, self.calls

        class _Device:
            # The scale really is public (0); the scan reported random (1).
            def __init__(self, addr_type, addr_bytes):
                self.addr_type = addr_type

            async def connect(self, timeout_ms=None, scan_duration_ms=None):
                calls.append((self.addr_type, timeout_ms, scan_duration_ms))
                if self.addr_type == 1:
                    clock.now += timeout_ms
                    raise asyncio.TimeoutError()
                clock.now += 1000
                return _Conn()

        self.aioble.Device = _Device

    def _connect(self, budget_ms):
        bridge = self.mod.BleBridge()
        return asyncio.run(bridge.connect("FF:03:00:53:D6:4D", 1, budget_ms=budget_ms))

    def test_wrong_type_fallback_fits_the_host_budget(self):
        result = self._connect(25000)
        self.assertEqual(result, {"chars": []})
        self.assertEqual([c[0] for c in self.calls], [1, 0])
        # Every attempt plus the discovery reserve stays inside the budget.
        self.assertLessEqual(self.clock.now + self.mod.CONNECT_DISCOVERY_RESERVE_MS, 25000)
        for _type, timeout_ms, scan_ms in self.calls:
            self.assertLessEqual(timeout_ms, 15000)
            self.assertLessEqual(scan_ms, timeout_ms)

    def test_no_attempt_is_started_without_time_left(self):
        # The busy wait ate most of the budget: the wrong-type probe gets what
        # is left, and the fallback is not started past the deadline.
        with self.assertRaises(asyncio.TimeoutError):
            self._connect(8000)
        self.assertEqual(len(self.calls), 1)
        self.assertLessEqual(self.clock.now, 8000)

    def test_without_a_budget_the_board_timeouts_are_unchanged(self):
        bridge = self.mod.BleBridge()
        asyncio.run(bridge.connect("FF:03:00:53:D6:4D", 1))
        self.assertEqual(self.calls[0], (1, 15000, 15000))
        self.assertEqual(self.calls[1], (0, 15000, 15000))


if __name__ == "__main__":
    unittest.main()
