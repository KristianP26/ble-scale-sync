# ESP32 Pre-Connect IDF-Heap Guard (#139) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the un-catchable ESP-IDF heap-exhaustion C panic at GATT-connect time on no-PSRAM classic ESP32 boards (the `assertion:semaphor->handle` / `npl_freertos_sem_init` Guru Meditation reboot loop, reporter heap `free=392 largest=336`) into a clean, observable, recoverable `MemoryError` skip that propagates through the firmware's existing handlers, keep the device scanning instead of rebooting, and document ESP32-S3 / PSRAM as the supported path for GATT-connect scales. This is the analysis's Tier A1 + A2 + C1 recommendation. It does NOT promise to make a connect succeed on a no-PSRAM board; with WiFi up the steady-state `largest` is ~336 B, so the correct Tier A outcome is a clean skip, not a connection.

**Architecture:** A new value-returning helper `_read_idf_heap()` in `firmware/ble_bridge.py` reads the ESP-IDF data heap exactly once and returns a `(free, largest)` tuple on-device, or `None` off-device (the `import esp32` lives in a `try/except` so host unit tests, which lack the `esp32` builtin, get `None` and the gate becomes a no-op). DELIBERATE DEVIATION from the source analysis: the analysis suggested hoisting `import esp32` to module scope, but this plan keeps it inside the `try/except` on purpose. A module-scope `import esp32` would raise `ImportError` at import time on a host (where the `esp32` builtin does not exist), breaking `import ble_bridge` for every firmware unit test and defeating the `None`-off-device no-op contract the whole gate depends on. Keeping the import inside the function preserves host-importability and is the correct call; this is the only intentional departure from the analysis. The existing `_log_idf_heap(when)` is refactored to consume that helper so its serial print is unchanged but the heap is touched only once, no more than `7bef0f6` already does at `ble_bridge.py:415`. A second, PURE, host-testable decision function `_should_skip_connect(free, largest, min_free, min_largest)` (no `esp32` import, no I/O) returns whether to refuse the connect; this is the function the new unit tests exercise directly. Inside `BleBridge.connect()`, immediately after `_log_idf_heap("before connect")` and before the `_addr_type_probe_order` connect loop, a gate reads the heap once, computes effective floors as `max(always_on_crash_floor, board_tunable)` for both `largest` and `free`, and raises `MemoryError` when either is below its floor. The always-on crash floors are conservative hard constants chosen to sit far above the observed crash values (336/392) yet far below the smallest plausible successful-connect requirement (research estimate 4-12 KB), so they can only ever trip on the pathological near-zero case and can never refuse a winnable connect. Per-board tunables `CONNECT_MIN_IDF_LARGEST` and `CONNECT_MIN_IDF_FREE`, read via `getattr(board, ..., 0)`, default to `0` on every board (gate effectively crash-floor-only until a maintainer calibrates them from a real successful-connect heap delta on a PSRAM board). The `MemoryError` rides the EXISTING control flow: `_auto_gatt_connect`'s `except Exception` (main.py:243-252) prints, resumes the streaming scan, and `publish_error`s; `handle_connect`'s `except Exception` (main.py:461-465) resumes scanning and re-raises into the main-loop `except Exception` (main.py:611-615) which `publish_error`s. No new exception type and no new plumbing: `MemoryError` degrades exactly like a `TimeoutError` does today.

**Tech Stack:** MicroPython firmware (host-importable for unit tests by stubbing `aioble` / `bluetooth` / `board` via `sys.modules`), Python `unittest` (host-runnable, the CI `python-check` job), no TypeScript / npm / tsc / eslint involvement.

## Global Constraints

