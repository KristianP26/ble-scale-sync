"""Host-runnable tests for the BLE advertisement parser in ble_bridge.

Runs under CPython by stubbing the MicroPython-only modules (aioble,
bluetooth, board) before importing the firmware module. Covers all AD
types the parser recognizes, malformed/truncated input, and the
_merge_entry dedup semantics (latest-wins for changing fields, H-06).

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

    def test_rssi_latest_wins_when_stronger(self):
        seen = {}
        ble_bridge._merge_entry(seen, self._entry(rssi=-80))
        ble_bridge._merge_entry(seen, self._entry(rssi=-60))
        self.assertEqual(seen[_MAC_STR]["rssi"], -60)

    def test_rssi_latest_wins_when_weaker(self):
        # H-06: RSSI is a live value, the newest frame reports the current link.
        seen = {}
        ble_bridge._merge_entry(seen, self._entry(rssi=-50))
        ble_bridge._merge_entry(seen, self._entry(rssi=-90))
        self.assertEqual(seen[_MAC_STR]["rssi"], -90)

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

    def test_manufacturer_data_latest_wins(self):
        # H-06: a broadcast scale changes its payload while the user stands on
        # it (unstable, then stable, then impedance), so the newest frame wins.
        seen = {}
        ble_bridge._merge_entry(
            seen, self._entry(manufacturer_id=0x0059, manufacturer_data="aa")
        )
        ble_bridge._merge_entry(
            seen, self._entry(manufacturer_id=0x004C, manufacturer_data="bb")
        )
        self.assertEqual(seen[_MAC_STR]["manufacturer_id"], 0x004C)
        self.assertEqual(seen[_MAC_STR]["manufacturer_data"], "bb")

    def test_manufacturer_data_kept_when_newer_frame_lacks_it(self):
        # A scan response (name only) must not wipe the advertisement payload.
        seen = {}
        ble_bridge._merge_entry(
            seen, self._entry(manufacturer_id=0x0059, manufacturer_data="aa")
        )
        ble_bridge._merge_entry(seen, self._entry(name="scale"))
        self.assertEqual(seen[_MAC_STR]["manufacturer_id"], 0x0059)
        self.assertEqual(seen[_MAC_STR]["manufacturer_data"], "aa")
        self.assertEqual(seen[_MAC_STR]["name"], "scale")

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

    def test_service_data_latest_wins_per_uuid(self):
        # H-06: Mi Scale 2 style service data changes between frames; the
        # newest payload for the same UUID replaces the older one.
        seen = {}
        ble_bridge._merge_entry(
            seen, self._entry(service_data=[{"uuid": "181b", "data": "01"}])
        )
        ble_bridge._merge_entry(
            seen, self._entry(service_data=[{"uuid": "181b", "data": "02"}])
        )
        self.assertEqual(
            seen[_MAC_STR]["service_data"],
            [{"uuid": "181b", "data": "02"}],
        )

    def test_service_data_other_uuid_kept(self):
        # A UUID carried only by another frame type (ADV vs scan response)
        # stays, so the published set does not flicker between drains.
        seen = {}
        ble_bridge._merge_entry(
            seen, self._entry(service_data=[{"uuid": "181b", "data": "01"}])
        )
        ble_bridge._merge_entry(
            seen, self._entry(service_data=[{"uuid": "fe95", "data": "aa"}])
        )
        ble_bridge._merge_entry(
            seen, self._entry(service_data=[{"uuid": "181b", "data": "02"}])
        )
        self.assertEqual(
            seen[_MAC_STR]["service_data"],
            [{"uuid": "181b", "data": "02"}, {"uuid": "fe95", "data": "aa"}],
        )

    def test_service_data_kept_when_newer_frame_lacks_it(self):
        seen = {}
        ble_bridge._merge_entry(
            seen, self._entry(service_data=[{"uuid": "181b", "data": "01"}])
        )
        ble_bridge._merge_entry(seen, self._entry(name="MIBFS"))
        self.assertEqual(
            seen[_MAC_STR]["service_data"],
            [{"uuid": "181b", "data": "01"}],
        )

    def test_service_data_uuid_count_is_bounded(self):
        # Memory bound: a peripheral rotating service data UUIDs cannot grow
        # one seen entry without limit across the SEEN_RESET_CYCLES window.
        seen = {}
        cap = ble_bridge._MAX_SERVICE_DATA_UUIDS
        for k in range(cap + 5):
            ble_bridge._merge_entry(
                seen, self._entry(service_data=[{"uuid": "%04x" % k, "data": "00"}])
            )
        self.assertEqual(len(seen[_MAC_STR]["service_data"]), cap)
        # A known UUID still updates once the cap is reached.
        ble_bridge._merge_entry(
            seen, self._entry(service_data=[{"uuid": "0000", "data": "ff"}])
        )
        self.assertEqual(seen[_MAC_STR]["service_data"][0], {"uuid": "0000", "data": "ff"})


class TestStreamingDrainLatestFrame(unittest.TestCase):
    """H-06: every streaming drain must publish the newest frame of each MAC.

    _seen keeps one entry per MAC across SEEN_RESET_CYCLES drains (so a device
    that advertises slower than PUBLISH_INTERVAL_MS stays in the published
    list, and memory is bounded by MACs, not frames), but the entry must carry
    the latest payload, not the first one captured in the window.
    """

    _OTHER = b"\x11\x22\x33\x44\x55\x66"

    def setUp(self):
        self._board = types.SimpleNamespace(SEEN_RESET_CYCLES=5)
        self._patch = mock.patch.object(ble_bridge, "board", self._board)
        self._patch.start()
        self.bridge = ble_bridge.BleBridge()

    def tearDown(self):
        self._patch.stop()

    @staticmethod
    def _svc(data_hex, mac=_MAC, rssi=-60):
        # Mi Scale 2 style: 16-bit service data 0x181B plus payload.
        raw = _ad(0x16, b"\x1b\x18" + bytes.fromhex(data_hex))
        return (mac, 0, rssi, raw)

    @staticmethod
    def _mfr(data_hex, mac=_MAC, rssi=-60):
        raw = _ad(0xFF, b"\x59\x00" + bytes.fromhex(data_hex))
        return (mac, 0, rssi, raw)

    def _drain(self, *frames):
        self.bridge._raw_results = list(frames)
        return {e["address"]: e for e in self.bridge.drain_results()}

    def test_later_frame_in_same_drain_wins(self):
        out = self._drain(self._svc("01"), self._svc("02"), self._svc("03"))
        self.assertEqual(out[_MAC_STR]["service_data"], [{"uuid": "181b", "data": "03"}])

    def test_next_drain_replaces_stale_service_data(self):
        self._drain(self._svc("01"))
        out = self._drain(self._svc("02"))
        self.assertEqual(out[_MAC_STR]["service_data"], [{"uuid": "181b", "data": "02"}])

    def test_next_drain_replaces_stale_manufacturer_data(self):
        self._drain(self._mfr("aa"))
        out = self._drain(self._mfr("bb"))
        self.assertEqual(out[_MAC_STR]["manufacturer_data"], "bb")

    def test_next_drain_reports_current_rssi(self):
        self._drain(self._mfr("aa", rssi=-40))
        out = self._drain(self._mfr("aa", rssi=-85))
        self.assertEqual(out[_MAC_STR]["rssi"], -85)

    def test_silent_mac_still_published_with_its_last_frame(self):
        # Original _seen intent: a MAC silent in this drain stays listed until
        # the reset cycle ages it out.
        self._drain(self._svc("01"), self._mfr("aa", mac=self._OTHER))
        out = self._drain(self._svc("02"))
        self.assertEqual(out["11:22:33:44:55:66"]["manufacturer_data"], "aa")
        self.assertEqual(out[_MAC_STR]["service_data"], [{"uuid": "181b", "data": "02"}])

    def test_reset_cycle_ages_out_silent_mac(self):
        self._drain(self._mfr("aa", mac=self._OTHER))
        for _ in range(self._board.SEEN_RESET_CYCLES - 1):
            self._drain()
        out = self._drain(self._svc("05"))
        self.assertNotIn("11:22:33:44:55:66", out)
        self.assertEqual(out[_MAC_STR]["service_data"], [{"uuid": "181b", "data": "05"}])


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


class TestUnpackScanResult(unittest.TestCase):
    """_unpack_scan_result: keep real addr_type, drop adv_type (#231)."""

    def test_preserves_random_addr_type(self):
        # IRQ event data order: (addr_type, addr, adv_type, rssi, adv_data).
        data = (1, _MAC, 0, -55, b"\x02\x01\x06")
        addr_type, addr, rssi, adv_data = ble_bridge._unpack_scan_result(data)
        self.assertEqual(addr_type, 1)
        self.assertEqual(bytes(addr), _MAC)
        self.assertEqual(rssi, -55)
        self.assertEqual(bytes(adv_data), b"\x02\x01\x06")

    def test_preserves_public_addr_type(self):
        data = (0, _MAC, 0, -40, b"")
        addr_type, _addr, _rssi, _adv = ble_bridge._unpack_scan_result(data)
        self.assertEqual(addr_type, 0)

    def test_addr_type_not_taken_from_adv_type(self):
        # Regression: random address (addr_type=1) advertising ADV_IND
        # (adv_type=0). The old unpack stored adv_type as addr_type, yielding 0
        # (public) and a connect timeout for random-address scales (#231).
        data = (1, _MAC, 0, -50, b"")
        addr_type, _addr, _rssi, _adv = ble_bridge._unpack_scan_result(data)
        self.assertEqual(addr_type, 1)


class _MicroPythonBytes(bytes):
    """bytes that rejects a slice step other than 1, as MicroPython does.

    MicroPython's bytes_subscr (py/objstr.c, v1.27.0) raises
    NotImplementedError("only slices with step=1 (aka None) are supported") for
    any step slice, so `buf[::-1]` passes on CPython and throws on the device.
    Slices keep this type, so a parser that slices first and reverses later is
    caught too.
    """

    def __getitem__(self, key):
        if isinstance(key, slice):
            if key.step not in (None, 1):
                raise NotImplementedError("only slices with step=1 (aka None) are supported")
            return _MicroPythonBytes(bytes.__getitem__(self, key))
        return bytes.__getitem__(self, key)


class TestParserUnderMicroPythonSliceRules(unittest.TestCase):
    """The parser must not rely on step slices, which MicroPython rejects.

    A single 128-bit advertiser in range used to throw out of the parser and
    drop the whole scan batch on the device, while every CPython test passed.
    """

    def test_stub_rejects_step_slices_like_micropython(self):
        with self.assertRaises(NotImplementedError):
            _MicroPythonBytes(b"\x01\x02")[::-1]

    def test_128bit_service_uuid(self):
        entry = _parse(_MicroPythonBytes(_ad(0x07, _UUID_1A10_LE)))
        self.assertEqual(entry["services"], [_UUID_1A10_FULL])

    def test_128bit_service_uuid_list_of_two(self):
        other_full = "0000fff0" + ble_bridge._BT_BASE_SUFFIX
        raw = _ad(0x06, _UUID_1A10_LE + _uuid_le(other_full))
        entry = _parse(_MicroPythonBytes(raw))
        self.assertEqual(entry["services"], [_UUID_1A10_FULL, other_full])

    def test_128bit_service_data(self):
        entry = _parse(_MicroPythonBytes(_ad(0x21, _UUID_1A10_LE + bytes([0xAA, 0xBB]))))
        self.assertEqual(entry["service_data"], [{"uuid": _UUID_1A10_FULL, "data": "aabb"}])

    def test_no_step_slices_in_device_code(self):
        # Belt and braces for code the parser tests do not reach: a step slice
        # anywhere in a module that runs on the device is a latent device-only
        # NotImplementedError (bytes, str and bytearray all reject it).
        import re

        # Two colons inside one pair of brackets, with no brace or quote in
        # between (so a list of dict literals does not match).
        inner = r"[^\[\]{}\"'\n]*"
        step_slice = re.compile(r"\[" + inner + ":" + inner + ":" + inner + r"\]")
        offenders = []
        for fname in sorted(os.listdir(_FIRMWARE_DIR)):
            if not fname.endswith(".py"):
                continue
            with open(os.path.join(_FIRMWARE_DIR, fname), encoding="utf-8") as handle:
                for lineno, line in enumerate(handle, 1):
                    code = line.split("#", 1)[0]
                    if step_slice.search(code):
                        offenders.append(f"{fname}:{lineno}: {line.strip()}")
        self.assertEqual(offenders, [], "step slice in device code")


class TestAddrTypeProbeOrder(unittest.TestCase):
    """_addr_type_probe_order: advertised type first, opposite as fallback (#231)."""

    def test_public_then_random(self):
        self.assertEqual(ble_bridge._addr_type_probe_order(0), (0, 1))

    def test_random_then_public(self):
        self.assertEqual(ble_bridge._addr_type_probe_order(1), (1, 0))

    def test_masks_to_low_bit(self):
        # addr_type may carry higher bits; only bit 0 selects public/random.
        self.assertEqual(ble_bridge._addr_type_probe_order(2), (0, 1))
        self.assertEqual(ble_bridge._addr_type_probe_order(3), (1, 0))


if __name__ == "__main__":
    unittest.main()
