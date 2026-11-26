"""Host-runnable tests for the Garmin region switch (garmin.com or garmin.cn).

Run: python -m unittest discover -s garmin-scripts/tests
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import garmin_domain  # noqa: E402


class DomainTestCase(unittest.TestCase):
    """A token directory and an environment without GARMIN_IS_CN."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.token_dir = tmp.name
        patcher = mock.patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop(garmin_domain.ENV_NAME, None)

    def marker(self, content):
        data = content if isinstance(content, bytes) else content.encode()
        (Path(self.token_dir) / garmin_domain.MARKER_NAME).write_bytes(data)

    def region(self):
        return garmin_domain.resolve_region(self.token_dir)


class ResolveRegionTest(DomainTestCase):
    def test_defaults_to_garmin_com(self):
        self.assertEqual(self.region(), (False, "default", ()))

    def test_defaults_to_garmin_com_without_a_token_dir(self):
        self.assertEqual(garmin_domain.resolve_region(), (False, "default", ()))

    def test_marker_cn(self):
        self.marker("cn")
        self.assertEqual(self.region(), (True, "marker", ()))

    def test_marker_com(self):
        self.marker("com")
        self.assertEqual(self.region(), (False, "marker", ()))

    def test_marker_is_read_case_and_whitespace_insensitive(self):
        self.marker(" CN\n")
        self.assertEqual(self.region(), (True, "marker", ()))

    def test_marker_with_a_byte_order_mark(self):
        # Notepad saves UTF-8 with one when someone edits the file by hand.
        self.marker(b"\xef\xbb\xbfcn\r\n")
        self.assertEqual(self.region(), (True, "marker", ()))

    def test_env_true_without_a_marker(self):
        for value in ("1", "true", "YES", "on", "cn"):
            with self.subTest(value=value):
                os.environ[garmin_domain.ENV_NAME] = value
                self.assertEqual(self.region(), (True, "env", ()))

    def test_env_false_beats_a_cn_marker(self):
        self.marker("cn")
        for value in ("0", "false", "no", "off", "com"):
            with self.subTest(value=value):
                os.environ[garmin_domain.ENV_NAME] = value
                self.assertEqual(self.region(), (False, "env", ()))

    def test_env_true_beats_a_com_marker(self):
        self.marker("com")
        os.environ[garmin_domain.ENV_NAME] = "true"
        self.assertEqual(self.region(), (True, "env", ()))

    def test_an_empty_env_is_unset_and_does_not_warn(self):
        self.marker("cn")
        os.environ[garmin_domain.ENV_NAME] = "  "
        self.assertEqual(self.region(), (True, "marker", ()))

    def test_an_unrecognised_env_warns_without_its_value_and_falls_back(self):
        self.marker("cn")
        os.environ[garmin_domain.ENV_NAME] = "ture-secret"
        region = self.region()
        self.assertEqual(region[:2], (True, "marker"))
        self.assertEqual(len(region.warnings), 1)
        self.assertIn("GARMIN_IS_CN", region.warnings[0])
        self.assertNotIn("ture-secret", region.warnings[0])

    def test_an_unrecognised_env_without_a_marker_uses_garmin_com(self):
        os.environ[garmin_domain.ENV_NAME] = "maybe"
        region = self.region()
        self.assertEqual(region[:2], (False, "default"))
        self.assertEqual(len(region.warnings), 1)

    def test_an_unrecognised_marker_warns_without_its_content_and_uses_garmin_com(self):
        self.marker("hunter2")
        region = self.region()
        self.assertEqual(region[:2], (False, "default"))
        self.assertEqual(len(region.warnings), 1)
        self.assertIn(garmin_domain.MARKER_NAME, region.warnings[0])
        self.assertNotIn("hunter2", region.warnings[0])

    def test_a_marker_with_a_nul_byte_is_unknown(self):
        self.marker(b"cn\x00")
        region = self.region()
        self.assertEqual(region[:2], (False, "default"))
        self.assertEqual(len(region.warnings), 1)

    def test_a_marker_that_is_not_utf8_is_unknown(self):
        self.marker(b"\xff\xfec\x00n\x00")
        region = self.region()
        self.assertEqual(region[:2], (False, "default"))
        self.assertEqual(len(region.warnings), 1)

    def test_an_oversized_marker_is_unknown_and_read_only_up_to_the_limit(self):
        # "cn" followed by blanks would pass strip(), so the size is the check.
        self.marker("cn" + " " * 4096)
        real_open = open
        read_sizes = []

        class CountingFile:
            def __init__(self, f):
                self._f = f

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return self._f.__exit__(*exc)

            def read(self, *args):
                data = self._f.read(*args)
                read_sizes.append(len(data))
                return data

        def counting_open(*args, **kwargs):
            return CountingFile(real_open(*args, **kwargs))

        with mock.patch.object(garmin_domain, "open", counting_open, create=True):
            region = self.region()
        self.assertEqual(region[:2], (False, "default"))
        self.assertEqual(len(region.warnings), 1)
        # One byte past the limit is enough to tell the file is too big.
        self.assertEqual(sum(read_sizes), 17)

    def test_a_marker_at_the_size_limit_is_still_read(self):
        self.marker("cn" + " " * 14)
        self.assertEqual(self.region(), (True, "marker", ()))

    def test_an_unreadable_marker_warns_and_uses_garmin_com(self):
        # A directory where the file should be stands in for any read error.
        os.mkdir(os.path.join(self.token_dir, garmin_domain.MARKER_NAME))
        region = self.region()
        self.assertEqual(region[:2], (False, "default"))
        self.assertEqual(len(region.warnings), 1)
        self.assertIn("could not read", region.warnings[0])

    def test_an_env_decision_does_not_read_the_marker(self):
        os.mkdir(os.path.join(self.token_dir, garmin_domain.MARKER_NAME))
        os.environ[garmin_domain.ENV_NAME] = "true"
        self.assertEqual(self.region(), (True, "env", ()))

    def test_never_prints(self):
        os.environ[garmin_domain.ENV_NAME] = "maybe"
        self.marker("hunter2")
        with mock.patch("builtins.print") as printed:
            self.region()
        printed.assert_not_called()


