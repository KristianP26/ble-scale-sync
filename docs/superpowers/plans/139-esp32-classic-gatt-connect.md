# Plan: #139 GATT proxy connect fails/reboots on classic ESP32 (WROOM-32 / ESP-32D)

## Problem

The WROOM-32 board request is done. The live problem (last reporter @flamingspaz,
ESP-32D, Eufy T9120) is that GATT proxy connect (active central connection) to
GATT-only scales always times out, then the ESP32 crashes with a NimBLE
`assertion:semaphor->handle / npl_freertos_sem_init` (Guru Meditation) and reboots.
Broadcast scanning works after the earlier scan-buffer fixes. Same symptom for
@geniusliang (Yunmai, GATT-only).

## Research-backed root cause (corrected)

- NimBLE + WiFi allocate from the ESP-IDF heap, SEPARATE from the MicroPython GC
  heap (MP split-heap starts 64 KiB, grows from IDF on demand). The fatal
  `npl_freertos_sem_init` is a NimBLE C allocation failing on an exhausted IDF
  heap during connect, while WiFi/MQTT are live. It is a C assertion, NOT
  catchable from Python.
- `MICROPY_GC_SPLIT_HEAP_AUTO` (default on ESP32): an empty MP split is returned
  to the IDF heap during a GC pass. So `gc.collect()` after freeing scan buffers
  CAN return memory to the IDF heap for NimBLE, but only if the split becomes
  fully empty (fragmentation can prevent it).
- The classic ESP32 vs ESP32-S3 difference is NOT "hardware vs software
  coexistence" (both share one 2.4 GHz radio via time-division coexistence). The
  real difference is RAM: S3 boards commonly ship with PSRAM (2-8 MB), giving far
  more IDF heap for a NimBLE connection. A no-PSRAM classic ESP32 (and a no-PSRAM
  S3) is at the edge of what a BLE central connection + WiFi + MQTT can fit.
- `aioble Device.connect` wraps `gap_connect` (default `scan_duration_ms=2000`);
  the firmware overrides to 15000 (added for Eufy P2 Pro short advertising bursts).
  A 15 s window keeps the shared radio + heap busy the whole time.

## Goal

Give the classic ESP32 the best shot at a GATT connect (free IDF heap before
connect, board-tunable connect window/retries), add a diagnostic so we can tell
RAM exhaustion from a radio timeout, and document the real hardware ceiling.
This is a mitigation + diagnosis change, not a guaranteed fix (RAM-bound).

## Changes

### 1. firmware/ble_bridge.py - free heap + diagnostic + tunable connect

In `connect()` (currently does `_ble.active(True)` then a single
`device.connect(timeout_ms=15000, scan_duration_ms=15000)`):

a. Before connecting, reclaim heap and log IDF headroom:
```py
import gc
gc.collect()
gc.collect()  # second pass: lets an emptied split return to the IDF heap
_log_idf_heap("before connect")
```
where a module-level helper (guarded so host/non-esp32 never breaks):
```py
def _log_idf_heap(when):
    try:
        import esp32
        regions = esp32.idf_heap_info(esp32.HEAP_DATA)
        free = sum(r[1] for r in regions)
        largest = max(r[2] for r in regions)  # no max(default=): MicroPython may lack the kwarg; empty -> ValueError -> caught
        print("IDF heap %s: free=%d largest=%d" % (when, free, largest))
    except Exception:
        pass
```
Rationale: `r = (total, free, largest_free, min_free)` per region; `free` and the
largest contiguous block are what decide whether NimBLE can allocate the
connection. A tiny `largest` before a failed connect => RAM ceiling; a healthy
`largest` + timeout => radio coexistence ceiling.

b. Make the connect window board-tunable with safe fallbacks (preserve current
15 s default so the Eufy P2 Pro path is unchanged on roomy boards), and retry
with a GC between attempts:
```py
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
        print("GATT connect attempt %d/%d failed for %s: %s: %s"
              % (attempt, retries, address, type(e).__name__, e))
        if attempt < retries:
            gc.collect()
            await asyncio.sleep_ms(500)
if last_exc is not None:
    raise last_exc
```
Keep the existing service/char discovery block unchanged below this.

