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

    def marker(self, text):
        (Path(self.token_dir) / garmin_domain.MARKER_NAME).write_text(text)


class IsCnDomainTest(DomainTestCase):
    def test_defaults_to_garmin_com(self):
        self.assertFalse(garmin_domain.is_cn_domain(self.token_dir))

    def test_defaults_to_garmin_com_without_a_token_dir(self):
        self.assertFalse(garmin_domain.is_cn_domain())

    def test_marker_cn(self):
        self.marker("cn")
        self.assertTrue(garmin_domain.is_cn_domain(self.token_dir))

    def test_marker_com(self):
        self.marker("com")
        self.assertFalse(garmin_domain.is_cn_domain(self.token_dir))

    def test_marker_is_read_case_and_whitespace_insensitive(self):
        self.marker(" CN\n")
        self.assertTrue(garmin_domain.is_cn_domain(self.token_dir))

    def test_env_true_without_a_marker(self):
        for value in ("1", "true", "YES", "cn"):
            with self.subTest(value=value):
                os.environ[garmin_domain.ENV_NAME] = value
                self.assertTrue(garmin_domain.is_cn_domain(self.token_dir))

    def test_env_false_beats_a_cn_marker(self):
        self.marker("cn")
        for value in ("0", "false", "no", "com"):
            with self.subTest(value=value):
                os.environ[garmin_domain.ENV_NAME] = value
                self.assertFalse(garmin_domain.is_cn_domain(self.token_dir))

    def test_env_true_beats_a_com_marker(self):
        self.marker("com")
        os.environ[garmin_domain.ENV_NAME] = "true"
        self.assertTrue(garmin_domain.is_cn_domain(self.token_dir))


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
        self.assertTrue(garmin_domain.is_cn_domain(self.token_dir))

    def test_an_unwritable_directory_raises_oserror(self):
        missing = os.path.join(self.token_dir, "absent")
        with self.assertRaises(OSError):
            garmin_domain.write_domain_marker(missing, True)

    def test_what_is_written_is_what_is_read(self):
        for is_cn in (True, False):
            with self.subTest(is_cn=is_cn):
                garmin_domain.write_domain_marker(self.token_dir, is_cn)
                self.assertIs(garmin_domain.is_cn_domain(self.token_dir), is_cn)


if __name__ == "__main__":
    unittest.main()
