# #231 ESP32 addr_type connect fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ESP32 proxy connect to random-address GATT-only scales (QN-Scale, `FF:..`) so the #231 autonomous-connect path stops failing with `TimeoutError`, and harden the host-initiated fallback path that returned `coroutine expected`.

**Architecture:** Firmware-only. (1) Fix the `_IRQ_SCAN_RESULT` tuple unpack in `ble_bridge.py` so the real `addr_type` is preserved instead of `adv_type` (root cause of the connect timeout). (2) As a safety net, probe the opposite address type once when a connect times out. (3) Serialize the host-initiated `handle_connect` against an in-flight autonomous connect (the `_busy` guard was batch-mode only) and print a REPL traceback on command errors so the residual `coroutine expected` is pinpointable. No host TypeScript change: with the addr_type fix the `scan/results` already carry the correct type that `entry.addr_type ?? 0` forwards.

**Tech Stack:** MicroPython (firmware), Python `unittest` (host-runnable firmware tests under CPython with stubbed `aioble`/`bluetooth`/`board`).

---

## Root cause (for context)

MicroPython `_IRQ_SCAN_RESULT` event data order is `(addr_type, addr, adv_type, rssi, adv_data)` (confirmed: MicroPython bluetooth docs + rename commit `dd0bc26`). Both IRQ closures in `ble_bridge.py` unpack it as `_, addr, addr_type, rssi, adv_data = data`, which discards the real `addr_type` (slot 0) and stores `adv_type` (slot 2) in its place. `adv_type` for a normal connectable advert (ADV_IND) is `0`, so every device looked like a public address. The QN-Scale advertises a random static address (`FF:03:00:53:D6:4D`, MSByte top two bits `0b11`), real `addr_type=1`. aioble `gap_connect` matches on `addr_type` AND `addr`, so connecting it as public never matches and times out (`asyncio.TimeoutError`). The MAC sits at slot 1 in both readings, so scanning and matching always worked, which hid the bug until a random-address GATT-only scale needed a connect.

Secondary: the host-initiated fallback (`handle_connect`) only waits out `_busy` on batch boards. On a continuous board it can run while an autonomous connect still holds `_busy`, re-entering aioble on the same bridge. The reporter saw a fast `coroutine expected` there; the guard plus a traceback closes that gap and makes any remainder diagnosable.

## File Structure

- Modify: `firmware/ble_bridge.py` - add `_unpack_scan_result()` + `_addr_type_probe_order()` helpers; use the unpack helper in both `_irq` closures; rewrite the `connect()` retry loop to probe both address types.
- Modify: `firmware/main.py` - extract `_wait_not_busy()`; make `handle_connect` serialize on it for all boards; print a traceback in the main-loop command handler.
- Modify: `firmware/tests/test_ad_parser.py` - tests for the two new `ble_bridge` helpers.
- Modify: `firmware/tests/test_auto_connect.py` - tests for `_wait_not_busy` (with an `asyncio.sleep_ms` CPython shim).
- Modify: `docs/guide/esp32-proxy.md` - troubleshooting note that random-address GATT scales now connect.
- Modify: `README.md` - one-line mention (project rule: README touched in this change).

No TypeScript changes. The host `scan.ts` already forwards `entry.addr_type ?? 0` and `gatt.ts` sends it on the `connect` topic; once the firmware reports the correct type, the fallback connect is correct too.

---

### Task 1: Preserve the real addr_type from the scan IRQ (root cause, Failure 1)

**Files:**
- Modify: `firmware/ble_bridge.py` (add helper near other module functions ~line 49; `scan()` `_irq` ~206-210; `start_streaming()` `_irq` ~271-275)
- Test: `firmware/tests/test_ad_parser.py`

- [ ] **Step 1: Write the failing tests**

Add at the end of `firmware/tests/test_ad_parser.py`, before the `if __name__` block:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m unittest firmware.tests.test_ad_parser -k UnpackScanResult`
Expected: FAIL with `AttributeError: module 'ble_bridge' has no attribute '_unpack_scan_result'`.

- [ ] **Step 3: Add the helper**

In `firmware/ble_bridge.py`, add a module-level function (next to `_raw_has_mac`, before `class BleBridge`):

```python
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
```

- [ ] **Step 4: Use the helper in both IRQ closures**

In `scan()` `_irq`, replace:

```python
                    _, addr, addr_type, rssi, adv_data = data
                    try:
                        raw_results.append((bytes(addr), addr_type, rssi, bytes(adv_data)))
```

with:

```python
                    addr_type, addr, rssi, adv_data = _unpack_scan_result(data)
                    try:
                        raw_results.append((bytes(addr), addr_type, rssi, bytes(adv_data)))
