# ble-scale-sync #139 - ESP32 GATT connect crashes on no-PSRAM boards: root cause and ranked solutions

> Authoritative analysis (multi-agent research + adversarial verify, 2026-06-19). The implementation plan for #139 derives its scope from this document. Approved scope: Tier A1 + A2 + C1. Tier B1 (WiFi-down) is NOT viable on stock MicroPython and is NOT implemented. Tier B2 (custom firmware build) is parked as a future maintainer decision.

## 1. Root cause (precise)

The crash is ESP-IDF internal-DRAM heap exhaustion at GATT-connect time, not a MicroPython GC-heap problem.

On a no-PSRAM classic ESP32 the proxy keeps WiFi-STA up the entire time (mqtt_as owns the STA interface and never tears it down), so the single internal-DRAM pool (MALLOC_CAP_INTERNAL/8BIT, the same region esp32.idf_heap_info(HEAP_DATA) reports) is already carved up by three resident consumers:

- the WiFi driver static buffers (tens of KB of static RX/TX that survive esp_wifi_stop, plus dynamic),
- the NimBLE host/controller baseline,
- and, critically, the MicroPython GC heap. On the modern esp32 port (MICROPY_GC_SPLIT_HEAP_AUTO, default since v1.21, so present on this v1.27 build) the GC heap is not a fixed block: it starts small and grows into the same IDF heap on demand by mallocing new split areas whenever the scan/MQTT/JSON loop forces a Python allocation.

By connect time the IDF heap is fragmented down to a largest contiguous free block of ~336 bytes (flamingspaz: free=392 largest=336). When aioble Device.connect() reaches NimBLE, the connection bring-up performs several allocations of varying size from that same exhausted internal heap: per-conn ble_hs_conn / ble_l2cap_chan structs, multiple FreeRTOS semaphores, and 256 B MSYS mbufs for ATT/GATT discovery (order of kilobytes in total). With free=392 largest=336, the heap is exhausted enough that at least one of these returns NULL. The reporter trace pins the failing one at npl_freertos_sem_init, which calls xSemaphoreCreateCounting(...); that malloc returns NULL, the assert(sem->handle) fires (assertion:semaphor->handle line:557), execution continues on the controller task into npl_freertos_sem_release (line:636) which calls xSemaphoreGive(NULL) -> NULL dereference -> Guru Meditation Core 1 panic LoadProhibited -> reboot loop.

Two consequences that drive the solution design:

- The load-bearing fact is the ratio, not the exact failing struct: connection bring-up needs kilobytes of internal heap across multiple distinct-sized allocations that must all succeed; the board has hundreds of bytes contiguous. We do not claim it is provably the first or smallest allocation that dies; only that the heap is exhausted enough that one of them does. This is why a largest-contiguous-block gate alone is structurally insufficient: you also need a free-total budget, because several allocations of different sizes each have to land.
- The panic is on the NimBLE FreeRTOS task, entirely outside the MicroPython VM, so a Python try/except around bridge.connect() cannot catch it. The device reboots before any Python exception is raised. (This is also why the existing try/except MemoryError around the scan IRQ append at ble_bridge.py:243 and :308 protects the scan path but does nothing for connect.)

gc.mem_free() reports ~85 KB and is misleading: it measures the MicroPython GC heap (free-inside-splits plus a max-new-split heuristic), a different accounting of a pool that NimBLE's C malloc cannot touch.

## 2. Why the v1.17.0 fix (7bef0f6) missed it

7bef0f6 added (a) gc.collect() called twice before connect (ble_bridge.py:406-415, second pass gated on AGGRESSIVE_GC), (b) the _log_idf_heap("before connect") diagnostic, and (c) a shorter connect window + retries on no-PSRAM boards. None of these touch the failing pool:

