#!/usr/bin/env bash
#
# Flash MicroPython + BLE-MQTT bridge firmware to an ESP32 / ESP32-S3.
#
# Prerequisites (install once):
#   pip install esptool mpremote
#
# Usage:
#   ./flash.sh                          # full flash (auto-detect board)
#   ./flash.sh --board atom_echo        # full flash for Atom Echo
#   ./flash.sh --board esp32_s3         # full flash for ESP32-S3
#   ./flash.sh --board guition_4848     # full flash for Guition display
#   ./flash.sh --app-only               # re-upload .py files (fast iteration)
#   ./flash.sh --libs-only              # re-install MicroPython libraries
#   ./flash.sh --board guition_4848 --app-only
#
# The script auto-detects the serial port. Override with:
#   PORT=/dev/ttyACM0 ./flash.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# ─── Config ───────────────────────────────────────────────────────────────────

# flash.sh uses pre-built MicroPython 1.27.0 binaries from micropython.org.
# build.sh (for the Guition 4848 display board) uses MicroPython 1.24.1 source
# because lv_binding_micropython is pinned to that version for LVGL compatibility.
MICROPYTHON_VERSION="1.27.0"

# Release dates differ per chip family
MICROPYTHON_DATE_ESP32="20260203"
MICROPYTHON_DATE_S3="20251209"

# Board-specific firmware settings (set by configure_board)
BOARD=""
CHIP=""
FIRMWARE_URL=""
FIRMWARE_FILE=""
FLASH_OFFSET=""
BAUD=""
BOARD_MODULE=""

# ─── Helpers ──────────────────────────────────────────────────────────────────

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }

die() { red "Error: $*" >&2; exit 1; }

check_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found. Install with: pip install $1"
}

# ─── Board configuration ─────────────────────────────────────────────────────

configure_board() {
  local board_name="$1"
  BOARD="$board_name"

  case "$board_name" in
    atom_echo)
      CHIP="esp32"
      FIRMWARE_URL="https://micropython.org/resources/firmware/ESP32_GENERIC-${MICROPYTHON_DATE_ESP32}-v${MICROPYTHON_VERSION}.bin"
      FIRMWARE_FILE="ESP32_GENERIC-v${MICROPYTHON_VERSION}.bin"
      FLASH_OFFSET="0x1000"
      BAUD=115200
      BOARD_MODULE="board_atom_echo.py"
      ;;
    esp32_s3)
      CHIP="esp32s3"
      FIRMWARE_URL="https://micropython.org/resources/firmware/ESP32_GENERIC_S3-SPIRAM_OCT-${MICROPYTHON_DATE_S3}-v${MICROPYTHON_VERSION}.bin"
      FIRMWARE_FILE="ESP32_GENERIC_S3-SPIRAM_OCT-v${MICROPYTHON_VERSION}.bin"
      FLASH_OFFSET="0x0"
      BAUD=460800
      BOARD_MODULE="board_esp32_s3.py"
      ;;
    guition_4848)
      CHIP="esp32s3"
      # LVGL-enabled MicroPython firmware — build from source:
      #   cd ../drivers && ./build.sh guition_4848
      FIRMWARE_URL=""  # No pre-built binary; use local build
      FIRMWARE_FILE="firmware_guition_4848.bin"
      FLASH_OFFSET="0x0"
      BAUD=460800
      BOARD_MODULE="board_guition_4848.py"
      ;;
    *)
      die "Unknown board: $board_name (valid: atom_echo, esp32_s3, guition_4848)"
      ;;
  esac
}

detect_board() {
  # Auto-detect board from connected chip
  local port="$1"
  blue "Auto-detecting board..."
  local chip_info
  chip_info=$(esptool.py --port "$port" chip_id 2>&1) || die "Could not identify chip. Is the ESP32 in download mode?"

  if echo "$chip_info" | grep -qi "ESP32-S3"; then
    green "Detected: ESP32-S3"
    configure_board "esp32_s3"
  elif echo "$chip_info" | grep -qi "ESP32"; then
    green "Detected: ESP32 (assuming Atom Echo)"
    configure_board "atom_echo"
  else
    die "Could not identify chip type from esptool output"
  fi
}

# ─── Port detection ──────────────────────────────────────────────────────────