```

In `start_streaming()` `_irq`, replace:

```python
                    _, addr, addr_type, rssi, adv_data = data
                    try:
                        self._raw_results.append((bytes(addr), addr_type, rssi, bytes(adv_data)))
```

with:

```python
                    addr_type, addr, rssi, adv_data = _unpack_scan_result(data)
                    try:
                        self._raw_results.append((bytes(addr), addr_type, rssi, bytes(adv_data)))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m unittest firmware.tests.test_ad_parser -k UnpackScanResult`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add firmware/ble_bridge.py firmware/tests/test_ad_parser.py
git commit -m "fix(ble): preserve BLE scan addr_type so random-address scales connect (#231)"
```

---

### Task 2: Probe the opposite address type on a connect timeout (Failure 1 safety net)

**Files:**
- Modify: `firmware/ble_bridge.py` (add helper near `_unpack_scan_result`; rewrite `connect()` body ~355-394)
- Test: `firmware/tests/test_ad_parser.py`

- [ ] **Step 1: Write the failing tests**

Add at the end of `firmware/tests/test_ad_parser.py`, before the `if __name__` block:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m unittest firmware.tests.test_ad_parser -k AddrTypeProbeOrder`
Expected: FAIL with `AttributeError: module 'ble_bridge' has no attribute '_addr_type_probe_order'`.

- [ ] **Step 3: Add the helper**

In `firmware/ble_bridge.py`, directly after `_unpack_scan_result`:

```python
def _addr_type_probe_order(addr_type):
    """Connect address types to attempt: advertised type first, then the
    opposite as a #231 timeout fallback. Returns ints (0 = public, 1 = random).
    aioble gap_connect matches on addr_type, so a misreported type only shows
    up as a connect timeout; probing both rules it out before giving up.
    """
    primary = addr_type & 1
    return (primary, primary ^ 1)
```

- [ ] **Step 4: Rewrite the connect() retry loop**

In `connect()`, replace this block (the two early lines that build `aioble_addr_type`/`device`, through the `raise last_exc`):

```python
        aioble_addr_type = aioble.ADDR_RANDOM if (addr_type & 1) else aioble.ADDR_PUBLIC
        device = aioble.Device(aioble_addr_type, addr_bytes)

        # Reclaim heap before connecting. NimBLE allocates its connection from
        # the ESP-IDF heap, and an empty MicroPython split is returned to that
        # heap during a GC pass (MICROPY_GC_SPLIT_HEAP_AUTO), so collecting after
        # the scan buffers are freed gives NimBLE the best chance to allocate on
        # a tight no-PSRAM board (#139). Two passes: the second can release a
        # split that the first only emptied.
        import gc

        gc.collect()
        gc.collect()
        _log_idf_heap("before connect")

        # aioble forwards scan_duration_ms to gap_connect (default 2 s). Scales
        # advertising in short bursts (Eufy P2 Pro) miss that window, so match it
        # to the connect timeout. Both are board-tunable: roomy boards keep the
        # 15 s window, no-PSRAM boards use a shorter window + retries (with a GC
        # between) to ease radio/heap pressure (#139).
        timeout_ms = getattr(board, "CONNECT_TIMEOUT_MS", 15000)
        scan_ms = getattr(board, "CONNECT_SCAN_MS", 15000)
        retries = getattr(board, "CONNECT_RETRIES", 1)
        last_exc = None
        for attempt in range(1, retries + 1):
            try:
                self._conn = await device.connect(timeout_ms=timeout_ms, scan_duration_ms=scan_ms)
                last_exc = None
                break
            except Exception as e:
                last_exc = e
                print(
                    "GATT connect attempt %d/%d failed for %s: %s: %s"
                    % (attempt, retries, address, type(e).__name__, e)
                )
                if attempt < retries:
                    gc.collect()
                    await asyncio.sleep_ms(500)
        if last_exc is not None:
            raise last_exc
