"""LVGL display UI — dark theme with status bar, connection indicators, state machine.

480x480 layout:
  Header bar (0-56):  "BLE Scale Sync" + scale icon
  Content (56-424):   Status text, user name, weight, exporters
  Status bar (424-480): WiFi / MQTT / BLE indicators

States: STARTUP -> IDLE -> SCALE_DETECTED -> READING -> RESULT -> IDLE

Hardware init is handled by board_guition_4848.init_display() using the
rgb_panel_lvgl C module.  This module only manages the UI layer on top.
LVGL tick is driven by an esp_timer in the C driver (no Python tick_inc needed).
"""

import time
import board

# ─── State constants ──────────────────────────────────────────────────────────

STARTUP = 0
IDLE = 1
SCALE_DETECTED = 2
READING = 3
RESULT = 4

# Timeouts (ms)
_SCALE_DETECTED_TIMEOUT_MS = 60_000
_RESULT_TIMEOUT_MS = 30_000
_FLASH_MS = 500

# ─── Colors ───────────────────────────────────────────────────────────────────

_BG = 0x0F1119
_PANEL = 0x1A1F2E
_SLATE_200 = 0xE2E8F0
_MUTED = 0x64748B
_INDIGO = 0x818CF8
_WHITE = 0xF8FAFC
_INDIGO_200 = 0xC7D2FE
_SLATE_400 = 0x94A3B8
_GREEN = 0x4ADE80
_RED = 0xF87171
_SKY = 0x38BDF8
_AMBER = 0xFBBF24
_DIM = 0x334155
_DIM_TEXT = 0x475569

# ─── Module state ─────────────────────────────────────────────────────────────

_state = STARTUP
_state_entered = 0
_users = []
_initialised = False

# Connection state
_wifi_connected = False
_mqtt_connected = False

# Widget refs
_hdr = None
_lbl_hdr_title = None
_lbl_hdr_scale = None
_lbl_users = None
_lbl_status = None
_lbl_startup_sub = None
_lbl_name = None
_lbl_weight = None
_lbl_exporters = None

# Status bar
_sbar = None
_lbl_wifi_icon = None
_lbl_wifi_text = None
_lbl_mqtt_icon = None
_lbl_mqtt_text = None
_lbl_ble_icon = None
_lbl_ble_text = None

# Flash timing
_scan_flash_time = 0
_pub_flash_time = 0


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _set_state(new_state):
    global _state, _state_entered
    _state = new_state
    _state_entered = time.ticks_ms()


def _elapsed_ms():
    return time.ticks_diff(time.ticks_ms(), _state_entered)


def _color(hex_val):
    import lvgl as lv
    return lv.color_hex(hex_val)


# ─── Init ─────────────────────────────────────────────────────────────────────

