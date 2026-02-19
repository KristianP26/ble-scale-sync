"""LVGL display state machine — shows scale reading flow on 480x480 display.

All public functions no-op if board.HAS_DISPLAY is False (follows beep.py pattern).
Called from main.py to update the display in response to MQTT events and scan activity.

States: IDLE → SCALE_DETECTED → READING → RESULT → (timeout) → IDLE
"""

import time
import board

# ─── State constants ──────────────────────────────────────────────────────────

_IDLE = 0
_SCALE_DETECTED = 1
_READING = 2
_RESULT = 3

# Timeouts (ms)
_SCALE_DETECTED_TIMEOUT_MS = 60_000
_RESULT_TIMEOUT_MS = 30_000

# ─── Module state ─────────────────────────────────────────────────────────────

_state = _IDLE
_state_entered = 0  # ticks_ms when current state was entered
_users = []  # list of {slug, name, weight_range}
_display = None  # LVGL display driver
_initialised = False

# LVGL label references
_lbl_title = None
_lbl_status = None
_lbl_info = None
_lbl_exporters = None
_lbl_scan_dot = None
_lbl_pub_dot = None

# Dot flash timing
_scan_dot_time = 0
_pub_dot_time = 0
_DOT_FLASH_MS = 500


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _set_state(new_state):
    global _state, _state_entered
    _state = new_state
    _state_entered = time.ticks_ms()


def _elapsed_ms():
    return time.ticks_diff(time.ticks_ms(), _state_entered)


# ─── Init ─────────────────────────────────────────────────────────────────────

def init():
    """Lazy LVGL setup via board.init_display(). Creates UI labels."""
    global _display, _initialised
    global _lbl_title, _lbl_status, _lbl_info, _lbl_exporters
    global _lbl_scan_dot, _lbl_pub_dot

    if not board.HAS_DISPLAY:
        return
    if _initialised:
        return

    try:
        import lvgl as lv
    except ImportError:
        print("LVGL not available — display disabled")
        return

    _display = board.init_display()
    if _display is None:
        return

    scr = lv.screen_active()
    scr.set_style_bg_color(lv.color_hex(0x1A1A2E), 0)

    # Title
    _lbl_title = lv.label(scr)
    _lbl_title.set_text("BLE Scale Sync")
    _lbl_title.set_style_text_color(lv.color_hex(0xE0E0E0), 0)
    _lbl_title.set_style_text_font(lv.font_montserrat_22, 0)
    _lbl_title.align(lv.ALIGN.TOP_MID, 0, 40)

    # Status line (state-dependent)
    _lbl_status = lv.label(scr)
    _lbl_status.set_text("Idle")
    _lbl_status.set_style_text_color(lv.color_hex(0x8888AA), 0)
    _lbl_status.set_style_text_font(lv.font_montserrat_18, 0)
    _lbl_status.align(lv.ALIGN.TOP_MID, 0, 160)

    # Info area (user name, weight, or user count)
    _lbl_info = lv.label(scr)
    _lbl_info.set_text("")
    _lbl_info.set_style_text_color(lv.color_hex(0xFFFFFF), 0)
    _lbl_info.set_style_text_font(lv.font_montserrat_28, 0)
    _lbl_info.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_info.set_width(440)
    _lbl_info.align(lv.ALIGN.TOP_MID, 0, 200)

    # Exporter list area
    _lbl_exporters = lv.label(scr)
    _lbl_exporters.set_text("")
    _lbl_exporters.set_style_text_color(lv.color_hex(0xCCCCCC), 0)
    _lbl_exporters.set_style_text_font(lv.font_montserrat_18, 0)
    _lbl_exporters.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    _lbl_exporters.set_width(440)
    _lbl_exporters.align(lv.ALIGN.TOP_MID, 0, 310)

    # Activity dots (scan + publish)
    _lbl_scan_dot = lv.label(scr)
    _lbl_scan_dot.set_text("")
    _lbl_scan_dot.set_style_text_color(lv.color_hex(0x444466), 0)
    _lbl_scan_dot.set_style_text_font(lv.font_montserrat_18, 0)
    _lbl_scan_dot.align(lv.ALIGN.BOTTOM_MID, -20, -30)

    _lbl_pub_dot = lv.label(scr)
    _lbl_pub_dot.set_text("")
    _lbl_pub_dot.set_style_text_color(lv.color_hex(0x444466), 0)
    _lbl_pub_dot.set_style_text_font(lv.font_montserrat_18, 0)
    _lbl_pub_dot.align(lv.ALIGN.BOTTOM_MID, 20, -30)

    _initialised = True
    _set_state(_IDLE)
    _render_idle()
    print("Display initialised")


# ─── Render helpers ───────────────────────────────────────────────────────────

