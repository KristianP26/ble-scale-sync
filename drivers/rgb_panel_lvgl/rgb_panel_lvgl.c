/*
 * Generic RGB Panel + LVGL Display Driver for MicroPython
 *
 * Based on ma261065/st7701 (https://github.com/ma261065/st7701)
 * Extended with LVGL display driver registration and data-driven init.
 *
 * Targets ESP32-S3 with 16-bit RGB565 parallel bus.
 * SPI 3-wire bit-banged init (9-bit mode) for panel register programming.
 * Panel init sequence is passed from Python as a list of (cmd, data, delay) tuples.
 * LVGL tick is driven by an esp_timer (no Python tick_inc needed).
 *
 * SPDX-License-Identifier: MIT
 */

#include <string.h>

#include "py/obj.h"
#include "py/runtime.h"
#include "py/mphal.h"

#include "driver/gpio.h"
#include "esp_lcd_panel_rgb.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/* LVGL is provided by lv_binding_micropython */
#include "lvgl/lvgl.h"

static const char *TAG = "rgb_panel_lvgl";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Object type                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

typedef struct _rgb_panel_obj_t {
    mp_obj_base_t base;

    /* RGB panel */
    esp_lcd_panel_handle_t panel_handle;
    uint16_t *framebuffer;
    uint16_t width;
    uint16_t height;

    /* SPI 3-wire pins (-1 = not used) */
    gpio_num_t spi_cs;
    gpio_num_t spi_clk;
    gpio_num_t spi_mosi;

    /* RGB signal pins */
    gpio_num_t pclk;
    gpio_num_t hsync;
    gpio_num_t vsync;
    gpio_num_t de;
    gpio_num_t data[16];

    /* RGB timing */
    uint32_t pclk_freq;
    uint16_t h_res;
    uint16_t v_res;
    uint8_t hsync_pulse_width;
    uint8_t hsync_back_porch;
    uint8_t hsync_front_porch;
    uint8_t vsync_pulse_width;
    uint8_t vsync_back_porch;
    uint8_t vsync_front_porch;

    /* Control pins */
    gpio_num_t backlight;

    /* Panel init commands (Python list or None) */
    mp_obj_t init_cmds;

    /* LVGL display */
    lv_display_t *lv_disp;

    /* LVGL tick timer */
    esp_timer_handle_t tick_timer;
} rgb_panel_obj_t;

/* Forward declarations */
static const mp_obj_type_t rgb_panel_type;

/* ────────────────────────────────────────────────────────────────────────── */
/*  LVGL tick via esp_timer                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

static void lv_tick_cb(void *arg) {
    lv_tick_inc(5);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  SPI 3-wire bit-bang (9-bit mode)                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/*
 * The ST7701S (and similar panels) use 9-bit SPI frames:
 *   Bit 0 (first out): D/C flag — 0 = command, 1 = data
 *   Bits 1-8: 8-bit value, MSB first
 *
 * Clock idles HIGH, data latched on rising edge (SPI Mode 3 behaviour).
 */
static void spi_write_9bit(rgb_panel_obj_t *self, bool is_data, uint8_t val) {
    gpio_set_level(self->spi_cs, 0);
    esp_rom_delay_us(1);

    /* D/C bit */
    gpio_set_level(self->spi_clk, 0);
    esp_rom_delay_us(1);
    gpio_set_level(self->spi_mosi, is_data ? 1 : 0);
    esp_rom_delay_us(1);
    gpio_set_level(self->spi_clk, 1);
    esp_rom_delay_us(1);

    /* 8 data bits, MSB first */
    for (int i = 7; i >= 0; i--) {
        gpio_set_level(self->spi_clk, 0);
        esp_rom_delay_us(1);
        gpio_set_level(self->spi_mosi, (val >> i) & 1);
        esp_rom_delay_us(1);
        gpio_set_level(self->spi_clk, 1);
        esp_rom_delay_us(1);
    }

    gpio_set_level(self->spi_cs, 1);
    esp_rom_delay_us(1);
}

static void lcd_cmd(rgb_panel_obj_t *self, uint8_t cmd) {
    spi_write_9bit(self, false, cmd);
}