### 2. Board configs - add CONNECT_* constants

Add to every board module (board.py re-exports via `*`; getattr fallbacks above
make this robust even if one is missed, but set them explicitly):
- `board_esp_wroom_32.py`, `board_atom_echo.py` (no PSRAM, tight): shorter window
  + retries -> `CONNECT_TIMEOUT_MS = 10000`, `CONNECT_SCAN_MS = 8000`,
  `CONNECT_RETRIES = 2`.
- `board_esp32_s3.py`, `board_guition_4848.py` (roomy): keep current behavior ->
  `CONNECT_TIMEOUT_MS = 15000`, `CONNECT_SCAN_MS = 15000`, `CONNECT_RETRIES = 1`.

### 3. Fix misleading board comments

- `board_esp32_s3.py`: "Hardware radio coexistence" is misleading; both ESP32 and
  S3 share one radio via time-division coexistence. Reword to: the S3 advantage
  is more RAM (commonly PSRAM), so BLE can stay active and scan buffers/GATT
  connections have headroom; no need to deactivate BLE after scan.
- `board_guition_4848.py`: same misleading "hardware coexistence" comment (line
  ~12) -> apply the same RAM-based reword as the S3.
- `board_esp_wroom_32.py`: keep the no-PSRAM / ~90 KB note (accurate), no false
  coexistence claim is present there.

### 4. docs/guide/esp32-proxy.md

- Supported Boards: add a short note that broadcast-only scales work on every
  listed board, but GATT-connect scales (need an active connection: e.g. QN /
  Renpho ES-CS20M, Yunmai, Inlife, some Eufy) are RAM-heavy and are reliable only
  on boards with more RAM (PSRAM, e.g. ESP32-S3-DevKitC / Guition). On a
  no-PSRAM classic ESP32 / Atom Echo the connection may time out or reboot.
- Fix the line "ESP32-S3 boards have hardware radio coexistence and don't need
  BLE deactivation" -> reword to the RAM-based explanation (S3 has more RAM, so
  BLE stays active; coexistence is still time-division on both).
- Troubleshooting: new entry "GATT connect times out or the ESP32 reboots
  (classic ESP32 / no PSRAM)" explaining the IDF-heap ceiling, that the NimBLE
  crash is a C assertion (not Python-catchable), that the firmware now frees heap
  + logs `IDF heap before connect: free=... largest=...` over serial, how to read
  it, and the recommendation to use a PSRAM board for GATT-connect scales.

### 5. Tests - firmware/tests/test_board_config.py

Host-runnable (board modules are pure constants, no MicroPython imports):
- import each of the four board modules.
- assert each defines `CONNECT_TIMEOUT_MS`, `CONNECT_SCAN_MS`, `CONNECT_RETRIES`
  as positive ints.
- assert the no-PSRAM boards (atom_echo, esp_wroom_32) use `CONNECT_RETRIES >= 2`
  and `CONNECT_SCAN_MS <= ` the S3 value (tighter window).
Run: `python -m unittest discover -s firmware/tests`.

## Out of scope (with reason)

- WiFi `pm`/modem-sleep tuning: research showed PM_PERFORMANCE is already the
  default and cycles the radio; PM_POWERSAVE adds little and the BLE-coexistence
  benefit is unconfirmed; PM_NONE would hurt. Not a reliable lever, skip.
- Catching the NimBLE semaphore crash: it is a C-level assertion outside the
  Python VM; cannot be try/except'd. Only avoidance (free heap) helps.
- A real "fix" for no-PSRAM GATT connect: bounded by hardware RAM; documented,
  not coded around.
- #231 / PR #214 share this connect path; the gc + tunable-window changes help
  there too, but that issue is tracked separately (no extra work here).

## Verification

- `python -m unittest discover -s firmware/tests` green (new + existing).
- `python -m py_compile firmware/ble_bridge.py firmware/board_*.py` clean (syntax).
- Manual reasoning: host can't run aioble/esp32; the diagnostic + connect changes
  are exercised on-device by the reporter. The `_log_idf_heap` guard ensures no
  failure off-device.
- TS side untouched, so no npm test/tsc needed; this is firmware + docs only.
