"""Host-runnable tests for the BLE advertisement parser in ble_bridge.

Runs under CPython by stubbing the MicroPython-only modules (aioble,
bluetooth, board) before importing the firmware module. Covers all AD
types the parser recognizes, malformed/truncated input, and the
_merge_entry dedup semantics.

Run: python -m unittest discover -s firmware/tests
"""

import os
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)

# Stub MicroPython-only modules before importing ble_bridge.
# - aioble: referenced only at runtime in connect()/disconnect()
# - bluetooth: ble_bridge calls bluetooth.BLE() at import time
# - board: ble_bridge `import board` resolves attributes lazily
sys.modules["aioble"] = types.ModuleType("aioble")
_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: None
sys.modules["bluetooth"] = _bt
sys.modules["board"] = types.ModuleType("board")

import ble_bridge  # noqa: E402


# ─── helpers ─────────────────────────────────────────────────────────────────

def _ad(ad_type, payload):
    """Build one AD structure: length byte + type byte + payload bytes."""
    return bytes([len(payload) + 1, ad_type]) + payload


def _uuid_le(canonical_hex):
    """Convert canonical 32-char hex UUID to little-endian wire bytes."""
    return bytes.fromhex(canonical_hex)[::-1]


# Yunmai vendor service 0x1A10 in canonical 128-bit form.
_UUID_1A10_FULL = "00001a10" + ble_bridge._BT_BASE_SUFFIX
_UUID_1A10_LE = _uuid_le(_UUID_1A10_FULL)

_MAC = b"\x84\xfc\xe6\x53\x06\x1c"
_MAC_STR = "84:FC:E6:53:06:1C"


def _parse(raw, addr_type=0, rssi=-50):
    return ble_bridge._parse_raw_entry(_MAC, addr_type, rssi, raw)


# ─── _parse_raw_entry ────────────────────────────────────────────────────────