- gc.collect() reclaims the MicroPython GC heap, not the IDF heap. Under SPLIT_HEAP_AUTO, a split area is returned to the IDF heap only if it becomes fully empty during a GC pass. A long-running scan/MQTT loop keeps live objects scattered across splits, so in the common case gc.collect() compacts free space within splits (raising gc.mem_free) while freeing few or zero whole splits back to IDF. The firmware's own diagnostic still prints largest=336 after both passes, which is the direct evidence that the GC route does not move the needle here.
- The shorter-window/retries change only re-attempts the same doomed allocation faster.

Important nuance: the second gc.collect() pass is not pure dead weight. A split is handed back only once it is fully empty during a pass, and a second pass can release a split the first pass only just emptied (for example, the scan-result buffers freed by the first pass). It is the single cheapest lever that can return a freed split to the IDF heap, and a second gc.collect() costs only a few ms against a multi-second connect window. Keep it. The honest verdict on 7bef0f6 is narrower: the GC route can help only marginally and only when a whole split happens to empty, which is not enough to cross the kilobyte gap, and the diagnostic line is the genuinely valuable thing it shipped because it is the smoking gun this analysis is built on.

## 3. Ranked solutions

Recommended sequence: ship Tier A immediately (ends the reboot loop, near-free), pair it with Tier C documentation (the honest supported path), and treat Tier B as investigation rather than a shippable feature.

### TIER A - Stop the crash / degrade gracefully (SHIP FIRST)

A1. Pre-connect IDF-heap guard - convert the un-catchable C panic into a clean MemoryError skip. (feasibility: high; effort: small; composes with everything below)

This is the headline fix, framed honestly: A1 stops the crash; it does not promise to enable connects. It converts the un-catchable C-panic-plus-reboot into a clean, observable, recoverable MQTT skip, reusing data the firmware already reads successfully on-device.

Why it is safe to call at the worst moment: the firmware already runs _log_idf_heap("before connect") at exactly this point (ble_bridge.py:415) in production on the failing boards, and it has never been reported to crash there. That existing successful call - which itself invokes esp32.idf_heap_info(esp32.HEAP_DATA) and builds the same list of region tuples - is the evidence that reading the heap is safe in the near-OOM state.

Touches:
- firmware/ble_bridge.py - factor the read out of _log_idf_heap (lines 18-36) into a value-returning helper (returns (free, largest) or None off-device so host unit tests are unaffected). Hoist import esp32 to module scope (frozen builtin, cheap) and compute free/largest once, passing the result to both the existing log line and the new gate, so the gate adds zero additional IDF-heap touches beyond what 7bef0f6 already does. Insert the gate immediately after _log_idf_heap("before connect") (line 415) and before the _addr_type_probe_order connect loop (line 434). When the gate trips, raise MemoryError("IDF heap too low for GATT connect: free=... largest=... (#139)"). Because device.connect() / npl_freertos_sem_init never run, the NULL-semaphore panic cannot happen.
- Board flags - add two tunables, CONNECT_MIN_IDF_LARGEST and CONNECT_MIN_IDF_FREE, read via getattr(board, ..., 0). Gate the largest and the free-total together (per section 1, several distinct-sized allocations must all land, so a largest-block check alone is not enough).
- Control flow - already in place, no new plumbing. The MemoryError propagates out of bridge.connect() into the existing handlers: _auto_gatt_connect (main.py:243-252) prints, resumes streaming scan, and publish_errors; handle_connect (main.py:461-465) re-raises into the main-loop handler (main.py:611-615) which publish_errors. Using MemoryError (not a new exception type) is deliberate so it degrades exactly like a TimeoutError does today: clean, observable, no reboot, device keeps scanning.

Critical correction on thresholds - ship the gate effectively crash-floor-only, board tunables disabled (0) by default. The defaults largest >= 4096, free >= 16384 are unmeasured guesses and must not ship as active per-board values. They sit on top of an unpinned per-connection cost (estimated 4-12 KB, never measured on this v1.27 / IDF 5.5.1 NimBLE build). An enabled-but-guessed gate is as likely to suppress good connects as bad ones.