```

with:

```python
        # Reclaim heap before connecting. NimBLE allocates its connection from
        # the ESP-IDF heap, and an empty MicroPython split is returned to that
        # heap during a GC pass (MICROPY_GC_SPLIT_HEAP_AUTO), so collecting after
        # the scan buffers are freed gives NimBLE the best chance to allocate on
        # a tight no-PSRAM board (#139). Two passes: the second can release a
        # split that the first only emptied.
        import gc

        gc.collect()
        gc.collect()
        _log_idf_heap("before connect")

        # aioble forwards scan_duration_ms to gap_connect (default 2 s). Scales
        # advertising in short bursts (Eufy P2 Pro) miss that window, so match it
        # to the connect timeout. Both are board-tunable: roomy boards keep the
        # 15 s window, no-PSRAM boards use a shorter window + retries (with a GC
        # between) to ease radio/heap pressure (#139).
        timeout_ms = getattr(board, "CONNECT_TIMEOUT_MS", 15000)
        scan_ms = getattr(board, "CONNECT_SCAN_MS", 15000)
        retries = getattr(board, "CONNECT_RETRIES", 1)

        # Try the advertised address type first, then the opposite once if it
        # times out. A wrong addr_type is indistinguishable from an absent peer
        # to aioble gap_connect (it matches on addr AND addr_type), so a scale
        # whose type was misreported looks like a pure TimeoutError (#231).
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
            # Only the opposite address type can cure a timeout; bail on any
            # other error so a real failure does not double the wait.
            if not isinstance(last_exc, asyncio.TimeoutError):
                break
            gc.collect()
        if self._conn is None and last_exc is not None:
            raise last_exc
```

- [ ] **Step 5: Run the helper tests + the full parser suite**

Run: `python -m unittest firmware.tests.test_ad_parser`
Expected: PASS (existing tests plus `AddrTypeProbeOrder`). `connect()` is exercised on hardware; the pure helper carries the unit coverage.

- [ ] **Step 6: Commit**

```bash
git add firmware/ble_bridge.py firmware/tests/test_ad_parser.py
git commit -m "fix(ble): probe opposite BLE address type on connect timeout (#231)"
```

---

### Task 3: Serialize host connect + log tracebacks (Failure 2)

**Files:**
- Modify: `firmware/main.py` (add `_wait_not_busy` near `describe_exc` ~144; `handle_connect` ~387-403; main-loop `except` ~584-585)
- Test: `firmware/tests/test_auto_connect.py`

- [ ] **Step 1: Write the failing tests**

In `firmware/tests/test_auto_connect.py`, add an `asyncio.sleep_ms` shim immediately after the `import main` block (after line ~94, outside the `try/finally`):

```python
# main._wait_not_busy awaits asyncio.sleep_ms, which only exists in MicroPython.
import asyncio as _asyncio

if not hasattr(_asyncio, "sleep_ms"):
    _asyncio.sleep_ms = lambda ms: _asyncio.sleep(ms / 1000)
```

Then add before the `if __name__` block:

```python
class TestWaitNotBusy(unittest.IsolatedAsyncioTestCase):
    """_wait_not_busy: serialize host connect against an in-flight BLE op (#231)."""

    async def test_returns_true_when_free(self):
        main._busy = False
        self.assertTrue(await main._wait_not_busy(max_iters=3, sleep_ms=1))

    async def test_returns_false_when_stays_busy(self):
        main._busy = True
        try:
            self.assertFalse(await main._wait_not_busy(max_iters=2, sleep_ms=1))
        finally:
            main._busy = False

    async def test_returns_true_when_busy_clears(self):
        main._busy = True

        async def _clear():
            await _asyncio.sleep(0.002)
            main._busy = False

        task = _asyncio.ensure_future(_clear())
        try:
            self.assertTrue(await main._wait_not_busy(max_iters=50, sleep_ms=1))
        finally:
            main._busy = False
            await task
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m unittest firmware.tests.test_auto_connect -k WaitNotBusy`
Expected: FAIL with `AttributeError: module 'main' has no attribute '_wait_not_busy'`.

- [ ] **Step 3: Add the `_wait_not_busy` helper**

In `firmware/main.py`, add a module-level coroutine right after `describe_exc` (before the `# Autonomous scan loop` banner):

```python
async def _wait_not_busy(max_iters=60, sleep_ms=500):
    """Wait up to max_iters*sleep_ms for an in-flight BLE op to clear (#231).

    Returns True if _busy is clear (free to proceed), False if it stayed set.
    """
    for _ in range(max_iters):
        if not _busy:
            return True
        await asyncio.sleep_ms(sleep_ms)
    return not _busy
```

- [ ] **Step 4: Serialize handle_connect on all boards**

In `handle_connect`, replace:

```python
    _scan_paused = True  # Pause autonomous scanning

    if board.CONTINUOUS_SCAN:
        bridge.stop_streaming()
    else:
        # Wait for any in-progress batch scan to finish (max 30s)
        for _ in range(60):
            if not _busy:
                break
            await asyncio.sleep_ms(500)
        if _busy:
            _scan_paused = False
            await publish_error("Busy — another BLE operation is in progress")
            return

    _busy = True
```

with:

