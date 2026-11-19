"""Host-runnable test: a full scan batch stays under the broker's packet limit.

The embedded broker on the host closes a connection whose MQTT packet is over
1 MiB (src/ble/embedded-broker.ts, EMBEDDED_BROKER_LIMITS.maxPacketBytes). The
largest packet the firmware sends is the `scan/results` JSON, so the worst
entry the parser can build, repeated up to the board's MAX_SCAN_ENTRIES, has to
stay below that limit or the board would loop on reconnects.

Run: python -m unittest discover -s firmware/tests
"""

import json
import os
import re
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)

# Same stubs as test_ad_parser.py: ble_bridge imports MicroPython-only modules.
sys.modules.setdefault("aioble", types.ModuleType("aioble"))
if "bluetooth" not in sys.modules:
    _bt = types.ModuleType("bluetooth")
    _bt.BLE = lambda: None
    sys.modules["bluetooth"] = _bt
sys.modules.setdefault("board", types.ModuleType("board"))

import ble_bridge  # noqa: E402

# EMBEDDED_BROKER_LIMITS.maxPacketBytes in the broker; tests/ble/embedded-broker-firmware-pin.test.ts
# reads this constant and fails when the two differ.
_BROKER_PACKET_LIMIT = 1_048_576


def _largest_scan_cap():
    """Largest MAX_SCAN_ENTRIES of any board_*.py, read from the files."""
    caps = []
    for name in os.listdir(_FIRMWARE_DIR):
        if name.startswith("board_") and name.endswith(".py"):
            with open(os.path.join(_FIRMWARE_DIR, name), encoding="utf-8") as f:
                caps += [int(m) for m in re.findall(r"^MAX_SCAN_ENTRIES\s*=\s*(\d+)", f.read(), re.M)]
    return max(caps)


_MAX_SCAN_ENTRIES = _largest_scan_cap()


def _ad(ad_type, payload):
    return bytes([len(payload) + 1, ad_type]) + payload


def _worst_entry(index):
    """One device built from the richest frames the parser accepts: a name, a
    16-bit and a 128-bit service list, manufacturer data, and eight frames that
    each carry a different 128-bit service data UUID (the merge cap)."""
    addr = bytes([0x84, 0xFC, 0xE6, (index >> 8) & 0xFF, index & 0xFF, 0x1C])
    first = (
        _ad(0x09, b"A-Very-Long-Local-Name")
        + _ad(0x03, b"\x10\x1a\x0f\x18")
        + _ad(0xFF, b"\x4c\x00" + bytes(range(12)))
    )
    seen = {}
    entry = ble_bridge._parse_raw_entry(addr, 1, -50, first)
    ble_bridge._merge_entry(seen, entry)
    for k in range(ble_bridge._MAX_SERVICE_DATA_UUIDS):
        uuid = bytes([k + 1]) * 16
        frame = _ad(0x21, uuid + bytes([0xAB]) * 11)
        ble_bridge._merge_entry(seen, ble_bridge._parse_raw_entry(addr, 1, -60, frame))
    return seen[entry["address"]]


class TestScanPayloadSize(unittest.TestCase):
    def test_worst_case_batch_is_under_the_broker_packet_limit(self):
        results = [_worst_entry(i) for i in range(_MAX_SCAN_ENTRIES)]
        size = len(json.dumps(results))
        self.assertLess(size, _BROKER_PACKET_LIMIT, f"{size} bytes")

    def test_the_worst_entry_really_holds_eight_service_data_uuids(self):
        entry = _worst_entry(0)
        self.assertEqual(len(entry["service_data"]), ble_bridge._MAX_SERVICE_DATA_UUIDS)


if __name__ == "__main__":
    unittest.main()
