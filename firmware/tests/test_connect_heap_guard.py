"""Host-runnable tests for the pre-connect IDF-heap guard (#139).

ble_bridge.py reads the ESP-IDF data heap right before a GATT connect and
refuses the connect when the heap is too low, turning the un-catchable NimBLE
C panic on a no-PSRAM board into a clean MemoryError skip. The skip decision is
a pure function so it is tested directly here; the heap read itself returns None
off-device (no esp32 builtin), so the gate no-ops in these host tests.

Run: python -m unittest discover -s firmware/tests
"""

import os
import sys
import types
import unittest
from unittest import mock

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)


_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: None
_bt.FLAG_READ = 0x02
_bt.FLAG_WRITE = 0x08
_bt.FLAG_NOTIFY = 0x10
_bt.FLAG_WRITE_NO_RESPONSE = 0x04
_bt.FLAG_INDICATE = 0x20
sys.modules["bluetooth"] = _bt

_aioble_core = types.ModuleType("aioble.core")
_aioble_core.ble_irq = lambda event, data: None

_aioble = types.ModuleType("aioble")
_aioble.core = _aioble_core
_aioble.ADDR_PUBLIC = 0
_aioble.ADDR_RANDOM = 1
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

# test_auto_connect stubs sys.modules["ble_bridge"] with a SimpleNamespace; drop
# it so the real firmware module imports under the stubs installed above.
sys.modules.pop("ble_bridge", None)
import ble_bridge  # noqa: E402


class TestHeapGuardDecision(unittest.TestCase):
    """The pure skip-decision function and the always-on crash floors (#139)."""

    def test_crash_floor_constants(self):
        self.assertEqual(ble_bridge.CRASH_FLOOR_LARGEST, 1024)
        self.assertEqual(ble_bridge.CRASH_FLOOR_FREE, 2048)

    def test_skips_at_observed_crash_values(self):
        # Reporter heap at the crash: free=392 largest=336, far below the floor.
        self.assertTrue(
            ble_bridge._should_skip_connect(
                392, 336, ble_bridge.CRASH_FLOOR_FREE, ble_bridge.CRASH_FLOOR_LARGEST
            )
        )

    def test_does_not_skip_at_healthy_values(self):
        # Tens of KB, like a PSRAM board: never gated by the crash floor.
        self.assertFalse(
            ble_bridge._should_skip_connect(
                80000, 40000, ble_bridge.CRASH_FLOOR_FREE, ble_bridge.CRASH_FLOOR_LARGEST
            )
        )

    def test_board_override_can_raise_the_bar(self):
        # A value that clears the crash floor but a non-zero board floor refuses.
        self.assertFalse(ble_bridge._should_skip_connect(20000, 5000, 16384, 4096))
        # Largest floor raised above the value: skip.
        self.assertTrue(ble_bridge._should_skip_connect(20000, 5000, 16384, 8192))
        # Free floor raised above the value: skip.
        self.assertTrue(ble_bridge._should_skip_connect(20000, 5000, 32768, 4096))

    def test_boundary_is_not_skipped(self):
        # A value exactly at the floor is allowed (strict less-than).
        self.assertFalse(ble_bridge._should_skip_connect(2048, 1024, 2048, 1024))

    def test_read_idf_heap_is_none_off_device(self):
        # No esp32 builtin on a host, so the read returns None and the gate skips.
        self.assertIsNone(ble_bridge._read_idf_heap())

    def test_zero_board_override_collapses_to_crash_floor(self):
        # The gate composes the effective floor as max(crash floor, board tunable).
        # A board override of 0 (the shipped default) collapses to the crash floor,
        # which keeps the gate crash-floor-only on every board. The gate in
        # connect() MUST use this identical max(...) expression.
        self.assertEqual(max(ble_bridge.CRASH_FLOOR_LARGEST, 0), 1024)
        self.assertEqual(max(ble_bridge.CRASH_FLOOR_FREE, 0), 2048)


# ESP-IDF capability bits (components/heap/include/esp_heap_caps.h, v5.5.1).
_CAP_EXEC = 1 << 0
_CAP_32BIT = 1 << 1
_CAP_8BIT = 1 << 2
_CAP_DMA = 1 << 3
_CAP_SPIRAM = 1 << 10
_CAP_INTERNAL = 1 << 11
_CAP_DEFAULT = 1 << 12


def _fake_esp32(regions):
    """esp32 builtin stand-in. regions: [(caps, (total, free, largest, min_free))].

    idf_heap_info(cap) returns every region holding ALL bits of cap, which is
    what MicroPython's modesp32.c does through ESP-IDF's heap_caps_match().
    """
    mod = types.ModuleType("esp32")
    mod.HEAP_DATA = _CAP_8BIT
    mod.HEAP_EXEC = _CAP_EXEC
    mod.idf_heap_info = lambda cap: [info for caps, info in regions if caps & cap == cap]
    return mod


_INTERNAL_DRAM = _CAP_8BIT | _CAP_32BIT | _CAP_DEFAULT | _CAP_INTERNAL | _CAP_DMA
# How ESP-IDF registers PSRAM with CONFIG_SPIRAM_USE_MALLOC (esp_psram.c).
_PSRAM = _CAP_SPIRAM | _CAP_DEFAULT | _CAP_8BIT | _CAP_32BIT


class TestIdfHeapReadPool(unittest.TestCase):
    """The guard protects NimBLE, which allocates internal RAM only (H-19).

    ESP-IDF's default BT_NIMBLE_MEM_ALLOC_MODE_INTERNAL allocates with
    MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT, and MicroPython's S3 SPIRAM builds
    add PSRAM to the IDF heap as an 8-bit region. esp32.HEAP_DATA alone
    (MALLOC_CAP_8BIT) therefore counted megabytes of PSRAM the connect can
    never use.
    """

    def _read(self, regions):
        with mock.patch.dict(sys.modules, {"esp32": _fake_esp32(regions)}):
            return ble_bridge._read_idf_heap()

    def test_psram_board_reports_internal_ram_only(self):
        regions = [
            (_INTERNAL_DRAM, (300000, 30000, 20000, 25000)),
            (_INTERNAL_DRAM, (50000, 4000, 3000, 3500)),
            (_PSRAM, (8388608, 2000000, 1900000, 1800000)),
        ]
        self.assertEqual(self._read(regions), (34000, 20000))

    def test_starved_internal_ram_is_seen_despite_free_psram(self):
        regions = [
            (_INTERNAL_DRAM, (300000, 392, 336, 300)),
            (_PSRAM, (8388608, 2000000, 1900000, 1800000)),
        ]
        free, largest = self._read(regions)
        self.assertTrue(
            ble_bridge._should_skip_connect(
                free, largest, ble_bridge.CRASH_FLOOR_FREE, ble_bridge.CRASH_FLOOR_LARGEST
            )
        )

    def test_board_without_psram_is_unchanged(self):
        regions = [
            (_INTERNAL_DRAM, (100000, 40000, 30000, 35000)),
            (_INTERNAL_DRAM, (20000, 5000, 4000, 4500)),
            (_CAP_EXEC | _CAP_32BIT | _CAP_INTERNAL, (60000, 20000, 20000, 20000)),
        ]
        self.assertEqual(self._read(regions), (45000, 30000))


if __name__ == "__main__":
    unittest.main()
