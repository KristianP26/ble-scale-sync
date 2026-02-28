"""Board config: Generic ESP32-S3 (16 MB flash, 8 MB PSRAM).

Hardware radio coexistence — BLE and WiFi run simultaneously, no need to
deactivate BLE after scanning.  Plenty of RAM for large scan buffers.
"""

BOARD_NAME = "esp32_s3"

# BLE/WiFi coexistence — hardware coexistence, no deactivation needed
DEACTIVATE_BLE_AFTER_SCAN = False
CONTINUOUS_SCAN = True
PUBLISH_INTERVAL_MS = 2000   # drain+publish every 2s
SEEN_RESET_CYCLES = 5        # clear _seen every 5 drains (10s) to age out gone devices

# Scan timing (batch mode fallback)
SCAN_INTERVAL_MS = 2000
SCAN_DURATION_MS = 8000

# Large PSRAM — generous scan buffer
MAX_SCAN_ENTRIES = 500

# No memory pressure
AGGRESSIVE_GC = False
GC_INTERVAL = 1000  # infrequent GC

# No speaker
HAS_BEEP = False
BEEP_PINS = None

# No display
HAS_DISPLAY = False


def on_scan_complete(results, scale_found):
    """No-op for headless board."""
    pass