def init():
    global _initialised
    global _hdr, _lbl_hdr_title, _lbl_hdr_scale
    global _lbl_users, _lbl_status, _lbl_startup_sub
    global _lbl_name, _lbl_weight, _lbl_exporters
    global _sbar, _lbl_wifi_icon, _lbl_wifi_text
    global _lbl_mqtt_icon, _lbl_mqtt_text
    global _lbl_ble_icon, _lbl_ble_text

    if not board.HAS_DISPLAY:
        return
    if _initialised:
        return

    try:
        import lvgl as lv
    except ImportError:
        print("LVGL not available — display disabled")
        return

    # Initialise display hardware (ST7701S panel + RGB bus + LVGL driver)
    result = board.init_display()
    if not result:
        print("Display init failed — UI disabled")
        return
    # Store display object in board module namespace for screenshot access
    board.display_dev = result

    scr = lv.screen_active()
    scr.set_style_bg_color(_color(_BG), 0)

    # ── Header bar (480x56) ──────────────────────────────────────────────
    _hdr = lv.obj(scr)
    _hdr.set_size(480, 56)
    _hdr.set_pos(0, 0)
    _hdr.set_style_bg_color(_color(_PANEL), 0)
    _hdr.set_style_bg_opa(lv.OPA.COVER, 0)
    _hdr.set_style_border_width(0, 0)
    _hdr.set_style_radius(0, 0)
    _hdr.set_style_pad_all(0, 0)
    _hdr.remove_flag(lv.obj.FLAG.SCROLLABLE)

    _lbl_hdr_title = lv.label(_hdr)
    _lbl_hdr_title.set_text("BLE Scale Sync")
    _lbl_hdr_title.set_style_text_color(_color(_SLATE_200), 0)
    _lbl_hdr_title.set_style_text_font(lv.font_montserrat_16, 0)
    _lbl_hdr_title.align(lv.ALIGN.LEFT_MID, 16, 0)

    _lbl_hdr_scale = lv.label(_hdr)
    _lbl_hdr_scale.set_text(lv.SYMBOL.BLUETOOTH)
    _lbl_hdr_scale.set_style_text_color(_color(_DIM), 0)
    _lbl_hdr_scale.set_style_text_font(lv.font_montserrat_14, 0)
    _lbl_hdr_scale.align(lv.ALIGN.RIGHT_MID, -16, 0)
    _lbl_hdr_scale.add_flag(lv.obj.FLAG.HIDDEN)

    # ── Content area ─────────────────────────────────────────────────────

    # Users count (right-aligned below header, very dim)
    _lbl_users = lv.label(scr)
    _lbl_users.set_text("")
    _lbl_users.set_style_text_color(_color(_DIM_TEXT), 0)
    _lbl_users.set_style_text_font(lv.font_montserrat_12, 0)
    _lbl_users.align(lv.ALIGN.TOP_RIGHT, -20, 64)

    # Status text (big, centered)
    _lbl_status = lv.label(scr)
    _lbl_status.set_text("Connecting...")
    _lbl_status.set_style_text_color(_color(_INDIGO), 0)
    _lbl_status.set_style_text_font(lv.font_montserrat_28, 0)
    _lbl_status.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_status.set_width(440)
    _lbl_status.align(lv.ALIGN.TOP_MID, 0, 190)

    # Startup sub-text
    _lbl_startup_sub = lv.label(scr)
    _lbl_startup_sub.set_text("WiFi: connecting...")
    _lbl_startup_sub.set_style_text_color(_color(_MUTED), 0)
    _lbl_startup_sub.set_style_text_font(lv.font_montserrat_14, 0)
    _lbl_startup_sub.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_startup_sub.set_width(440)
    _lbl_startup_sub.align(lv.ALIGN.TOP_MID, 0, 235)

    # User name (shown during READING/RESULT)
    _lbl_name = lv.label(scr)
    _lbl_name.set_text("")
    _lbl_name.set_style_text_color(_color(_INDIGO_200), 0)
    _lbl_name.set_style_text_font(lv.font_montserrat_20, 0)
    _lbl_name.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_name.set_width(440)
    _lbl_name.align(lv.ALIGN.TOP_MID, 0, 140)
    _lbl_name.add_flag(lv.obj.FLAG.HIDDEN)

    # Weight value (shown during READING/RESULT)
    _lbl_weight = lv.label(scr)
    _lbl_weight.set_text("")
    _lbl_weight.set_style_text_color(_color(_WHITE), 0)
    _lbl_weight.set_style_text_font(lv.font_montserrat_28, 0)
    _lbl_weight.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_weight.set_width(440)
    _lbl_weight.align(lv.ALIGN.TOP_MID, 0, 190)
    _lbl_weight.add_flag(lv.obj.FLAG.HIDDEN)

    # Exporter list
    _lbl_exporters = lv.label(scr)
    _lbl_exporters.set_text("")
    _lbl_exporters.set_style_text_color(_color(_SLATE_400), 0)
    _lbl_exporters.set_style_text_font(lv.font_montserrat_14, 0)
    _lbl_exporters.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_exporters.set_width(400)
    _lbl_exporters.align(lv.ALIGN.TOP_MID, 0, 260)
    _lbl_exporters.add_flag(lv.obj.FLAG.HIDDEN)

    # ── Status bar (480x56 at Y=424) ─────────────────────────────────────
    _sbar = lv.obj(scr)
    _sbar.set_size(480, 56)
    _sbar.set_pos(0, 424)
    _sbar.set_style_bg_color(_color(_PANEL), 0)
    _sbar.set_style_bg_opa(lv.OPA.COVER, 0)
    _sbar.set_style_border_width(0, 0)
    _sbar.set_style_radius(0, 0)
    _sbar.set_style_pad_all(0, 0)
    _sbar.remove_flag(lv.obj.FLAG.SCROLLABLE)

    # WiFi indicator (left third, centered at x=80)
    _lbl_wifi_icon = lv.label(_sbar)
    _lbl_wifi_icon.set_text(lv.SYMBOL.WIFI)
    _lbl_wifi_icon.set_style_text_color(_color(_RED), 0)
    _lbl_wifi_icon.set_style_text_font(lv.font_montserrat_14, 0)
    _lbl_wifi_icon.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_wifi_icon.set_width(160)
    _lbl_wifi_icon.set_pos(0, 10)

    _lbl_wifi_text = lv.label(_sbar)
    _lbl_wifi_text.set_text("WiFi")
    _lbl_wifi_text.set_style_text_color(_color(_RED), 0)
    _lbl_wifi_text.set_style_text_font(lv.font_montserrat_12, 0)
    _lbl_wifi_text.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_wifi_text.set_width(160)
    _lbl_wifi_text.set_pos(0, 32)

    # MQTT indicator (center third, centered at x=240)
    _lbl_mqtt_icon = lv.label(_sbar)
    _lbl_mqtt_icon.set_text(lv.SYMBOL.UPLOAD)
    _lbl_mqtt_icon.set_style_text_color(_color(_RED), 0)
    _lbl_mqtt_icon.set_style_text_font(lv.font_montserrat_14, 0)
    _lbl_mqtt_icon.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_mqtt_icon.set_width(160)
    _lbl_mqtt_icon.set_pos(160, 10)

    _lbl_mqtt_text = lv.label(_sbar)
    _lbl_mqtt_text.set_text("MQTT")
    _lbl_mqtt_text.set_style_text_color(_color(_RED), 0)
    _lbl_mqtt_text.set_style_text_font(lv.font_montserrat_12, 0)
    _lbl_mqtt_text.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_mqtt_text.set_width(160)
    _lbl_mqtt_text.set_pos(160, 32)

    # BLE indicator (right third, centered at x=400)
    _lbl_ble_icon = lv.label(_sbar)
    _lbl_ble_icon.set_text(lv.SYMBOL.BLUETOOTH)
    _lbl_ble_icon.set_style_text_color(_color(_DIM), 0)
    _lbl_ble_icon.set_style_text_font(lv.font_montserrat_14, 0)
    _lbl_ble_icon.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_ble_icon.set_width(160)
    _lbl_ble_icon.set_pos(320, 10)

    _lbl_ble_text = lv.label(_sbar)
    _lbl_ble_text.set_text("Scan")
    _lbl_ble_text.set_style_text_color(_color(_DIM), 0)
    _lbl_ble_text.set_style_text_font(lv.font_montserrat_12, 0)
    _lbl_ble_text.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_ble_text.set_width(160)
    _lbl_ble_text.set_pos(320, 32)

    _initialised = True
    _set_state(STARTUP)
    print("UI initialised (STARTUP)")