static void lcd_data(rgb_panel_obj_t *self, uint8_t data) {
    spi_write_9bit(self, true, data);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Data-driven panel init from Python list                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/*
 * init_cmds is a Python list of tuples: [(cmd, [data...] or None, delay_ms), ...]
 * Iterates through and sends each command via SPI 3-wire.
 */
static void run_init_cmds(rgb_panel_obj_t *self) {
    if (self->init_cmds == mp_const_none) return;

    mp_obj_t *items;
    size_t len;
    mp_obj_get_array(self->init_cmds, &len, &items);

    for (size_t i = 0; i < len; i++) {
        mp_obj_t *entry;
        size_t entry_len;
        mp_obj_get_array(items[i], &entry_len, &entry);

        /* Command byte */
        uint8_t cmd = mp_obj_get_int(entry[0]);
        lcd_cmd(self, cmd);

        /* Data bytes (entry[1] may be None or a list) */
        if (entry_len > 1 && entry[1] != mp_const_none) {
            mp_obj_t *data;
            size_t data_len;
            mp_obj_get_array(entry[1], &data_len, &data);
            for (size_t j = 0; j < data_len; j++) {
                lcd_data(self, mp_obj_get_int(data[j]));
            }
        }

        /* Delay (entry[2] in ms, 0 = no delay) */
        if (entry_len > 2) {
            int delay_ms = mp_obj_get_int(entry[2]);
            if (delay_ms > 0) {
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
            }
        }
    }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  GPIO setup                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

static void setup_spi_pins(rgb_panel_obj_t *self) {
    gpio_config_t io_conf = {
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    io_conf.pin_bit_mask = (1ULL << self->spi_cs) |
                           (1ULL << self->spi_clk) |
                           (1ULL << self->spi_mosi);
    gpio_config(&io_conf);

    /* Clock idles HIGH (Mode 3), CS idles HIGH */
    gpio_set_level(self->spi_clk, 1);
    gpio_set_level(self->spi_cs, 1);
}

static void setup_backlight(rgb_panel_obj_t *self) {
    if (self->backlight < 0) return;
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << self->backlight),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  RGB panel setup via esp_lcd                                              */
/* ────────────────────────────────────────────────────────────────────────── */

static esp_err_t setup_rgb_panel(rgb_panel_obj_t *self) {
    esp_lcd_rgb_panel_config_t panel_config = {
        .clk_src = LCD_CLK_SRC_DEFAULT,
        .timings = {
            .pclk_hz = self->pclk_freq,
            .h_res = self->width,
            .v_res = self->height,
            .hsync_pulse_width = self->hsync_pulse_width,
            .hsync_back_porch = self->hsync_back_porch,
            .hsync_front_porch = self->hsync_front_porch,
            .vsync_pulse_width = self->vsync_pulse_width,
            .vsync_back_porch = self->vsync_back_porch,
            .vsync_front_porch = self->vsync_front_porch,
            .flags = {
                .pclk_active_neg = 0,
                .hsync_idle_low = 0,
                .vsync_idle_low = 0,
            },
        },
        .data_width = 16,
        .bits_per_pixel = 16,
        .num_fbs = 2,           /* double-buffered for LVGL DIRECT mode */
        .bounce_buffer_size_px = 0,  /* no bounce buffers */
        .sram_trans_align = 8,
        .psram_trans_align = 64,
        .hsync_gpio_num = self->hsync,
        .vsync_gpio_num = self->vsync,
        .de_gpio_num = self->de,
        .pclk_gpio_num = self->pclk,
        .disp_gpio_num = -1,
        .data_gpio_nums = {
            self->data[0],  self->data[1],  self->data[2],  self->data[3],
            self->data[4],  self->data[5],  self->data[6],  self->data[7],
            self->data[8],  self->data[9],  self->data[10], self->data[11],
            self->data[12], self->data[13], self->data[14], self->data[15],
        },
        .flags = {
            .fb_in_psram = 1,
        },
    };

    ESP_ERROR_CHECK(esp_lcd_new_rgb_panel(&panel_config, &self->panel_handle));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(self->panel_handle));
    ESP_ERROR_CHECK(esp_lcd_panel_init(self->panel_handle));

    /* Retrieve both framebuffer pointers */
    void *fb0 = NULL, *fb1 = NULL;
    esp_lcd_rgb_panel_get_frame_buffer(self->panel_handle, 2, &fb0, &fb1);
    self->framebuffer = (uint16_t *)fb0;

    ESP_LOGI(TAG, "RGB panel ready: %dx%d, fb0=%p, fb1=%p",
             self->width, self->height, fb0, fb1);
    return ESP_OK;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  LVGL flush callback                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/*
 * DIRECT mode with double-buffered framebuffers:
 *
 * LVGL renders changed areas directly into one panel framebuffer.  The flush
 * callback is invoked once per dirty area.  We must copy each dirty area to
 * the OTHER framebuffer so both buffers stay in sync.  Without this, changes
 * appear for one frame then vanish because LVGL won't redraw unchanged areas
 * in the alternate buffer.
 *
 * On the last dirty area we also tell the RGB peripheral to swap which buffer
 * it scans out, giving tear-free updates.
 */
static void rgb_panel_flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map) {
    rgb_panel_obj_t *self = (rgb_panel_obj_t *)lv_display_get_user_data(disp);

    /* Get both framebuffer pointers from the RGB panel */
    void *fb0 = NULL, *fb1 = NULL;
    esp_lcd_rgb_panel_get_frame_buffer(self->panel_handle, 2, &fb0, &fb1);

    /* px_map is the buffer LVGL just rendered into; other_buf is the stale one */
    uint8_t *other_buf = (px_map == (uint8_t *)fb0) ? (uint8_t *)fb1 : (uint8_t *)fb0;

    /* Copy the dirty area from source to dest buffer (row by row) */
    int32_t x1 = area->x1;
    int32_t y1 = area->y1;
    int32_t w = lv_area_get_width(area);
    int32_t h = lv_area_get_height(area);
    size_t stride = (size_t)self->width * sizeof(uint16_t);  /* bytes per row */
    size_t row_bytes = (size_t)w * sizeof(uint16_t);

    for (int32_t y = y1; y < y1 + h; y++) {
        size_t offset = (size_t)y * stride + (size_t)x1 * sizeof(uint16_t);
        memcpy(other_buf + offset, px_map + offset, row_bytes);
    }

    /* On the last dirty area, swap the displayed buffer */
    if (lv_display_flush_is_last(disp)) {
        esp_lcd_panel_draw_bitmap(self->panel_handle, 0, 0,
                                  self->width, self->height, px_map);
    }

    lv_display_flush_ready(disp);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  LVGL display registration                                                */
/* ────────────────────────────────────────────────────────────────────────── */

static void setup_lvgl_display(rgb_panel_obj_t *self) {
    /* Get both framebuffer pointers */
    void *fb0 = NULL, *fb1 = NULL;
    esp_lcd_rgb_panel_get_frame_buffer(self->panel_handle, 2, &fb0, &fb1);

    lv_display_t *disp = lv_display_create(self->width, self->height);
    lv_display_set_user_data(disp, self);
    lv_display_set_flush_cb(disp, rgb_panel_flush_cb);

    /* DIRECT mode: LVGL draws directly into the panel framebuffer.
     * Two framebuffers enable tear-free updates. */
    size_t fb_size = (size_t)self->width * self->height * sizeof(uint16_t);
    lv_display_set_buffers(disp, fb0, fb1, fb_size, LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);

    self->lv_disp = disp;

    /* Start LVGL tick timer (5ms periodic) */
    esp_timer_create_args_t tick_args = {
        .callback = lv_tick_cb,
        .name = "lv_tick",
    };
    ESP_ERROR_CHECK(esp_timer_create(&tick_args, &self->tick_timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(self->tick_timer, 5000));

    ESP_LOGI(TAG, "LVGL display registered: %dx%d DIRECT mode, tick=5ms",
             self->width, self->height);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  MicroPython constructor                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

static mp_obj_t rgb_panel_make_new(const mp_obj_type_t *type, size_t n_args,
                                    size_t n_kw, const mp_obj_t *all_args) {
    enum {
        ARG_width, ARG_height,
        ARG_data_pins,
        ARG_hsync_pin, ARG_vsync_pin, ARG_de_pin, ARG_pclk_pin,
        ARG_pclk_freq,
        ARG_hsync_pulse_width, ARG_hsync_back_porch, ARG_hsync_front_porch,
        ARG_vsync_pulse_width, ARG_vsync_back_porch, ARG_vsync_front_porch,
        ARG_spi_scl, ARG_spi_sda, ARG_spi_cs,
        ARG_backlight,
        ARG_init_cmds,
    };
    static const mp_arg_t allowed_args[] = {
        { MP_QSTR_width,               MP_ARG_REQUIRED | MP_ARG_INT },
        { MP_QSTR_height,              MP_ARG_REQUIRED | MP_ARG_INT },
        { MP_QSTR_data_pins,           MP_ARG_REQUIRED | MP_ARG_OBJ },
        { MP_QSTR_hsync_pin,           MP_ARG_REQUIRED | MP_ARG_INT },
        { MP_QSTR_vsync_pin,           MP_ARG_REQUIRED | MP_ARG_INT },
        { MP_QSTR_de_pin,              MP_ARG_REQUIRED | MP_ARG_INT },
        { MP_QSTR_pclk_pin,            MP_ARG_REQUIRED | MP_ARG_INT },
        { MP_QSTR_pclk_freq,           MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = 12000000} },
        { MP_QSTR_hsync_pulse_width,   MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = 8} },
        { MP_QSTR_hsync_back_porch,    MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = 20} },
        { MP_QSTR_hsync_front_porch,   MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = 10} },
        { MP_QSTR_vsync_pulse_width,   MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = 8} },
        { MP_QSTR_vsync_back_porch,    MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = 10} },
        { MP_QSTR_vsync_front_porch,   MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = 10} },
        { MP_QSTR_spi_scl,             MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = -1} },
        { MP_QSTR_spi_sda,             MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = -1} },
        { MP_QSTR_spi_cs,              MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = -1} },
        { MP_QSTR_backlight,           MP_ARG_KW_ONLY | MP_ARG_INT, {.u_int = -1} },
        { MP_QSTR_init_cmds,           MP_ARG_KW_ONLY | MP_ARG_OBJ, {.u_obj = mp_const_none} },
    };

    mp_arg_val_t args[MP_ARRAY_SIZE(allowed_args)];
    mp_arg_parse_all_kw_array(n_args, n_kw, all_args,
                              MP_ARRAY_SIZE(allowed_args), allowed_args, args);

    rgb_panel_obj_t *self = mp_obj_malloc(rgb_panel_obj_t, &rgb_panel_type);

    self->width = args[ARG_width].u_int;
    self->height = args[ARG_height].u_int;

    /* Parse data_pins list (must be exactly 16 GPIOs) */
    mp_obj_t *pin_items;
    size_t pin_count;
    mp_obj_get_array(args[ARG_data_pins].u_obj, &pin_count, &pin_items);
    if (pin_count != 16) {
        mp_raise_ValueError(MP_ERROR_TEXT("data_pins must have exactly 16 elements"));
    }
    for (int i = 0; i < 16; i++) {
        self->data[i] = mp_obj_get_int(pin_items[i]);
    }

    self->hsync = args[ARG_hsync_pin].u_int;
    self->vsync = args[ARG_vsync_pin].u_int;
    self->de = args[ARG_de_pin].u_int;
    self->pclk = args[ARG_pclk_pin].u_int;

    self->pclk_freq = args[ARG_pclk_freq].u_int;
    self->hsync_pulse_width = args[ARG_hsync_pulse_width].u_int;
    self->hsync_back_porch = args[ARG_hsync_back_porch].u_int;
    self->hsync_front_porch = args[ARG_hsync_front_porch].u_int;
    self->vsync_pulse_width = args[ARG_vsync_pulse_width].u_int;
    self->vsync_back_porch = args[ARG_vsync_back_porch].u_int;
    self->vsync_front_porch = args[ARG_vsync_front_porch].u_int;

    self->spi_cs = args[ARG_spi_cs].u_int;
    self->spi_clk = args[ARG_spi_scl].u_int;
    self->spi_mosi = args[ARG_spi_sda].u_int;

    self->backlight = args[ARG_backlight].u_int;
    self->init_cmds = args[ARG_init_cmds].u_obj;

    self->panel_handle = NULL;
    self->framebuffer = NULL;
    self->lv_disp = NULL;
    self->tick_timer = NULL;

    return MP_OBJ_FROM_PTR(self);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Methods                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/* init() — set up hardware, send init sequence, register LVGL display */
