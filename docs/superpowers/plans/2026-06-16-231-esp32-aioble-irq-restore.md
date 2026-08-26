# ESP32 #231: Restore aioble IRQ Before Connect

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the ESP32 streaming scan from permanently stealing aioble's BLE IRQ handler, so autonomous (and host-initiated) GATT connects stop timing out (#231).

**Architecture:** The firmware drives the streaming scan with the raw `bluetooth.BLE` API and installs its own `_ble.irq(_irq)` handler, but performs GATT connects with aioble. They share the one `bluetooth.BLE()` singleton, which has exactly one IRQ slot. aioble registers its dispatcher (`aioble.core.ble_irq`) only once at import and never re-registers, so once the scan handler is installed, aioble never again receives `_IRQ_PERIPHERAL_CONNECT` and every `device.connect()` times out. Fix: hand the IRQ back to aioble at the top of `BleBridge.connect()`, before any aioble call. `start_streaming()` already re-installs the scan handler after the session, so no other change is needed.

**Tech Stack:** MicroPython (ESP32 / ESP32-S3), aioble (micropython-lib), CPython `unittest` for host-runnable firmware tests.

---

## Background (verified facts)

- **Symptom (5th retest, 2026-06-16):** correct module loaded (`ble_bridge.py`, not FROZEN), `addr_type=1` tried first, scale detected at 250ms and "connecting immediately", IDF heap healthy (`free=8414239 largest=8126464`), yet `GATT connect attempt 1/1 (addr_type=1) failed ... TimeoutError`, then `addr_type=0` also times out. Unchanged across 5 rounds of fixes (MAC seed `2266086`, addr_type unpack `989ace6`, addr_type source, connect-timing/GC). Per systematic-debugging, 3+ non-curative fixes => architectural cause.
- **Root cause (code):** `firmware/ble_bridge.py` has `_ble = bluetooth.BLE()` (line 12). `start_streaming()` calls `_ble.irq(_irq)` (line 334) and `scan()` calls `_ble.irq(_irq)` (line 270); that `_irq` only handles `event == 5` (`_IRQ_SCAN_RESULT`). `stop_streaming()` (lines 383-392) only calls `_ble.gap_scan(None)` and does NOT restore aioble's handler. Grep confirms the only `_ble.irq(...)` call sites are lines 270 and 334; nothing restores aioble's dispatcher anywhere (including `main.py`).
- **Root cause (aioble source, verified via micropython-lib `aioble/core.py`):** `ble.irq(ble_irq)` is set ONCE at module import. `ensure_active()` only does `ble.active(True)` when inactive and NEVER calls `ble.irq(...)`. So once the firmware clobbers the IRQ, aioble is permanently deaf; `device.connect()`'s `_IRQ_PERIPHERAL_CONNECT` is delivered to `_irq`, dropped, and aioble's connect future never resolves => `TimeoutError`. Both addr types time out for the same reason, which is why the addr_type fixes did not move the symptom.
- **Why S3/continuous and not single-run:** `board_esp32_s3.py` sets `DEACTIVATE_BLE_AFTER_SCAN = False`, so BLE stays active and continuous mode runs `start_streaming()` at boot (`main.py:262`) before the first connect. Single-run, where the ESP32 connects without first scanning, leaves aioble's import-time IRQ intact, so it worked.
- **Connect is the single chokepoint:** both the autonomous path (`main.py` `_auto_gatt_connect`, ~line 216) and the host-initiated path (`main.py` `handle_connect`, ~line 438) call `bridge.connect(...)`. Fixing `BleBridge.connect()` covers both.
- **`aioble.core` is already imported** by `import aioble` (line 7), so `import aioble.core as _aioble_core` inside `connect()` binds the already-loaded submodule with no new device-side side effects.
- **Host test feasibility:** `ble_bridge.py` module-level code is just `import aioble/asyncio/bluetooth/board` + `_ble = bluetooth.BLE()`. `_log_idf_heap` is wrapped in `try/except` (no-op off device). With `bluetooth`, `aioble`, `aioble.core`, and `board` stubbed (same technique as `firmware/tests/test_auto_connect.py`), `BleBridge.connect()` runs on CPython.

## Chosen fix: minimal surgical restore (not the register_irq_handler refactor)

Two options were considered:
1. **Minimal (this plan):** restore `_ble.irq(aioble.core.ble_irq)` at the top of `connect()`. Tiny, directly curative, low blast radius, host-testable.
2. **Architectural:** stop calling `_ble.irq()` directly and register the scan handler via `aioble.core.register_irq_handler` so aioble stays the sole IRQ owner. Cleaner long-term, but it requires reworking both the batch and streaming scan handlers (which use different buffers) to a single dispatched handler, a larger change that is hard to validate without hardware.