- This is the MicroPython FIRMWARE under `firmware/`, NOT the TypeScript app. Do NOT run `npm`, `npx tsc`, `eslint`, or `prettier` for any change in this plan. None of these changes touch `src/`.
- Firmware code MUST stay valid MicroPython AND host-importable. The new heap-read helper MUST no-op off-device exactly like `_log_idf_heap` already does, via `try: import esp32 ... except Exception: return None`. The skip-decision function MUST be pure (no `esp32` import, no print) so host tests can call it directly.
- Tests run host-side: `python -m unittest discover -s firmware/tests` (the exact command CI's `python-check` job runs, with `-v`). There is NO ruff / black / flake8 / mypy step in CI for firmware (verified in `.github/workflows/ci.yml`), so the only firmware gate is the unittest discovery plus `python -m py_compile` of the edited modules to catch syntax errors the way CI does for the garmin scripts.
- Behavior preservation is the dominant requirement. The S3 / PSRAM connect path and ALL existing firmware behavior MUST be unchanged: with board tunables at `0` and the crash floors well below any healthy heap, the gate never trips on a PSRAM board (its `largest`/`free` are tens of KB), and off-device-import-less host tests get `None` from the helper so the gate is skipped. Every one of the 68 existing firmware tests MUST stay green at every commit.
- Never use an em dash or a double dash anywhere (code, comments, commit messages, docs, this plan). Rewrite the sentence instead.
- Conventional Commits, per-task. Firmware uses `fix(firmware):`, `test(firmware):`, `docs:` (see git log, e.g. `fix(firmware): drain aioble services before characteristic discovery (#231)`).
- NEVER `git add -A` in this repo (it stages untracked `docs/superpowers/plans/*.md`). Use explicit `git add <named files>`.
- Branch: work on `dev` (already checked out). Do not touch `main`. Do NOT push; the orchestrator pushes after a final review.
- Do NOT close issue #139. This is graceful degradation plus docs, not a full fix. The orchestrator handles the issue comment.
- OUT OF SCOPE (the analysis proves these are not viable or not wanted; do not drift into them):
  - **Tier B1 (WiFi-down-during-connect):** NOT viable on stock MicroPython. The `_wlan` handle exists only inside `if board.HAS_DISPLAY` (main.py:506-508) and both reporter boards are headless; `mqtt_as` owns the STA interface with no pause-and-hand-back primitive; stock `WLAN.active(False)` calls only `esp_wifi_stop()` (frees a few KB, far short of the kilobytes needed) and MicroPython exposes no `esp_wifi_deinit` binding; the buffered-notify rework is a net regression on the no-PSRAM target. Do NOT implement.
  - **Tier B2 (custom MicroPython build):** the only WiFi-up + GATT-works path, but unbudgeted and it breaks the flash-stock + copy-`.py` onboarding. Parked as a deliberate future maintainer decision. Do NOT implement.
  - **Tier B3 (scan-loop memory hygiene):** lowering `MAX_SCAN_ENTRIES` / filtering adverts cannot reclaim the tens of KB pinned by WiFi + live GC splits and must not be sold as a #139 fix. Out of scope.
  - A structured `connect_skipped` MQTT status: would need a matching Node-side consumer to be useful, so it is out of scope. A clearer human-readable error STRING in the existing `MemoryError` message is in scope (A2).

---

## Background facts (verified against the codebase, 2026-06-19)

All line references below were confirmed by reading the real files at the stated commit (`dev` HEAD `b162b06`). The three commits that landed after `c584098` (issue #244: `072a9da`, `14b7ad1`, `b162b06`) are a TypeScript-only refactor: `git diff --stat c584098 b162b06` touches only `src/*.ts`, `tests/*.ts`, and `tsconfig.test-types.json`, and NONE of `firmware/`, `docs/guide/esp32-proxy.md`, or the firmware tests. Every firmware line reference in this plan still matches the current working tree.

**`firmware/ble_bridge.py`:**
- `_log_idf_heap(when)` is defined at lines 18-36. Its docstring is lines 19-27. The actual heap read is lines 28-36:
  ```python
  try:
      import esp32

      regions = esp32.idf_heap_info(esp32.HEAP_DATA)
      free = sum(r[1] for r in regions)
      largest = max(r[2] for r in regions)
      print("IDF heap %s: free=%d largest=%d" % (when, free, largest))
  except Exception:
      pass
  ```
  This existing call runs in production on the failing boards right before connect and has never been reported to crash, which is the evidence that reading the heap is safe in the near-OOM state.
- `BleBridge.connect()` is lines 380-516. The two pre-connect `gc.collect()` passes are lines 406-414, preceded by the explanatory comment at lines 400-405. `_log_idf_heap("before connect")` is called at line 415. The `_addr_type_probe_order` connect loop begins at line 434 (`for probe, use_type in enumerate(_addr_type_probe_order(addr_type)):`). The gate is inserted between line 415 and line 434 (after the log, before the timeout/scan/retry reads at lines 422-424 is acceptable, but placing it immediately after line 415 and before line 417's comment block is cleanest).
- The comment at lines 400-405 says collecting "gives NimBLE the best chance to allocate"; per the analysis this is the comment to correct (gc.collect cannot hand kilobytes back to the IDF heap under SPLIT_HEAP_AUTO), while KEEPING both passes (lines 408 and 413-414, the second gated on `AGGRESSIVE_GC`). The second pass is the one cheap lever that can return a just-emptied split to the IDF heap; do NOT remove it.

**`firmware/main.py`:**
- `_auto_gatt_connect(mac, addr_type)` is lines 197-254. Its `except Exception as e:` block is lines 243-252: it `sys.print_exception(e)`, prints "Auto-connect failed", sets `_scan_paused = False`, restarts streaming on `CONTINUOUS_SCAN`, and `await publish_error(...)`. A bare `except Exception` catches `MemoryError` (it is a subclass of `Exception`), so this path already degrades a `MemoryError` exactly like any other connect failure: clean, observable, device keeps scanning, no reboot. `finally:` clears `_busy` (line 253-254).
- `handle_connect(payload)` is lines 415-467. Its `except Exception as e:` block is lines 461-465: sets `_scan_paused = False`, restarts streaming on `CONTINUOUS_SCAN`, then `raise e`. The re-raise lands in the main-loop dispatcher's `except Exception as e:` at lines 611-615, which `sys.print_exception(e)` and `await publish_error(describe_exc(e))`. So a host-initiated connect that hits the gate also surfaces cleanly to the host with no reboot.
- Conclusion (confirmed by reading both handlers): `MemoryError` needs NO new propagation plumbing. Using `MemoryError` rather than a new exception type is deliberate so it rides these existing `except Exception` paths identically to a `TimeoutError`.

**Board files (all four):** each defines a "GATT connect tuning (#139)" block with `CONNECT_TIMEOUT_MS`, `CONNECT_SCAN_MS`, `CONNECT_RETRIES`:
- `firmware/board_atom_echo.py` lines 20-25 (no PSRAM, ~100 KB free).
- `firmware/board_esp_wroom_32.py` lines 27-32 (no PSRAM, ~90 KB free; its docstring already names the exact failure: "NimBLE crashes on a failed semaphore allocation (Guru Meditation, reboot loop)").
- `firmware/board_esp32_s3.py` lines 24-28 (8 MB PSRAM, ample IDF-heap headroom).
- `firmware/board_guition_4848.py` lines 26-29 (ESP32-S3-4848S040; `HAS_DISPLAY = True`). Its docstring (lines 1-8) only describes the ST7701S RGB LCD and pin mapping, not RAM, so do NOT cite it for PSRAM. The board family is the integrated-PSRAM ESP32-S3-4848S040, and the module itself profiles like the other PSRAM board: `DEACTIVATE_BLE_AFTER_SCAN = False`, `CONTINUOUS_SCAN = True`, `MAX_SCAN_ENTRIES = 500`, and no `AGGRESSIVE_GC` (so the `getattr(board, "AGGRESSIVE_GC", True)` default applies but the connect window stays one long 15 s pass like `board_esp32_s3.py`). On that evidence it is a PSRAM S3 board, so a default of `0` for the new tunables is correct (the gate stays crash-floor-only and never trips on its healthy heap).
- `firmware/board.py` re-exports `*` from the matched board module, so adding the two constants to each board module makes them visible as `board.CONNECT_MIN_IDF_LARGEST` / `board.CONNECT_MIN_IDF_FREE`. The gate reads them via `getattr(board, ..., 0)` so a board that somehow lacks them still defaults to `0`.

**Tests (`firmware/tests/`, host-runnable):**
- The harness stubs MicroPython-only modules via `sys.modules` BEFORE importing firmware, then imports the firmware module under those stubs. `test_ad_parser.py` (lines 24-30) and `test_connect_irq.py` (lines 38-210) are the reference patterns: `sys.modules["aioble"] = types.ModuleType("aioble")`, a `bluetooth` stub whose `BLE` is `lambda: None` (or a mock), and a `board` stub `types.ModuleType("board")` with the constants the imported code reads at load time. `ble_bridge.py` calls `bluetooth.BLE()` at import (line 12) and `import board` (line 10), so both must be stubbed before `import ble_bridge`.
- `test_board_config.py` imports each `board_*.py` directly with `importlib.import_module` and asserts the per-board constants. `_ALL_BOARDS` is the four module names (lines 20-25). This is the file to extend for the new board constants.
- Baseline: `python -m unittest discover -s firmware/tests` reports `Ran 68 tests` `OK` on the current `dev` HEAD. The CI `python-check` job runs exactly `python -m unittest discover -s firmware/tests -v` plus `python -m py_compile` of the garmin scripts.

**Crash-floor constants (chosen and justified here):**
- `CRASH_FLOOR_LARGEST = 1024` (1 KB) and `CRASH_FLOOR_FREE = 2048` (2 KB), defined as module constants in `ble_bridge.py`.
- Reasoning the executor MUST preserve in the code comment: the observed crash is at `free=392 largest=336`. A BLE central connection plus GATT discovery needs kilobytes of internal heap across several distinct-sized allocations (per-conn structs, FreeRTOS semaphores, 256 B MSYS mbufs), estimated 4-12 KB and never measured on this exact build. A floor of `largest < 1024` or `free < 2048` therefore sits comfortably ABOVE the 336/392 crash point (so it reliably catches the pathological near-zero case) and well BELOW the smallest plausible winnable connect (4 KB), so it can NEVER refuse a connect that could have succeeded. It is a pure crash guard, not a connect-viability predictor. Deciding which connects are winnable is left to the board tunables, which default to `0` until calibrated.
- The gate must check BOTH `largest` and `free` together (`largest < eff_min_largest OR free < eff_min_free`). A largest-block-only check is structurally insufficient because several allocations of different sizes must all land, so the free total is an independent constraint (per analysis section 1).

---

## Task 1: Refactor heap read into a value-returning helper and add the pure skip-decision function

**Files:**
- Modify: `firmware/ble_bridge.py` (add `_read_idf_heap()`, add `_should_skip_connect(...)`, add crash-floor module constants, refactor `_log_idf_heap` to consume the helper). Do NOT add the gate to `connect()` yet (that is Task 2), so the refactor lands behavior-neutral and the existing suite proves it.
- Test: `firmware/tests/test_connect_heap_guard.py` (NEW).

**Produces / consumes:**
- Produces `_read_idf_heap()` returning `(free, largest)` on-device, `None` off-device (host tests get `None`).
- Produces `_should_skip_connect(free, largest, min_free, min_largest) -> bool`, a pure function: `True` when `largest < min_largest or free < min_free`.
- Produces module constants `CRASH_FLOOR_LARGEST = 1024`, `CRASH_FLOOR_FREE = 2048`.
- `_log_idf_heap(when)` now consumes `_read_idf_heap()` (heap touched once) and prints the same line.
- Consumes nothing new; `_should_skip_connect` is import-free and pure.

**TDD Steps:**

- [ ] **Step 1: Write the failing test** `firmware/tests/test_connect_heap_guard.py`. Follow the exact stub pattern from `test_connect_irq.py` (stub `aioble`, `bluetooth`, `board` via `sys.modules` before `import ble_bridge`; pop any cached `ble_bridge` stub left by `test_auto_connect.py`). Because the host has no `esp32` builtin, `_read_idf_heap()` returns `None` here. Assert:
  - `ble_bridge._should_skip_connect` trips at the observed crash values: `_should_skip_connect(392, 336, 0, 0)` is truthy (free 392 < CRASH_FLOOR_FREE 2048 and largest 336 < CRASH_FLOOR_LARGEST 1024 once the gate combines the floor; but since the PURE function takes the EFFECTIVE floors, pass the crash floors explicitly: `_should_skip_connect(392, 336, ble_bridge.CRASH_FLOOR_FREE, ble_bridge.CRASH_FLOOR_LARGEST)` is `True`).
  - Does NOT trip at healthy values: `_should_skip_connect(80000, 40000, ble_bridge.CRASH_FLOOR_FREE, ble_bridge.CRASH_FLOOR_LARGEST)` is `False` (tens of KB, like a PSRAM board).
  - A non-zero board override raises the bar: with a healthy-ish `largest=5000 free=20000` that passes the crash floor, `_should_skip_connect(20000, 5000, 16384, 4096)` is `False`, but raising the largest floor above the value `_should_skip_connect(20000, 5000, 16384, 8192)` is `True` (override `min_largest=8192 > 5000`), and raising the free floor `_should_skip_connect(20000, 5000, 32768, 4096)` is `True` (override `min_free=32768 > 20000`). This proves a board tunable can refuse a connect the crash floor alone would allow.
  - Boundary: a value exactly at the floor is NOT skipped (`_should_skip_connect(2048, 1024, 2048, 1024)` is `False`; strict `<`).
  - The crash floors are the documented constants: `assertEqual(ble_bridge.CRASH_FLOOR_LARGEST, 1024)` and `assertEqual(ble_bridge.CRASH_FLOOR_FREE, 2048)`.
  - The off-device heap-read helper returns `None` so the gate is skipped: `assertIsNone(ble_bridge._read_idf_heap())`.

- [ ] **Step 2: Run the test to verify it fails.**
  Run (bash or PowerShell): `python -m unittest firmware.tests.test_connect_heap_guard -v`
  (or scoped discovery: `python -m unittest discover -s firmware/tests -p test_connect_heap_guard.py -v`).
  Expected: FAIL with `AttributeError: module 'ble_bridge' has no attribute '_should_skip_connect'` (and/or `_read_idf_heap` / `CRASH_FLOOR_LARGEST`).

- [ ] **Step 3: Write the implementation** in `firmware/ble_bridge.py`.
  - Add module constants near the top (after `_BT_BASE_SUFFIX`, around line 15-16):
    ```python
    # Always-on conservative crash floor for the pre-connect IDF-heap guard (#139).
    # The observed crash is at free=392 largest=336. A BLE central connection plus
    # GATT discovery needs kilobytes across several distinct-sized allocations
    # (estimated 4 to 12 KB, never measured on this build), so a floor far above
    # 336/392 yet far below 4 KB can only ever trip the pathological near-zero case
    # and can never refuse a connect that could have succeeded. Deciding which
    # connects are winnable is left to the board tunables, which default to 0.
    CRASH_FLOOR_LARGEST = 1024
    CRASH_FLOOR_FREE = 2048
    ```
  - Add `_read_idf_heap()` returning the tuple on-device, `None` off-device:
    ```python
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
    ```
  - Refactor `_log_idf_heap(when)` so it calls `_read_idf_heap()` once and prints from the tuple (keep the existing docstring, lightly trimmed if needed, no behavior change):
    ```python
    def _log_idf_heap(when):
        """Log ESP-IDF heap headroom (best-effort, no-op off-device). See
        _read_idf_heap for why the read can be absent. Tiny `largest` here tells a
        RAM ceiling apart from a radio-coexistence timeout (healthy `largest`)."""
        heap = _read_idf_heap()
        if heap is not None:
            free, largest = heap
            print("IDF heap %s: free=%d largest=%d" % (when, free, largest))
    ```
  - Add the pure decision function (no `esp32`, no print):
    ```python
    def _should_skip_connect(free, largest, min_free, min_largest):
        """Pure crash-floor decision (#139): True when the IDF heap is too low to
        attempt a GATT connect. Gates the largest contiguous block AND the free
        total together, because connection bring-up performs several
        distinct-sized allocations that must all land, so a largest-only check is
        structurally insufficient. min_free / min_largest are the EFFECTIVE floors
        (max of the always-on crash floor and the board tunable); this function is
        host-testable and does not read the heap itself."""
        return largest < min_largest or free < min_free
    ```

- [ ] **Step 4: Run the new test to verify it passes**, then run the FULL firmware suite to prove the refactor is behavior-neutral.
  Run: `python -m unittest firmware.tests.test_connect_heap_guard -v` (expect PASS), then `python -m unittest discover -s firmware/tests -v` (expect `Ran` a count `> 68` and `OK`: the 68 prior tests plus however many methods the new module adds; do NOT assert an exact total, since the new assertions may be split across several test methods). The gate is the `OK` result with all 68 pre-existing tests still passing, not the precise count; the `_log_idf_heap` refactor changes no observable host behavior because off-device it still no-ops.

- [ ] **Step 5: Firmware gate + py_compile + commit.** This gate runs in EVERY task.
  ```bash
  python -m py_compile firmware/ble_bridge.py
  python -m unittest discover -s firmware/tests -v
  git add firmware/ble_bridge.py firmware/tests/test_connect_heap_guard.py
  git commit -m "test(firmware): add pure IDF-heap skip-decision and value-returning heap read (#139)"
  ```
  Expected: `py_compile` silent (no syntax error), unittest `OK`, commit succeeds. (`git add` names only the two files; it does NOT stage `docs/superpowers/plans`.)

---

## Task 2: Insert the pre-connect IDF-heap gate in BleBridge.connect()

**Files:**
- Modify: `firmware/ble_bridge.py` (`connect()`, between line 415 `_log_idf_heap("before connect")` and the connect loop at line 434).
- Test: `firmware/tests/test_connect_heap_guard.py` (extend with a thin composition assertion). The off-device no-op of the gate is ALREADY proven by the existing `firmware/tests/test_connect_irq.py` connect tests, so Task 2 does NOT re-author the full aioble connect mock (see Step 1).

**Produces / consumes:**
- Consumes `_read_idf_heap()`, `_should_skip_connect()`, `CRASH_FLOOR_LARGEST`, `CRASH_FLOOR_FREE`, and `getattr(board, "CONNECT_MIN_IDF_LARGEST", 0)` / `getattr(board, "CONNECT_MIN_IDF_FREE", 0)`.
- Produces: `connect()` raises `MemoryError` with a message including `free`, `largest`, `#139`, and the "use an ESP32-S3 / PSRAM board for GATT-connect scales" hint when the heap is below the effective floor on-device; off-device (`_read_idf_heap()` is `None`) the gate is skipped so the existing connect-mock tests in `test_connect_irq.py` proceed unchanged.

**TDD Steps:**

- [ ] **Step 1: Add a thin composition assertion** to `firmware/tests/test_connect_heap_guard.py`. Do NOT duplicate the ~190-line aioble connect mock from `test_connect_irq.py` (its `_MockBLE`, `_aioble_ble_irq`, `_FakeDevice`, `_FakeConn` with async-iterator `services()`, ADDR_PUBLIC/RANDOM, the `board` stub WITHOUT `CONNECT_MIN_IDF_*`, and the mandatory `sys.modules.pop("ble_bridge")`). That suite already drives `bridge.connect(...)` through to a returned conn off-device, so once this task's gate lands those tests run THROUGH the new gate and already prove it no-ops (they still return their mapped `{"chars": ...}` because `_read_idf_heap()` is `None` on host). Re-authoring that mock here only adds maintenance burden. Instead add a single host-pure assertion that pins the effective-floor composition the gate uses:
  - `self.assertEqual(max(ble_bridge.CRASH_FLOOR_LARGEST, 0), 1024)` and `self.assertEqual(max(ble_bridge.CRASH_FLOOR_FREE, 0), 2048)`: a board override of `0` collapses to the crash floor. The gate code in Step 3 MUST use the identical `max(...)` expression, so this documents the composition contract. The skip-logic assertions themselves (skip-at-crash, no-skip-at-healthy, board-override-raises-bar) already live in Task 1 Step 1 and remain the load-bearing failing test for the skip decision.
  - The off-device no-op of `connect()` itself is covered by the existing `test_connect_irq.py` connect tests after this gate lands (they would fail if the gate raised off-device), so no new async connect test is required. If a dedicated regression guard for the no-op is wanted, prefer reusing the `test_connect_irq.py` harness shape minimally over building a fresh mock.

- [ ] **Step 2: Run the test to verify state.**
  Run: `python -m unittest firmware.tests.test_connect_heap_guard -v`
  Expected: the thin composition assertions PASS immediately (they exercise only the Task 1 constants, which already exist). They are a guard, not a red-green driver; the red-green driver for the skip decision is Task 1 Step 1. The behavior-preservation proof for the gate's off-device no-op is the full-suite run in Step 4 (the existing `test_connect_irq.py` connect tests must stay green with the gate present).

- [ ] **Step 3: Write the implementation.** In `connect()`, immediately after line 415 (`_log_idf_heap("before connect")`) and before the existing comment block at line 417, insert:
  ```python
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
  ```
  Because `device.connect()` / `npl_freertos_sem_init` never run when the gate trips, the NULL-semaphore panic cannot happen. The `MemoryError` propagates out of `connect()` into `_auto_gatt_connect` (main.py:243-252) or `handle_connect` (main.py:461-465) -> main-loop (main.py:611-615), all of which already catch `Exception`, resume scanning, and `publish_error`. No change to main.py is required; confirm by re-reading those three handlers that each catches `Exception` (it does) so `MemoryError` is handled identically to a `TimeoutError`.

- [ ] **Step 4: Run the new/updated test, then the full suite (this is the load-bearing no-op proof).**
  Run: `python -m unittest firmware.tests.test_connect_heap_guard -v` (expect PASS), then `python -m unittest discover -s firmware/tests -v`. Expect `OK` with all `test_connect_irq.py` connect tests STILL green: they import `ble_bridge` without `esp32`, so `_read_idf_heap()` is `None`, the gate is skipped, and `bridge.connect(...)` returns its mapped `{"chars": ...}` exactly as before the gate was inserted. That green run is the behavior-preservation evidence; if any `test_connect_irq.py` test regresses, the gate is wrongly firing off-device and the `None` guard is broken.

- [ ] **Step 5: Firmware gate + py_compile + commit.**
  ```bash
  python -m py_compile firmware/ble_bridge.py
  python -m unittest discover -s firmware/tests -v
  git add firmware/ble_bridge.py firmware/tests/test_connect_heap_guard.py
  git commit -m "fix(firmware): refuse GATT connect on near-empty IDF heap instead of crashing (#139)"
  ```
  Expected: `py_compile` silent, unittest `OK`, commit succeeds.

---

## Task 3: Add board tunables (default 0) to all four board files and assert them

**Files:**
- Modify: `firmware/board_atom_echo.py`, `firmware/board_esp_wroom_32.py`, `firmware/board_esp32_s3.py`, `firmware/board_guition_4848.py` (add `CONNECT_MIN_IDF_LARGEST = 0` and `CONNECT_MIN_IDF_FREE = 0` into each board's `#139` GATT-connect tuning block).
- Test: `firmware/tests/test_board_config.py` (extend `TestBoardConnectConfig`).

**Produces / consumes:**
- Produces `board.CONNECT_MIN_IDF_LARGEST` and `board.CONNECT_MIN_IDF_FREE` (both `0`) on every board, surfaced through `board.py`'s `from board_* import *`.
- Consumed by the gate in Task 2 via `getattr`. Default `0` means the gate stays crash-floor-only on every board, so the S3 / PSRAM connect path is behaviorally unchanged (its healthy heap is far above the 1 KB / 2 KB crash floor, and `max(floor, 0) == floor`).

**TDD Steps:**

- [ ] **Step 1: Write the failing test** (extend `firmware/tests/test_board_config.py`). Add a method to `TestBoardConnectConfig`:
  ```python
  def test_all_boards_define_idf_heap_tunables_default_zero(self):
      for name in _ALL_BOARDS:
          mod = self._load(name)
          for const in ("CONNECT_MIN_IDF_LARGEST", "CONNECT_MIN_IDF_FREE"):
              self.assertTrue(hasattr(mod, const), f"{name} missing {const}")
              value = getattr(mod, const)
              self.assertIsInstance(value, int, f"{name}.{const} must be int")
              self.assertGreaterEqual(value, 0, f"{name}.{const} must be >= 0")
  ```
  (The requirement is `int >= 0`; the shipped default is `0` so the gate is crash-floor-only. The `>= 0` bound lets a maintainer later raise a board's floor after calibration without editing the test.)

- [ ] **Step 2: Run the test to verify it fails.**
  Run: `python -m unittest firmware.tests.test_board_config -v`
  Expected: FAIL with `AssertionError: board_atom_echo missing CONNECT_MIN_IDF_LARGEST` (first board lacking the constant).

- [ ] **Step 3: Write the implementation.** In each of the four board files, inside the existing "GATT connect tuning (#139)" block (right after `CONNECT_RETRIES`), add:
  ```python
  # Pre-connect IDF-heap guard floors (#139). Default 0 = pure always-on crash
  # floor (ble_bridge.CRASH_FLOOR_*). Raise these only after measuring a real
  # successful-connect heap delta on a PSRAM board: set CONNECT_MIN_IDF_FREE a
  # little above the observed (free_before - free_after) connection cost and
  # CONNECT_MIN_IDF_LARGEST a little above the observed post-connect largest
  # floor. gc.collect() cannot hand kilobytes back to the IDF heap, so a non-zero
  # value here only ever produces a clean skip, never a successful connect, on a
  # no-PSRAM board with WiFi up.
  CONNECT_MIN_IDF_LARGEST = 0
  CONNECT_MIN_IDF_FREE = 0
  ```
  Apply the identical two assignments to all four boards (the comment may be abbreviated on the S3/Guition boards but the two `= 0` lines are required on every board). `board_guition_4848.py` is a PSRAM S3 board (ESP32-S3-4848S040 family, same `DEACTIVATE_BLE_AFTER_SCAN = False` / `MAX_SCAN_ENTRIES = 500` / one-long-window profile as `board_esp32_s3.py`; its docstring does not mention PSRAM, so do not cite it), so `0` is correct there too.

- [ ] **Step 4: Run the board test, then the full suite.**
  Run: `python -m unittest firmware.tests.test_board_config -v` (expect PASS, including the existing `test_psram_boards_keep_single_long_window` and `test_no_psram_boards_use_tighter_window_and_retry` which are untouched), then `python -m unittest discover -s firmware/tests -v` (expect `OK`).

- [ ] **Step 5: Firmware gate + py_compile + commit.**
  ```bash
  python -m py_compile firmware/board_atom_echo.py firmware/board_esp_wroom_32.py firmware/board_esp32_s3.py firmware/board_guition_4848.py
  python -m unittest discover -s firmware/tests -v
  git add firmware/board_atom_echo.py firmware/board_esp_wroom_32.py firmware/board_esp32_s3.py firmware/board_guition_4848.py firmware/tests/test_board_config.py
  git commit -m "fix(firmware): add per-board IDF-heap guard tunables defaulting to 0 (#139)"
  ```
  Expected: `py_compile` silent, unittest `OK`, commit succeeds.

---

## Task 4: Comment cleanup in ble_bridge.py only (A2)

**Files:**
- Modify: `firmware/ble_bridge.py` ONLY (the pre-connect `gc.collect()` comment at lines 400-405; keep BOTH passes).
- Do NOT touch any `firmware/board_*.py` file in this task. The board files are deliberately out of scope here: the WROOM-32 docstring already correctly attributes the crash to a failed semaphore allocation, and Task 3 already added a tunable comment to every board's `#139` block stating that `gc.collect()` cannot hand kilobytes back to the IDF heap, so no further board comment edit is needed. Leaving the board files untouched also avoids the pre-existing U+2014 em dashes that sit in their coexistence/docstring comments (`board_atom_echo.py:9`, `board_esp32_s3.py:11,21`, `board_guition_4848.py:12,119`): an edit near those lines could either reproduce a forbidden em dash or get entangled with text this plan does not own. Task 3's new tunable block is inserted after `CONNECT_RETRIES`, clear of those em-dash lines, and is itself em-dash-free, so the board changes already made in Task 3 are safe; this task simply does not add to them.
- Test: no new test; this is comment-only. The full suite MUST stay green (comments do not change behavior).

**Produces / consumes:** documentation-only correctness. No interface change.

**TDD Steps:**

- [ ] **Step 1 (no failing test; this task is comment-only).** Before editing, run `python -m unittest discover -s firmware/tests -v` and record `OK` as the baseline these edits must preserve.

- [ ] **Step 2: Edit the `connect()` gc comment** at `firmware/ble_bridge.py` lines 400-405. Replace the "gives NimBLE the best chance to allocate" framing with the honest statement, while keeping both `gc.collect()` passes (lines 408 and 413-414). Suggested replacement comment:
  ```python
  # Two gc.collect() passes before connecting (#139). Under MICROPY_GC_SPLIT_HEAP_AUTO
  # a MicroPython split is returned to the ESP-IDF heap only when it becomes fully
  # empty during a pass, so gc.collect() cannot hand kilobytes back to the IDF heap
  # that NimBLE allocates from; on a busy no-PSRAM board it usually frees zero whole
  # splits. It is kept because the second pass is the single cheap lever that can
  # release a split the first only just emptied (for example the scan buffers), and
  # it costs only a few ms against a multi-second connect window. gc.mem_free()
  # measures the GC heap, not this pool, so it must never gate a connect; the real
  # guard is the IDF-heap read below.
  ```
  Keep the existing second-pass comment at lines 409-412 (or fold it into the above) and KEEP the `if getattr(board, "AGGRESSIVE_GC", True): gc.collect()` line. Do NOT remove either pass.

- [ ] **Step 3: Do NOT edit any board file.** The board `#139` blocks already read correctly after Task 3 (the WROOM-32 docstring names the semaphore-allocation crash; every board's Task 3 tunable comment already states `gc.collect()` cannot hand kilobytes back to the IDF heap). Confirm by re-reading each board's `#139` block that no comment claims gc.collect frees the IDF heap, then leave the board files untouched. This also keeps the plan clear of the pre-existing em dashes in those files. If a future reading ever finds a board comment that does claim gc reclaims the IDF heap, raise it separately rather than editing it here, because any edit on those lines must also rewrite the adjacent em-dash sentence, which is out of this task's scope.

- [ ] **Step 4: Run the full suite to confirm the single comment edit changed nothing.**
  Run: `python -m unittest discover -s firmware/tests -v`
  Expected: `OK`, same test count as the baseline in Step 1.

- [ ] **Step 5: Firmware gate + py_compile + commit (ble_bridge.py only).**
  ```bash
  python -m py_compile firmware/ble_bridge.py
  python -m unittest discover -s firmware/tests -v
  git add firmware/ble_bridge.py
  git commit -m "docs(firmware): correct gc-vs-IDF-heap comment around the connect guard (#139)"
  ```
  Expected: `py_compile` silent, unittest `OK`, commit succeeds. Only `firmware/ble_bridge.py` is staged; no board file is touched in this task.

---

## Task 5: Docs (C1) - scale-type x board support table and #139 guidance

**Files:**
- Modify: `docs/guide/esp32-proxy.md` (update the existing #139 section that `7bef0f6` added at lines 385-398, and the "Broadcast vs GATT scales and RAM" tip at lines 62-64; add a scale-type x board support table).
- Test: none (docs only). No firmware behavior changes, so the firmware suite is unaffected; still run it as the per-task gate to prove nothing regressed.

**Produces / consumes:** user-facing guidance. No code interface change.

**TDD Steps:**

- [ ] **Step 1 (no failing test; docs only).** Run `python -m unittest discover -s firmware/tests -v` and record `OK` as the baseline.

- [ ] **Step 2: Add a scale-type x board support table** to `docs/guide/esp32-proxy.md`, near the existing "Supported Boards" / "Broadcast vs GATT scales and RAM" content (around lines 49-64). The table makes the supported floor explicit. No em dash, no double dash anywhere. Content to convey:
  - Columns: Scale type, Example scales, No-PSRAM classic ESP32 (WROOM-32, Atom Echo, ESP-32D), ESP32-S3 / PSRAM (S3-DevKitC, Guition).
  - Broadcast-only scales (Mi Scale 2, Xiaomi S800): "Reliable" on both columns (no connection needed; work on any board).
  - GATT-connect scales (Yunmai, Inlife, Eufy T9120, QN / Renpho ES-CS20M): "Not supported, clean skip" on no-PSRAM; "Supported" on ESP32-S3 / PSRAM.
  - One sentence under the table: a no-PSRAM classic ESP32 is a reliable BROADCAST-ONLY proxy; for GATT-connect scales use an ESP32-S3 / PSRAM board because the BLE central connection plus GATT discovery needs kilobytes of ESP-IDF internal heap that WiFi-STA plus NimBLE plus the MicroPython GC heap leave near zero on a no-PSRAM board (steady-state largest contiguous block is about 336 bytes with WiFi up).

- [ ] **Step 3: Update the existing #139 troubleshooting section** ("GATT connect times out or the ESP32 reboots", lines 385-398). State plainly that as of this release the firmware no longer reboots on a near-empty IDF heap: it now refuses the connect and prints a clear `IDF heap too low for GATT connect: free=... largest=... (#139)` line, keeps scanning, and reports an MQTT error to the host instead of crashing with the NimBLE semaphore assertion. Keep the existing `IDF heap before connect: free=<bytes> largest=<bytes>` diagnostic explanation. Add the advanced-users note:
  - The guard ships with board tunables `CONNECT_MIN_IDF_LARGEST` and `CONNECT_MIN_IDF_FREE` at `0`, so by default only an always-on conservative crash floor (about 1 KB largest, 2 KB free) is active; that floor only ever trips the pathological near-empty case and never refuses a connect that could have succeeded.
  - How to calibrate: on a PSRAM board where a connect SUCCEEDS, temporarily log the IDF heap before connect and after connect plus discovery, take the `(free_before - free_after)` delta and the post-connect largest, then set `CONNECT_MIN_IDF_FREE` a little above the delta and `CONNECT_MIN_IDF_LARGEST` a little above the post-connect largest in that board's `board_*.py`. Note that on a no-PSRAM board with WiFi up a non-zero tunable only ever produces a clean skip, never a successful connect, because `gc.collect()` cannot hand kilobytes back to the IDF heap.
  - Keep the existing closing line that broadcast-only scales are unaffected.

- [ ] **Step 4: Proofread for forbidden characters and accuracy.** Ensure NO em dash and NO double dash anywhere in the edited sections (rewrite sentences instead). Verify the table renders as valid VitePress markdown (pipe-delimited, header separator row). Confirm the claims match the implementation: crash floor about 1 KB largest / 2 KB free, tunables default 0, MemoryError message text matches Task 2 Step 3.

- [ ] **Step 5: Firmware gate (regression proof) + commit.**
  ```bash
  python -m unittest discover -s firmware/tests -v
  git add docs/guide/esp32-proxy.md
  git commit -m "docs: document no-PSRAM broadcast-only vs PSRAM GATT support for #139"
  ```
  Expected: unittest `OK` (docs change touched no code), commit succeeds.

---

## Final verification (run before handing back to the orchestrator)

- [ ] Full firmware suite green: `python -m unittest discover -s firmware/tests -v` reports `OK` with a `Ran` count `> 68` (the original 68 plus the new heap-guard module's methods plus the new board-config assertion). Do NOT assert an exact total; the gate is `OK` with all 68 pre-existing tests still passing (behavior preserved).
- [ ] Syntax-clean (the CI `python-check` posture): `python -m py_compile firmware/ble_bridge.py firmware/board_atom_echo.py firmware/board_esp_wroom_32.py firmware/board_esp32_s3.py firmware/board_guition_4848.py firmware/main.py` is silent.
- [ ] No TypeScript / npm involvement occurred (no `src/` files changed; this is firmware-only).
- [ ] `git log --oneline` on `dev` shows the five per-task commits, no `main` commits, nothing pushed.
- [ ] Issue #139 is NOT closed (the orchestrator handles the comment).
- [ ] Grep the diff for an em dash or a double dash; if any slipped in, rewrite and amend.