class TestParseRawEntry(unittest.TestCase):
    def test_address_and_rssi_passthrough(self):
        entry = _parse(b"", addr_type=1, rssi=-77)
        self.assertEqual(entry["address"], _MAC_STR)
        self.assertEqual(entry["rssi"], -77)
        self.assertEqual(entry["addr_type"], 1)

    def test_empty_raw_yields_empty_fields(self):
        entry = _parse(b"")
        self.assertEqual(entry["name"], "")
        self.assertEqual(entry["services"], [])
        self.assertNotIn("service_data", entry)
        self.assertNotIn("manufacturer_id", entry)

    def test_local_name_complete(self):
        entry = _parse(_ad(0x09, b"ES-CS20M"))
        self.assertEqual(entry["name"], "ES-CS20M")

    def test_local_name_shortened(self):
        entry = _parse(_ad(0x08, b"ES-CS"))
        self.assertEqual(entry["name"], "ES-CS")

    def test_16bit_service_uuid_single(self):
        # 0x1A10 little-endian = 10 1a
        entry = _parse(_ad(0x03, bytes([0x10, 0x1A])))
        self.assertEqual(entry["services"], ["1a10"])

    def test_16bit_service_uuid_multi(self):
        # 0x180F (battery) + 0x180A (device info), both LE
        entry = _parse(_ad(0x02, bytes([0x0F, 0x18, 0x0A, 0x18])))
        self.assertEqual(entry["services"], ["180f", "180a"])

    def test_32bit_service_uuid_expanded(self):
        # 0x12345678 LE = 78 56 34 12
        entry = _parse(_ad(0x05, bytes([0x78, 0x56, 0x34, 0x12])))
        self.assertEqual(entry["services"], ["12345678" + ble_bridge._BT_BASE_SUFFIX])

    def test_128bit_service_uuid_complete(self):
        entry = _parse(_ad(0x07, _UUID_1A10_LE))
        self.assertEqual(entry["services"], [_UUID_1A10_FULL])

    def test_128bit_service_uuid_incomplete(self):
        # 0x06 uses identical code path; verify it's wired up.
        entry = _parse(_ad(0x06, _UUID_1A10_LE))
        self.assertEqual(entry["services"], [_UUID_1A10_FULL])

    def test_service_data_16bit_with_payload(self):
        # Exposure notification UUID 0xFD6F + data "cafe"
        entry = _parse(_ad(0x16, bytes([0x6F, 0xFD, 0xCA, 0xFE])))
        self.assertEqual(entry["service_data"], [{"uuid": "fd6f", "data": "cafe"}])

    def test_service_data_16bit_uuid_only(self):
        # 2-byte payload = UUID only, empty data portion.
        entry = _parse(_ad(0x16, bytes([0x6F, 0xFD])))
        self.assertEqual(entry["service_data"], [{"uuid": "fd6f", "data": ""}])

    def test_service_data_32bit(self):
        entry = _parse(_ad(0x20, bytes([0x78, 0x56, 0x34, 0x12, 0xAB])))
        self.assertEqual(
            entry["service_data"],
            [{"uuid": "12345678" + ble_bridge._BT_BASE_SUFFIX, "data": "ab"}],
        )

    def test_service_data_128bit(self):
        entry = _parse(_ad(0x21, _UUID_1A10_LE + bytes([0xAA, 0xBB])))
        self.assertEqual(
            entry["service_data"],
            [{"uuid": _UUID_1A10_FULL, "data": "aabb"}],
        )

    def test_manufacturer_specific(self):
        # mfr id 0x004C (Apple) + data ff ee
        entry = _parse(_ad(0xFF, bytes([0x4C, 0x00, 0xFF, 0xEE])))
        self.assertEqual(entry["manufacturer_id"], 0x004C)
        self.assertEqual(entry["manufacturer_data"], "ffee")

    def test_mixed_advert(self):
        # Local name + 128-bit UUID + manufacturer data in one buffer.
        raw = (
            _ad(0x09, b"ES-CS20M")
            + _ad(0x07, _UUID_1A10_LE)
            + _ad(0xFF, bytes([0x4C, 0x00, 0x01, 0x02]))
        )
        entry = _parse(raw)
        self.assertEqual(entry["name"], "ES-CS20M")
        self.assertEqual(entry["services"], [_UUID_1A10_FULL])
        self.assertEqual(entry["manufacturer_id"], 0x004C)
        self.assertEqual(entry["manufacturer_data"], "0102")
        self.assertNotIn("service_data", entry)

    def test_length_zero_terminates(self):
        # Zero-length AD marks end of payload; trailing bytes ignored.
        raw = _ad(0x09, b"OK") + b"\x00\xFF\xFF"
        entry = _parse(raw)
        self.assertEqual(entry["name"], "OK")

    def test_malformed_32bit_partial_payload(self):
        # 3 bytes for a 32-bit UUID list → no partial UUID emitted.
        entry = _parse(_ad(0x05, bytes([0xAA, 0xBB, 0xCC])))
        self.assertEqual(entry["services"], [])

    def test_malformed_128bit_partial_payload(self):
        entry = _parse(_ad(0x07, bytes(range(15))))
        self.assertEqual(entry["services"], [])

    def test_truncated_ad_structure(self):
        # Declared length runs past buffer end — slice clips silently.
        raw = bytes([0x10, 0x07]) + bytes([0x01, 0x02])  # declares 16 bytes, has 2
        entry = _parse(raw)
        # Slice yields 2 bytes; 128-bit iteration needs 16 → emits nothing, no crash.
        self.assertEqual(entry["services"], [])

    def test_length_byte_at_end_of_buffer(self):
        # Length byte without a type byte after it must not raise.
        entry = _parse(b"\x05")
        self.assertEqual(entry["services"], [])

    def test_service_data_only_no_other_fields(self):
        # Confirms service_data key is emitted even when name/mfr are absent.
        entry = _parse(_ad(0x16, bytes([0x10, 0x1A, 0x42])))
        self.assertEqual(entry["service_data"], [{"uuid": "1a10", "data": "42"}])
        self.assertEqual(entry["name"], "")
        self.assertNotIn("manufacturer_id", entry)


# ─── _merge_entry ────────────────────────────────────────────────────────────