So: default CONNECT_MIN_IDF_LARGEST = 0 and CONNECT_MIN_IDF_FREE = 0 on every board, and combine them with an always-on conservative hard crash floor that cannot refuse a winnable connect (a connection needs kilobytes; a floor set well below that but above the observed 336/392 crash, e.g. on the order of largest < ~1 KB or free < ~2 KB, only ever trips on the pathological near-zero case). Enable a non-zero board gate only after the calibration measurement in section 4 yields a real (free_before - free_after) delta and a post-connect largest floor from a board where connect actually works. Until that number exists, A1's job is strictly never let the panic happen, not decide which connects are winnable.

Honest caveat: with WiFi up, steady-state largest is ~336 B, so on the two reporter boards the practical outcome is a clean skip rather than a successful connect. That is the correct Tier A outcome: a clean skip beats a reboot loop.

A2. Comment cleanup (small, composes with A1; optional host status). Fix the misleading comments at ble_bridge.py:400-405 and the board files to state plainly that gc.collect() cannot hand kilobytes back to the IDF heap and that gc.mem_free() must never gate a connect; point maintainers at the idf_heap guard. Keep both gc.collect() passes on no-PSRAM (the second pass is the one cheap lever that can return a just-emptied split to IDF). Optionally publish a clearer error string so the host/HA add-on shows why a GATT-only scale was skipped; a structured connect_skipped status would need a matching Node-side consumer to be useful, so it is non-blocking and out of scope unless trivial.

### TIER B - Best-effort make-it-work (investigation, NOT implemented)

B1. WiFi-down-during-connect - investigated, NOT viable on stock MicroPython. Demoted to investigated-not-viable for four concrete reasons: (1) the _wlan handle is defined only inside if board.HAS_DISPLAY (main.py:506-508); both reporter boards are headless so it does not exist there; (2) WLAN ownership conflict with mqtt_as (deadlock risk, no pause-and-hand-back primitive, clean=True drops retained subs); (3) stock WLAN.active(False) calls esp_wifi_stop() only, not esp_wifi_deinit(), so it frees only a few KB of dynamic buffers, far short of the requirement, and MicroPython exposes no esp_wifi_deinit binding; (4) the buffered-notify rework is a net regression on the no-PSRAM target (buffer lives on the same exhausted GC heap; a failed cold reconnect loses the whole weighing; ordering breaks the host proxy). Do NOT implement on stock MicroPython.