detect_port() {
  if [[ -n "${PORT:-}" ]]; then
    echo "$PORT"
    return
  fi

  local candidates=()

  # Linux
  for p in /dev/ttyUSB* /dev/ttyACM*; do
    [[ -e "$p" ]] && candidates+=("$p")
  done

  # macOS
  for p in /dev/cu.usbserial-* /dev/cu.SLAB_USBtoUART* /dev/cu.wchusbserial*; do
    [[ -e "$p" ]] && candidates+=("$p")
  done

  if [[ ${#candidates[@]} -eq 0 ]]; then
    die "No serial port found. Is the ESP32 plugged in? Set PORT= manually."
  fi

  if [[ ${#candidates[@]} -gt 1 ]]; then
    blue "Multiple serial ports found:" >&2
    for p in "${candidates[@]}"; do echo "  $p" >&2; done
    blue "Using first: ${candidates[0]}  (override with PORT=...)" >&2
  fi

  echo "${candidates[0]}"
}

# ─── Steps ───────────────────────────────────────────────────────────────────

download_firmware() {
  if [[ -f "$FIRMWARE_FILE" ]]; then
    green "Firmware already downloaded: $FIRMWARE_FILE"
    return
  fi
  if [[ -z "$FIRMWARE_URL" ]]; then
    die $'No pre-built firmware for '"${BOARD}"$'. Build from source:\n  cd ../drivers && ./build.sh '"${BOARD}"$'\nThen copy the .bin here:\n  cp ../drivers/build/firmware.bin '"$FIRMWARE_FILE"
  fi
  blue "Downloading MicroPython v${MICROPYTHON_VERSION} for ${BOARD}..."
  curl -L -o "$FIRMWARE_FILE" "$FIRMWARE_URL"
  green "Downloaded: $FIRMWARE_FILE"
}

erase_and_flash() {
  local port="$1"
  blue "Erasing flash..."
  esptool.py --chip "$CHIP" --port "$port" erase_flash

  blue "Flashing MicroPython v${MICROPYTHON_VERSION} (${CHIP})..."
  esptool.py --chip "$CHIP" --port "$port" --baud "$BAUD" write_flash -z "$FLASH_OFFSET" "$FIRMWARE_FILE"
  green "MicroPython flashed successfully"

  blue "Waiting for device to reboot..."
  sleep 3
}

install_libs() {
  local port="$1"
  # aioble is from micropython-lib, version tracks MicroPython release (no separate pinning)
  blue "Installing aioble..."
  mpremote connect "$port" mip install aioble

  blue "Installing mqtt_as (Peter Hinch)..."
  mpremote connect "$port" mip install "github:peterhinch/micropython-mqtt@70b56a7a4aaf"

  blue "Installing async primitives (mqtt_as dependency)..."
  mpremote connect "$port" mip install "github:peterhinch/micropython-async@68b5f01e999b/v3/primitives"

  green "Libraries installed"
}

upload_app() {
  local port="$1"

  if [[ ! -f config.json ]]; then
    die "config.json not found. Copy config.json.example to config.json and edit WiFi/MQTT settings."
  fi

  blue "Uploading application files for ${BOARD}..."
  mpremote connect "$port" cp config.json :config.json
  mpremote connect "$port" cp boot.py :boot.py
  mpremote connect "$port" cp board.py :board.py
  mpremote connect "$port" cp "$BOARD_MODULE" ":$BOARD_MODULE"
  mpremote connect "$port" cp ble_bridge.py :ble_bridge.py
  mpremote connect "$port" cp beep.py :beep.py
  if [[ "$BOARD" == "guition_4848" ]]; then
    mpremote connect "$port" cp panel_init_guition_4848.py :panel_init_guition_4848.py
    mpremote connect "$port" cp ui.py :ui.py
  fi
  mpremote connect "$port" cp main.py :main.py
  green "Application uploaded (board: ${BOARD})"
}

reset_device() {
  local port="$1"
  blue "Resetting device..."
  mpremote connect "$port" reset
  green "Done! The ESP32 should now connect to WiFi and MQTT."
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  local mode="full"
  local board_arg=""

  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --board)
        board_arg="$2"
        shift 2
        ;;
      --app-only|--libs-only)
        mode="$1"
        shift
        ;;
      *)
        mode="$1"
        shift
        ;;
    esac
  done

  check_tool esptool.py
  check_tool mpremote

  local port
  port=$(detect_port)
  blue "Using port: $port"

  # Configure board (explicit or auto-detect)
  if [[ -n "$board_arg" ]]; then
    configure_board "$board_arg"
  else
    detect_board "$port"
  fi
  blue "Board: ${BOARD} (chip: ${CHIP}, baud: ${BAUD})"

  case "$mode" in
    --app-only)
      upload_app "$port"
      reset_device "$port"
      ;;
    --libs-only)
      install_libs "$port"
      reset_device "$port"
      ;;
    full|*)
      download_firmware
      erase_and_flash "$port"
      install_libs "$port"
      upload_app "$port"
      reset_device "$port"
      ;;
  esac

  echo ""
  green "═══════════════════════════════════════════════════"
  green "  ESP32 BLE-MQTT bridge flashed successfully!"
  green "  Board: ${BOARD} (${CHIP})"
  green "═══════════════════════════════════════════════════"
  echo ""
  echo "  Next steps:"
  echo "  1. Check serial output:  mpremote connect $port repl"
  echo "  2. Verify MQTT status:   mosquitto_sub -t 'ble-proxy/+/status'"
  echo "  3. Configure ble-scale-sync:"
  echo "     ble:"
  echo "       handler: mqtt-proxy"
  echo "       mqtt_proxy:"
  echo "         broker_url: mqtt://<your-broker>:1883"
  echo ""
}

main "$@"
