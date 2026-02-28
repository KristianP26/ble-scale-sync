"""BLE Central bridge using aioble — scan, connect, notify, read, write.

Board-specific tuning (scan limits, BLE deactivation) is read from the
board abstraction layer so this module works on ESP32 and ESP32-S3.
"""

import aioble
import asyncio
import bluetooth
import board

_ble = bluetooth.BLE()

# Bluetooth Base UUID suffix (matches Node.js normalizeUuid)
_BT_BASE_SUFFIX = "00001000800000805f9b34fb"


def _norm_uuid(uuid):
    """Convert MicroPython UUID to normalized 32-char hex (matches Node.js normalizeUuid)."""
    s = str(uuid)
    # "UUID(0x2a9d)" -> "00002a9d" + base suffix
    if s.startswith("UUID(0x") and s.endswith(")"):
        return "0000" + s[7:-1].lower() + _BT_BASE_SUFFIX
    # "UUID('12345678-1234-1234-1234-123456789abc')" -> strip dashes
    if s.startswith("UUID('") and s.endswith("')"):
        return s[6:-2].replace("-", "").lower()
    return s.lower().replace("-", "")


def _parse_raw_entry(addr_bytes, addr_type, rssi, raw):
    """Parse a single raw BLE advertisement into a device dict."""
    mac = ":".join("%02X" % b for b in addr_bytes)
    name = ""
    services = []
    mfr_id = None
    mfr_data = None

    i = 0
    while i < len(raw):
        length = raw[i]
        if length == 0:
            break
        if i + 1 >= len(raw):
            break
        ad_type = raw[i + 1]
        ad_payload = raw[i + 2:i + 1 + length]

        if ad_type == 0x09 or ad_type == 0x08:  # Local Name
            try:
                name = ad_payload.decode("utf-8")
            except Exception:
                pass
        elif ad_type == 0x03 or ad_type == 0x02:  # 16-bit Service UUIDs
            for j in range(0, len(ad_payload) - 1, 2):
                uuid = ad_payload[j] | (ad_payload[j + 1] << 8)
                services.append("%04x" % uuid)
        elif ad_type == 0xFF and length >= 3:  # Manufacturer Specific
            mfr_id = ad_payload[0] | (ad_payload[1] << 8)
            mfr_data = ad_payload[2:].hex()

        i += length + 1

    entry = {
        "address": mac,
        "name": name,
        "rssi": rssi,
        "services": services,
        "addr_type": addr_type,
    }
    if mfr_id is not None:
        entry["manufacturer_id"] = mfr_id
        entry["manufacturer_data"] = mfr_data
    return entry


def _merge_entry(seen, entry):
    """Merge a parsed device entry into the seen dict (dedup by MAC, strongest RSSI)."""
    mac = entry["address"]
    if mac in seen:
        if entry["rssi"] > seen[mac]["rssi"]:
            seen[mac]["rssi"] = entry["rssi"]
        if entry["name"] and not seen[mac]["name"]:
            seen[mac]["name"] = entry["name"]
        if entry.get("manufacturer_data") and not seen[mac].get("manufacturer_data"):
            seen[mac]["manufacturer_id"] = entry["manufacturer_id"]
            seen[mac]["manufacturer_data"] = entry["manufacturer_data"]
    else:
        seen[mac] = entry


