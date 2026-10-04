"""Host-runnable tests: a broken config.json fails with a message that says why.

main.py read every required key with cfg["..."], so a missing key ended the
boot with a bare KeyError traceback in the REPL, and a wrong type (a quoted
port) got as far as the MQTT client before failing somewhere inside it. The
board half of the same review finding (an unknown "board" value silently
picking the S3 profile) is covered by test_board_selection.py.

Run: python -m unittest discover -s firmware/tests
"""

import json
import unittest

from _main_loader import VALID_CONFIG, load_main


def _without(key):
    cfg = dict(VALID_CONFIG)
    del cfg[key]
    return cfg


def _with(**changes):
    cfg = dict(VALID_CONFIG)
    cfg.update(changes)
    return cfg


class ConfigValidationTest(unittest.TestCase):
    def test_valid_config_still_boots(self):
        main = load_main(VALID_CONFIG)
        self.assertEqual(main.BASE, "test/test")

    def test_optional_keys_may_be_null(self):
        # config.json.example ships these as null.
        load_main(_with(board=None, mqtt_user=None, mqtt_password=None, mqtt_ca_file=None))

    def test_missing_key_is_named(self):
        for key in ("topic_prefix", "device_id", "wifi_ssid", "wifi_password", "mqtt_broker", "mqtt_port"):
            with self.subTest(key=key):
                with self.assertRaises(ValueError) as ctx:
                    load_main(_without(key))
                self.assertIn(key, str(ctx.exception))
                self.assertIn("config.json", str(ctx.exception))

    def test_all_missing_keys_are_named_at_once(self):
        cfg = _without("mqtt_broker")
        del cfg["device_id"]
        with self.assertRaises(ValueError) as ctx:
            load_main(cfg)
        self.assertIn("mqtt_broker", str(ctx.exception))
        self.assertIn("device_id", str(ctx.exception))

    def test_null_required_key_is_refused(self):
        with self.assertRaises(ValueError) as ctx:
            load_main(_with(mqtt_broker=None))
        self.assertIn("mqtt_broker", str(ctx.exception))

    def test_quoted_port_is_refused(self):
        with self.assertRaises(ValueError) as ctx:
            load_main(_with(mqtt_port="1883"))
        self.assertIn("mqtt_port", str(ctx.exception))

    def test_empty_broker_or_ids_are_refused(self):
        for key in ("mqtt_broker", "device_id", "topic_prefix"):
            with self.subTest(key=key):
                with self.assertRaises(ValueError) as ctx:
                    load_main(_with(**{key: ""}))
                self.assertIn(key, str(ctx.exception))

    def test_empty_wifi_password_is_allowed(self):
        # An open network has no password.
        load_main(_with(wifi_password=""))

    def test_missing_file_says_so(self):
        with self.assertRaises(OSError) as ctx:
            load_main()
        self.assertIn("config.json", str(ctx.exception))
        self.assertIn("config.json.example", str(ctx.exception))

    def test_invalid_json_says_so(self):
        with self.assertRaises(ValueError) as ctx:
            load_main(raw_config='{"mqtt_port": 1883,}')
        self.assertIn("config.json", str(ctx.exception))

    def test_non_object_is_refused(self):
        with self.assertRaises(ValueError) as ctx:
            load_main(raw_config=json.dumps(["not", "an", "object"]))
        self.assertIn("config.json", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
