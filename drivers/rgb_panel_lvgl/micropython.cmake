# Generic RGB panel + LVGL display driver for ESP32-S3
# Include this alongside lv_binding_micropython in USER_C_MODULES

add_library(usermod_rgb_panel_lvgl INTERFACE)

target_sources(usermod_rgb_panel_lvgl INTERFACE
    ${CMAKE_CURRENT_LIST_DIR}/rgb_panel_lvgl.c
)

target_include_directories(usermod_rgb_panel_lvgl INTERFACE
    ${CMAKE_CURRENT_LIST_DIR}
)

# ESP-IDF components for esp_lcd RGB panel driver
if(IDF_TARGET)
    target_link_libraries(usermod_rgb_panel_lvgl INTERFACE
        idf::esp_lcd
        idf::driver
    )
endif()

# Link to LVGL for headers
# lvgl_interface is created by lv_binding_micropython/micropython.cmake
if(TARGET lvgl_interface)
    target_link_libraries(usermod_rgb_panel_lvgl INTERFACE lvgl_interface)
endif()
# Also link the IDF lvgl component for include paths
if(TARGET __idf_lvgl)
    target_link_libraries(usermod_rgb_panel_lvgl INTERFACE __idf_lvgl)
endif()

target_link_libraries(usermod INTERFACE usermod_rgb_panel_lvgl)
