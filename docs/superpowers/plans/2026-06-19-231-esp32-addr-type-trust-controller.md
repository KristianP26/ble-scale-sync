# #231 ESP32 Autonomous Connect: Trust Controller-Reported Address Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ESP32 autonomous GATT connect use the controller-reported BLE address type instead of a MAC-bit heuristic, so the QN-Scale (which advertises as public) connects on the first probe instead of timing out.

**Architecture:** Two firmware modules force `addr_type=1` (random) for any address whose first byte has its top two bits set (`addr[0] & 0xC0 == 0xC0`, true for `FF:..`). That override is wrong: the scale advertises as public (`addr_type=0`), confirmed by both the ESP32 NimBLE controller and the Pi BlueZ controller (which read the advertising PDU TxAdd bit directly) and by the host-initiated connect path, which connected as public successfully in #201. Connecting as random never matches the public advertiser, so `gap_connect` never sends a connection request (no Bluetooth icon on the scale) and always times out. This plan removes the override so the reported type is probed first, keeps the opposite type as a fallback, keeps the commit `c29dc1c` aioble IRQ restore, and hardens the fallback so a non-timeout error cannot strand the connect on a single address type.

**Tech Stack:** MicroPython (firmware), aioble (BLE central), Python `unittest` host-runnable tests (CI: `python -m unittest discover -s firmware/tests -v` on Python 3.12).

## Global Constraints