Given this is the 5th remote round and the maintainer is hardware-blind, ship the minimal fix now. Note the register_irq_handler cleanup as a follow-up (out of scope below).

---

## File Structure

- **Modify:** `firmware/ble_bridge.py` — in `BleBridge.connect()` (starts line 394), immediately after `_ble.active(True)` (line 399), restore aioble's IRQ dispatcher (defensive `try/except`).
- **Create:** `firmware/tests/test_connect_irq.py` — host-runnable `unittest` that stubs `bluetooth`/`aioble`/`aioble.core`/`board`, then asserts that by the time aioble's `device.connect()` runs, the shared BLE singleton's IRQ handler is aioble's dispatcher, not the firmware scan handler.

---

### Task 1: Restore aioble IRQ before connect

**Files:**
- Modify: `firmware/ble_bridge.py:394-409`
- Test: `firmware/tests/test_connect_irq.py`

- [ ] **Step 1: Write the failing test**

Create `firmware/tests/test_connect_irq.py`:

```python
"""Host-runnable test: BleBridge.connect() restores aioble's IRQ handler (#231).

The streaming scan installs the firmware's own _ble.irq() handler on the shared
bluetooth.BLE() singleton. aioble registers its dispatcher only once at import
and never restores it, so connect() must hand the IRQ back to aioble before
calling device.connect(), or _IRQ_PERIPHERAL_CONNECT is dropped and the connect
times out.

Run: python -m unittest discover -s firmware/tests
"""

import os
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)


class _MockBLE:
    def __init__(self):
        self.current_irq = None

    def active(self, value=None):
        return True

    def irq(self, handler):
        self.current_irq = handler

    def gap_scan(self, *args):
        pass


_mock_ble = _MockBLE()

_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: _mock_ble
_bt.FLAG_READ = 0x02
_bt.FLAG_WRITE = 0x08
_bt.FLAG_NOTIFY = 0x10
_bt.FLAG_WRITE_NO_RESPONSE = 0x04
_bt.FLAG_INDICATE = 0x20
sys.modules["bluetooth"] = _bt

# aioble dispatcher sentinel: connect() must install THIS on the BLE singleton.
def _aioble_ble_irq(event, data):  # noqa: ARG001
    return None


_captured = {}


class _FakeConn:
    async def services(self):
        return []

    async def disconnect(self):
        pass

    def is_connected(self):
        return True


class _FakeDevice:
    def __init__(self, addr_type, addr_bytes):
        self._addr_type = addr_type

    async def connect(self, timeout_ms=None, scan_duration_ms=None):
        # Snapshot which IRQ handler owns the singleton at connect time.
        _captured["irq_at_connect"] = _mock_ble.current_irq
        _captured["addr_type"] = self._addr_type
        return _FakeConn()


_aioble_core = types.ModuleType("aioble.core")
_aioble_core.ble_irq = _aioble_ble_irq

_aioble = types.ModuleType("aioble")
_aioble.core = _aioble_core
_aioble.ADDR_PUBLIC = 0
_aioble.ADDR_RANDOM = 1
_aioble.Device = _FakeDevice
sys.modules["aioble"] = _aioble
sys.modules["aioble.core"] = _aioble_core

_board = types.ModuleType("board")
_board.MAX_SCAN_ENTRIES = 500
_board.AGGRESSIVE_GC = False
_board.DEACTIVATE_BLE_AFTER_SCAN = False
_board.CONNECT_TIMEOUT_MS = 15000
_board.CONNECT_SCAN_MS = 15000
_board.CONNECT_RETRIES = 1
sys.modules["board"] = _board

# Another test module (test_auto_connect) stubs sys.modules["ble_bridge"] with a
# SimpleNamespace that has no connect(). When the whole suite is discovered in one
# process that stub may already be cached, so drop it to force a real import of the
# firmware module under the stubs installed above.
sys.modules.pop("ble_bridge", None)
import ble_bridge  # noqa: E402


class TestConnectRestoresAiobleIrq(unittest.IsolatedAsyncioTestCase):
    """connect() must reclaim the BLE IRQ for aioble after a streaming scan (#231)."""

    async def test_irq_restored_before_connect(self):
        _captured.clear()
        bridge = ble_bridge.BleBridge()

        # Streaming scan installs the firmware's scan-only handler, clobbering
        # aioble's dispatcher (the production bug's precondition).
        bridge.start_streaming()
        self.assertIsNot(_mock_ble.current_irq, _aioble_core.ble_irq)

        await bridge.connect("FF:03:00:53:D6:4D", 1)

        # By the time aioble's Device.connect() ran, aioble's dispatcher must own
        # the IRQ, otherwise _IRQ_PERIPHERAL_CONNECT is dropped and it times out.
        self.assertIs(_captured["irq_at_connect"], _aioble_core.ble_irq)
        self.assertEqual(_captured["addr_type"], 1)  # FF.. static random first


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
python -m unittest firmware.tests.test_connect_irq -v
```
(or `cd firmware && python -m unittest tests.test_connect_irq -v`)

