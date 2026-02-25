# Porting to New Boards

## Adding a headless board (no display) — ~5 minutes

1. Copy `firmware/board_esp32_s3.py` to `firmware/board_<name>.py`
2. Edit constants: BOARD_NAME, radio coexistence, scan timing, GC, beep
3. Add dispatch entry in `firmware/board.py`
4. Add flash config in `firmware/flash.sh` (chip, firmware URL, baud, offset)
5. Done — uses stock MicroPython from micropython.org

### Board config reference

| Constant | Description | Headless example |
|----------|-------------|------------------|
| BOARD_NAME | Identifier string | "my_board" |
| DEACTIVATE_BLE_AFTER_SCAN | True if BLE/WiFi share radio | False (ESP32-S3) |
| SCAN_INTERVAL_MS | Min ms between scans | 2000 |
| SCAN_DURATION_MS | BLE scan window | 8000 |
| MAX_SCAN_ENTRIES | Max devices per scan | 500 |
| AGGRESSIVE_GC | Frequent garbage collection | False |
| GC_INTERVAL | Main-loop iterations between GC | 1000 |
| HAS_BEEP | Has I2S speaker | False |
| BEEP_PINS | {"sck": N, "ws": N, "sd": N} | None |
| HAS_DISPLAY | Has LVGL display | False |

## Adding a display board with RGB parallel interface — ~30 minutes

Requires building custom MicroPython firmware with the rgb_panel_lvgl C module.

### Prerequisites
- ESP-IDF v5.2+ (`. $IDF_PATH/export.sh`)

### Steps

1. **Create board definition** in `drivers/boards/MY_BOARD/`:
   - Copy from `drivers/boards/GUITION_4848/`
   - Edit `mpconfigboard.h` (board name)
   - Edit `sdkconfig.board` (PSRAM type/speed, flash size, cache sizes)
   - Edit `partitions.csv` (adjust app/vfs sizes for your flash)

2. **Write panel init sequence** — `firmware/panel_init_<name>.py`:
   - Find your panel's datasheet or reference code
   - Convert to `[(cmd, [data...], delay_ms), ...]` format
   - For ST7701S panels, start from `panel_init_guition_4848.py`

3. **Write board config** — `firmware/board_<name>.py`:
   - Copy from `board_guition_4848.py`
   - Change pin mapping for your board
   - Change `from panel_init_<name> import INIT_CMDS`

4. **Add dispatch** in `firmware/board.py` and `firmware/flash.sh`

5. **Build**: `cd drivers && ./build.sh my_board`

6. **Flash**: `cd firmware && ./flash.sh --board my_board`

### Finding your pin mapping
- Check your board's schematic or product page
- RGB data pins: 16 GPIOs for RGB565 (Blue 5, Green 6, Red 5)
- Sync pins: HSYNC, VSYNC, DE, PCLK
- SPI init pins: SCL, SDA, CS (for ST7701S command interface)
- Backlight: usually PWM-capable GPIO

### Finding your panel init sequence
- Search for your board name + "init sequence" or "register init"
- Check ESPHome device configs (devices.esphome.io)
- Check Arduino/ESP-IDF example code from the board vendor
- For ST7701S panels, the PAGE 10/11/13 structure is the same —
  only the gamma/GIP/power values differ per panel

## Adding a display board with SPI interface (future)

The `rgb_panel_lvgl` driver is for RGB parallel panels only. SPI displays
(ILI9341, ST7789, etc.) need a different C driver. The pattern is the same:
- C driver handles bus + LVGL registration + flush callback
- Python provides init commands + pin mapping
- Board definition provides sdkconfig + partitions
