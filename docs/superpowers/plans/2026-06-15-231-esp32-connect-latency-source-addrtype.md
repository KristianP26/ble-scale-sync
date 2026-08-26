# #231 ESP32 autonomous connect: source addr_type + latency cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ESP32 autonomous GATT connect for misreported static-random scales (Renpho ES-CS20M / QN-Scale, #231) connect on the first attempt with the right address type AND reach `gap_connect` before the briefly-connectable scale sleeps.

**Architecture:** Two independent locks were diagnosed. Lock 1 (address type): the NimBLE/ESP-IDF scan IRQ misreports the static-random scale as public (addr_type=0); `ble_bridge._addr_type_probe_order` already overrides this from the MAC bits, but the raw scan addr_type still flows through `main._find_scale_in_raw` and is what the host-visible log shows. We correct addr_type at that source too (belt-and-suspenders + unambiguous diagnostic log). Lock 2 (timing): the autonomous loop awaits an MQTT `scan/results` publish (a WiFi round-trip) plus GC passes BEFORE `device.connect()`, burning the scale's short connectable window. We snapshot scan results synchronously before stopping the scan but defer the awaited MQTT publish until after the connect attempt, and gate the second pre-connect GC pass to no-PSRAM boards only.

**Tech Stack:** MicroPython (firmware), aioble, host-runnable `unittest` with stubbed `aioble`/`bluetooth`/`board`/`mqtt_as`/`ble_bridge`.

---

## File Structure

- `firmware/main.py` — `_find_scale_in_raw` (addr_type source correction); `_streaming_scan_loop` autonomous branch (defer MQTT publish past connect).
- `firmware/ble_bridge.py` — `connect()` (gate the second GC pass on `board.AGGRESSIVE_GC`).
- `firmware/tests/test_auto_connect.py` — new tests for the addr_type source override; update one existing test whose fixture MAC is now bit-overridden.
- `docs/guide/esp32-proxy.md` and `README.md` — doc touch (project rule: update README every commit).

Branch: `dev` (already on it). No host TypeScript change. No config schema change.

---

### Task 1: Correct addr_type at the source in `_find_scale_in_raw`

**Files:**
- Modify: `firmware/main.py:175-186`
- Test: `firmware/tests/test_auto_connect.py`

- [ ] **Step 1: Update the existing `test_returns_first_match` test (it uses the FF static-random MAC with addr_type=0, which the source fix now overrides to 1)**

Replace the body of `test_returns_first_match` in `firmware/tests/test_auto_connect.py` (currently asserts `result[2] == 0`):

```python
    def test_returns_first_match(self):
        # Both entries are the same FF (static random) MAC. The first match is
        # returned, and its misreported addr_type=0 is corrected to 1 (#231).
        raw = [_raw_entry(_MAC_BYTES, addr_type=0), _raw_entry(_MAC_BYTES, addr_type=1)]
        result = main._find_scale_in_raw(raw)
        self.assertIsNotNone(result)
        self.assertEqual(result[0], _MAC_STR)
        self.assertEqual(result[1], _MAC_BYTES)
        self.assertEqual(result[2], 1)  # FF -> static random, override forces 1
```

- [ ] **Step 2: Add a new test class for the addr_type source override**

Append after `TestFindScaleInRaw` in `firmware/tests/test_auto_connect.py`:

```python
class TestFindScaleAddrTypeOverride(unittest.TestCase):
    """_find_scale_in_raw corrects a misreported static-random addr_type (#231)."""

    def setUp(self):
        main._scale_macs = {_MAC_STR, _PUBLIC_MAC_STR}

    def tearDown(self):
        main._scale_macs = set()

    def test_static_random_mac_reported_public_is_overridden(self):
        # FF:.. is static random (0xFF & 0xC0 == 0xC0); scan misreports it as
        # public (0). Source must force random (1).
        raw = [_raw_entry(_MAC_BYTES, addr_type=0)]
        result = main._find_scale_in_raw(raw)
        self.assertIsNotNone(result)
        self.assertEqual(result[2], 1)

    def test_static_random_mac_reported_random_stays_random(self):
        raw = [_raw_entry(_MAC_BYTES, addr_type=1)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 1)

    def test_non_static_mac_keeps_reported_public(self):
        # 84:.. top bits are 0b10, NOT static random; trust the reported type.
        raw = [_raw_entry(_PUBLIC_MAC_BYTES, addr_type=0)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 0)

    def test_non_static_mac_keeps_reported_random(self):
        raw = [_raw_entry(_PUBLIC_MAC_BYTES, addr_type=1)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 1)
```

Add these module-level fixtures next to `_MAC_BYTES`/`_MAC_STR` near the top of the helpers section (after `_OTHER_MAC_STR`):

```python
_PUBLIC_MAC_BYTES = b"\x84\xFC\xE6\x53\x06\x1C"
_PUBLIC_MAC_STR = "84:FC:E6:53:06:1C"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd firmware && python -m unittest tests.test_auto_connect -v`
Expected: FAIL — `test_static_random_mac_reported_public_is_overridden` gets addr_type 0 (no override yet), and `test_returns_first_match` gets 0 not 1.