class TestMergeEntry(unittest.TestCase):
    def _entry(self, **overrides):
        base = {
            "address": _MAC_STR,
            "name": "",
            "rssi": -80,
            "services": [],
            "addr_type": 0,
        }
        base.update(overrides)
        return base

    def test_new_mac_inserts_as_is(self):
        seen = {}
        entry = self._entry(name="hello", rssi=-50)
        ble_bridge._merge_entry(seen, entry)
        self.assertIs(seen[_MAC_STR], entry)

    def test_stronger_rssi_replaces_weaker(self):
        seen = {}
        ble_bridge._merge_entry(seen, self._entry(rssi=-80))
        ble_bridge._merge_entry(seen, self._entry(rssi=-60))
        self.assertEqual(seen[_MAC_STR]["rssi"], -60)

    def test_weaker_rssi_does_not_overwrite(self):
        seen = {}
        ble_bridge._merge_entry(seen, self._entry(rssi=-50))
        ble_bridge._merge_entry(seen, self._entry(rssi=-90))
        self.assertEqual(seen[_MAC_STR]["rssi"], -50)

    def test_name_fills_in_when_empty(self):
        seen = {}
        ble_bridge._merge_entry(seen, self._entry(name=""))
        ble_bridge._merge_entry(seen, self._entry(name="scale"))
        self.assertEqual(seen[_MAC_STR]["name"], "scale")

    def test_name_preserved_when_already_present(self):
        seen = {}
        ble_bridge._merge_entry(seen, self._entry(name="first"))
        ble_bridge._merge_entry(seen, self._entry(name="second"))
        self.assertEqual(seen[_MAC_STR]["name"], "first")

    def test_manufacturer_data_fills_in(self):
        seen = {}
        ble_bridge._merge_entry(seen, self._entry())
        ble_bridge._merge_entry(
            seen,
            self._entry(manufacturer_id=0x004C, manufacturer_data="ff"),
        )
        self.assertEqual(seen[_MAC_STR]["manufacturer_id"], 0x004C)
        self.assertEqual(seen[_MAC_STR]["manufacturer_data"], "ff")

    def test_manufacturer_data_preserved(self):
        seen = {}
        ble_bridge._merge_entry(
            seen, self._entry(manufacturer_id=0x0059, manufacturer_data="aa")
        )
        ble_bridge._merge_entry(
            seen, self._entry(manufacturer_id=0x004C, manufacturer_data="bb")
        )
        self.assertEqual(seen[_MAC_STR]["manufacturer_id"], 0x0059)
        self.assertEqual(seen[_MAC_STR]["manufacturer_data"], "aa")

    def test_services_fill_in(self):
        seen = {}
        ble_bridge._merge_entry(seen, self._entry())
        ble_bridge._merge_entry(seen, self._entry(services=["1a10"]))
        self.assertEqual(seen[_MAC_STR]["services"], ["1a10"])

    def test_services_preserved(self):
        seen = {}
        ble_bridge._merge_entry(seen, self._entry(services=["1a10"]))
        ble_bridge._merge_entry(seen, self._entry(services=["180f"]))
        self.assertEqual(seen[_MAC_STR]["services"], ["1a10"])

    def test_service_data_fill_in(self):
        seen = {}
        ble_bridge._merge_entry(seen, self._entry())
        ble_bridge._merge_entry(
            seen,
            self._entry(service_data=[{"uuid": "1a10", "data": "ab"}]),
        )
        self.assertEqual(
            seen[_MAC_STR]["service_data"],
            [{"uuid": "1a10", "data": "ab"}],
        )

    def test_service_data_preserved(self):
        seen = {}
        ble_bridge._merge_entry(
            seen, self._entry(service_data=[{"uuid": "1a10", "data": "01"}])
        )
        ble_bridge._merge_entry(
            seen, self._entry(service_data=[{"uuid": "1a10", "data": "02"}])
        )
        self.assertEqual(
            seen[_MAC_STR]["service_data"],
            [{"uuid": "1a10", "data": "01"}],
        )


class TestRawHasMac(unittest.TestCase):
    """_raw_has_mac: non-destructive peek of the streaming IRQ buffer (#201)."""

    @staticmethod
    def _raw(addr_bytes):
        # (addr_bytes, addr_type, rssi, adv_raw) — the streaming IRQ tuple shape.
        return (addr_bytes, 0, -50, b"")

    def test_empty_buffer(self):
        self.assertFalse(ble_bridge._raw_has_mac([], {_MAC_STR}))

    def test_no_known_mac_present(self):
        raw = [self._raw(b"\x11\x22\x33\x44\x55\x66")]
        self.assertFalse(ble_bridge._raw_has_mac(raw, {_MAC_STR}))

    def test_known_mac_present(self):
        raw = [self._raw(b"\x11\x22\x33\x44\x55\x66"), self._raw(_MAC)]
        self.assertTrue(ble_bridge._raw_has_mac(raw, {_MAC_STR}))

    def test_empty_mac_set(self):
        self.assertFalse(ble_bridge._raw_has_mac([self._raw(_MAC)], set()))

    def test_address_formatted_uppercase_colon(self):
        # The buffer's address bytes must format to the same uppercase
        # colon-separated MAC the config topic carries; a lowercase set entry
        # must therefore not match.
        self.assertFalse(ble_bridge._raw_has_mac([self._raw(_MAC)], {_MAC_STR.lower()}))


if __name__ == "__main__":
    unittest.main()
