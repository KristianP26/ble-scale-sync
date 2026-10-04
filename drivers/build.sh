#!/usr/bin/env bash
#
# Build MicroPython firmware with LVGL + RGB panel driver for a display board.
#
# Prerequisites:
#   - ESP-IDF v5.2+ installed and sourced (. $IDF_PATH/export.sh)
#   - Python 3.8+
#
# Usage:
#   ./build.sh guition_4848            # Full build (clone deps + compile)
#   ./build.sh guition_4848 --compile  # Recompile only (deps already cloned)
#   ./build.sh guition_4848 --clean    # Clean build directory
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_ROOT="${SCRIPT_DIR}/_build"
FIRMWARE_DIR="${SCRIPT_DIR}/../firmware"

# Versions
MICROPYTHON_VERSION="v1.24.1"
# lv_binding_micropython has no releases, so it is pinned to a commit rather
# than following master. This one was master when the driver moved to the
# binding (2026-02-20) and stayed master until 2026-05-02, so it is what every
# build of drivers/rgb_panel_lvgl and lv_conf.h so far was made against. It
# carries LVGL v9.3.0, the version lv_conf.h is based on. Move it on purpose,
# together with a test build, never by following master.
LV_BINDING_COMMIT="f33add088fb69b41fd01f0a9e5f3424005bf04f2"

# Build paths
MPY_DIR="${BUILD_ROOT}/micropython"
LV_BINDING_DIR="${BUILD_ROOT}/lv_binding_micropython"
PORT_DIR="${MPY_DIR}/ports/esp32"

# ─── Helpers ──────────────────────────────────────────────────────────────────

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }
die()   { red "Error: $*" >&2; exit 1; }

check_idf() {
    if [[ -z "${IDF_PATH:-}" ]]; then
        die "ESP-IDF not found. Source it first: . \$IDF_PATH/export.sh"
    fi
    blue "ESP-IDF: ${IDF_PATH}"
}

# ─── Clone dependencies ──────────────────────────────────────────────────────

clone_deps() {
    mkdir -p "${BUILD_ROOT}"

    # MicroPython
    if [[ ! -d "${MPY_DIR}" ]]; then
        blue "Cloning MicroPython ${MICROPYTHON_VERSION}..."
        git clone --depth 1 --branch "${MICROPYTHON_VERSION}" \
            https://github.com/micropython/micropython.git "${MPY_DIR}"

        blue "Building MicroPython cross-compiler..."
        make -C "${MPY_DIR}/mpy-cross" -j"$(nproc)"

        blue "Initializing ESP32 port submodules..."
        make -C "${PORT_DIR}" submodules
    else
        green "MicroPython already cloned at ${MPY_DIR}"
    fi

    # lv_binding_micropython
    if [[ ! -d "${LV_BINDING_DIR}" ]]; then
        blue "Cloning lv_binding_micropython ${LV_BINDING_COMMIT:0:12}..."
        # Submodules only after the checkout, so they are the ones this
        # commit records, not the ones master records.
        git clone https://github.com/lvgl/lv_binding_micropython.git "${LV_BINDING_DIR}"
        git -C "${LV_BINDING_DIR}" checkout --detach "${LV_BINDING_COMMIT}"
        git -C "${LV_BINDING_DIR}" submodule update --init --recursive
    else
        green "lv_binding_micropython already cloned at ${LV_BINDING_DIR}"
        local head
        head="$(git -C "${LV_BINDING_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)"
        if [[ "${head}" != "${LV_BINDING_COMMIT}" ]]; then
            red "Warning: it is at ${head}, not the pinned ${LV_BINDING_COMMIT}."
            red "  Delete ${LV_BINDING_DIR} to re-clone it at the pinned commit."
        fi
    fi

    # Override lv_conf.h with our version (extra Montserrat font sizes)
    if [[ -f "${SCRIPT_DIR}/lv_conf.h" ]]; then
        blue "Installing custom lv_conf.h (extra fonts: 12,18,20,22,28)..."
        cp "${SCRIPT_DIR}/lv_conf.h" "${LV_BINDING_DIR}/lv_conf.h"
    fi
}

# ─── Build firmware ──────────────────────────────────────────────────────────

compile() {
    local board_name="$1"
    local board_upper
    board_upper="$(echo "${board_name}" | tr '[:lower:]' '[:upper:]')"
    local board_dir="${SCRIPT_DIR}/boards/${board_upper}"

    if [[ ! -d "${board_dir}" ]]; then
        die "Board definition not found: ${board_dir}"
    fi

    local output_name="firmware_${board_name}.bin"

    blue "Building firmware..."
    blue "  Board: ${board_name}"
    blue "  BOARD_DIR: ${board_dir}"
    blue "  lv_conf.h: ${SCRIPT_DIR}/lv_conf.h"

    # Tell the build where to find lv_binding_micropython
    export LV_BINDINGS_DIR="${LV_BINDING_DIR}"

    # Tell manifest.py where to find the project root
    export PROJECT_DIR="${SCRIPT_DIR}/.."

    make -C "${PORT_DIR}" \
        BOARD_DIR="${board_dir}" \
        -j"$(nproc)"

    # Find the output binary
    local build_dir="${PORT_DIR}/build-${board_upper}"
    local bin_file="${build_dir}/firmware.bin"

    if [[ -f "${bin_file}" ]]; then
        cp "${bin_file}" "${FIRMWARE_DIR}/${output_name}"
        green "Firmware built: ${FIRMWARE_DIR}/${output_name}"
        green "  Size: $(stat -c%s "${FIRMWARE_DIR}/${output_name}") bytes"
    else
        die "Build succeeded but firmware binary not found. Check ${build_dir}/"
    fi
}

clean() {
    local board_name="$1"
    local board_upper
    board_upper="$(echo "${board_name}" | tr '[:lower:]' '[:upper:]')"
    local board_dir="${SCRIPT_DIR}/boards/${board_upper}"

    blue "Cleaning build for ${board_name}..."
    if [[ -d "${PORT_DIR}" ]]; then
        make -C "${PORT_DIR}" \
            BOARD_DIR="${board_dir}" \
            clean 2>/dev/null || true
    fi
    green "Clean complete"
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
    local board_name="${1:?Usage: ./build.sh <board_name> [--compile|--clean]}"
    local mode="${2:-full}"

    check_idf

    case "${mode}" in
        --compile)
            compile "${board_name}"
            ;;
        --clean)
            clean "${board_name}"
            ;;
        full|*)
            clone_deps
            compile "${board_name}"
            ;;
    esac

    echo ""
    green "═══════════════════════════════════════════════════"
    green "  Next steps:"
    green "  1. Flash:  cd ../firmware && ./flash.sh --board ${board_name}"
    green "  2. Or manually:"
    green "     esptool --chip esp32s3 --port /dev/ttyUSB0 --baud 460800 \\"
    green "       write-flash 0x0 ${FIRMWARE_DIR}/firmware_${board_name}.bin"
    green "═══════════════════════════════════════════════════"
}

main "$@"
