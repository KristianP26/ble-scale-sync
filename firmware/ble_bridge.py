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

# Always-on conservative crash floor for the pre-connect IDF-heap guard (#139).
# The observed crash is at free=392 largest=336. A BLE central connection plus
# GATT discovery needs kilobytes across several distinct-sized allocations
# (estimated 4 to 12 KB, never measured on this build), so a floor far above
# 336/392 yet far below 4 KB can only ever trip the pathological near-zero case
# and can never refuse a connect that could have succeeded. Deciding which
# connects are winnable is left to the board tunables, which default to 0.
CRASH_FLOOR_LARGEST = 1024
CRASH_FLOOR_FREE = 2048


def _read_idf_heap():
    """Return (free, largest) ESP-IDF data-heap bytes on-device, None off-device.

    NimBLE allocates its connection structures from the ESP-IDF heap, which is
    separate from the MicroPython GC heap. Reading it requires the frozen
    `esp32` builtin, absent on a host, so this returns None there and every
    caller treats None as "cannot read, do not gate" (#139).
    """
    try:
        import esp32

        regions = esp32.idf_heap_info(esp32.HEAP_DATA)
        free = sum(r[1] for r in regions)
        largest = max(r[2] for r in regions)
        return (free, largest)
    except Exception:
        return None


def _log_idf_heap(when):
    """Log ESP-IDF heap headroom (best-effort, no-op off-device). See
    _read_idf_heap for why the read can be absent. Tiny `largest` here tells a
    RAM ceiling apart from a radio-coexistence timeout (healthy `largest`)."""
    heap = _read_idf_heap()
    if heap is not None:
        free, largest = heap
        print("IDF heap %s: free=%d largest=%d" % (when, free, largest))


def _should_skip_connect(free, largest, min_free, min_largest):
    """Pure crash-floor decision (#139): True when the IDF heap is too low to
    attempt a GATT connect. Gates the largest contiguous block AND the free
    total together, because connection bring-up performs several
    distinct-sized allocations that must all land, so a largest-only check is
    structurally insufficient. min_free / min_largest are the EFFECTIVE floors
    (max of the always-on crash floor and the board tunable); this function is
    host-testable and does not read the heap itself."""
    return largest < min_largest or free < min_free


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
    """Parse a single raw BLE advertisement into a device dict.

    Handles 16/32/128-bit Service UUIDs (AD types 0x02-0x07) and Service Data
    (0x16/0x20/0x21). UUIDs are advertised little-endian per BT Core spec;
    32-bit and 128-bit UUIDs are emitted as the full 32-char canonical form
    (32-bit expanded via the Bluetooth base UUID) because Node-side
    normalizeUuid only expands the 4-char (16-bit) form. 16-bit UUIDs are kept
    as 4-char hex so existing adapters and Node-side normalization continue to
    match.
    """
    mac = ":".join("%02X" % b for b in addr_bytes)
    name = ""
    services = []
    service_data = []
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
        elif ad_type == 0x05 or ad_type == 0x04:  # 32-bit Service UUIDs
            for j in range(0, len(ad_payload) - 3, 4):
                val = (
                    ad_payload[j]
                    | (ad_payload[j + 1] << 8)
                    | (ad_payload[j + 2] << 16)
                    | (ad_payload[j + 3] << 24)
                )
                services.append("%08x" % val + _BT_BASE_SUFFIX)
        elif ad_type == 0x07 or ad_type == 0x06:  # 128-bit Service UUIDs
            for j in range(0, len(ad_payload) - 15, 16):
                services.append(ad_payload[j:j + 16][::-1].hex())
        elif ad_type == 0x16 and len(ad_payload) >= 2:  # Service Data — 16-bit
            uuid = "%04x" % (ad_payload[0] | (ad_payload[1] << 8))
            service_data.append({"uuid": uuid, "data": ad_payload[2:].hex()})
        elif ad_type == 0x20 and len(ad_payload) >= 4:  # Service Data — 32-bit
            val = (
                ad_payload[0]
                | (ad_payload[1] << 8)
                | (ad_payload[2] << 16)
                | (ad_payload[3] << 24)
            )
            uuid = "%08x" % val + _BT_BASE_SUFFIX
            service_data.append({"uuid": uuid, "data": ad_payload[4:].hex()})
        elif ad_type == 0x21 and len(ad_payload) >= 16:  # Service Data — 128-bit
            uuid = ad_payload[0:16][::-1].hex()
            service_data.append({"uuid": uuid, "data": ad_payload[16:].hex()})
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
    if service_data:
        entry["service_data"] = service_data
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
        if entry.get("services") and not seen[mac].get("services"):
            seen[mac]["services"] = entry["services"]
        if entry.get("service_data") and not seen[mac].get("service_data"):
            seen[mac]["service_data"] = entry["service_data"]
    else:
        seen[mac] = entry