# ─── Screen renderers ─────────────────────────────────────────────────────────

def _show_startup():
    """Show connecting screen with sub-text."""
    if not _initialised:
        return
    import lvgl as lv
    # Show status + sub, hide name/weight/exporters
    _lbl_status.remove_flag(lv.obj.FLAG.HIDDEN)
    _lbl_startup_sub.remove_flag(lv.obj.FLAG.HIDDEN)
    _lbl_name.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_weight.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_exporters.add_flag(lv.obj.FLAG.HIDDEN)

    _lbl_status.set_text("Connecting...")
    _lbl_status.set_style_text_color(_color(_INDIGO), 0)

    if _wifi_connected and not _mqtt_connected:
        _lbl_startup_sub.set_text("MQTT: connecting...")
    elif not _wifi_connected:
        _lbl_startup_sub.set_text("WiFi: connecting...")
    else:
        _lbl_startup_sub.set_text("")


def _show_idle():
    """Show idle screen — just big 'Idle' text."""
    if not _initialised:
        return
    import lvgl as lv
    _lbl_status.remove_flag(lv.obj.FLAG.HIDDEN)
    _lbl_startup_sub.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_name.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_weight.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_exporters.add_flag(lv.obj.FLAG.HIDDEN)

    _lbl_status.set_text("Idle")
    _lbl_status.set_style_text_color(_color(_MUTED), 0)


