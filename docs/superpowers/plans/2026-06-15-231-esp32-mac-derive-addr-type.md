# #231 ESP32 derive addr_type from MAC bits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ESP32 proxy connect to the QN-Scale by deriving the BLE connect address type from the MAC's reserved high bits when the controller misreports it in the scan result, so the autonomous connect tries the correct address type first and stops timing out (#231).

**Architecture:** Firmware-only. A BLE static random address is identifiable by spec: the top two bits of the MSByte are `0b11` (`addr[0] & 0xC0 == 0xC0`). The ESP32 scan IRQ for the reporter's `FF:03:..` scale reports `addr_type=0` (public), which is impossible for that MAC and is a known NimBLE/ESP-IDF misreport. aioble `gap_connect` matches on `addr_type` AND `addr`, so the wrong type never matches and the connect times out. The fix derives the connect type from the MAC bits when, and only when, they are the unambiguous static-random pattern, otherwise it keeps trusting the scan-reported type. The opposite-type fallback probe added in `989ace6` stays as the safety net.

**Tech Stack:** MicroPython (firmware), Python `unittest` (host-runnable firmware tests under CPython with stubbed `aioble`/`bluetooth`/`board`).

---

## Root cause (for context)

After `989ace6` the firmware preserves the real scan `addr_type` (`_unpack_scan_result`) and probes the opposite type once on `TimeoutError`. The reporter retest still failed: the scan reports `addr_type=0` for `FF:03:00:53:D6:4D`, both probe attempts (`0` then `1`) time out, and the second attempt only fires after the scale has powered off.

Verified facts:
- MicroPython `_IRQ_SCAN_RESULT` order is `(addr_type, addr, adv_type, rssi, adv_data)` (MicroPython bluetooth docs). The unpack is correct, so the `addr_type=0` is what the controller actually reported.
- BLE static random addresses are defined by the top two bits of the MSByte being `0b11`, detectable as `addr[0] & 0xC0 == 0xC0` (Bluetooth Core spec; Infineon, Nordic references). `0xFF & 0xC0 == 0xC0`, so `FF:03:..` MUST be random; a reported `addr_type=0` is wrong.
- aioble `central.py` `_connect` matches the connect event with `if d.addr_type == addr_type and d.addr == addr`. A wrong `addr_type` never matches and surfaces only as a `TimeoutError`.
- The QN-Scale is GATT-only and sleeps within a few seconds of step-on (openMQTTGateway thread; `status=13` connection timeout, "device may no longer be listening"). Probing the wrong type first burns the whole awake window.

Only the static-random pattern (`0b11`) is unambiguous. Public, resolvable-private (`0b01`), and non-resolvable-private (`0b00`) addresses cannot be told apart by bits alone, so the derive only overrides for the `0b11` case and trusts the scan-reported type otherwise. This keeps the public-address scales (which connect fine today) untouched.

## File Structure

- Modify: `firmware/ble_bridge.py` — add `_addr_is_random_static(address)` module helper; extend `_addr_type_probe_order(addr_type, address=None)` to override the primary type when the MAC is unambiguously random static; pass `address` at the one call site in `connect()`.
- Modify: `firmware/tests/test_ad_parser.py` — tests for `_addr_is_random_static` and the address-aware `_addr_type_probe_order`.
- Modify: `docs/guide/esp32-proxy.md` — extend the random-address troubleshooting note.
- Modify: `README.md` — no behavior-line change needed beyond the existing random-address sentence; touch it only if the guide link text changes (project rule: README touched in this change, see Task 3).

No TypeScript changes. The host already forwards `entry.addr_type` and the firmware owns the connect address type, so deriving it on the firmware side needs no host change.

---

### Task 1: Derive the connect address type from the MAC's reserved bits

**Files:**
- Modify: `firmware/ble_bridge.py` (add `_addr_is_random_static` next to `_addr_type_probe_order` ~line 182; extend `_addr_type_probe_order` ~line 182-189; call site in `connect()` ~line 406)
- Test: `firmware/tests/test_ad_parser.py` (add two test classes before the `if __name__` block ~line 358)

- [ ] **Step 1: Write the failing tests**

Add at the end of `firmware/tests/test_ad_parser.py`, before the `if __name__ == "__main__":` block:

