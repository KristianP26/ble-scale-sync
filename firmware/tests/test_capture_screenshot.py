"""Host-runnable tests for firmware/tools/capture_screenshot.py.

The tool defaulted to one developer's LAN address when BROKER was unset and had
no way to log in, so against a broker that requires a password (the app's
embedded broker on a LAN interface does) it could not work at all.

The script runs in a subprocess against a fake paho package that records what
the tool asked for and then stops it, so nothing goes over the network.

Run: python -m unittest discover -s firmware/tests
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_TOOL = os.path.join(_FIRMWARE_DIR, "tools", "capture_screenshot.py")

_FAKE_CLIENT = '''
import json, os


class _Stop(Exception):
    pass


def _record(**fields):
    with open(os.environ["FAKE_PAHO_LOG"], "a") as f:
        f.write(json.dumps(fields) + "\\n")


class Client:
    def __init__(self, *args, **kwargs):
        pass

    def username_pw_set(self, username, password=None):
        _record(call="username_pw_set", username=username, password=password)

    def connect(self, host, port=1883, *args, **kwargs):
        _record(call="connect", host=host, port=port)
        raise SystemExit(0)
'''


class CaptureScreenshotTest(unittest.TestCase):
    def _run(self, env_extra):
        with tempfile.TemporaryDirectory() as work:
            pkg = os.path.join(work, "paho", "mqtt")
            os.makedirs(pkg)
            open(os.path.join(work, "paho", "__init__.py"), "w").close()
            open(os.path.join(pkg, "__init__.py"), "w").close()
            with open(os.path.join(pkg, "client.py"), "w") as f:
                f.write(_FAKE_CLIENT)
            log = os.path.join(work, "calls.jsonl")
            env = {
                k: v
                for k, v in os.environ.items()
                if k not in ("BROKER", "MQTT_PORT", "MQTT_USER", "MQTT_PASSWORD", "BASE")
            }
            env["PYTHONPATH"] = work
            env["FAKE_PAHO_LOG"] = log
            env.update(env_extra)
            proc = subprocess.run(
                [sys.executable, _TOOL, os.path.join(work, "out.png")],
                env=env,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
            calls = []
            if os.path.exists(log):
                with open(log) as f:
                    calls = [json.loads(line) for line in f if line.strip()]
        return proc, calls

    def test_no_broker_is_an_error_not_a_hardcoded_address(self):
        proc, calls = self._run({})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("BROKER", proc.stderr)
        self.assertEqual([c for c in calls if c["call"] == "connect"], [])

    def test_broker_from_the_environment(self):
        proc, calls = self._run({"BROKER": "broker.example"})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(calls, [{"call": "connect", "host": "broker.example", "port": 1883}])

    def test_port_from_the_environment(self):
        _, calls = self._run({"BROKER": "broker.example", "MQTT_PORT": "1884"})
        self.assertEqual(calls[-1], {"call": "connect", "host": "broker.example", "port": 1884})

    def test_credentials_are_sent_before_connecting(self):
        proc, calls = self._run(
            {"BROKER": "broker.example", "MQTT_USER": "esp32", "MQTT_PASSWORD": "pw"}
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            calls,
            [
                {"call": "username_pw_set", "username": "esp32", "password": "pw"},
                {"call": "connect", "host": "broker.example", "port": 1883},
            ],
        )


if __name__ == "__main__":
    unittest.main()
