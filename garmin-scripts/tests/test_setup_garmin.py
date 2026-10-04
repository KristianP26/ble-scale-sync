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


class ConfigTokenDirTest(unittest.TestCase):
    """F-11: a relative token_dir in config.yaml is next to config.yaml."""

    def run_setup(self, config, config_path, cli_token_dir=None):
        with mock.patch.object(setup_garmin, "load_config", return_value=config):
            with mock.patch.object(
                setup_garmin, "authenticate", return_value=True
            ) as authenticate:
                with mock.patch("builtins.print"):
                    setup_garmin.run_from_config(config_path, cli_token_dir=cli_token_dir)
        return authenticate.call_args[0][2]

    def config_with(self, token_dir):
        entry = {"type": "garmin", "email": "a@x", "password": "pw", "token_dir": token_dir}
        return {"users": [{"name": "Alice", "exporters": [entry]}]}

    def test_relative_token_dir_resolves_from_the_config_directory(self):
        with tempfile.TemporaryDirectory() as config_dir:
            config_path = os.path.join(config_dir, "config.yaml")
            token_dir = self.run_setup(self.config_with("./garmin-tokens/alice"), config_path)
            self.assertEqual(
                os.path.normcase(token_dir),
                os.path.normcase(
                    os.path.join(os.path.realpath(config_dir), "garmin-tokens", "alice")
                ),
            )

    def test_absolute_token_dir_is_kept(self):
        with tempfile.TemporaryDirectory() as config_dir:
            absolute = os.path.join(config_dir, "elsewhere")
            token_dir = self.run_setup(
                self.config_with(absolute), os.path.join(config_dir, "sub", "config.yaml")
            )
            self.assertEqual(token_dir, absolute)

    def test_command_line_token_dir_still_wins(self):
        with tempfile.TemporaryDirectory() as config_dir:
            override = os.path.join(config_dir, "override")
            token_dir = self.run_setup(
                self.config_with("./garmin-tokens/alice"),
                os.path.join(config_dir, "config.yaml"),
                cli_token_dir=override,
            )
            self.assertEqual(token_dir, override)


class _Cwd:
    """Run a block from another working directory, restoring it afterwards."""

    def __init__(self, path):
        self.path = path

    def __enter__(self):
        self.saved = os.getcwd()
        os.chdir(self.path)

    def __exit__(self, *exc):
        os.chdir(self.saved)


def run_main(argv, cwd, env=None):
    """Run main() from `cwd` with authenticate() replaced; return its mock.

    Every Garmin variable is removed first and `env` set, and whatever the
    code under test loads from a .env is dropped again afterwards.
    """
    with mock.patch.dict(os.environ):
        for key in ("GARMIN_EMAIL", "GARMIN_PASSWORD", "TOKEN_DIR", "BSS_TEST_GARMIN_PW"):
            os.environ.pop(key, None)
        os.environ.update(env or {})
        with _Cwd(cwd):
            with mock.patch.object(sys, "argv", ["setup_garmin.py", *argv]):
                with mock.patch.object(
                    setup_garmin, "authenticate", return_value=True
                ) as authenticate:
                    with mock.patch("builtins.print"):
                        try:
                            setup_garmin.main()
                        except SystemExit:
                            pass
    return authenticate


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


