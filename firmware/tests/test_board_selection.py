"""Host-runnable tests: flash.sh and board.py pick the same board.

flash.sh uploads exactly one board_*.py, and board.py picks a board module at
runtime. They used to decide independently: `./flash.sh --board esp_wroom_32`
with "board": null uploaded the WROOM-32 module while board.py imported the
Atom Echo one (never uploaded), and "board": "guition_4848" with a plain
`./flash.sh` uploaded the S3 module. Both ended in ImportError on the device.

The board.py tests run the real board.py in a temp working directory that
plays the device filesystem. The flash.sh tests run the real script with stub
esptool/mpremote executables that only record their arguments; nothing touches
a serial port.

Run: python -m unittest discover -s firmware/tests
"""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_BOARD_PY = os.path.join(_FIRMWARE_DIR, "board.py")

_CLASSIC = "ESP32 module with ESP32"
_S3 = "Generic ESP32S3 module with Octal-SPIRAM with ESP32S3"


def _load_board(machine, config_board="absent", board_txt=None):
    """Import firmware/board.py as the device would, return the module."""
    with tempfile.TemporaryDirectory() as device:
        if config_board != "absent":
            with open(os.path.join(device, "config.json"), "w") as f:
                json.dump({"board": config_board}, f)
        if board_txt is not None:
            with open(os.path.join(device, "board.txt"), "w") as f:
                f.write(board_txt)

        had_uname = hasattr(os, "uname")
        orig_uname = getattr(os, "uname", None)
        orig_cwd = os.getcwd()
        os.uname = lambda: types.SimpleNamespace(machine=machine)
        os.chdir(device)
        import sys

        sys.path.insert(0, _FIRMWARE_DIR)
        try:
            spec = importlib.util.spec_from_file_location("board_under_test", _BOARD_PY)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
        finally:
            sys.path.remove(_FIRMWARE_DIR)
            os.chdir(orig_cwd)
            if had_uname:
                os.uname = orig_uname
            else:
                del os.uname


class BoardPyRuntimeSelectionTest(unittest.TestCase):
    def test_chip_detect_without_any_hint_is_unchanged(self):
        self.assertEqual(_load_board(_CLASSIC, config_board=None).BOARD_NAME, "atom_echo")
        self.assertEqual(_load_board(_S3, config_board=None).BOARD_NAME, "esp32_s3")

    def test_flashed_board_is_used_when_config_has_no_override(self):
        # ./flash.sh --board esp_wroom_32 with "board": null
        mod = _load_board(_CLASSIC, config_board=None, board_txt="esp_wroom_32\n")
        self.assertEqual(mod.BOARD_NAME, "esp_wroom_32")

    def test_flashed_guition_on_s3_chip(self):
        mod = _load_board(_S3, config_board=None, board_txt="guition_4848")
        self.assertEqual(mod.BOARD_NAME, "guition_4848")

    def test_config_override_still_wins(self):
        mod = _load_board(_CLASSIC, config_board="esp_wroom_32", board_txt="atom_echo")
        self.assertEqual(mod.BOARD_NAME, "esp_wroom_32")

    def test_explicit_esp32_s3_override(self):
        self.assertEqual(_load_board(_S3, config_board="esp32_s3").BOARD_NAME, "esp32_s3")

    def test_unknown_override_does_not_silently_pick_the_s3_profile(self):
        # A typo used to fall into the S3 branch, whose continuous scan and
        # 500-entry buffer exhaust the heap on a classic ESP32.
        mod = _load_board(_CLASSIC, config_board="wroom", board_txt="esp_wroom_32")
        self.assertEqual(mod.BOARD_NAME, "esp_wroom_32")
        mod = _load_board(_CLASSIC, config_board="esp32-s3")
        self.assertEqual(mod.BOARD_NAME, "atom_echo")


def _usable_bash():
    path = shutil.which("bash")
    if not path:
        return None
    # On Windows, System32\bash.exe is the WSL launcher, which cannot see
    # Windows temp paths the same way; only Git Bash style shells are used.
    if "system32" in path.lower():
        return None
    return path


_STUB = """#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$STUB_LOG"
if [[ "$(basename "$0")" == "esptool" && " $* " == *" chip-id "* ]]; then
  echo "Chip is $STUB_CHIP"
fi
exit 0
"""


@unittest.skipUnless(_usable_bash(), "bash is not available")
class FlashShBoardSelectionTest(unittest.TestCase):
    def _run(self, args, config_board, chip="ESP32-D0WD-V3"):
        bash = _usable_bash()
        with tempfile.TemporaryDirectory() as work:
            shutil.copy(os.path.join(_FIRMWARE_DIR, "flash.sh"), work)
            with open(os.path.join(work, "config.json"), "w") as f:
                json.dump({"board": config_board, "wifi_ssid": "x"}, f, indent=2)
            bin_dir = os.path.join(work, "bin")
            os.mkdir(bin_dir)
            for tool in ("esptool", "mpremote"):
                path = os.path.join(bin_dir, tool)
                with open(path, "w", newline="\n") as f:
                    f.write(_STUB)
                os.chmod(path, 0o755)
            log = os.path.join(work, "calls.log")
            open(log, "w").close()
            env = dict(os.environ)
            env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
            env["PORT"] = "/dev/ttyFAKE0"
            env["STUB_LOG"] = log
            env["STUB_CHIP"] = chip
            proc = subprocess.run(
                [bash, os.path.join(work, "flash.sh")] + args + ["--app-only"],
                env=env,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
            with open(log) as f:
                calls = f.read()
        return proc, calls

    def _uploaded_board_modules(self, calls):
        return sorted(
            set(
                word
                for word in calls.split()
                if word.startswith("board_") and word.endswith(".py")
            )
        )

    def test_board_flag_is_recorded_on_the_device(self):
        proc, calls = self._run(["--board", "esp_wroom_32"], config_board=None)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self._uploaded_board_modules(calls), ["board_esp_wroom_32.py"])
        self.assertIn("open('board.txt', 'w').write('esp_wroom_32')", calls)

    def test_config_board_is_honoured_without_the_flag(self):
        proc, calls = self._run([], config_board="esp_wroom_32")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self._uploaded_board_modules(calls), ["board_esp_wroom_32.py"])
        self.assertNotIn("chip-id", calls)

    def test_config_guition_uploads_its_display_files(self):
        proc, calls = self._run([], config_board="guition_4848", chip="ESP32-S3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self._uploaded_board_modules(calls), ["board_guition_4848.py"])
        self.assertIn("ui.py", calls)
        self.assertIn("panel_init_guition_4848.py", calls)

    def test_conflicting_flag_and_config_is_refused(self):
        proc, calls = self._run(["--board", "esp_wroom_32"], config_board="atom_echo")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("conflicts", proc.stderr)
        self.assertEqual(self._uploaded_board_modules(calls), [])

    def test_auto_detect_is_recorded_too(self):
        proc, calls = self._run([], config_board=None)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self._uploaded_board_modules(calls), ["board_atom_echo.py"])
        self.assertIn("open('board.txt', 'w').write('atom_echo')", calls)


if __name__ == "__main__":
    unittest.main()
