# Top-level USER_C_MODULES file that includes:
#   1. lv_binding_micropython (LVGL bindings)
#   2. rgb_panel_lvgl (generic RGB panel driver with LVGL integration)
#
# Usage:
#   make -C ports/esp32 BOARD_DIR=/path/to/boards/GUITION_4848

# LVGL bindings — set LV_BINDINGS_DIR before including
get_filename_component(_UM_DIR ${CMAKE_CURRENT_LIST_DIR} ABSOLUTE)

if(NOT DEFINED LV_BINDINGS_DIR)
    # Check environment variable first (set by build.sh)
    if(DEFINED ENV{LV_BINDINGS_DIR})
        set(LV_BINDINGS_DIR $ENV{LV_BINDINGS_DIR})
    else()
        # Default: lv_binding_micropython checked out alongside ble-scale-sync
        get_filename_component(LV_BINDINGS_DIR ${_UM_DIR}/../../lv_binding_micropython ABSOLUTE)
    endif()
endif()

if(NOT EXISTS ${LV_BINDINGS_DIR}/micropython.cmake)
    message(FATAL_ERROR
        "lv_binding_micropython not found at ${LV_BINDINGS_DIR}\n"
        "Clone it with: git clone --recurse-submodules "
        "https://github.com/lvgl/lv_binding_micropython.git ${LV_BINDINGS_DIR}"
    )
endif()

include(${LV_BINDINGS_DIR}/micropython.cmake)

# RGB panel driver
include(${_UM_DIR}/micropython.cmake)