def _show_scale_detected():
    """Show 'Reading in progress...' while waiting for data."""
    if not _initialised:
        return
    import lvgl as lv
    _lbl_status.remove_flag(lv.obj.FLAG.HIDDEN)
    _lbl_startup_sub.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_name.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_weight.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_exporters.add_flag(lv.obj.FLAG.HIDDEN)

    _lbl_status.set_text("Reading in\nprogress...")
    _lbl_status.set_style_text_color(_color(_INDIGO), 0)


def _show_reading(name, weight, exporters):
    """Show user name, weight, and in-progress exporters."""
    if not _initialised:
        return
    import lvgl as lv
    _lbl_status.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_startup_sub.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_name.remove_flag(lv.obj.FLAG.HIDDEN)
    _lbl_weight.remove_flag(lv.obj.FLAG.HIDDEN)
    _lbl_exporters.remove_flag(lv.obj.FLAG.HIDDEN)

    _lbl_name.set_text(name)
    _lbl_weight.set_text(f"{weight:.1f} kg")

    lines = []
    for exp_name in exporters:
        lines.append(lv.SYMBOL.REFRESH + "  " + exp_name)
    _lbl_exporters.set_text("\n".join(lines))
    _lbl_exporters.set_style_text_color(_color(_SLATE_400), 0)


def _show_result(name, weight, exports):
    """Show user name, weight, and export results with success/fail icons."""
    if not _initialised:
        return
    import lvgl as lv
    _lbl_status.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_startup_sub.add_flag(lv.obj.FLAG.HIDDEN)
    _lbl_name.remove_flag(lv.obj.FLAG.HIDDEN)
    _lbl_weight.remove_flag(lv.obj.FLAG.HIDDEN)
    _lbl_exporters.remove_flag(lv.obj.FLAG.HIDDEN)

    _lbl_name.set_text(name)
    _lbl_weight.set_text(f"{weight:.1f} kg")

    # Build colored exporter lines — LVGL recoloring
    lines = []
    for exp in exports:
        if exp.get("ok"):
            lines.append("#4ADE80 " + lv.SYMBOL.OK + "  " + exp["name"] + "#")
        else:
            lines.append("#F87171 " + lv.SYMBOL.CLOSE + "  " + exp["name"] + "#")
    _lbl_exporters.set_recolor(True)
    _lbl_exporters.set_text("\n".join(lines))


# ─── Public API ───────────────────────────────────────────────────────────────

def on_wifi_change(connected):
    """Update WiFi indicator and startup sub-text."""
    global _wifi_connected
    if not board.HAS_DISPLAY or not _initialised:
        return
    _wifi_connected = connected
    c = _GREEN if connected else _RED
    _lbl_wifi_icon.set_style_text_color(_color(c), 0)
    _lbl_wifi_text.set_style_text_color(_color(c), 0)
    if _state == STARTUP:
        _show_startup()
    print(f"UI: WiFi {'connected' if connected else 'disconnected'}")


def on_mqtt_change(connected):
    """Update MQTT indicator. Transition STARTUP->IDLE when both connected."""
    global _mqtt_connected
    if not board.HAS_DISPLAY or not _initialised:
        return
    _mqtt_connected = connected
    c = _INDIGO if connected else _RED
    _lbl_mqtt_icon.set_style_text_color(_color(c), 0)
    _lbl_mqtt_text.set_style_text_color(_color(c), 0)
    if _state == STARTUP:
        if _wifi_connected and _mqtt_connected:
            _set_state(IDLE)
            _show_idle()
            _update_users_label()
            print("UI: STARTUP -> IDLE")
        else:
            _show_startup()
    print(f"UI: MQTT {'connected' if connected else 'disconnected'}")


