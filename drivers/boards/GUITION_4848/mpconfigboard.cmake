set(IDF_TARGET esp32s3)

set(SDKCONFIG_DEFAULTS
    boards/sdkconfig.base
    ${SDKCONFIG_IDF_VERSION_SPECIFIC}
    boards/sdkconfig.ble
    ${MICROPY_BOARD_DIR}/sdkconfig.board
)

# Partition table
set(MICROPY_BOARD_PARTITION_TABLE ${MICROPY_BOARD_DIR}/partitions.csv)

# C display driver
get_filename_component(_DRIVERS_DIR "${MICROPY_BOARD_DIR}/../.." ABSOLUTE)
set(USER_C_MODULES ${_DRIVERS_DIR}/rgb_panel_lvgl/user_modules.cmake)

# Frozen manifest
set(MICROPY_FROZEN_MANIFEST ${MICROPY_BOARD_DIR}/manifest.py)
