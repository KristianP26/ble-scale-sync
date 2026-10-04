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

    @unittest.skipIf(os.name == "nt", "POSIX permission bits")
    def test_token_dir_and_files_are_owner_only(self):
        # The token grants full access to the Garmin account. makedirs()
        # without a mode left the directory 0755 and the dumped file got
        # whatever the library and umask gave it.
        token_dir = os.path.join(self.token_dir, "garmin-tokens")
        garmin = make_garmin()

        def dump(path):
            target = os.path.join(path, "garmin_tokens.json")
            with open(target, "w") as f:
                f.write("{}")
            os.chmod(target, 0o644)

        garmin.client.dump.side_effect = dump
        old_umask = os.umask(0o022)
        try:
            self.assertTrue(run_authenticate(garmin, token_dir))
        finally:
            os.umask(old_umask)

        self.assertEqual(os.stat(token_dir).st_mode & 0o777, 0o700)
        token_file = os.path.join(token_dir, "garmin_tokens.json")
        self.assertEqual(os.stat(token_file).st_mode & 0o777, 0o600)

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


class ResolveEnvRefTest(unittest.TestCase):
    def test_resolves_a_reference(self):
        with mock.patch.dict(os.environ, {"BSS_TEST_PW": "secret"}):
            self.assertEqual(setup_garmin.resolve_env_ref("${BSS_TEST_PW}"), "secret")

    def test_dollar_dollar_brace_is_a_literal(self):
        # G-24: the same escape the TypeScript loader accepts.
        with mock.patch.dict(os.environ, {"BSS_TEST_PW": "secret"}):
            self.assertEqual(
                setup_garmin.resolve_env_ref("pa$${BSS_TEST_PW}ss"), "pa${BSS_TEST_PW}ss"
            )


GLOBAL_GARMIN = {"type": "garmin", "email": "family@x", "password": "pw"}


class GarminUsersFromConfigTest(unittest.TestCase):
    """F-20: setup must authenticate the accounts the runtime will use."""

    def test_user_without_own_entry_inherits_the_global_one(self):
        config = {
            "users": [
                {
                    "name": "Alice",
                    "exporters": [{"type": "garmin", "email": "alice@x", "password": "a"}],
                },
                {"name": "Bob"},
            ],
            "global_exporters": [GLOBAL_GARMIN],
        }
        users = setup_garmin.get_garmin_users(config)
        self.assertEqual(
            [(u["name"], u["email"]) for u in users],
            [("Alice", "alice@x"), ("Bob", "family@x")],
        )

    def test_only_the_first_global_entry_is_inherited(self):
        second = dict(GLOBAL_GARMIN, email="other@x")
        config = {"users": [{"name": "Bob"}], "global_exporters": [GLOBAL_GARMIN, second]}
        users = setup_garmin.get_garmin_users(config)
        self.assertEqual([u["email"] for u in users], ["family@x"])

    def test_one_login_for_an_account_shared_by_every_user(self):
        config = {"users": [{"name": "Alice"}, {"name": "Bob"}], "global_exporters": [GLOBAL_GARMIN]}
        with tempfile.TemporaryDirectory() as token_dir:
            with mock.patch.object(setup_garmin, "load_config", return_value=config):
                with mock.patch.object(
                    setup_garmin, "authenticate", return_value=True
                ) as authenticate:
                    with mock.patch("builtins.print"):
                        setup_garmin.run_from_config("config.yaml", cli_token_dir=token_dir)
        authenticate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