B2. Custom MicroPython build - the only WiFi-up + GATT-works path, but plausible-and-unbudgeted. Levers in order of payoff: shrink WiFi static/dynamic buffers (CONFIG_ESP_WIFI_*_BUFFER_NUM, biggest), trim NimBLE (CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1, smaller ACL/MSYS, lower MTU), cap the GC heap (MICROPY_GC_INITIAL_HEAP_SIZE / constrain SPLIT_HEAP_AUTO; precedent micropython#16650 freed ~4 KB IDF and fixed mbedTLS starvation). Sufficiency is unproven without a trial-build budget measurement, and it carries an ESP-IDF + MicroPython build-pipeline + CI + per-release .bin cost that breaks the flash-stock + copy-.py onboarding. Park as a deliberate future decision.

B3. Flatten scan-loop memory (hygiene, not a fix). Lowering MAX_SCAN_ENTRIES, filtering junk adverts before building dicts, freeing scan results before connect slow IDF-heap creep but cannot reclaim the tens of KB pinned by WiFi + live splits. Must not be sold as a #139 fix. Out of scope unless trivial and coordinated with the host message shape.

### TIER C - Hardware reality (the documented, supported floor) (SHIP)

C1. Declare GATT-connect scales a PSRAM / ESP32-S3 supported scenario; keep no-PSRAM boards as broadcast-only proxies. Classic ESP32 has ~290 KB usable internal DRAM; WiFi-STA + NimBLE central + the MicroPython GC heap (in that same DRAM on a no-PSRAM board) leaves near-zero contiguous headroom - largest=336 B is the steady state. ESP32-S3 / PSRAM works because the GC heap moves to SPIRAM. Broadcast-only scales (Mi Scale 2, Xiaomi S800) need no connection and work on any board. Keep no-PSRAM boards as broadcast-only proxies; let A1's skip fail GATT-only scales clean with a tailored message; add a scale-type x board support table to the ESP32 proxy docs (docs/guide/esp32-proxy.md). This is the only verdict the evidence fully supports without a custom binary.

### How the tiers compose
- A1 is the foundation: it ends the reboot loop. The board tunables default to 0; an always-on conservative crash floor prevents only the pathological panic.
- A2 (comments, keep both gc passes, clearer error) composes with A1 at near-zero cost.
- C1 pairs with A1: A1 provides the clean refusal, C1 provides the documented use-PSRAM/S3 answer. A1 + A2 + C1 is the honest shippable outcome.
- B1 investigated and parked (not viable). B2 the only durable WiFi-up + connect path, flagged plausible-but-unbudgeted. B3 opportunistic hygiene, out of scope.

## 4. Concrete next step and what to ask the reporters

Maintainer, first: ship A1 as a crash-to-clean-skip guard with the board tunables defaulted to 0 (crash floor on), the comment cleanup (A2), and the C1 docs table. This ends the reboot loop and is safe regardless of calibration.

Calibration the maintainer runs (not the reporters), on a board where connect SUCCEEDS (the S3/PSRAM board): add a temporary _log_idf_heap("after connect+discovery") just before return {"chars": chars_info} (ble_bridge.py:516). Run a full connect+read and capture both the before connect and after connect+discovery lines. Then set CONNECT_MIN_IDF_FREE a little above the observed (free_before - free_after) connection cost and CONNECT_MIN_IDF_LARGEST a little above the observed post-connect largest floor. Only after this delta exists should any non-zero gate be enabled on the no-PSRAM boards.

Ask the two reporters (geniusliang, flamingspaz), only the high-value low-risk asks:
1. Confirm A1 ends the reboot loop (both, no-PSRAM build with the guard). Trigger an auto-connect to the GATT-only scale and paste the serial around the attempt. Success = IDF heap before connect: free=... largest=... immediately followed by the clean IDF heap too low for GATT connect ... (#139) skip line, then the device keeps scanning, with no assertion:semaphor->handle, no Guru Meditation, no reboot banner, and the host receives an MQTT error instead of the device flapping offline. Paste the exact free / largest numbers.
2. (Only if they can borrow/buy hardware) PSRAM validation for C1 on an ESP32-S3 or WROVER.

Do not ask the reporters to flash a WiFi-down build (section B1).

## 5. Honest bottom line

No. A no-PSRAM classic ESP32 cannot reliably serve GATT-connect scales as a WiFi proxy on stock MicroPython. The internal DRAM is structurally too small to hold WiFi-STA buffers + NimBLE central + a growing MicroPython GC heap and still leave the kilobytes of contiguous internal heap a central connection plus GATT discovery needs. largest=336 B with WiFi up is the steady state, and stock MicroPython exposes no runtime lever that changes it.

Shippable now: A1 + A2 + C1 - stop the crash for good (clean MQTT skip instead of a reboot loop), keep no-PSRAM boards as solid broadcast-only proxies, and document ESP32-S3 / PSRAM as the supported path for GATT-only scales (Yunmai, Inlife, Eufy T9120, QN/Renpho ES-CS20M). Not reliably shippable today: WiFi-down (B1, not viable on stock); a custom build (B2, the only WiFi-up + connect path, but unbudgeted). Avoid shipping a guessed heap threshold as if validated: ship A1 board-tunables disabled-by-default as a pure crash guard, calibrate from a real successful-connect heap delta on the PSRAM board, then consider enabling a tuned gate.
