"""Board auto-detection and dispatch.

Reads optional "board" override from config.json, otherwise detects the
chip family from os.uname().machine.  Re-exports all constants from the
matched board module so callers just `import board`.
"""

import os
import json

# Check config.json for explicit board override
try:
    with open("config.json") as f:
        _override = json.load(f).get("board")
except Exception:
    _override = None

# Auto-detect from chip identifier
_machine = os.uname().machine.upper()

if _override == "atom_echo" or (
    not _override and "ESP32S3" not in _machine and "ESP32-S3" not in _machine
):
    from board_atom_echo import *
elif _override == "guition_4848":
    from board_guition_4848 import *
else:
    from board_esp32_s3 import *