```python
    _scan_paused = True  # Pause autonomous scanning

    # Serialize against an in-flight BLE op. On continuous boards the autonomous
    # connect path (#201) holds _busy while it runs; without this wait a
    # host-initiated fallback connect (#231) re-enters aioble on the same bridge
    # concurrently, which can abort the connect mid-flight.
    if not await _wait_not_busy():
        _scan_paused = False
        await publish_error("Busy: another BLE operation is in progress")
        return

    if board.CONTINUOUS_SCAN:
        bridge.stop_streaming()

    _busy = True
```

- [ ] **Step 5: Print a traceback on command-handler errors**

In `main()`, in the command-dispatch loop, replace:

```python
            except Exception as e:
                await publish_error(describe_exc(e))
```

with:

```python
            except Exception as e:
                import sys

                sys.print_exception(e)
                await publish_error(describe_exc(e))
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python -m unittest firmware.tests.test_auto_connect -k WaitNotBusy`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add firmware/main.py firmware/tests/test_auto_connect.py
git commit -m "fix(ble): serialize ESP32 host connect against autonomous connect and log tracebacks (#231)"
```

---

### Task 4: Docs + README

**Files:**
- Modify: `docs/guide/esp32-proxy.md` (Troubleshooting section ~400)
- Modify: `README.md`

- [ ] **Step 1: Add a troubleshooting note**

In `docs/guide/esp32-proxy.md`, directly after the existing `### A GATT-only scale never connects with auto_connect` paragraph (ends ~line 402), add:

```markdown
### A random-address scale times out on connect

Some scales advertise a random Bluetooth address (the first MAC byte is `C0` or
higher, for example `FF:03:..`) rather than a fixed public one. The proxy now
reads the advertised address type correctly and connects with it, and if a
connect still times out it retries once with the opposite address type. If your
scale used to log `GATT connect attempt ... failed ... TimeoutError` on every
weigh-in, update the firmware and try again.
```

- [ ] **Step 2: Add a one-line README note**

In `README.md`, append one sentence to the existing ESP32 proxy bullet (line 90). Replace:

```markdown
- **[ESP32 BLE proxy](https://blescalesync.dev/guide/esp32-proxy).** Use a remote ESP32 as a BLE radio over MQTT, with a built-in embedded broker for zero-config setup, simplified Docker deployment, and optional display. Set `ble.scale_mac` for GATT-only scales (for example QN-Scale) so the ESP32 can connect autonomously the instant it sees the scale.
```

with (adds a closing sentence, no em dash, no double dash):

```markdown
- **[ESP32 BLE proxy](https://blescalesync.dev/guide/esp32-proxy).** Use a remote ESP32 as a BLE radio over MQTT, with a built-in embedded broker for zero-config setup, simplified Docker deployment, and optional display. Set `ble.scale_mac` for GATT-only scales (for example QN-Scale) so the ESP32 can connect autonomously the instant it sees the scale. It connects to both public-address and random-address GATT scales.
```

- [ ] **Step 3: Commit**

```bash
git add docs/guide/esp32-proxy.md README.md
git commit -m "docs: note random-address GATT scales now connect via ESP32 proxy (#231)"
```

---

### Task 5: Full verification

- [ ] **Step 1: Firmware test suite**

Run: `python -m unittest discover -s firmware/tests`
Expected: PASS (existing 50+ plus the new `UnpackScanResult`, `AddrTypeProbeOrder`, `WaitNotBusy` cases).

- [ ] **Step 2: TypeScript suite unchanged and green**

```bash
taskkill //F //IM node.exe
npx tsc --noEmit
npm run lint
npx prettier --check .
npm test
```
Expected: all green (no TS files were touched, so this is a regression guard).

- [ ] **Step 3: Push to dev**

```bash
git push origin dev
```

---

## Self-Review

**Spec coverage:** Solution 1 (IRQ unpack fix) = Task 1. Solution 2 (opposite-type probe) = Task 2. Failure 2 (serialize + traceback) = Task 3. Docs/README rule = Task 4. Verification + push = Task 5. All recommendations covered.

**Placeholder scan:** No TBD/TODO. Every code step shows full code.

**Type consistency:** `_unpack_scan_result(data) -> (addr_type, addr, rssi, adv_data)` consumed identically in both IRQ closures. `_addr_type_probe_order(addr_type) -> (int, int)` consumed in `connect()` and mapped to `aioble.ADDR_RANDOM`/`aioble.ADDR_PUBLIC` via `use_type`. `_wait_not_busy(max_iters, sleep_ms) -> bool` consumed in `handle_connect`. `connect()` keeps `import gc`, `_log_idf_heap`, and board getattrs above the loop; `self._conn` initialized to `None` before the loop and the post-loop guard is `if self._conn is None and last_exc is not None`.
