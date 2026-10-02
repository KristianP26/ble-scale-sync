"""Host-runnable tests for the Garmin setup script's authentication path.

Imports setup_garmin directly and patches the Garmin client away, so nothing
here touches Garmin or the network.

The regression these cover: setup_garmin used to hand token_dir to
Garmin.login(), which loads an existing token file and, on success, skips the
credential login entirely. A stale token then failed the profile fetch with a
401 surfacing as "Failed to retrieve social profile" -- credentials never
sent, MFA never prompted, and the printed message blamed IP blocking because
only str(exc) was shown and the chained cause was dropped.

Run: python -m unittest discover -s garmin-scripts/tests
"""

import os
import sys
import tempfile
import unittest
from unittest import mock

_SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import setup_garmin  # noqa: E402


def make_garmin(login_result=(None, None)):
    """A Garmin double whose login() records how it was called."""
    garmin = mock.Mock()
    garmin.login.return_value = login_result
    return garmin


def run_authenticate(garmin, token_dir, mfa_code="123456"):
    """Run authenticate() against a Garmin double; return its result."""
    with mock.patch.object(setup_garmin, "Garmin", return_value=garmin):
        with mock.patch("builtins.input", return_value=mfa_code):
            return setup_garmin.authenticate("a@b.c", "pw", token_dir)


class LoginFreshTest(unittest.TestCase):
    def test_passes_no_tokenstore_so_a_cached_token_is_never_loaded(self):
        garmin = make_garmin()
        setup_garmin.login_fresh(garmin)
        garmin.login.assert_called_once_with()

    def test_hides_garmintokens_during_login(self):
        garmin = make_garmin()
        seen = {}
        garmin.login.side_effect = lambda: seen.setdefault(
            "env", os.environ.get("GARMINTOKENS")
        )
        with mock.patch.dict(os.environ, {"GARMINTOKENS": "/cached"}):
            setup_garmin.login_fresh(garmin)
        self.assertIsNone(seen["env"])

    def test_restores_garmintokens_afterwards(self):
        garmin = make_garmin()
        with mock.patch.dict(os.environ, {"GARMINTOKENS": "/cached"}):
            setup_garmin.login_fresh(garmin)
            self.assertEqual(os.environ["GARMINTOKENS"], "/cached")

    def test_restores_garmintokens_even_when_login_raises(self):
        garmin = make_garmin()
        garmin.login.side_effect = RuntimeError("boom")
        with mock.patch.dict(os.environ, {"GARMINTOKENS": "/cached"}):
            with self.assertRaises(RuntimeError):
                setup_garmin.login_fresh(garmin)
            self.assertEqual(os.environ["GARMINTOKENS"], "/cached")

    def test_leaves_garmintokens_unset_when_it_was_unset(self):
        garmin = make_garmin()
        with mock.patch.dict(os.environ):
            os.environ.pop("GARMINTOKENS", None)
            setup_garmin.login_fresh(garmin)
            self.assertNotIn("GARMINTOKENS", os.environ)


class AuthenticateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.token_dir = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def test_never_hands_the_token_dir_to_login(self):
        garmin = make_garmin()
        self.assertTrue(run_authenticate(garmin, self.token_dir))
        garmin.login.assert_called_once_with()

    def test_dumps_the_new_token_on_a_clean_login(self):
        garmin = make_garmin()
        self.assertTrue(run_authenticate(garmin, self.token_dir))
        garmin.resume_login.assert_not_called()
        garmin.client.dump.assert_called_once_with(self.token_dir)

    def test_resumes_and_dumps_on_the_mfa_path(self):
        garmin = make_garmin(login_result=("needs_mfa", {"state": 1}))
        self.assertTrue(run_authenticate(garmin, self.token_dir, mfa_code="654321"))
        garmin.resume_login.assert_called_once_with({"state": 1}, "654321")
        garmin.client.dump.assert_called_once_with(self.token_dir)

    def test_reports_failure_when_the_dump_fails(self):
        garmin = make_garmin()
        garmin.client.dump.side_effect = OSError("read-only filesystem")
        self.assertFalse(run_authenticate(garmin, self.token_dir))

    def test_prints_the_chained_cause_of_a_login_failure(self):
        garmin = make_garmin()
        cause = ConnectionError("API Error 401")
        garmin.login.side_effect = RuntimeError(
            "Failed to retrieve social profile"
        )
        garmin.login.side_effect.__cause__ = cause

        with mock.patch("builtins.print") as printed:
            self.assertFalse(run_authenticate(garmin, self.token_dir))

        output = "\n".join(str(call.args[0]) for call in printed.call_args_list)
        self.assertIn("Failed to retrieve social profile", output)
        self.assertIn("API Error 401", output)


if __name__ == "__main__":
    unittest.main()