```python
class TestAddrIsRandomStatic(unittest.TestCase):
    """_addr_is_random_static: MSByte top two bits 0b11 => static random (#231)."""

    def test_ff_prefix_is_random_static(self):
        # 0xFF & 0xC0 == 0xC0. The reporter's QN-Scale MAC.
        self.assertTrue(ble_bridge._addr_is_random_static("FF:03:00:53:D6:4D"))

    def test_c0_prefix_is_random_static(self):
        # 0xC0 is the lowest MSByte with both top bits set.
        self.assertTrue(ble_bridge._addr_is_random_static("C0:11:22:33:44:55"))

    def test_lowercase_prefix_is_random_static(self):
        self.assertTrue(ble_bridge._addr_is_random_static("ff:03:00:53:d6:4d"))

    def test_public_oui_prefix_is_not_random_static(self):
        # 0x84 & 0xC0 == 0x80, not 0xC0 — a normal public OUI address.
        self.assertFalse(ble_bridge._addr_is_random_static("84:FC:E6:53:06:1C"))

    def test_resolvable_private_prefix_is_not_static(self):
        # 0x40 & 0xC0 == 0x40 (resolvable private) — not the static pattern.
        self.assertFalse(ble_bridge._addr_is_random_static("40:11:22:33:44:55"))

    def test_non_resolvable_private_prefix_is_not_static(self):
        # 0x00 & 0xC0 == 0x00 (non-resolvable private) — not the static pattern.
        self.assertFalse(ble_bridge._addr_is_random_static("00:11:22:33:44:55"))


class TestAddrTypeProbeOrderFromMac(unittest.TestCase):
    """_addr_type_probe_order with an address overrides a misreported type (#231)."""

    def test_random_static_mac_overrides_public_scan_type(self):
        # Scan misreported addr_type=0, but FF:.. is unambiguously random:
        # random (1) must be probed first, public (0) as the fallback.
        self.assertEqual(
            ble_bridge._addr_type_probe_order(0, "FF:03:00:53:D6:4D"), (1, 0)
        )

    def test_random_static_mac_keeps_random_first(self):
        self.assertEqual(
            ble_bridge._addr_type_probe_order(1, "FF:03:00:53:D6:4D"), (1, 0)
        )

    def test_public_mac_trusts_scan_type(self):
        # Not the static pattern: keep the scan-reported order (no override).
        self.assertEqual(
            ble_bridge._addr_type_probe_order(0, "84:FC:E6:53:06:1C"), (0, 1)
        )
        self.assertEqual(
            ble_bridge._addr_type_probe_order(1, "84:FC:E6:53:06:1C"), (1, 0)
        )

    def test_no_address_falls_back_to_scan_type(self):
        # Backward compatible with the no-address call form.
        self.assertEqual(ble_bridge._addr_type_probe_order(0), (0, 1))
        self.assertEqual(ble_bridge._addr_type_probe_order(1), (1, 0))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m unittest firmware.tests.test_ad_parser -k "AddrIsRandomStatic or AddrTypeProbeOrderFromMac"`
Expected: FAIL with `AttributeError: module 'ble_bridge' has no attribute '_addr_is_random_static'` (and the probe-order-with-address tests fail because the second positional arg is rejected).

- [ ] **Step 3: Add the `_addr_is_random_static` helper**

In `firmware/ble_bridge.py`, add a module-level function immediately before `_addr_type_probe_order`:

```python
def _addr_is_random_static(address):
    """True if a colon-MAC string is a BLE static random address.

    A static random address is defined by the top two bits of its most
    significant byte being 0b11 (addr[0] & 0xC0 == 0xC0). That pattern is
    reserved exclusively for random static addresses, so it identifies the
    type even when the controller misreports it in the scan result (some
    NimBLE / ESP-IDF builds report such a scale as public). Public,
    resolvable-private (0b01) and non-resolvable-private (0b00) addresses are
    NOT distinguishable from each other by bits alone, so only this one
    pattern is treated as authoritative (#231).
    """
    return (int(address.split(":")[0], 16) & 0xC0) == 0xC0
```

- [ ] **Step 4: Extend `_addr_type_probe_order` to take the address**

In `firmware/ble_bridge.py`, replace:

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

with:

```python
def _addr_type_probe_order(addr_type, address=None):
    """Connect address types to attempt: best-guess type first, then the
    opposite as a #231 timeout fallback. Returns ints (0 = public, 1 = random).

    aioble gap_connect matches on addr_type, so a misreported type only shows
    up as a connect timeout; probing both rules it out before giving up. When
    the MAC is an unambiguous static random address (addr[0] & 0xC0 == 0xC0),
    its real type is known from the bits, so probe random first regardless of a
    misreported scan type; otherwise trust the scan-reported type (#231).
    """
    if address is not None and _addr_is_random_static(address):
        primary = 1
    else:
        primary = addr_type & 1
    return (primary, primary ^ 1)
```

