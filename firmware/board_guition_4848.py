"""Board config: Guition ESP32-S3-4848S040 (480x480 display, GT911 touch).

ST7701S RGB LCD with 480x480 resolution.  Uses lv_binding_micropython +
rgb_panel_lvgl C module for hardware init (RGB bus, SPI 3-wire, backlight).
Panel init sequence is data-driven from panel_init_guition_4848.py.

Pin mapping from https://homeding.github.io/boards/esp32s3/panel-4848S040.htm
"""

BOARD_NAME = "guition_4848"

# BLE/WiFi coexistence — hardware coexistence, no deactivation needed
DEACTIVATE_BLE_AFTER_SCAN = False
CONTINUOUS_SCAN = True
PUBLISH_INTERVAL_MS = 2000   # drain+publish every 2s
SEEN_RESET_CYCLES = 5        # clear _seen every 5 drains (10s) to age out gone devices

# Scan timing (batch mode fallback)
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

# Display object (set by init_display, used for DMA framebuffer access)
display_dev = None

# Display
HAS_DISPLAY = True
DISPLAY_WIDTH = 480
DISPLAY_HEIGHT = 480

# ─── Pin mapping ─────────────────────────────────────────────────────────────

# 16-bit RGB565 data bus: Blue(0-4), Green(5-10), Red(11-15)
_DATA_PINS = [4, 5, 6, 7, 15, 8, 20, 3, 46, 9, 10, 11, 12, 13, 14, 0]

# RGB sync signals
_HSYNC_PIN = 16
_VSYNC_PIN = 17
_DE_PIN = 18
_PCLK_PIN = 21

# SPI 3-wire (ST7701S command interface)
_SPI_SCL = 48
_SPI_SDA = 47
_SPI_CS = 39

# Backlight
_BACKLIGHT_PIN = 38


def init_display():
    """Initialise ST7701S panel and register LVGL display driver.

    Uses the rgb_panel_lvgl C module which handles:
    - SPI 3-wire bit-bang init (Mode 3 equivalent, ~500kHz)
    - RGB bus setup via esp_lcd_panel_rgb (16-bit, 12MHz pixel clock)
    - Data-driven panel init sequence from panel_init_guition_4848
    - LVGL display creation with double-buffered DIRECT mode
    - LVGL tick via esp_timer (no Python tick_inc needed)
    """
    global display_dev
    try:
        import lvgl as lv
        from rgb_panel_lvgl import RGBPanel
        from panel_init_guition_4848 import INIT_CMDS

        lv.init()

        display = RGBPanel(
            width=DISPLAY_WIDTH,
            height=DISPLAY_HEIGHT,
            data_pins=_DATA_PINS,
            hsync_pin=_HSYNC_PIN,
            vsync_pin=_VSYNC_PIN,
            de_pin=_DE_PIN,
            pclk_pin=_PCLK_PIN,
            pclk_freq=12_000_000,
            hsync_pulse_width=8,
            hsync_back_porch=20,
            hsync_front_porch=10,
            vsync_pulse_width=8,
            vsync_back_porch=10,
            vsync_front_porch=10,
            spi_scl=_SPI_SCL,
            spi_sda=_SPI_SDA,
            spi_cs=_SPI_CS,
            backlight=_BACKLIGHT_PIN,
            init_cmds=INIT_CMDS,
        )
        display.init()
        display_dev = display

        print("LVGL display ready (rgb_panel_lvgl driver)")
        return display
    except Exception as e:
        print(f"Display init failed: {e}")
        import sys
        sys.print_exception(e)
        return None


def on_scan_complete(results, scale_found):
    """No-op — display updates are handled by ui.py state machine."""
    pass
