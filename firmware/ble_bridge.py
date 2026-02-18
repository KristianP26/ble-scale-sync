"""BLE Central bridge using aioble — scan, connect, notify, read, write.

Optimized for memory-constrained boards (ESP32-PICO / Atom Echo, no PSRAM).

ESP32 BLE/WiFi coexistence: BLE must be deactivated after scanning so WiFi
can reconnect (shared 2.4 GHz radio). However, rapid active(False)/active(True)
cycles cause "BLE_INIT: controller init failed". The caller must rate-limit
scans (minimum ~15s between cycles).
"""

import aioble
import asyncio
import bluetooth

_ble = bluetooth.BLE()

# Maximum raw scan entries to keep (prevents OOM in dense BLE environments)
_MAX_SCAN_ENTRIES = 200

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


class BleBridge:
    def __init__(self):
        self._conn = None
        self._chars = {}  # uuid_str -> characteristic
        self._notify_tasks = []

    async def scan(self, duration_ms=8000):
        """Scan for BLE peripherals using raw BLE API for reliable ad parsing.

        Deduplicates by address, keeps strongest RSSI but updates manufacturer
        data from any advertisement that carries it.
        """
        import gc
        gc.collect()
        seen = {}  # address -> dict
        raw_results = []  # collect raw IRQ data

        def _irq(event, data):
            if event == 5:  # _IRQ_SCAN_RESULT
                if len(raw_results) < _MAX_SCAN_ENTRIES:
                    _, addr, addr_type, rssi, adv_data = data
                    raw_results.append((bytes(addr), addr_type, rssi, bytes(adv_data)))

        _ble.active(True)
        _ble.irq(_irq)
        _ble.gap_scan(duration_ms, 100000, 30000, True)  # interval=100ms, window=30ms, active=True
        await asyncio.sleep_ms(duration_ms + 500)
        try:
            _ble.gap_scan(None)
        except Exception:
            pass

        # Post-process results outside the IRQ handler
        for addr_bytes, addr_type, rssi, raw in raw_results:
            mac = ":".join("%02X" % b for b in addr_bytes)
            name = ""
            services = []
            mfr_id = None
            mfr_data = None

            # Parse AD structures
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

            # Dedup: keep strongest RSSI, but always update mfr data if new
            if mac in seen:
                if rssi > seen[mac]["rssi"]:
                    seen[mac]["rssi"] = rssi
                if name and not seen[mac]["name"]:
                    seen[mac]["name"] = name
                if mfr_data and not seen[mac].get("manufacturer_data"):
                    seen[mac]["manufacturer_id"] = mfr_id
                    seen[mac]["manufacturer_data"] = mfr_data
            else:
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
                seen[mac] = entry

        # Only return devices with a name OR manufacturer data (filter noise)
        results = [v for v in seen.values() if v["name"] or v.get("manufacturer_data")]
        seen.clear()
        raw_results.clear()
        # Deactivate BLE radio so WiFi can reconnect (shared 2.4 GHz radio)
        _ble.active(False)
        gc.collect()
        return results

    async def connect(self, address, addr_type=0):
        """Connect to a BLE peripheral by MAC address, discover services/chars.

        addr_type: 0 = public, 1 = random (from scan results).
        """
        _ble.active(True)
        addr_bytes = bytes(int(b, 16) for b in address.split(":"))
        aioble_addr_type = aioble.ADDR_RANDOM if addr_type == 1 else aioble.ADDR_PUBLIC
        device = aioble.Device(aioble_addr_type, addr_bytes)

        self._conn = await device.connect(timeout_ms=15000)
        self._chars = {}
        chars_info = []

        for service in await self._conn.services():
            for char in await service.characteristics():
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

        return {"chars": chars_info}

    async def start_notify(self, uuid_str, publish_fn):
        """Start forwarding notifications from a characteristic via publish_fn."""
        char = self._chars.get(uuid_str)
        if not char:
            return

        async def _notify_loop():
            try:
                while self._conn and self._conn.is_connected():
                    data = await char.notified(timeout_ms=60000)
                    if data:
                        await publish_fn(uuid_str, bytes(data))
            except asyncio.CancelledError:
                pass
            except Exception as e:
                print(f"Notify loop error ({uuid_str}): {e}")

        task = asyncio.create_task(_notify_loop())
        self._notify_tasks.append(task)

    async def write(self, uuid_str, data):
        """Write data to a characteristic."""
        char = self._chars.get(uuid_str)
        if char:
            await char.write(data, response=True)

    async def read(self, uuid_str):
        """Read data from a characteristic."""
        char = self._chars.get(uuid_str)
        if char:
            return bytes(await char.read())
        return b""

    async def disconnect(self):
        """Disconnect, cancel notify tasks, clear state, deactivate BLE."""
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

        # Deactivate BLE radio so WiFi can recover (shared 2.4 GHz radio)
        try:
            _ble.active(False)
        except Exception:
            pass
