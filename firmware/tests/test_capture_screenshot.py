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

# A broker that accepts everything and a firmware that never answers: what the
# tool sees when the ESP32 has "screenshot" off.
_SILENT_CLIENT = '''
class Client:
    def __init__(self, *args, **kwargs):
        pass

    def username_pw_set(self, *args, **kwargs):
        pass

    def connect(self, *args, **kwargs):
        pass

    def subscribe(self, *args, **kwargs):
        pass

    def publish(self, *args, **kwargs):
        pass

    def loop_start(self):
        pass

    def loop_stop(self):
        pass

    def disconnect(self):
        pass
'''


# A firmware that refuses every request with the error the real one publishes
# while a BLE connection is in progress, and counts the requests.
_REFUSING_CLIENT = _SILENT_CLIENT.replace(
    """    def publish(self, *args, **kwargs):
        pass
""",
    """    def publish(self, topic, *args, **kwargs):
        import json, os

        with open(os.environ["FAKE_PAHO_LOG"], "a") as f:
            f.write(json.dumps({"call": "publish", "topic": topic}) + "\\n")

        class Msg:
            pass

        msg = Msg()
        msg.topic = topic.rsplit("/screenshot", 1)[0] + "/error"
        msg.payload = json.dumps(
            {"op": "screenshot", "message": "Screenshot refused: a BLE connection is in progress"}
        ).encode()
        self.on_message(self, None, msg)
""",
)


class CaptureScreenshotTest(unittest.TestCase):
    def _run(self, env_extra, fake=_FAKE_CLIENT, timeout=60):
        with tempfile.TemporaryDirectory() as work:
            pkg = os.path.join(work, "paho", "mqtt")
            os.makedirs(pkg)
            open(os.path.join(work, "paho", "__init__.py"), "w").close()
            open(os.path.join(pkg, "__init__.py"), "w").close()
            with open(os.path.join(pkg, "client.py"), "w") as f:
                f.write(fake)
            log = os.path.join(work, "calls.jsonl")
            env = {
                k: v
                for k, v in os.environ.items()
                if k
                not in ("BROKER", "MQTT_PORT", "MQTT_USER", "MQTT_PASSWORD", "BASE", "WAIT_SECONDS")
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
                timeout=timeout,
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

    def test_a_silent_esp32_ends_with_a_message_that_names_the_config_key(self):
        # Without the check the tool waits 3 x 45 s and ignores WAIT_SECONDS, so
        # the 20 s limit turns the old behavior into an error instead of a long wait.
        proc, _ = self._run(
            {"BROKER": "broker.example", "WAIT_SECONDS": "1"}, fake=_SILENT_CLIENT, timeout=20
        )
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn('"screenshot": true', proc.stderr)
        self.assertIn("No answer within 1 s", proc.stderr)

    def test_a_refusal_during_a_ble_connection_is_retried_not_taken_for_silence(self):
        # The firmware answers on <base>/error, not under screenshot/. Reading that
        # as silence ended the run after one attempt, before the connection was over.
        proc, calls = self._run(
            {"BROKER": "broker.example", "WAIT_SECONDS": "1"}, fake=_REFUSING_CLIENT, timeout=30
        )
        self.assertEqual(len([c for c in calls if c["call"] == "publish"]), 3)
        self.assertNotIn("No answer within", proc.stderr)
        self.assertIn("Screenshot refused: a BLE connection is in progress", proc.stdout)
        self.assertEqual(proc.returncode, 1)

    def test_a_wait_that_is_not_a_number_is_a_message_not_a_traceback(self):
        proc, _ = self._run({"BROKER": "broker.example", "WAIT_SECONDS": "soon"})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("WAIT_SECONDS must be a number", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)


if __name__ == "__main__":
    unittest.main()