- [ ] **Step 4: Implement the source correction in `_find_scale_in_raw`**

Replace `firmware/main.py:175-186` with:

```python
def _find_scale_in_raw(raw_results):
    """Find the first known scale MAC in the raw IRQ buffer.

    Returns (mac, addr_bytes, addr_type) or None. Non-destructive peek used by the
    autonomous connect logic to skip the MQTT round-trip (#201).

    Some NimBLE / ESP-IDF builds misreport a static random scale as public in the
    scan IRQ. A static random address is unambiguous from its top two bits
    (addr[0] & 0xC0 == 0xC0), so trust the bits over the reported type: connecting
    with the wrong addr_type only ever surfaces as a connect TimeoutError because
    aioble gap_connect matches on addr AND addr_type (#231).
    """
    for addr_bytes, addr_type, _rssi, _raw in raw_results:
        mac = ":".join("%02X" % b for b in addr_bytes)
        if mac in _scale_macs:
            if (addr_bytes[0] & 0xC0) == 0xC0:
                addr_type = 1
            print(f"Auto-connect: found known scale {mac} in raw buffer (addr_type={addr_type})")
            return mac, addr_bytes, addr_type
    return None
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd firmware && python -m unittest tests.test_auto_connect -v`
Expected: PASS (all, including the updated `test_returns_first_match`).

- [ ] **Step 6: Commit**

```bash
git add firmware/main.py firmware/tests/test_auto_connect.py
git commit -m "fix(ble): correct misreported static-random addr_type at scan source (#231)"
```

---

### Task 2: Defer the MQTT scan/results publish until after the autonomous connect

**Files:**
- Modify: `firmware/main.py:277-296` (the `if _auto_connect:` block inside `_streaming_scan_loop`)

- [ ] **Step 1: Replace the autonomous-connect telemetry ordering**

In `_streaming_scan_loop`, the current block (main.py ~277-296) drains results, runs `gc.collect()`, beep/display, then `await client.publish(scan/results)` BEFORE `_auto_gatt_connect`. Replace it so the awaited MQTT publish happens AFTER the connect attempt. `bridge.stop_streaming()` (called inside `_auto_gatt_connect`) clears `_raw_results`, so the results MUST be drained synchronously first; only the awaited publish is deferred.

Replace:

```python
                if _auto_connect:
                    found = _find_scale_in_raw(bridge._raw_results)
                    if found:
                        mac, _addr_bytes, addr_type = found
                        print(f"Auto-connect: scale {mac} detected after {waited}ms, connecting immediately")
                        # Drain and publish scan results first so the host
                        # sees what triggered the connect.
                        try:
                            results = bridge.drain_results()
                            gc.collect()
                            _check_scale_beep(results)
                            board.on_scan_complete(results, bool(_scale_macs))
                            await client.publish(topic("scan/results"), json.dumps(results), qos=0)
                        except Exception:
                            pass
                        await _auto_gatt_connect(mac, addr_type)
                        break
```

with:

```python
                if _auto_connect:
                    found = _find_scale_in_raw(bridge._raw_results)
                    if found:
                        mac, _addr_bytes, addr_type = found
                        print(f"Auto-connect: scale {mac} detected after {waited}ms, connecting immediately")
                        # A stepped-on GATT-only scale stays connectable only
                        # briefly, so reach gap_connect with minimal delay (#231).
                        # Snapshot scan results synchronously before stop_streaming
                        # clears the raw buffer, but defer the awaited MQTT publish
                        # (a WiFi round-trip) until AFTER the connect attempt.
                        try:
                            results = bridge.drain_results()
                            _check_scale_beep(results)
                            board.on_scan_complete(results, bool(_scale_macs))
                        except Exception:
                            results = []
                        await _auto_gatt_connect(mac, addr_type)
                        try:
                            await client.publish(topic("scan/results"), json.dumps(results), qos=0)
                        except Exception:
                            pass
                        break
```

- [ ] **Step 2: Static review of the edit**

Confirm there is no `await` (especially no `await client.publish`) between the `print("...detected...")` line and the `await _auto_gatt_connect(mac, addr_type)` call. `drain_results`, `_check_scale_beep`, and `board.on_scan_complete` are all synchronous. The only awaited work before connect remaining is inside `_auto_gatt_connect` itself (stop_streaming, the no-op disconnect, GC).

Run: `git diff firmware/main.py` and read the block.
Expected: the awaited publish now sits after `_auto_gatt_connect`; the pre-connect `gc.collect()` is gone.

- [ ] **Step 3: Run the firmware tests (no regression)**

Run: `cd firmware && python -m unittest discover -s tests -v`
Expected: PASS (all). `_streaming_scan_loop` itself is not host-tested; this guards the helpers it calls.