Expected: FAIL on `assertIs(_captured["irq_at_connect"], _aioble_core.ble_irq)` — without the fix, `connect()` never restores the IRQ, so the singleton still holds the firmware scan handler when `device.connect()` runs.

- [ ] **Step 3: Implement the restore**

In `firmware/ble_bridge.py`, in `connect()`, replace the opening of the method (lines 399-400):

```python
        _ble.active(True)
        addr_bytes = bytes(int(b, 16) for b in address.split(":"))
```

with:

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
python -m unittest firmware.tests.test_connect_irq -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add firmware/ble_bridge.py firmware/tests/test_connect_irq.py
git commit -m "fix(esp32): restore aioble IRQ before GATT connect (#231)"
```

---

### Task 2: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole firmware test suite (no regressions)**

Run:
```bash
python -m unittest discover -s firmware/tests -v
```
Expected: all tests pass, including the existing `test_auto_connect`, `test_ad_parser`, `test_board_config`, plus the new `test_connect_irq`.

- [ ] **Step 2: Confirm no TypeScript/host code was touched**

Run:
```bash
git diff --name-only HEAD~1
```
Expected: only `firmware/ble_bridge.py` and `firmware/tests/test_connect_irq.py`. The TS test suite (vitest), tsc, eslint, and prettier are unaffected because only Python firmware files changed. (Optional sanity: `taskkill //F //IM node.exe 2>/dev/null; npm test` should still be green, unchanged.)

---

## Self-Review

**1. Spec coverage:**
- Stop the scan handler from stealing aioble's IRQ across a connect -> restore in `connect()` (Task 1). ✓
- Cover both autonomous and host-initiated connect -> both go through `BleBridge.connect()`, the single chokepoint. ✓
- No regression to scanning -> `start_streaming()` still re-installs `_irq` after the session; the restore only runs inside `connect()`. Verified against `main.py`: every connect exit path reinstalls the scan handler — autonomous success/disconnect (`handle_disconnect`/`handle_unexpected_disconnect`), autonomous failure (`_auto_gatt_connect` except -> `start_streaming()`), host-initiated failure (`handle_connect` except -> `start_streaming()`). ✓
- ASSUMPTION (documented): `scan()` (batch) and `start_streaming()` clobber the IRQ and do not self-restore; this is safe only because every path that talks to aioble (connect/read/notify) goes through `BleBridge.connect()`, which restores it first. If a future code path calls aioble after `scan()` without going through `connect()`, it must restore the IRQ too. The register_irq_handler cleanup (follow-up) removes this footgun entirely. ✓
- Defensive against aioble version drift -> `try/except` logs and continues if `aioble.core.ble_irq` is unavailable (no worse than today). ✓

**2. Placeholder scan:** No TBD/TODO; every code step is complete. ✓

**3. Type/name consistency:** The stub registers both `sys.modules["aioble"]` and `sys.modules["aioble.core"]`, so `import aioble.core as _aioble_core` in the implementation resolves in the test. The sentinel `_aioble_core.ble_irq` is the exact attribute the implementation reads. `_FakeDevice.connect(timeout_ms, scan_duration_ms)` matches the real `device.connect(timeout_ms=..., scan_duration_ms=...)` call (ble_bridge.py:439-441). `services()` returns `[]` so the discovery loop and `bluetooth.FLAG_*` reads are not exercised, but the flags are stubbed anyway. ✓

## Out of scope / follow-ups (not in this plan)

- **Architectural cleanup:** migrate the streaming/batch scan handlers off raw `_ble.irq()` to `aioble.core.register_irq_handler` so aioble is the single IRQ owner and no manual hand-off is needed. Larger change; do after this fix is confirmed on hardware.
- **Retest comms:** after this ships to `dev`, ask @marcelorodrigo to re-flash `firmware/ble_bridge.py`, soft-reset, and confirm the `addr_type=1` connect now succeeds and a reading arrives. Not a code task.