class DotenvBesideConfigTest(unittest.TestCase):
    """F-11: the .env read is the one next to config.yaml, as in the app.

    It used to be the package directory's, which after an npm or npx install
    is not where the user keeps either file, so the legacy setup did not see
    GARMIN_EMAIL / GARMIN_PASSWORD and --from-config left ${VAR} unresolved.
    """

    def test_legacy_setup_reads_the_env_in_the_working_directory(self):
        with tempfile.TemporaryDirectory() as here:
            write(
                os.path.join(here, ".env"),
                "GARMIN_EMAIL=dot@x\nGARMIN_PASSWORD=pw\n",
            )
            authenticate = run_main([], cwd=here)
        self.assertTrue(authenticate.called)
        self.assertEqual(authenticate.call_args[0][0], "dot@x")

    def test_from_config_reads_the_env_beside_the_given_config(self):
        with tempfile.TemporaryDirectory() as root:
            config_dir = os.path.join(root, "cfg")
            elsewhere = os.path.join(root, "elsewhere")
            os.makedirs(elsewhere)
            write(
                os.path.join(config_dir, "config.yaml"),
                "users:\n"
                "  - name: Alice\n"
                "    exporters:\n"
                "      - type: garmin\n"
                "        email: a@x\n"
                "        password: ${BSS_TEST_GARMIN_PW}\n"
                "        token_dir: ./tokens\n",
            )
            write(os.path.join(config_dir, ".env"), "BSS_TEST_GARMIN_PW=from-dotenv\n")
            authenticate = run_main(
                ["--from-config", "--config-path", os.path.join(config_dir, "config.yaml")],
                cwd=elsewhere,
            )
        self.assertTrue(authenticate.called)
        self.assertEqual(authenticate.call_args[0][1], "from-dotenv")


class TokenDirEnvTest(unittest.TestCase):
    """F-11: a relative TOKEN_DIR is next to config.yaml, not the working directory.

    The app reads it that way (findTokenDirCollisions resolves the Garmin
    default against the config directory), so the setup has to write there.
    """

    def test_relative_token_dir_env_is_taken_from_the_config_directory(self):
        with tempfile.TemporaryDirectory() as root:
            config_dir = os.path.join(root, "cfg")
            elsewhere = os.path.join(root, "elsewhere")
            os.makedirs(elsewhere)
            write(
                os.path.join(config_dir, "config.yaml"),
                "users:\n"
                "  - name: Alice\n"
                "    exporters:\n"
                "      - type: garmin\n"
                "        email: a@x\n"
                "        password: pw\n",
            )
            authenticate = run_main(
                ["--from-config", "--config-path", os.path.join(config_dir, "config.yaml")],
                cwd=elsewhere,
                env={"TOKEN_DIR": "garmin-tokens"},
            )
            expected = os.path.join(os.path.realpath(config_dir), "garmin-tokens")
        self.assertTrue(authenticate.called)
        self.assertEqual(
            os.path.normcase(authenticate.call_args[0][2]), os.path.normcase(expected)
        )

    def test_legacy_mode_resolves_token_dir_env_against_config_path(self):
        # The wizard runs the legacy (env credential) mode and passes the
        # config it is writing. A relative TOKEN_DIR must land next to that
        # config, where the app looks, not next to the package.
        with tempfile.TemporaryDirectory() as root:
            config_dir = os.path.join(root, "cfg")
            elsewhere = os.path.join(root, "elsewhere")
            os.makedirs(config_dir)
            os.makedirs(elsewhere)
            authenticate = run_main(
                ["--config-path", os.path.join(config_dir, "config.yaml")],
                cwd=elsewhere,
                env={"GARMIN_EMAIL": "a@x", "GARMIN_PASSWORD": "pw", "TOKEN_DIR": "garmin-tokens"},
            )
            expected = os.path.join(os.path.realpath(config_dir), "garmin-tokens")
        self.assertTrue(authenticate.called)
        self.assertEqual(
            os.path.normcase(authenticate.call_args[0][2]), os.path.normcase(expected)
        )

    def test_absolute_token_dir_env_is_kept(self):
        with tempfile.TemporaryDirectory() as here:
            absolute = os.path.join(here, "abs-tokens")
            write(
                os.path.join(here, ".env"),
                f"GARMIN_EMAIL=a@x\nGARMIN_PASSWORD=pw\nTOKEN_DIR={absolute}\n",
            )
            authenticate = run_main([], cwd=here)
        self.assertTrue(authenticate.called)
        self.assertEqual(authenticate.call_args[0][2], absolute)


if __name__ == "__main__":
    unittest.main()