static mp_obj_t rgb_panel_init(mp_obj_t self_in) {
    rgb_panel_obj_t *self = MP_OBJ_TO_PTR(self_in);

    /* 1. SPI init (only if SPI pins are configured) */
    if (self->spi_clk >= 0) {
        setup_spi_pins(self);
        run_init_cmds(self);
    }

    /* 2. Set up the RGB panel with ESP-IDF lcd driver */
    setup_rgb_panel(self);

    /* 3. Turn on backlight */
    if (self->backlight >= 0) {
        setup_backlight(self);
        gpio_set_level(self->backlight, 1);
    }

    /* 4. Register LVGL display driver + start tick timer */
    setup_lvgl_display(self);

    ESP_LOGI(TAG, "RGB panel init complete");
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(rgb_panel_init_obj, rgb_panel_init);

/* deinit() — tear down display */
static mp_obj_t rgb_panel_deinit(mp_obj_t self_in) {
    rgb_panel_obj_t *self = MP_OBJ_TO_PTR(self_in);

    if (self->tick_timer != NULL) {
        esp_timer_stop(self->tick_timer);
        esp_timer_delete(self->tick_timer);
        self->tick_timer = NULL;
    }

    if (self->lv_disp != NULL) {
        lv_display_delete(self->lv_disp);
        self->lv_disp = NULL;
    }

    if (self->panel_handle != NULL) {
        esp_lcd_panel_del(self->panel_handle);
        self->panel_handle = NULL;
    }

    if (self->backlight >= 0) {
        gpio_set_level(self->backlight, 0);
    }

    self->framebuffer = NULL;
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_1(rgb_panel_deinit_obj, rgb_panel_deinit);

/* backlight(on) — control backlight GPIO */
static mp_obj_t rgb_panel_backlight(mp_obj_t self_in, mp_obj_t on_in) {
    rgb_panel_obj_t *self = MP_OBJ_TO_PTR(self_in);
    if (self->backlight >= 0) {
        gpio_set_level(self->backlight, mp_obj_is_true(on_in) ? 1 : 0);
    }
    return mp_const_none;
}
static MP_DEFINE_CONST_FUN_OBJ_2(rgb_panel_backlight_obj, rgb_panel_backlight);

/* framebuffer(index) — return memoryview of DMA framebuffer 0 or 1 */
static mp_obj_t rgb_panel_framebuffer(mp_obj_t self_in, mp_obj_t idx_in) {
    rgb_panel_obj_t *self = MP_OBJ_TO_PTR(self_in);
    if (!self->panel_handle) {
        mp_raise_msg(&mp_type_RuntimeError, MP_ERROR_TEXT("not initialised"));
    }
    void *fb0 = NULL, *fb1 = NULL;
    esp_lcd_rgb_panel_get_frame_buffer(self->panel_handle, 2, &fb0, &fb1);
    int idx = mp_obj_get_int(idx_in);
    void *fb = (idx == 0) ? fb0 : fb1;
    if (!fb) return mp_const_none;
    size_t size = (size_t)self->width * self->height * sizeof(uint16_t);
    return mp_obj_new_memoryview('B', size, fb);
}
static MP_DEFINE_CONST_FUN_OBJ_2(rgb_panel_framebuffer_obj, rgb_panel_framebuffer);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Module/type registration                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

static const mp_rom_map_elem_t rgb_panel_locals_dict_table[] = {
    { MP_ROM_QSTR(MP_QSTR_init),        MP_ROM_PTR(&rgb_panel_init_obj) },
    { MP_ROM_QSTR(MP_QSTR_deinit),      MP_ROM_PTR(&rgb_panel_deinit_obj) },
    { MP_ROM_QSTR(MP_QSTR_backlight),   MP_ROM_PTR(&rgb_panel_backlight_obj) },
    { MP_ROM_QSTR(MP_QSTR_framebuffer), MP_ROM_PTR(&rgb_panel_framebuffer_obj) },
};
static MP_DEFINE_CONST_DICT(rgb_panel_locals_dict, rgb_panel_locals_dict_table);

static MP_DEFINE_CONST_OBJ_TYPE(
    rgb_panel_type,
    MP_QSTR_RGBPanel,
    MP_TYPE_FLAG_NONE,
    make_new, rgb_panel_make_new,
    locals_dict, &rgb_panel_locals_dict
);

static const mp_rom_map_elem_t rgb_panel_module_globals_table[] = {
    { MP_ROM_QSTR(MP_QSTR___name__), MP_ROM_QSTR(MP_QSTR_rgb_panel_lvgl) },
    { MP_ROM_QSTR(MP_QSTR_RGBPanel), MP_ROM_PTR(&rgb_panel_type) },
};
static MP_DEFINE_CONST_DICT(rgb_panel_module_globals, rgb_panel_module_globals_table);

const mp_obj_module_t rgb_panel_lvgl_module = {
    .base = { &mp_type_module },
    .globals = (mp_obj_dict_t *)&rgb_panel_module_globals,
};

MP_REGISTER_MODULE(MP_QSTR_rgb_panel_lvgl, rgb_panel_lvgl_module);