def on_scan_tick(count=0):
    """Flash BLE scan indicator sky-blue."""
    global _scan_flash_time
    if not board.HAS_DISPLAY or not _initialised:
        return
    _scan_flash_time = time.ticks_ms()
    _lbl_ble_icon.set_style_text_color(_color(_SKY), 0)
    _lbl_ble_text.set_style_text_color(_color(_SKY), 0)


def on_publish_tick():
    """Flash MQTT indicator bright on publish."""
    global _pub_flash_time
    if not board.HAS_DISPLAY or not _initialised:
        return
    _pub_flash_time = time.ticks_ms()
    _lbl_mqtt_icon.set_style_text_color(_color(_WHITE), 0)
    _lbl_mqtt_text.set_style_text_color(_color(_WHITE), 0)


def on_scale_detected(mac):
    """Transition to SCALE_DETECTED. Header scale icon bright amber."""
    if not board.HAS_DISPLAY or not _initialised:
        return
    if _state in (IDLE, RESULT):
        _set_state(SCALE_DETECTED)
        _show_scale_detected()
        _lbl_hdr_scale.set_style_text_color(_color(_AMBER), 0)
        print(f"UI: scale detected ({mac})")


def on_reading(slug, name, weight, impedance, exporters):
    """Show matched user + weight + exporter list (all in-progress)."""
    if not board.HAS_DISPLAY or not _initialised:
        return
    _set_state(READING)
    _show_reading(name, weight, exporters)
    print(f"UI: reading for {name} ({weight:.1f} kg)")


def on_result(slug, name, weight, exports):
    """Show final export results with success/failure icons."""
    if not board.HAS_DISPLAY or not _initialised:
        return
    _set_state(RESULT)
    _show_result(name, weight, exports)
    # Dim the scale icon back
    _lbl_hdr_scale.set_style_text_color(_color(_DIM), 0)
    print(f"UI: result for {name}")


def on_config_update(users):
    """Store user list from config topic, update idle screen."""
    global _users
    if not board.HAS_DISPLAY:
        return
    _users = users
    if _initialised:
        _update_users_label()


def on_scale_macs_update(has_macs):
    """Show/hide scale icon in header based on whether MACs are registered."""
    if not board.HAS_DISPLAY or not _initialised:
        return
    import lvgl as lv
    if has_macs:
        _lbl_hdr_scale.remove_flag(lv.obj.FLAG.HIDDEN)
    else:
        _lbl_hdr_scale.add_flag(lv.obj.FLAG.HIDDEN)


def _update_users_label():
    """Update the users count label."""
    n = len(_users)
    if n > 0:
        _lbl_users.set_text(f"{n} user{'s' if n != 1 else ''}")
    else:
        _lbl_users.set_text("")


def check_timeout():
    """Handle flash fades, state timeouts, and tick LVGL. Call every loop iteration."""
    global _scan_flash_time, _pub_flash_time
    if not board.HAS_DISPLAY or not _initialised:
        return

    import lvgl as lv
    now = time.ticks_ms()

    # Fade BLE scan flash
    if _scan_flash_time and time.ticks_diff(now, _scan_flash_time) > _FLASH_MS:
        _lbl_ble_icon.set_style_text_color(_color(_DIM), 0)
        _lbl_ble_text.set_style_text_color(_color(_DIM), 0)
        _scan_flash_time = 0

    # Fade MQTT publish flash — restore to current connection color
    if _pub_flash_time and time.ticks_diff(now, _pub_flash_time) > _FLASH_MS:
        c = _INDIGO if _mqtt_connected else _RED
        _lbl_mqtt_icon.set_style_text_color(_color(c), 0)
        _lbl_mqtt_text.set_style_text_color(_color(c), 0)
        _pub_flash_time = 0

    # State timeouts
    elapsed = _elapsed_ms()

    if _state == SCALE_DETECTED and elapsed > _SCALE_DETECTED_TIMEOUT_MS:
        print("UI: scale detected timeout")
        _set_state(IDLE)
        _show_idle()
        _lbl_hdr_scale.set_style_text_color(_color(_DIM), 0)

    elif _state == RESULT and elapsed > _RESULT_TIMEOUT_MS:
        _set_state(IDLE)
        _show_idle()

    # Process pending LVGL renders (tick is handled by C esp_timer)
    try:
        lv.task_handler()
    except Exception:
        pass

