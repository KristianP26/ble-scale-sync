"""Host-runnable tests: the ESP32 MQTT leg can use TLS.

The firmware never set mqtt_as's `ssl`/`ssl_params`, so the ESP32 always talked
plain MQTT: the broker password and every notification (weight, impedance)
crossed the LAN/WiFi in the clear, and a TLS-only broker was unreachable.

mqtt_as (pinned 70b56a7a4aaf, VERSION 0.8.4) wraps its socket with
`ssl.wrap_socket(sock, **ssl_params)` when `ssl` is True. On the mbedtls based
esp32 port only `cert_reqs=CERT_REQUIRED` validates the broker certificate, and
CERT_REQUIRED without `server_hostname` raises ValueError.

Run: python -m unittest discover -s firmware/tests
"""

import importlib.util
import json
import os
import ssl
import sys
import tempfile
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)

# Stub MicroPython-only modules before importing anything from firmware.
sys.modules.setdefault("aioble", types.ModuleType("aioble"))
if "bluetooth" not in sys.modules:
    _bt = types.ModuleType("bluetooth")
    _bt.BLE = lambda: None
    sys.modules["bluetooth"] = _bt

if "mqtt_as" not in sys.modules:
    _mqtt_as = types.ModuleType("mqtt_as")
    _mqtt_as.config = {}

    class _FakeMQTTClient:
        def __init__(self, cfg):
            pass

        async def connect(self):
            raise RuntimeError("test stub: not connecting")

    _mqtt_as.MQTTClient = _FakeMQTTClient
    sys.modules["mqtt_as"] = _mqtt_as


def _board_stub():
    # Other test modules swap sys.modules["board"] for partial stubs, so the
    # boot below brings its own complete one.
    b = types.ModuleType("board")
    b.HAS_BEEP = False
    b.HAS_DISPLAY = False
    b.CONTINUOUS_SCAN = True
    b.PUBLISH_INTERVAL_MS = 2000
    b.SCAN_INTERVAL_MS = 5000
    b.DEACTIVATE_BLE_AFTER_SCAN = False
    b.GC_INTERVAL = 100
    b.MAX_SCAN_ENTRIES = 500
    b.BOARD_NAME = "test"
    b.on_scan_complete = lambda *a: None
    return b


def _ble_bridge_stub():
    m = types.ModuleType("ble_bridge")
    m.BleBridge = lambda: types.SimpleNamespace()
    return m


_BASE_CFG = {
    "topic_prefix": "test",
    "device_id": "test",
    "wifi_ssid": "",
    "wifi_password": "",
    "mqtt_broker": "broker.lan",
    "mqtt_port": 8883,
}

_CA = b"-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n"


def _boot_main(extra_cfg, files=None):
    """Import firmware/main.py as the device boots it, from a temp filesystem.

    Returns the mqtt_as config dict main.py filled in. The shared stub dict is
    restored afterwards so other test modules see what they set themselves.
    """
    cfg = dict(_BASE_CFG)
    cfg.update(extra_cfg)
    shared = sys.modules["mqtt_as"].config
    saved = dict(shared)
    saved_modules = {name: sys.modules.get(name) for name in ("board", "ble_bridge")}
    sys.modules["board"] = _board_stub()
    sys.modules["ble_bridge"] = _ble_bridge_stub()
    orig_cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as device:
        with open(os.path.join(device, "config.json"), "w") as f:
            json.dump(cfg, f)
        for name, data in (files or {}).items():
            with open(os.path.join(device, name), "wb") as f:
                f.write(data)
        os.chdir(device)
        try:
            spec = importlib.util.spec_from_file_location(
                "main_tls_under_test", os.path.join(_FIRMWARE_DIR, "main.py")
            )
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            result = dict(shared)
        finally:
            os.chdir(orig_cwd)
            shared.clear()
            shared.update(saved)
            for name, mod in saved_modules.items():
                if mod is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = mod
    return result


class MqttTlsConfigTest(unittest.TestCase):
    def test_plain_mqtt_stays_the_default(self):
        mc = _boot_main({"mqtt_port": 1883})
        self.assertFalse(mc.get("ssl", False))
        self.assertEqual(mc.get("ssl_params", {}), {})

    def test_tls_without_a_ca_encrypts_and_sends_sni(self):
        mc = _boot_main({"mqtt_tls": True})
        self.assertIs(mc.get("ssl"), True)
        self.assertEqual(mc["ssl_params"], {"server_hostname": "broker.lan"})

    def test_tls_to_an_ip_broker_without_a_ca_sends_no_sni(self):
        # RFC 6066 forbids an IP literal as SNI; there is nothing to verify.
        mc = _boot_main({"mqtt_tls": True, "mqtt_broker": "192.168.1.100"})
        self.assertIs(mc.get("ssl"), True)
        self.assertEqual(mc["ssl_params"], {})

    def test_tls_with_a_ca_file_verifies_the_broker(self):
        mc = _boot_main({"mqtt_tls": True, "mqtt_ca_file": "ca.pem"}, files={"ca.pem": _CA})
        self.assertIs(mc.get("ssl"), True)
        params = mc["ssl_params"]
        self.assertEqual(params["cert_reqs"], ssl.CERT_REQUIRED)
        self.assertEqual(params["cadata"], _CA)
        # mbedtls refuses CERT_REQUIRED without a hostname to check.
        self.assertEqual(params["server_hostname"], "broker.lan")

    def test_hostname_override_for_a_broker_reached_by_ip(self):
        mc = _boot_main(
            {
                "mqtt_tls": True,
                "mqtt_broker": "192.168.1.100",
                "mqtt_ca_file": "ca.pem",
                "mqtt_tls_hostname": "mqtt.home.example",
            },
            files={"ca.pem": _CA},
        )
        self.assertEqual(mc["ssl_params"]["server_hostname"], "mqtt.home.example")

    def test_missing_ca_file_fails_loudly_instead_of_skipping_verification(self):
        with self.assertRaises(OSError) as ctx:
            _boot_main({"mqtt_tls": True, "mqtt_ca_file": "ca.pem"})
        self.assertIn("ca.pem", str(ctx.exception))

    def test_ca_file_without_tls_is_refused_not_sent_in_plaintext(self):
        with self.assertRaises(ValueError) as ctx:
            _boot_main({"mqtt_ca_file": "ca.pem"}, files={"ca.pem": _CA})
        self.assertIn("mqtt_tls", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