class BleBridge:
    def __init__(self):
        self._conn = None
        self._chars = {}  # uuid_str -> characteristic
        self._notify_tasks = []
        self._on_disconnect = None
        self._disconnect_fired = False
        # Streaming scan state
        self._streaming = False
        self._raw_results = []
        self._seen = {}
        self._seen_cycle = 0
        self._cap_logged = False

    def set_on_disconnect(self, callback):
        """Set callback for unexpected peripheral disconnect (fires at most once)."""
        self._on_disconnect = callback
        self._disconnect_fired = False

    async def scan(self, duration_ms=None):
        """Scan for BLE peripherals using raw BLE API (batch mode).

        Deduplicates by address, keeps strongest RSSI but updates manufacturer
        data from any advertisement that carries it.
        """
        if duration_ms is None:
            duration_ms = board.SCAN_DURATION_MS

        import gc
        gc.collect()
        seen = {}  # address -> dict
        raw_results = []  # collect raw IRQ data

        _cap_logged = False

        def _irq(event, data):
            nonlocal _cap_logged
            if event == 5:  # _IRQ_SCAN_RESULT
                if len(raw_results) < board.MAX_SCAN_ENTRIES:
                    _, addr, addr_type, rssi, adv_data = data
                    raw_results.append((bytes(addr), addr_type, rssi, bytes(adv_data)))
                elif not _cap_logged:
                    _cap_logged = True
                    print(f"Scan entry cap reached ({board.MAX_SCAN_ENTRIES}), ignoring further results")

        _ble.active(True)
        try:
            _ble.irq(_irq)
            _ble.gap_scan(duration_ms, 100000, 30000, True)  # interval=100ms, window=30ms, active=True
            await asyncio.sleep_ms(duration_ms + 500)
            try:
                _ble.gap_scan(None)
            except Exception:
                pass

            for addr_bytes, addr_type, rssi, raw in raw_results:
                entry = _parse_raw_entry(addr_bytes, addr_type, rssi, raw)
                _merge_entry(seen, entry)

            results = [v for v in seen.values() if v["name"] or v.get("manufacturer_data")]
            seen.clear()
            raw_results.clear()
            return results
        finally:
            if board.DEACTIVATE_BLE_AFTER_SCAN:
                try:
                    _ble.active(False)
                except Exception:
                    pass
            gc.collect()

    def start_streaming(self):
        """Start an indefinite BLE scan (ESP32-S3 continuous mode).

        IRQ handler accumulates raw results; call drain_results() periodically
        to process and publish them.
        """
        import gc
        gc.collect()
        self._streaming = True
        self._raw_results = []
        self._seen = {}
        self._seen_cycle = 0
        self._cap_logged = False

        def _irq(event, data):
            if event == 5:  # _IRQ_SCAN_RESULT
                if len(self._raw_results) < board.MAX_SCAN_ENTRIES:
                    _, addr, addr_type, rssi, adv_data = data
                    self._raw_results.append((bytes(addr), addr_type, rssi, bytes(adv_data)))
                elif not self._cap_logged:
                    self._cap_logged = True
                    print(f"Streaming scan cap reached ({board.MAX_SCAN_ENTRIES}), ignoring until drain")

        _ble.active(True)
        _ble.irq(_irq)
        _ble.gap_scan(0, 100000, 30000, True)  # duration=0 → indefinite
        print("Streaming scan started")

    def drain_results(self):
        """Drain accumulated raw scan results and return filtered device list.

        Merges into _seen dict for cross-cycle dedup. Clears _seen every
        SEEN_RESET_CYCLES drains to age out disappeared devices.
        """
        # Atomically swap raw_results (IRQ appends are non-preemptive)
        raw = self._raw_results
        self._raw_results = []
        self._cap_logged = False

        for addr_bytes, addr_type, rssi, adv_raw in raw:
            entry = _parse_raw_entry(addr_bytes, addr_type, rssi, adv_raw)
            _merge_entry(self._seen, entry)

        self._seen_cycle += 1
        if self._seen_cycle >= board.SEEN_RESET_CYCLES:
            self._seen_cycle = 0
            results = [v for v in self._seen.values() if v["name"] or v.get("manufacturer_data")]
            self._seen = {}
            return results

        return [v for v in self._seen.values() if v["name"] or v.get("manufacturer_data")]

    def stop_streaming(self):
        """Stop the indefinite BLE scan."""
        if self._streaming:
            try:
                _ble.gap_scan(None)
            except Exception:
                pass
            self._streaming = False
            self._raw_results = []
            print("Streaming scan stopped")

    async def connect(self, address, addr_type=0):
        """Connect to a BLE peripheral by MAC address, discover services/chars.

        addr_type: 0 = public, 1 = random (from scan results).
        """
        _ble.active(True)
        addr_bytes = bytes(int(b, 16) for b in address.split(":"))
        aioble_addr_type = aioble.ADDR_RANDOM if (addr_type & 1) else aioble.ADDR_PUBLIC
        device = aioble.Device(aioble_addr_type, addr_bytes)

        self._conn = await device.connect(timeout_ms=15000)
        self._chars = {}
        chars_info = []

        try:
            services = await asyncio.wait_for(self._conn.services(), 10)
            for service in services:
                chars = await asyncio.wait_for(service.characteristics(), 10)
                for char in chars:
                    uuid_str = _norm_uuid(char.uuid)
                    self._chars[uuid_str] = char
                    props = []
                    if char.properties & bluetooth.FLAG_READ:
                        props.append("read")
                    if char.properties & bluetooth.FLAG_WRITE:
                        props.append("write")
                    if char.properties & bluetooth.FLAG_NOTIFY:
                        props.append("notify")
                    if char.properties & bluetooth.FLAG_WRITE_NO_RESPONSE:
                        props.append("write-without-response")
                    if char.properties & bluetooth.FLAG_INDICATE:
                        props.append("indicate")
                    chars_info.append({"uuid": uuid_str, "properties": props})
        except asyncio.TimeoutError:
            print(f"Service discovery timed out for {address}")
            await self.disconnect()
            raise

        return {"chars": chars_info}

    async def start_notify(self, uuid_str, publish_fn):
        """Start forwarding notifications from a characteristic via publish_fn."""
        char = self._chars.get(uuid_str)
        if not char:
            return

        async def _notify_loop():
            try:
                while self._conn and self._conn.is_connected():
                    data = await char.notified(timeout_ms=10000)
                    if data:
                        await publish_fn(uuid_str, bytes(data))
            except asyncio.CancelledError:
                pass
            except Exception as e:
                print(f"Notify loop error ({uuid_str}): {e}")
            # Fire disconnect callback once if connection was lost (not cancelled)
            if not self._disconnect_fired and self._conn and not self._conn.is_connected():
                self._disconnect_fired = True
                if self._on_disconnect:
                    self._on_disconnect()

        task = asyncio.create_task(_notify_loop())
        self._notify_tasks.append(task)

    async def write(self, uuid_str, data):
        """Write data to a characteristic (auto-detects response mode)."""
        char = self._chars.get(uuid_str)
        if char:
            use_response = bool(char.properties & bluetooth.FLAG_WRITE)
            await char.write(data, response=use_response)

    async def read(self, uuid_str):
        """Read data from a characteristic."""
        char = self._chars.get(uuid_str)
        if char:
            return bytes(await char.read())
        return b""

    async def disconnect(self):
        """Disconnect, cancel notify tasks, clear state, optionally deactivate BLE."""
        self._disconnect_fired = True  # Suppress callback during explicit disconnect
        for task in self._notify_tasks:
            task.cancel()
        self._notify_tasks.clear()

        if self._conn:
            try:
                await self._conn.disconnect()
            except Exception:
                pass
            self._conn = None

        self._chars = {}

        if board.DEACTIVATE_BLE_AFTER_SCAN:
            # Deactivate BLE radio so WiFi can recover (shared 2.4 GHz radio)
            try:
                _ble.active(False)
            except Exception:
                pass
