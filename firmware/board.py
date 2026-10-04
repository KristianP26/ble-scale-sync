"""Board auto-detection and dispatch.

Picks the board profile in this order:
1. "board" in config.json (explicit user override)
2. board.txt, written by flash.sh with the board it uploaded (--board, the
   config.json value, or its own chip auto-detect)
3. the chip family from os.uname().machine (S3 -> esp32_s3, else atom_echo)

flash.sh uploads only the selected board_*.py, so the runtime choice has to
come from the same decision, or `import board` fails on a module that is not on
the device. Re-exports all constants from the matched board module so callers
just `import board`.
"""

import os
import json

VALID_BOARDS = ("atom_echo", "esp_wroom_32", "esp32_s3", "guition_4848")


def _read_override():
    try:
        with open("config.json") as f:
            return json.load(f).get("board")
    except Exception:
        return None


def _read_flashed():
    try:
        with open("board.txt") as f:
            return f.read().strip() or None
    except Exception:
        return None


def _select(override, flashed, machine):
    """Board name to load.

    A value that is not a board is reported and skipped, never mapped silently
    to the S3 profile, which on a classic ESP32 runs out of heap.
    """
    for source, name in (("config.json \"board\"", override), ("board.txt", flashed)):
        if not name:
            continue
        if name in VALID_BOARDS:
            return name
        print("Ignoring unknown board %r from %s (valid: %s)" % (name, source, ", ".join(VALID_BOARDS)))
    if "ESP32S3" in machine or "ESP32-S3" in machine:
        return "esp32_s3"
    return "atom_echo"


BOARD_KEY = _select(_read_override(), _read_flashed(), os.uname().machine.upper())

try:
    if BOARD_KEY == "atom_echo":
        from board_atom_echo import *
    elif BOARD_KEY == "esp_wroom_32":
        from board_esp_wroom_32 import *
    elif BOARD_KEY == "guition_4848":
        from board_guition_4848 import *
    else:
        from board_esp32_s3 import *
except ImportError as e:
    raise ImportError(
        "board_%s.py could not be loaded (%s). Reflash with ./flash.sh --board %s"
        % (BOARD_KEY, e, BOARD_KEY)
    )