- [ ] **Step 4: Commit**

```bash
git add firmware/main.py
git commit -m "fix(ble): connect before publishing scan results on autonomous path (#231)"
```

---

### Task 3: Gate the second pre-connect GC pass on no-PSRAM boards

**Files:**
- Modify: `firmware/ble_bridge.py:407-411`

- [ ] **Step 1: Replace the double GC with a board-gated second pass**

Replace `firmware/ble_bridge.py:407-411`:

```python
        import gc

        gc.collect()
        gc.collect()
        _log_idf_heap("before connect")
```

with:

```python
        import gc

        gc.collect()
        # The second pass can release a split the first only emptied, which
        # matters on a tight no-PSRAM board (#139). On PSRAM boards it only adds
        # latency before connect, and a stepped-on scale stays connectable
        # briefly (#231), so gate it on the aggressive-GC board flag.
        if getattr(board, "AGGRESSIVE_GC", True):
            gc.collect()
        _log_idf_heap("before connect")
```

- [ ] **Step 2: Verify the board flags**

Run: `grep -n "AGGRESSIVE_GC" firmware/board_esp32_s3.py firmware/board_esp_wroom_32.py firmware/board_atom_echo.py firmware/board_guition_4848.py`
Expected: `board_esp32_s3.py` and `board_guition_4848.py` = `False` (PSRAM, single GC); `board_esp_wroom_32.py` and `board_atom_echo.py` = `True` (no-PSRAM, keep double GC). Default `True` keeps the safe #139 behavior if the flag is ever absent.

- [ ] **Step 3: Run the firmware tests**

Run: `cd firmware && python -m unittest discover -s tests -v`
Expected: PASS (all). `connect()` is not host-tested (needs aioble), so this is a no-regression guard.

- [ ] **Step 4: Commit**

```bash
git add firmware/ble_bridge.py
git commit -m "perf(ble): single pre-connect GC pass on PSRAM boards (#231)"
```

---

### Task 4: Docs + README, full verification, push

**Files:**
- Modify: `docs/guide/esp32-proxy.md` (the random-address timeout paragraph, ~line 406)
- Modify: `README.md` (ESP32 proxy feature bullet, line 90)

- [ ] **Step 1: Update the esp32-proxy troubleshooting paragraph**

Read `docs/guide/esp32-proxy.md` around the "random-address scale times out on connect" paragraph. Append one sentence after the existing random-address text:

```
The proxy connects with minimal delay after spotting the scale and publishes the scan results afterward, because a GATT-only scale that was just stepped on stays connectable for only a short window.
```

- [ ] **Step 2: Refresh the README ESP32 proxy bullet**

`README.md:90` currently ends: "It connects to both public-address and random-address GATT scales, even when the controller misreports the address type."

Replace that closing sentence with:

```
It connects to both public-address and random-address GATT scales even when the controller misreports the address type, and connects with minimal delay so a briefly-connectable scale is reached before it sleeps.
```

- [ ] **Step 3: Full firmware + host verification**

```bash
cd firmware && python -m unittest discover -s tests -v
```
Expected: PASS (all firmware tests).

Then from the repo root (kill node first per project rule):
```bash
taskkill //F //IM node.exe
npm test
npm run lint
npx tsc --noEmit
npx prettier --check .
```
Expected: TS suite green, lint clean, tsc no errors, prettier no changes. (No TS files changed, so this is a regression guard.)

- [ ] **Step 4: Commit docs**

```bash
git add docs/guide/esp32-proxy.md README.md
git commit -m "docs: note minimal-delay autonomous connect for GATT scales (#231)"
```

- [ ] **Step 5: Push to dev**

```bash
git push origin dev
```

- [ ] **Step 6: Confirm the Deploy Docs workflow re-runs on dev**

Run: `"C:\Program Files\GitHub CLI\gh.exe" run list --branch dev --limit 5`
Expected: a "Deploy Docs" run queued/in_progress for the new push (dev preview regeneration).

---

## Notes / out of scope

- Lever D (shorter `CONNECT_SCAN_MS`/`CONNECT_TIMEOUT_MS` on the autonomous path) is deliberately NOT changed: those values are shared with the host-initiated connect path and a shorter window risks regressing the Eufy P2 Pro short-burst advertising case (#139). Task 1 makes the first attempt use the correct address type, which removes the 15 s wrong-type burn that was the actual blocker.
- The `ble_bridge._addr_type_probe_order` override (commit 4909038) stays as the downstream safety net; Task 1 is the upstream belt-and-suspenders that also makes the host-visible `addr_type=` log authoritative.
- If the reporter's next retest log STILL shows `addr_type=0` first after reflashing, that proves the new firmware is not loaded on-device (stale `sys.modules` cache without a soft reset, wrong copy path, or a leftover old file), not a logic bug. The issue comment asks them to soft-reset and verify the loaded module via `import ble_bridge; print(getattr(ble_bridge, '__file__', 'FROZEN'))`.
