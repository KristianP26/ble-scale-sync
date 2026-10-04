"""Host-runnable tests: flash.sh argument parsing never defaults to a full flash.

The parser used to store any unrecognised argument as the mode, and the mode
`case` sent everything that was not --app-only or --libs-only to the full
erase-and-flash branch. `./flash.sh --help` or a typo like `--app-onyl` then
erased the device and reflashed MicroPython from scratch.

The script runs with stub esptool/mpremote/curl executables that only record
their arguments (curl writes a fake firmware image large enough to pass the
size check), so an unfixed parser reaches `erase-flash` in the stub log
instead of on a real device.

Run: python -m unittest discover -s firmware/tests
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

from test_board_selection import _FIRMWARE_DIR, _usable_bash

_TOOL_STUB = """#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$STUB_LOG"
if [[ "$(basename "$0")" == "esptool" && " $* " == *" chip-id "* ]]; then
  echo "Chip is ESP32-D0WD-V3"
fi
exit 0
"""

# Writes a 1.1 MB file to the -o target so download_firmware's size check
# passes and an unfixed parser goes on to erase the (stub) device.
_CURL_STUB = """#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out="$2"; shift 2; else shift; fi
done
[[ -n "$out" ]] && head -c 1100000 /dev/zero > "$out"
exit 0
"""


@unittest.skipUnless(_usable_bash(), "bash is not available")
class FlashShArgumentTest(unittest.TestCase):
    def _run(self, args, extra_cfg=None, files=None):
        bash = _usable_bash()
        cfg = {"board": "atom_echo", "wifi_ssid": "x"}
        cfg.update(extra_cfg or {})
        with tempfile.TemporaryDirectory() as work:
            shutil.copy(os.path.join(_FIRMWARE_DIR, "flash.sh"), work)
            with open(os.path.join(work, "config.json"), "w") as f:
                json.dump(cfg, f, indent=2)
            for name, data in (files or {}).items():
                with open(os.path.join(work, name), "w") as f:
                    f.write(data)
            bin_dir = os.path.join(work, "bin")
            os.mkdir(bin_dir)
            for tool, body in (
                ("esptool", _TOOL_STUB),
                ("mpremote", _TOOL_STUB),
                ("curl", _CURL_STUB),
            ):
                path = os.path.join(bin_dir, tool)
                with open(path, "w", newline="\n") as f:
                    f.write(body)
                os.chmod(path, 0o755)
            log = os.path.join(work, "calls.log")
            open(log, "w").close()
            env = dict(os.environ)
            env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
            env["PORT"] = "/dev/ttyFAKE0"
            env["STUB_LOG"] = log
            proc = subprocess.run(
                [bash, os.path.join(work, "flash.sh")] + args,
                env=env,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
            with open(log) as f:
                calls = f.read()
        return proc, calls

    def test_help_prints_usage_and_touches_nothing(self):
        for flag in ("--help", "-h"):
            proc, calls = self._run([flag])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("Usage", proc.stdout)
            self.assertEqual(calls, "", f"{flag} ran tools: {calls}")

    def test_unknown_argument_is_refused_before_any_tool_runs(self):
        proc, calls = self._run(["--app-onyl"])
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--app-onyl", proc.stderr)
        self.assertNotIn("erase-flash", calls)
        self.assertEqual(calls, "")

    def test_bare_word_is_not_taken_as_a_mode(self):
        proc, calls = self._run(["app-only"])
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(calls, "")

    def test_board_without_a_value_fails_with_a_clear_message(self):
        proc, calls = self._run(["--board"])
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--board needs a value", proc.stderr)
        self.assertEqual(calls, "")

    def test_board_followed_by_another_flag_is_refused(self):
        proc, calls = self._run(["--board", "--app-only"])
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--board needs a value", proc.stderr)
        self.assertEqual(calls, "")

    def test_two_modes_are_refused(self):
        proc, calls = self._run(["--app-only", "--libs-only"])
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(calls, "")

    def test_no_argument_still_runs_the_full_flash(self):
        proc, calls = self._run([])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("erase-flash", calls)
        self.assertIn("write-flash", calls)

    def test_app_only_still_skips_the_erase(self):
        proc, calls = self._run(["--app-only"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("erase-flash", calls)
        self.assertIn("main.py", calls)


    # The CA file for mqtt_tls (H-12) lives next to config.json and has to
    # reach the device, or main.py refuses to boot with a verified TLS config.

    def test_ca_file_is_uploaded_with_the_app(self):
        proc, calls = self._run(
            ["--app-only"],
            extra_cfg={"mqtt_tls": True, "mqtt_ca_file": "ca.pem"},
            files={"ca.pem": "pem"},
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("cp ca.pem :ca.pem", calls)

    def test_missing_ca_file_stops_a_full_flash_before_the_erase(self):
        proc, calls = self._run([], extra_cfg={"mqtt_tls": True, "mqtt_ca_file": "ca.pem"})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("ca.pem", proc.stderr)
        self.assertNotIn("erase-flash", calls)

    def test_ca_file_must_be_a_plain_file_name(self):
        proc, calls = self._run(
            ["--app-only"],
            extra_cfg={"mqtt_tls": True, "mqtt_ca_file": "certs/ca.pem"},
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("plain file name", proc.stderr)
        self.assertEqual(calls, "")

    def test_no_ca_file_uploads_no_extra_file(self):
        proc, calls = self._run(["--app-only"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn(".pem", calls)


if __name__ == "__main__":
    unittest.main()
