"""Board config: M5Stack Atom Echo (ESP32-PICO, no PSRAM).

Shared 2.4 GHz radio requires deactivating BLE after each scan so WiFi
can reconnect.  ~100 KB free RAM demands aggressive garbage collection.
"""

BOARD_NAME = "atom_echo"

# BLE/WiFi coexistence — shared radio, must deactivate BLE after scan
DEACTIVATE_BLE_AFTER_SCAN = True

# Scan timing
SCAN_INTERVAL_MS = 5000
SCAN_DURATION_MS = 8000

# Memory-constrained: cap raw IRQ results
MAX_SCAN_ENTRIES = 200

# Aggressive GC to avoid OOM (~100 KB free after imports)
AGGRESSIVE_GC = True
GC_INTERVAL = 200  # main-loop iterations between gc.collect()

# I2S speaker (NS4168 DAC)
HAS_BEEP = True
BEEP_PINS = {"sck": 19, "ws": 33, "sd": 22}

# No display
HAS_DISPLAY = False


def on_scan_complete(results, scale_found):
    """No-op for headless board."""
    pass
