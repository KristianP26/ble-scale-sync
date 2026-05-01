"""Board config: Generic ESP-WROOM-32 dev board (stock ESP32, no PSRAM).

BLE and WiFi share the 2.4 GHz radio in software, so BLE must be deactivated
after each scan to let WiFi reconnect.  Stock module has ~250 KB free RAM,
so a moderately sized scan buffer is fine.
"""

BOARD_NAME = "esp_wroom_32"

# BLE/WiFi coexistence — shared radio, must deactivate BLE after scan
DEACTIVATE_BLE_AFTER_SCAN = True
CONTINUOUS_SCAN = False

# Scan timing
SCAN_INTERVAL_MS = 5000
SCAN_DURATION_MS = 8000

MAX_SCAN_ENTRIES = 300

AGGRESSIVE_GC = True
GC_INTERVAL = 200

# No I2S speaker
HAS_BEEP = False
BEEP_PINS = None

# No display
HAS_DISPLAY = False


def on_scan_complete(results, scale_found):
    """No-op for headless board."""
    pass