- [ ] **Step 5: Pass the address at the connect() call site**

In `firmware/ble_bridge.py` `connect()`, replace:

```python
        for probe, use_type in enumerate(_addr_type_probe_order(addr_type)):
```

with:

```python
        for probe, use_type in enumerate(_addr_type_probe_order(addr_type, address)):
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `python -m unittest firmware.tests.test_ad_parser -k "AddrIsRandomStatic or AddrTypeProbeOrderFromMac"`
Expected: PASS.

- [ ] **Step 7: Run the full parser suite (regression guard)**

Run: `python -m unittest firmware.tests.test_ad_parser`
Expected: PASS, including the existing `TestAddrTypeProbeOrder` (no-address form still returns scan-type order).

- [ ] **Step 8: Commit**

```bash
git add firmware/ble_bridge.py firmware/tests/test_ad_parser.py
git commit -m "fix(ble): derive connect addr_type from MAC bits for misreported random scales (#231)"
```

---

### Task 2: Whole firmware suite regression guard

**Files:** none (verification only)

- [ ] **Step 1: Run the full firmware test suite**

Run: `python -m unittest discover -s firmware/tests`
Expected: PASS (existing cases plus the two new classes).

---

### Task 3: Docs + README

**Files:**
- Modify: `docs/guide/esp32-proxy.md` (the `### A random-address scale times out on connect` note added in `989ace6`)
- Modify: `README.md`

- [ ] **Step 1: Extend the troubleshooting note**

In `docs/guide/esp32-proxy.md` line ~406, replace the existing single-line paragraph:

```markdown
Some scales advertise a random Bluetooth address (the first MAC byte is `C0` or higher, for example `FF:03:..`) rather than a fixed public one. The proxy now reads the advertised address type correctly and connects with it, and if a connect still times out it retries once with the opposite address type. If your scale used to log `GATT connect attempt ... failed ... TimeoutError` on every weigh-in, update the firmware and try again.
```

with (adds the misreport clause, still one line, no em dash, no double dash):

```markdown
Some scales advertise a random Bluetooth address (the first MAC byte is `C0` or higher, for example `FF:03:..`) rather than a fixed public one. The proxy reads the advertised address type and connects with it, and when the MAC is an unambiguous random address it connects with that type even if the controller reported the scan result as public. If a connect still times out it retries once with the opposite address type. If your scale used to log `GATT connect attempt ... failed ... TimeoutError` on every weigh-in, update the firmware and try again.
```

- [ ] **Step 2: Touch README per project rule**

The README ESP32 proxy bullet (line ~90) already ends with `It connects to both public-address and random-address GATT scales.` (added in `989ace6`). Replace that closing sentence:

```markdown
It connects to both public-address and random-address GATT scales.
```

with (one line, no em dash, no double dash):

```markdown
It connects to both public-address and random-address GATT scales, even when the controller misreports the address type.
```

- [ ] **Step 3: Commit**

```bash
git add docs/guide/esp32-proxy.md README.md
git commit -m "docs: clarify random-address GATT connect via MAC-derived addr_type (#231)"
```

---

### Task 4: Full verification + push

- [ ] **Step 1: Firmware suite**

Run: `python -m unittest discover -s firmware/tests`
Expected: PASS.

- [ ] **Step 2: TypeScript suite unchanged and green (regression guard)**

```bash
taskkill //F //IM node.exe
npx tsc --noEmit
npm run lint
npx prettier --check .
npm test
```
Expected: all green (no TS touched).

- [ ] **Step 3: Push to dev**

```bash
git push origin dev
```

---

## Self-Review

**Spec coverage:** MAC-derive override = Task 1 (`_addr_is_random_static` + address-aware `_addr_type_probe_order` + call site). Regression = Task 2. Docs/README rule = Task 3. Verify + push = Task 4. The deliberately-out-of-scope timeout shortening (would regress the Eufy P2 Pro short-burst window, #139) is documented in the root-cause section and not implemented.

**Placeholder scan:** No TBD/TODO. Every code step shows full code.

**Type consistency:** `_addr_is_random_static(address) -> bool` consumed by `_addr_type_probe_order(addr_type, address=None) -> (int, int)`, which is called once in `connect()` as `_addr_type_probe_order(addr_type, address)`. `address` is the colon-MAC string already passed to `connect(self, address, addr_type=0)`. Existing `TestAddrTypeProbeOrder` single-arg calls stay valid because `address` defaults to `None`.
