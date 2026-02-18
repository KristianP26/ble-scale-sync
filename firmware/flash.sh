#!/usr/bin/env bash
#
# Flash MicroPython + BLE-MQTT bridge firmware to an ESP32.
#
# Prerequisites (install once):
#   pip install esptool mpremote
#
# Usage:
#   ./flash.sh              # full flash (erase + firmware + libs + app)
#   ./flash.sh --app-only   # just re-upload .py and config.json (fast iteration)
#   ./flash.sh --libs-only  # just re-install MicroPython libraries
#
# The script auto-detects the serial port. Override with:
#   PORT=/dev/ttyACM0 ./flash.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# ─── Config ───────────────────────────────────────────────────────────────────

MICROPYTHON_VERSION="1.27.0"
MICROPYTHON_DATE="20260203"
FIRMWARE_URL="https://micropython.org/resources/firmware/ESP32_GENERIC-${MICROPYTHON_DATE}-v${MICROPYTHON_VERSION}.bin"
FIRMWARE_FILE="ESP32_GENERIC-v${MICROPYTHON_VERSION}.bin"
BAUD=460800

# ─── Helpers ──────────────────────────────────────────────────────────────────

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }

die() { red "Error: $*" >&2; exit 1; }

check_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found. Install with: pip install $1"
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
    blue "Multiple serial ports found:"
    for p in "${candidates[@]}"; do echo "  $p"; done
    blue "Using first: ${candidates[0]}  (override with PORT=...)"
  fi

  echo "${candidates[0]}"
}

# ─── Steps ───────────────────────────────────────────────────────────────────

download_firmware() {
  if [[ -f "$FIRMWARE_FILE" ]]; then
    green "Firmware already downloaded: $FIRMWARE_FILE"
    return
  fi
  blue "Downloading MicroPython v${MICROPYTHON_VERSION}..."
  curl -L -o "$FIRMWARE_FILE" "$FIRMWARE_URL"
  green "Downloaded: $FIRMWARE_FILE"
}

erase_and_flash() {
  local port="$1"
  blue "Erasing flash..."
  esptool.py --chip esp32 --port "$port" erase_flash

  blue "Flashing MicroPython v${MICROPYTHON_VERSION}..."
  esptool.py --chip esp32 --port "$port" --baud "$BAUD" write_flash -z 0x1000 "$FIRMWARE_FILE"
  green "MicroPython flashed successfully"

  blue "Waiting for device to reboot..."
  sleep 3
}

install_libs() {
  local port="$1"
  blue "Installing aioble..."
  mpremote connect "$port" mip install aioble

  blue "Installing mqtt_as (Peter Hinch)..."
  mpremote connect "$port" mip install github:peterhinch/micropython-mqtt

  blue "Installing async primitives (mqtt_as dependency)..."
  mpremote connect "$port" mip install github:peterhinch/micropython-async/v3/primitives

  green "Libraries installed"
}

upload_app() {
  local port="$1"

  if [[ ! -f config.json ]]; then
    die "config.json not found. Copy config.json.example to config.json and edit WiFi/MQTT settings."
  fi

  blue "Uploading application files..."
  mpremote connect "$port" cp config.json :config.json
  mpremote connect "$port" cp boot.py :boot.py
  mpremote connect "$port" cp ble_bridge.py :ble_bridge.py
  mpremote connect "$port" cp main.py :main.py
  green "Application uploaded"
}

reset_device() {
  local port="$1"
  blue "Resetting device..."
  mpremote connect "$port" reset
  green "Done! The ESP32 should now connect to WiFi and MQTT."
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  local mode="${1:-full}"

  check_tool esptool.py
  check_tool mpremote

  local port
  port=$(detect_port)
  blue "Using port: $port"

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