def _raw_has_mac(raw_results, macs):
    """True if any raw scan tuple advertises an address in `macs`.

    `macs` is a set of uppercase colon-separated MAC strings (the format
    carried on the `config` topic). Non-destructive peek of the streaming IRQ
    buffer — lets the publish loop flush early for a known scale (#201).
    """
    for addr_bytes, _addr_type, _rssi, _raw in raw_results:
        if ":".join("%02X" % b for b in addr_bytes) in macs:
            return True
    return False


def _unpack_scan_result(data):
    """Unpack a MicroPython _IRQ_SCAN_RESULT event tuple.

    Event data order is (addr_type, addr, adv_type, rssi, adv_data). adv_type
    (the connectable/scannable advertising kind) is intentionally dropped;
    addr_type (0 = public, 1 = random) MUST be preserved because aioble
    gap_connect matches on it. Reading addr_type as adv_type made every device
    look public, so random-address scales (MAC top bits 0b11, e.g. FF:..) timed
    out on connect (#231).
    """
    addr_type, addr, _adv_type, rssi, adv_data = data
    return addr_type, addr, rssi, adv_data


def _addr_type_probe_order(addr_type):
    """Connect address types to attempt: the controller-reported type first, then
    the opposite as a #231 timeout fallback. Returns ints (0 = public, 1 = random).

    aioble gap_connect matches on addr_type as well as the address, so a wrong type
    only ever surfaces as a connect TimeoutError; probing both rules it out before
    giving up. The controller-reported type comes straight from the advertising PDU
    TxAdd bit and is authoritative, so it is always tried first. An earlier build
    derived the type from the MAC bits (addr[0] & 0xC0 == 0xC0) on the theory that
    an FF address must be random static, but a public address may use any bytes and
    cheap scale SoCs advertise arbitrary public addresses that also start with 0xFF;
    that override connected the QN-Scale as random so it never matched the public
    advertiser and always timed out (#231).
    """
    primary = addr_type & 1
    return (primary, primary ^ 1)


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
        _oom_logged = False

        def _irq(event, data):
            nonlocal _cap_logged, _oom_logged
            if event == 5:  # _IRQ_SCAN_RESULT
                if len(raw_results) < board.MAX_SCAN_ENTRIES:
                    addr_type, addr, rssi, adv_data = _unpack_scan_result(data)
                    try:
                        raw_results.append((bytes(addr), addr_type, rssi, bytes(adv_data)))
                    except MemoryError:
                        # Drop this advertisement instead of letting the OOM
                        # propagate out of the IRQ. An unhandled IRQ exception
                        # leaves NimBLE in a bad state and panics the device.
                        if not _oom_logged:
                            _oom_logged = True
                            print("Scan IRQ low memory, dropping results (lower MAX_SCAN_ENTRIES)")
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

            results = [
                v
                for v in seen.values()
                if v["name"]
                or v.get("manufacturer_data")
                or v.get("services")
                or v.get("service_data")
            ]
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
        self._oom_logged = False

        def _irq(event, data):
            if event == 5:  # _IRQ_SCAN_RESULT
                if len(self._raw_results) < board.MAX_SCAN_ENTRIES:
                    addr_type, addr, rssi, adv_data = _unpack_scan_result(data)
                    try:
                        self._raw_results.append((bytes(addr), addr_type, rssi, bytes(adv_data)))
                    except MemoryError:
                        # Drop this advertisement instead of letting the OOM
                        # propagate out of the IRQ. An unhandled IRQ exception
                        # leaves NimBLE in a bad state and panics the device.
                        if not self._oom_logged:
                            self._oom_logged = True
                            print("Streaming scan IRQ low memory, dropping results (lower MAX_SCAN_ENTRIES)")
                elif not self._cap_logged:
                    self._cap_logged = True
                    print(f"Streaming scan cap reached ({board.MAX_SCAN_ENTRIES}), ignoring until drain")

        _ble.active(True)
        _ble.irq(_irq)
        _ble.gap_scan(0, 100000, 30000, True)  # duration=0 → indefinite
        print("Streaming scan started")

    def has_pending_scale_mac(self, macs):
        """True when the streaming IRQ buffer holds an advertisement from a
        known scale MAC, so the publish loop can flush early instead of
        waiting out the full PUBLISH_INTERVAL_MS (#201)."""
        return _raw_has_mac(self._raw_results, macs)

    def drain_results(self):
        """Drain accumulated raw scan results and return filtered device list.

        Merges into _seen dict for cross-cycle dedup. Clears _seen every
        SEEN_RESET_CYCLES drains to age out disappeared devices.
        """
        # Atomically swap raw_results (IRQ appends are non-preemptive)
        raw = self._raw_results
        self._raw_results = []
        self._cap_logged = False
        self._oom_logged = False

        for addr_bytes, addr_type, rssi, adv_raw in raw:
            entry = _parse_raw_entry(addr_bytes, addr_type, rssi, adv_raw)
            _merge_entry(self._seen, entry)

        self._seen_cycle += 1
        if self._seen_cycle >= board.SEEN_RESET_CYCLES:
            self._seen_cycle = 0
            results = [
                v
                for v in self._seen.values()
                if v["name"]
                or v.get("manufacturer_data")
                or v.get("services")
                or v.get("service_data")
            ]
            self._seen = {}
            return results

        return [
            v
            for v in self._seen.values()
            if v["name"]
            or v.get("manufacturer_data")
            or v.get("services")
            or v.get("service_data")
        ]

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
        # The streaming scan installs the firmware's own _ble.irq() handler on
        # the shared BLE singleton, which replaces aioble's central dispatcher.
        # aioble registers its dispatcher only once at import and never restores
        # it, so after a scan the _IRQ_PERIPHERAL_CONNECT event is delivered to
        # the scan handler and dropped, making every connect time out (#231).
        # Hand the IRQ back to aioble before any aioble call; start_streaming()
        # re-installs the scan handler after the session.
        try:
            import aioble.core as _aioble_core

            _ble.irq(_aioble_core.ble_irq)
        except Exception as e:  # noqa: BLE001
            print("Warning: could not restore aioble IRQ before connect: %s" % e)
        addr_bytes = bytes(int(b, 16) for b in address.split(":"))
        # Two gc.collect() passes before connecting (#139). Under MICROPY_GC_SPLIT_HEAP_AUTO
        # a MicroPython split is returned to the ESP-IDF heap only when it becomes fully
        # empty during a pass, so gc.collect() cannot hand kilobytes back to the IDF heap
        # that NimBLE allocates from; on a busy no-PSRAM board it usually frees zero whole
        # splits. It is kept because the second pass is the single cheap lever that can
        # release a split the first only just emptied (for example the scan buffers), and
        # it costs only a few ms against a multi-second connect window. gc.mem_free()
        # measures the GC heap, not this pool, so it must never gate a connect; the real
        # guard is the IDF-heap read below.
        import gc

        gc.collect()
        # The second pass can release a split the first only emptied, which matters on a
        # tight no-PSRAM board (#139). On PSRAM boards it only adds latency before connect,
        # and a stepped-on scale stays connectable briefly (#231), so gate it on the
        # aggressive-GC board flag.
        if getattr(board, "AGGRESSIVE_GC", True):
            gc.collect()
        _log_idf_heap("before connect")

        # Pre-connect IDF-heap crash guard (#139). NimBLE builds the connection from
        # the ESP-IDF heap; on a no-PSRAM board with WiFi up that heap can be down to
        # a few hundred bytes contiguous, so device.connect() trips a NULL malloc deep
        # in npl_freertos_sem_init and the C assert panics the chip (uncatchable from
        # Python). Reading the heap here and refusing the connect turns that reboot
        # loop into a clean MemoryError that the existing handlers report and recover
        # from. The read returns None off-device (host tests), where the gate is a
        # no-op so the connect proceeds. Effective floor = max(always-on crash floor,
        # board tunable); the board tunables default to 0 (pure crash floor) until a
        # maintainer calibrates them from a successful-connect heap delta on a PSRAM
        # board. Both largest and free are gated because several distinct-sized
        # allocations must all land.
        _heap = _read_idf_heap()
        if _heap is not None:
            _free, _largest = _heap
            _min_largest = max(CRASH_FLOOR_LARGEST, getattr(board, "CONNECT_MIN_IDF_LARGEST", 0))
            _min_free = max(CRASH_FLOOR_FREE, getattr(board, "CONNECT_MIN_IDF_FREE", 0))
            if _should_skip_connect(_free, _largest, _min_free, _min_largest):
                raise MemoryError(
                    "IDF heap too low for GATT connect: free=%d largest=%d (#139); "
                    "use an ESP32-S3 / PSRAM board for GATT-connect scales"
                    % (_free, _largest)
                )

        # aioble forwards scan_duration_ms to gap_connect (default 2 s). Scales
        # advertising in short bursts (Eufy P2 Pro) miss that window, so match it
        # to the connect timeout. Both are board-tunable: roomy boards keep the
        # 15 s window, no-PSRAM boards use a shorter window + retries (with a GC
        # between) to ease radio/heap pressure (#139).
        timeout_ms = getattr(board, "CONNECT_TIMEOUT_MS", 15000)
        scan_ms = getattr(board, "CONNECT_SCAN_MS", 15000)
        retries = getattr(board, "CONNECT_RETRIES", 1)

        # Probe the controller-reported address type first, then the opposite as
        # a fallback on any failure. A wrong addr_type is indistinguishable from
        # an absent peer to aioble gap_connect (it matches on addr AND addr_type),
        # so a scale connected with the wrong type looks like a TimeoutError, and
        # an aioble re-entry can also surface a TypeError; either way the fallback
        # must run (#231).
        self._conn = None
        last_exc = None
        for probe, use_type in enumerate(_addr_type_probe_order(addr_type)):
            aioble_type = aioble.ADDR_RANDOM if use_type else aioble.ADDR_PUBLIC
            device = aioble.Device(aioble_type, addr_bytes)
            type_retries = retries if probe == 0 else 1
            for attempt in range(1, type_retries + 1):
                try:
                    self._conn = await device.connect(
                        timeout_ms=timeout_ms, scan_duration_ms=scan_ms
                    )
                    last_exc = None
                    break
                except Exception as e:
                    last_exc = e
                    print(
                        "GATT connect attempt %d/%d (addr_type=%d) failed for %s: %s: %s"
                        % (attempt, type_retries, use_type, address, type(e).__name__, e)
                    )
                    if attempt < type_retries:
                        gc.collect()
                        await asyncio.sleep_ms(500)
            if self._conn is not None:
                break
            # Try the opposite address type on any connect failure, not only a
            # TimeoutError. A misreported type is the usual reason a known-awake
            # scale fails to connect, and discriminating on the exception class
            # proved fragile: a re-entry into aioble after a wrong-type timeout
            # surfaced a TypeError ("coroutine expected"), not a TimeoutError, so
            # the fallback was skipped and the connect stranded on one type (#231).
            gc.collect()
        if self._conn is None and last_exc is not None:
            raise last_exc
        self._chars = {}

        # aioble's services()/characteristics() return ClientDiscover async
        # iterators, not coroutines, so they must be driven with `async for`.
        # Wrapping them in asyncio.wait_for() called create_task() on a
        # non-coroutine and raised "TypeError: coroutine expected", which
        # escaped the timeout handler and stranded the autonomous connect in
        # main.py's retry loop (#231). aioble's own per-call timeout_ms is an
        # unimplemented TODO (ClientDiscover.__anext__ waits on an IRQ flag with
        # no timeout), so one asyncio.wait_for around the whole discovery is
        # what actually bounds a stalled peer.
        async def _discover_chars():
            chars_info = []
            # aioble allows only one discovery in flight per connection (a single
            # connection._discover slot), so the services() iterator must be
            # fully drained before any characteristics() discovery starts.
            # Nesting characteristics() inside the services() loop raised
            # "ValueError: Discovery in progress" (#231). Collect services first,
            # then discover characteristics per service (aioble's own pattern).
            services = []
            async for service in self._conn.services():
                services.append(service)
            for service in services:
                async for char in service.characteristics():
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
            return chars_info

        try:
            chars_info = await asyncio.wait_for(_discover_chars(), 10)
        except asyncio.TimeoutError:
            print(f"Service discovery timed out for {address}")
            await self.disconnect()
            raise
        except Exception as e:
            print(f"Service discovery failed for {address}: {type(e).__name__}: {e}")
            await self.disconnect()
            raise

        return {"chars": chars_info}

    async def start_notify(self, uuid_str, publish_fn):
        """Start forwarding notifications from a characteristic via publish_fn.

        This also writes the CCCD (Client Characteristic Configuration
        Descriptor) so the peripheral actually sends notifications. Without this
        step aioble's char.notified() just waits forever on an empty queue and
        times out with no data (#231)."""
        char = self._chars.get(uuid_str)
        if not char:
            return

        can_notify = bool(char.properties & bluetooth.FLAG_NOTIFY)
        can_indicate = bool(char.properties & bluetooth.FLAG_INDICATE)
        if not can_notify and not can_indicate:
            # Nothing to consume: no CCCD to write and notified()/indicated()
            # would both raise ValueError("Unsupported"). Skip cleanly.
            print(f"Subscribe: {uuid_str} supports neither notify nor indicate, skipping")
            return

        # Enable notify/indicate on the peripheral. aioble's notified() only
        # consumes events; it does not turn on the CCCD bit itself.
        print(f"Subscribe: enabling CCCD for {uuid_str}")
        try:
            await char.subscribe(notify=can_notify, indicate=can_indicate)
        except Exception as e:
            print(f"Subscribe: CCCD enable failed for {uuid_str}: {type(e).__name__}: {e}")
            raise
        print(f"Subscribe: CCCD enabled for {uuid_str}")

        # Read from the queue the characteristic actually feeds. aioble's
        # notified() raises ValueError("Unsupported") on an indicate-only char
        # (Robi S9 FFB3 result), which killed the read task and left the final
        # A3 frame undelivered (#248). A char exposing BOTH flags is drained via
        # notified() by convention; this assumes such a device streams via
        # notify rather than indicate, which holds for every registry scale.
        prefer_indicate = can_indicate and not can_notify

        async def _notify_loop():
            try:
                while self._conn and self._conn.is_connected():
                    try:
                        if prefer_indicate:
                            data = await char.indicated(timeout_ms=10000)
                        else:
                            data = await char.notified(timeout_ms=10000)
                    except asyncio.TimeoutError:
                        # No data in the 10s window but the link is still up
                        # (the final result frame can lag the live stream).
                        # Re-arm instead of killing the reader for good (#248).
                        continue
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
