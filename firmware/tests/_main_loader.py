"""Load firmware/main.py in isolation for host tests.

main.py reads config.json from the working directory and builds an MQTT client
and a BLE bridge at import time. load_main() runs it in a temporary directory
with a config the test supplies and stub MicroPython modules, under a fresh
module name, so it never reads a developer's real firmware/config.json and
never shares module state with the `main` other test files import.
"""

import importlib.util
import itertools
import json
import os
import sys
import tempfile
import types
from unittest import mock

FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MAIN_PY = os.path.join(FIRMWARE_DIR, "main.py")

VALID_CONFIG = {
    "topic_prefix": "test",
    "device_id": "test",
    "wifi_ssid": "",
    "wifi_password": "",
    "mqtt_broker": "localhost",
    "mqtt_port": 1883,
}

_counter = itertools.count()


def _stub_board(**overrides):
    board = types.ModuleType("board")
    board.HAS_BEEP = False
    board.HAS_DISPLAY = False
    board.CONTINUOUS_SCAN = True
    board.PUBLISH_INTERVAL_MS = 2000
    board.SCAN_INTERVAL_MS = 5000
    board.DEACTIVATE_BLE_AFTER_SCAN = False
    board.GC_INTERVAL = 100
    board.MAX_SCAN_ENTRIES = 500
    board.BOARD_NAME = "test"
    board.on_scan_complete = lambda *a: None
    for key, value in overrides.items():
        setattr(board, key, value)
    return board


class _FakeMQTTClient:
    def __init__(self, cfg):
        self.published = []

    async def connect(self):
        raise RuntimeError("test stub: not connecting")

    async def publish(self, topic, msg, retain=False, qos=0):
        self.published.append((topic, msg))

    async def subscribe(self, topic, qos=0):
        pass


def load_main(config=None, raw_config=None, **board_overrides):
    """Execute main.py with `config` (a dict) or `raw_config` (file text).

    Returns the module. Exceptions raised while main.py runs propagate.
    """
    mqtt_as = types.ModuleType("mqtt_as")
    mqtt_as.config = {}
    mqtt_as.MQTTClient = _FakeMQTTClient

    ble_bridge = types.ModuleType("ble_bridge")
    ble_bridge.BleBridge = lambda: types.SimpleNamespace(
        start_streaming=lambda: None,
        stop_streaming=lambda: None,
        has_pending_scale_mac=lambda macs: False,
        drain_results=lambda: [],
        _raw_results=[],
    )

    network = types.ModuleType("network")
    network.STA_IF = 0
    network.WLAN = lambda _if: types.SimpleNamespace(isconnected=lambda: False)

    stubs = {
        "network": network,
        "board": _stub_board(**board_overrides),
        "mqtt_as": mqtt_as,
        "ble_bridge": ble_bridge,
        "ui": types.ModuleType("ui"),
        "beep": types.SimpleNamespace(beep=lambda *a, **k: None),
    }

    name = "main_isolated_%d" % next(_counter)
    orig_cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as device, mock.patch.dict(sys.modules, stubs):
        if raw_config is None and config is not None:
            raw_config = json.dumps(config)
        if raw_config is not None:
            with open(os.path.join(device, "config.json"), "w") as f:
                f.write(raw_config)
        os.chdir(device)
        try:
            spec = importlib.util.spec_from_file_location(name, MAIN_PY)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        finally:
            os.chdir(orig_cwd)