class DescribeRegionTest(unittest.TestCase):
    def test_names_the_host_and_where_it_came_from(self):
        cases = {
            (True, "env"): "Region: garmin.cn (from GARMIN_IS_CN)",
            (False, "env"): "Region: garmin.com (from GARMIN_IS_CN)",
            (True, "marker"): "Region: garmin.cn (from garmin_domain.txt)",
            (False, "default"): "Region: garmin.com (default)",
        }
        for (is_cn, source), expected in cases.items():
            with self.subTest(is_cn=is_cn, source=source):
                region = garmin_domain.Region(is_cn, source, ())
                self.assertEqual(garmin_domain.describe_region(region), expected)


class WriteDomainMarkerTest(DomainTestCase):
    def read(self):
        return (Path(self.token_dir) / garmin_domain.MARKER_NAME).read_text()

    def test_writes_cn(self):
        garmin_domain.write_domain_marker(self.token_dir, True)
        self.assertEqual(self.read(), "cn")

    def test_writes_com(self):
        garmin_domain.write_domain_marker(self.token_dir, False)
        self.assertEqual(self.read(), "com")

    @unittest.skipIf(os.name == "nt", "POSIX permission bits")
    def test_the_marker_is_owner_only(self):
        old_umask = os.umask(0o022)
        try:
            garmin_domain.write_domain_marker(self.token_dir, True)
        finally:
            os.umask(old_umask)
        mode = os.stat(os.path.join(self.token_dir, garmin_domain.MARKER_NAME)).st_mode
        self.assertEqual(mode & 0o777, 0o600)

    @unittest.skipIf(os.name == "nt", "POSIX permission bits")
    def test_an_older_world_readable_marker_becomes_owner_only(self):
        self.marker("com")
        os.chmod(os.path.join(self.token_dir, garmin_domain.MARKER_NAME), 0o644)
        garmin_domain.write_domain_marker(self.token_dir, True)
        mode = os.stat(os.path.join(self.token_dir, garmin_domain.MARKER_NAME)).st_mode
        self.assertEqual(mode & 0o777, 0o600)

    def test_leaves_only_the_marker_behind(self):
        garmin_domain.write_domain_marker(self.token_dir, True)
        self.assertEqual(os.listdir(self.token_dir), [garmin_domain.MARKER_NAME])

    def test_a_failed_write_keeps_the_old_marker_and_cleans_up(self):
        self.marker("cn")
        with mock.patch.object(garmin_domain.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                garmin_domain.write_domain_marker(self.token_dir, False)
        self.assertEqual(os.listdir(self.token_dir), [garmin_domain.MARKER_NAME])
        self.assertTrue(self.region().is_cn)

    def test_an_unwritable_directory_raises_oserror(self):
        missing = os.path.join(self.token_dir, "absent")
        with self.assertRaises(OSError):
            garmin_domain.write_domain_marker(missing, True)

    def test_what_is_written_is_what_is_read(self):
        for is_cn in (True, False):
            with self.subTest(is_cn=is_cn):
                garmin_domain.write_domain_marker(self.token_dir, is_cn)
                self.assertEqual(self.region(), (is_cn, "marker", ()))


if __name__ == "__main__":
    unittest.main()