def _render_idle():
    if not _initialised:
        return
    _lbl_status.set_text("Idle")
    user_count = len(_users)
    if user_count > 0:
        _lbl_info.set_text(f"{user_count} user{'s' if user_count != 1 else ''} configured")
    else:
        _lbl_info.set_text("")
    _lbl_exporters.set_text("")


def _render_scale_detected():
    if not _initialised:
        return
    _lbl_status.set_text("Reading in progress...")
    _lbl_info.set_text("")
    _lbl_exporters.set_text("")


def _render_reading(name, weight, exporters):
    if not _initialised:
        return
    import lvgl as lv
    _lbl_status.set_text("")
    _lbl_info.set_text(f"{name}\n{weight:.1f} kg")
    lines = []
    for exp_name in exporters:
        lines.append(lv.SYMBOL.REFRESH + "  " + exp_name)
    _lbl_exporters.set_text("\n".join(lines))


def _render_result(name, weight, exports):
    if not _initialised:
        return
    import lvgl as lv
    _lbl_status.set_text("")
    _lbl_info.set_text(f"{name}\n{weight:.1f} kg")
    lines = []
    for exp in exports:
        icon = lv.SYMBOL.OK if exp.get("ok") else lv.SYMBOL.CLOSE
        lines.append(icon + "  " + exp["name"])
    _lbl_exporters.set_text("\n".join(lines))


# ─── Public API ───────────────────────────────────────────────────────────────

def on_scan_tick(device_count=0):
    """Flash scan indicator dot after each BLE scan completes."""
    global _scan_dot_time
    if not board.HAS_DISPLAY or not _initialised:
        return
    import lvgl as lv
    _scan_dot_time = time.ticks_ms()
    _lbl_scan_dot.set_text(lv.SYMBOL.WIFI)
    _lbl_scan_dot.set_style_text_color(lv.color_hex(0x44AA44), 0)


def on_publish_tick():
    """Flash publish indicator dot after MQTT publish."""
    global _pub_dot_time
    if not board.HAS_DISPLAY or not _initialised:
        return
    import lvgl as lv
    _pub_dot_time = time.ticks_ms()
    _lbl_pub_dot.set_text(lv.SYMBOL.UPLOAD)
    _lbl_pub_dot.set_style_text_color(lv.color_hex(0x4444AA), 0)


def on_scale_detected(mac):
    """Transition to SCALE_DETECTED when a known scale MAC appears in scan."""
    if not board.HAS_DISPLAY or not _initialised:
        return
    # New scale detection pre-empts RESULT screen
    if _state in (_IDLE, _RESULT):
        _set_state(_SCALE_DETECTED)
        _render_scale_detected()
        print(f"Display: scale detected ({mac})")


def on_reading(slug, name, weight, impedance, exporters):
    """Show matched user + weight + exporter list (all in-progress)."""
    if not board.HAS_DISPLAY or not _initialised:
        return
    _set_state(_READING)
    _render_reading(name, weight, exporters)
    print(f"Display: reading for {name} ({weight:.1f} kg)")


def on_result(slug, name, weight, exports):
    """Show final export results with success/failure icons."""
    if not board.HAS_DISPLAY or not _initialised:
        return
    _set_state(_RESULT)
    _render_result(name, weight, exports)
    print(f"Display: result for {name}")


def on_config_update(users):
    """Store user list from config topic, update idle screen."""
    global _users
    if not board.HAS_DISPLAY:
        return
    _users = users
    if _initialised and _state == _IDLE:
        _render_idle()


def check_timeout():
    """Handle state timeouts. Call each main loop iteration."""
    if not board.HAS_DISPLAY or not _initialised:
        return

    import lvgl as lv

    now = time.ticks_ms()

    # Fade activity dots after flash duration
    if _scan_dot_time and time.ticks_diff(now, _scan_dot_time) > _DOT_FLASH_MS:
        _lbl_scan_dot.set_style_text_color(lv.color_hex(0x444466), 0)
        _scan_dot_time = 0

    if _pub_dot_time and time.ticks_diff(now, _pub_dot_time) > _DOT_FLASH_MS:
        _lbl_pub_dot.set_style_text_color(lv.color_hex(0x444466), 0)
        _pub_dot_time = 0

    # State timeouts
    elapsed = _elapsed_ms()

    if _state == _SCALE_DETECTED and elapsed > _SCALE_DETECTED_TIMEOUT_MS:
        print("Display: scale detected timeout — no reading")
        _lbl_status.set_text("No reading taken")
        # Brief display, then back to IDLE on next check
        _set_state(_IDLE)
        # Delay the idle render slightly so "No reading taken" is visible
        # (it will be overwritten on the next check_timeout or event)
        _render_idle()

    elif _state == _RESULT and elapsed > _RESULT_TIMEOUT_MS:
        _set_state(_IDLE)
        _render_idle()

    # Tick LVGL task handler
    try:
        lv.task_handler()
    except Exception:
        pass