- Firmware only. No config schema change, no host (TypeScript) change.
- No em dash and no double dash in any commit, comment, or doc text. CLI flags that literally require two dashes are fine.
- Conventional Commits (`fix(firmware): ...`).
- Never `git add -A` in this repo (it stages untracked `docs/superpowers/plans/*.md`). Stage explicit paths only.
- Firmware unit tests are the only automated gate (no hardware in CI). They must stay green: `python -m unittest discover -s firmware/tests -v`.
- Do not shorten `CONNECT_TIMEOUT_MS` / `CONNECT_SCAN_MS`: the long window is needed for short-burst advertisers (Eufy P2 Pro) and the no-PSRAM boards (#139). The address-type fix makes the first probe correct, so the window length is no longer the lever.

## Background: why the reported type is authoritative

A BLE advertising PDU header carries a `TxAdd` bit: `0` = public address, `1` = random address. The controller copies that bit into the HCI LE Advertising Report `Address_Type` field, so the scan-reported type is read straight from the air and is authoritative. The "top two bits `0b11` means static random" rule only classifies an address that is already known to be random; a public address may use any 48 bits, and inexpensive scale SoCs commonly advertise arbitrary non-OUI addresses with `TxAdd=0` (public) that still start with `0xFF`. Verified against the aioble source: `central.py` `_central_irq` matches a connect-complete on `d.addr_type == addr_type and d.addr == addr`, and `gap_connect` is passed `device.addr_type`, so a wrong type can only ever surface as a `TimeoutError`.

## File Structure

- `firmware/ble_bridge.py` - remove `_addr_is_random_static`; simplify `_addr_type_probe_order(addr_type)` to trust the reported type; update the one call site in `connect()`; broaden the fallback so it retries the opposite type on any connect failure.
- `firmware/main.py` - remove the `addr[0] & 0xC0` override in `_find_scale_in_raw`; add a REPL traceback in the `_auto_gatt_connect` failure path.
- `firmware/tests/test_ad_parser.py` - delete the two test classes that asserted the heuristic (`TestAddrIsRandomStatic`, `TestAddrTypeProbeOrderFromMac`).
- `firmware/tests/test_auto_connect.py` - rewrite the override tests to assert the reported type passes through unchanged; fix `test_returns_first_match`.
- `firmware/tests/test_connect_irq.py` - add a regression test that a public `FF:` scale probes public first; add a fallback test that a non-timeout error still tries the opposite type; update one stale comment.

---

## Task 1: Trust the controller-reported address type end to end

Remove both MAC-bit overrides so the reported `addr_type` is probed first, and update every test that asserted the old random-forcing behavior. After this task the QN-Scale connects as public on the first probe.

**Files:**
- Modify: `firmware/ble_bridge.py:182-211` (delete `_addr_is_random_static`, simplify `_addr_type_probe_order`), `firmware/ble_bridge.py:446` (call site)
- Modify: `firmware/main.py:175-194` (`_find_scale_in_raw`)
- Test: `firmware/tests/test_auto_connect.py`, `firmware/tests/test_ad_parser.py`, `firmware/tests/test_connect_irq.py`

**Interfaces:**
- Produces: `_addr_type_probe_order(addr_type: int) -> tuple[int, int]` returning `(reported, opposite)` where `reported = addr_type & 1`. The `address` second parameter is removed.
- Produces: `_find_scale_in_raw(raw_results) -> (mac: str, addr_bytes: bytes, addr_type: int) | None` where `addr_type` is the scan-reported value unchanged.
- Consumes: nothing new.

- [ ] **Step 1: Rewrite the `_find_scale_in_raw` tests to expect the reported type**

In `firmware/tests/test_auto_connect.py`, replace `test_returns_first_match` (currently expects `result[2] == 1`) so it expects the reported `addr_type=0`:

```python
    def test_returns_first_match(self):
        # Both entries are the same FF MAC. The first match is returned, and its
        # controller-reported addr_type is passed through unchanged (#231).
        raw = [_raw_entry(_MAC_BYTES, addr_type=0), _raw_entry(_MAC_BYTES, addr_type=1)]
        result = main._find_scale_in_raw(raw)
        self.assertIsNotNone(result)
        self.assertEqual(result[0], _MAC_STR)
        self.assertEqual(result[1], _MAC_BYTES)
        self.assertEqual(result[2], 0)  # reported type trusted, no override
```

Replace the whole `TestFindScaleAddrTypeOverride` class with:

```python
class TestFindScaleTrustsScanAddrType(unittest.TestCase):
    """_find_scale_in_raw passes the controller-reported addr_type through
    unchanged. The FF scale advertises as public and must connect as public; the
    earlier random-forcing override was the #231 bug."""

    def setUp(self):
        main._scale_macs = {_MAC_STR, _PUBLIC_MAC_STR}

    def tearDown(self):
        main._scale_macs = set()

    def test_ff_mac_reported_public_stays_public(self):
        # FF starts with 0xFF, but the controller reports it public (TxAdd=0) and
        # the host-initiated path connects it as public successfully, so the
        # reported type must win. Forcing random here was the bug (#231).
        raw = [_raw_entry(_MAC_BYTES, addr_type=0)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 0)

    def test_ff_mac_reported_random_stays_random(self):
        raw = [_raw_entry(_MAC_BYTES, addr_type=1)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 1)

    def test_public_oui_mac_reported_public_stays_public(self):
        raw = [_raw_entry(_PUBLIC_MAC_BYTES, addr_type=0)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 0)

    def test_public_oui_mac_reported_random_stays_random(self):
        raw = [_raw_entry(_PUBLIC_MAC_BYTES, addr_type=1)]
        self.assertEqual(main._find_scale_in_raw(raw)[2], 1)
```

- [ ] **Step 2: Remove the heuristic tests in `test_ad_parser.py`**

Delete the entire `TestAddrIsRandomStatic` class and the entire `TestAddrTypeProbeOrderFromMac` class (the block from `class TestAddrIsRandomStatic` through the end of `test_no_address_falls_back_to_scan_type`). Leave `TestAddrTypeProbeOrder` (the no-argument form) untouched.

- [ ] **Step 3: Add the public-first regression test in `test_connect_irq.py`**

Update the stale comment in `test_irq_restored_before_connect` from `# FF.. static random first` to `# reported type (1) probed first`. Then add this method to the same `TestConnectRestoresAiobleIrq` class:

```python
    async def test_public_scale_probes_reported_type_first(self):
        # Regression for #231: the QN-Scale advertises as public (addr_type=0).
        # connect() must probe the reported type (public=0) first, not force
        # random from the FF MAC bits, or it never matches the advertiser.
        _captured.clear()
        bridge = ble_bridge.BleBridge()
        bridge.start_streaming()
        await bridge.connect("FF:03:00:53:D6:4D", 0)
        self.assertEqual(_captured["addr_type"], 0)
```

- [ ] **Step 4: Run the tests and confirm they fail against current code**

Run: `python -m unittest discover -s firmware/tests -v`
Expected: FAIL on exactly these three (current code forces random for the FF MAC): `test_auto_connect` -> `test_ff_mac_reported_public_stays_public` (`1 != 0`) and `test_returns_first_match` (`1 != 0`); `test_connect_irq` -> `test_public_scale_probes_reported_type_first` (`1 != 0`). The other rewritten cases (`test_ff_mac_reported_random_stays_random`, the two public-OUI cases) pass already because the reported value happens to match. `test_ad_parser` has no failures (the heuristic classes were deleted in Step 2, not left dangling).

- [ ] **Step 5: Remove the override in `_find_scale_in_raw` (`main.py`)**

Replace the function body so the reported `addr_type` is returned unchanged and the docstring explains why:

```python
def _find_scale_in_raw(raw_results):
    """Find the first known scale MAC in the raw IRQ buffer.

    Returns (mac, addr_bytes, addr_type) or None. Non-destructive peek used by the
    autonomous connect logic to skip the MQTT round-trip (#201).

    The controller-reported addr_type (the advertising PDU TxAdd bit) is
    authoritative and is passed through unchanged. An earlier build forced
    addr_type=1 whenever addr[0] & 0xC0 == 0xC0 on the theory that an FF address
    must be random static, but a public address may use any bytes and cheap scale
    SoCs advertise arbitrary public addresses that also start with 0xFF, so that
    override connected the QN-Scale as random and it never matched the public
    advertiser (#231).
    """
    for addr_bytes, addr_type, _rssi, _raw in raw_results:
        mac = ":".join("%02X" % b for b in addr_bytes)
        if mac in _scale_macs:
            print(f"Auto-connect: found known scale {mac} in raw buffer (addr_type={addr_type})")
            return mac, addr_bytes, addr_type
    return None
```

- [ ] **Step 6: Simplify `_addr_type_probe_order` and delete `_addr_is_random_static` (`ble_bridge.py`)**

Delete the `_addr_is_random_static` function entirely. Replace `_addr_type_probe_order` with the no-address form:

```python
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
```

- [ ] **Step 7: Update the call site in `connect()` (`ble_bridge.py:446`)**

Change the loop header to drop the `address` argument:

```python
        for probe, use_type in enumerate(_addr_type_probe_order(addr_type)):
```

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `python -m unittest discover -s firmware/tests -v`
Expected: PASS (all firmware tests green).

- [ ] **Step 9: Commit**

```bash
git add firmware/ble_bridge.py firmware/main.py firmware/tests/test_ad_parser.py firmware/tests/test_auto_connect.py firmware/tests/test_connect_irq.py
git commit -m "fix(firmware): trust controller-reported BLE address type on autonomous connect (#231)"
```

---

## Task 2: Harden the address-type fallback and add a failure traceback

The opposite-type fallback currently runs only when the first probe raised `asyncio.TimeoutError`. After commit `c29dc1c` a re-entry into aioble surfaced a `TypeError` ("coroutine expected") instead of a `TimeoutError`, so the fallback was skipped and the connect was stranded on one type. Make the fallback fire on any connect failure, and print a full REPL traceback in the autonomous failure path so any residual error is diagnosable on the next retest.

**Files:**
- Modify: `firmware/ble_bridge.py:466-472` (fallback condition in `connect()`)
- Modify: `firmware/main.py:243-249` (`_auto_gatt_connect` except block)
- Test: `firmware/tests/test_connect_irq.py`

**Interfaces:**
- Consumes: `_addr_type_probe_order(addr_type)` from Task 1.
- Produces: no signature change. `connect()` now attempts both address types on any connect failure before raising the last exception.

- [ ] **Step 1: Add the fallback test in `test_connect_irq.py`**

Add this new class at the end of the file, before the `if __name__` guard:

```python
class TestConnectFallbackTriesOppositeType(unittest.IsolatedAsyncioTestCase):
    """connect() falls back to the opposite address type on any connect failure,
    not only a TimeoutError. A re-entry after a wrong-type timeout surfaced a
    TypeError, which previously stranded the connect on one type (#231)."""

    async def test_opposite_type_tried_after_non_timeout_error(self):
        attempts = []

        class _FailFirstDevice:
            def __init__(self, addr_type, addr_bytes):
                self._addr_type = addr_type

            async def connect(self, timeout_ms=None, scan_duration_ms=None):
                attempts.append(self._addr_type)
                if len(attempts) == 1:
                    raise TypeError("coroutine expected")
                return _FakeConn()

        orig_device = _aioble.Device
        _aioble.Device = _FailFirstDevice
        try:
            bridge = ble_bridge.BleBridge()
            result = await bridge.connect("84:FC:E6:53:06:1C", 0)
        finally:
            _aioble.Device = orig_device

        # Public reported -> probe order (0, 1). The first attempt (0) raises a
        # non-timeout TypeError; the fallback (1) must still run and succeed.
        self.assertEqual(attempts, [0, 1])
        self.assertEqual(result, {"chars": []})
```

- [ ] **Step 2: Run the test and confirm it fails against current code**

Run: `python -m unittest discover -s firmware/tests -p "test_connect_irq.py" -v`
Expected: FAIL or ERROR on `test_opposite_type_tried_after_non_timeout_error`. The first probe raises `TypeError`, the current `if not isinstance(last_exc, asyncio.TimeoutError): break` exits after one probe, and `connect()` re-raises the `TypeError`, so `attempts == [0]` and the call raises instead of returning the dict.

- [ ] **Step 3: Broaden the fallback in `connect()` (`ble_bridge.py`)**

Replace the post-inner-loop block (currently lines 466-472):

```python
            if self._conn is not None:
                break
            # Only the opposite address type can cure a timeout; bail on any
            # other error so a real failure does not double the wait.
            if not isinstance(last_exc, asyncio.TimeoutError):
                break
            gc.collect()
```

with:

```python
            if self._conn is not None:
                break
            # Try the opposite address type on any connect failure, not only a
            # TimeoutError. A misreported type is the usual reason a known-awake
            # scale fails to connect, and discriminating on the exception class
            # proved fragile: a re-entry into aioble after a wrong-type timeout
            # surfaced a TypeError ("coroutine expected"), not a TimeoutError, so
            # the fallback was skipped and the connect stranded on one type (#231).
            gc.collect()
```

- [ ] **Step 4: Add the failure traceback in `_auto_gatt_connect` (`main.py`)**

In the `except Exception as e:` block, add a REPL traceback before the existing print (matching the `sys.print_exception` pattern already used in the main loop):

```python
    except Exception as e:
        import sys

        sys.print_exception(e)
        print(f"Auto-connect failed for {mac}: {describe_exc(e)}")
        _scan_paused = False
        if board.CONTINUOUS_SCAN:
            bridge.start_streaming()
            print(f"Auto-connect: resumed streaming scan after failure")
        await publish_error(f"Auto-connect failed for {mac}: {describe_exc(e)}")
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `python -m unittest discover -s firmware/tests -v`
Expected: PASS (all firmware tests green, including the new fallback test).

- [ ] **Step 6: Commit**

```bash
git add firmware/ble_bridge.py firmware/main.py firmware/tests/test_connect_irq.py
git commit -m "fix(firmware): retry opposite BLE address type on any connect failure (#231)"
```

---

## Verification (whole-plan)

- [ ] Run the full firmware suite one more time: `python -m unittest discover -s firmware/tests -v`. Expected: OK, all tests pass.
- [ ] Confirm no remaining references to the removed helper: `git grep -n "_addr_is_random_static"` returns only matches inside `docs/superpowers/plans/` (historical), none in `firmware/`.
- [ ] Confirm the probe-order call site no longer passes `address`: `git grep -n "_addr_type_probe_order(" firmware` shows only the no-argument call in `connect()` and the `def`.

## What this does NOT change (and why)

- `CONNECT_TIMEOUT_MS` / `CONNECT_SCAN_MS` stay as-is (Eufy P2 Pro short-burst window, no-PSRAM #139). The first probe is now the correct type, so it connects while the scale is awake without needing a shorter window.
- The commit `c29dc1c` aioble IRQ restore in `connect()` stays. It is correct and necessary (aioble registers `ble.irq(ble_irq)` only at import; the streaming scan replaces it). It was masked by the wrong-type-first override, not wrong.
- `_unpack_scan_result` stays. Preserving the real `addr_type` from event slot 0 (rather than `adv_type`) is correct and unrelated to the override being removed.

## Reporter retest ask (post-release, after dev to main)

Re-flash `firmware/ble_bridge.py` and `firmware/main.py` from the released build, soft reset, weigh in with `ble.scale_mac=FF:03:00:53:D6:4D` and `auto_connect` on. Expected REPL: `Auto-connect: found known scale FF:03:00:53:D6:4D in raw buffer (addr_type=0)`, the first connect attempt `(addr_type=0)` succeeding while the scale is awake, and a reading published with `autonomous: true`. If it still times out, the new traceback plus the `addr_type=0` first-attempt line will show whether the scale really is public and where any residual error originates.

## Self-Review

**Spec coverage:** Root cause (wrong-type-first override) is removed in Task 1 across both modules (`_find_scale_in_raw`, `_addr_type_probe_order` + `_addr_is_random_static`) with the call site updated. Fallback fragility and the `coroutine expected` diagnosis are addressed in Task 2 (broaden fallback, add traceback). Tests for both. IRQ restore and timeouts explicitly preserved with rationale.

**Placeholder scan:** No TBD, no "handle errors", every code step shows full code and exact commands.

**Type consistency:** `_addr_type_probe_order(addr_type) -> (int, int)` is called as `_addr_type_probe_order(addr_type)` at the single call site (Task 1 Step 7), matching the new one-argument signature. `_find_scale_in_raw` returns `(mac, addr_bytes, addr_type)` unchanged in shape; only the `addr_type` value handling changed. The Task 2 fallback test reuses the module-level `_FakeConn` and `_aioble` stub already defined at the top of `test_connect_irq.py`.
