"""Board config: Guition ESP32-S3-4848S040 (480x480 display, GT911 touch).

ST7701S RGB LCD with 480x480 resolution.  Uses LVGL MicroPython firmware
which includes a frozen ``display`` module that handles hardware init
(RGBBus, Spi3Wire, I2C, ST7701 driver, GT911 touch, backlight, TaskHandler).

Pin mapping from https://homeding.github.io/boards/esp32s3/panel-4848S040.htm
"""

BOARD_NAME = "esp32_s3_4848"

# BLE/WiFi coexistence — hardware coexistence, no deactivation needed
DEACTIVATE_BLE_AFTER_SCAN = False

# Scan timing
SCAN_INTERVAL_MS = 2000
SCAN_DURATION_MS = 8000

# Large PSRAM
MAX_SCAN_ENTRIES = 500

# No memory pressure
AGGRESSIVE_GC = False
GC_INTERVAL = 1000

# I2S speaker (optional hardware mod)
HAS_BEEP = False
BEEP_PINS = None

# Display
HAS_DISPLAY = True
DISPLAY_WIDTH = 480
DISPLAY_HEIGHT = 480


def init_display():
    """Verify the frozen display module initialised LVGL correctly.

    The LVGL firmware has a frozen ``display`` module (generated from the
    TOML config at build time) that runs at boot — it sets up ST7701S,
    GT911 touch, backlight, and the LVGL task handler.  We just confirm
    LVGL is active and return True.
    """
    try:
        import lvgl as lv
        scr = lv.screen_active()
        if scr is None:
            print("LVGL screen not available")
            return None
        print("LVGL display ready (frozen driver)")
        return True
    except Exception as e:
        print(f"LVGL init check failed: {e}")
        return None


def on_scan_complete(results, scale_found):
    """No-op — display updates are handled by ui.py state machine."""
    pass
