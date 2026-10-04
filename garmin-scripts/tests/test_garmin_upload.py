"""Host-runnable tests for the Garmin uploader's payload handling.

Imports garmin_upload directly and patches the authenticated client away, so
nothing here touches Garmin or the network.

The weight-only switch lives on the Python side of the stdin boundary: the
TypeScript exporter only sets a flag, and every metric still crosses the wire,
so the assertion that matters -- that each derived metric reaches
add_body_composition as None -- cannot be made from the Vitest suite.

Run: python -m unittest discover -s garmin-scripts/tests
"""

import io
import json
import os
import sys
import unittest
from unittest import mock

_SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import garmin_upload  # noqa: E402
from garminconnect.exceptions import (  # noqa: E402
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
)

FULL_PAYLOAD = {
    "weight": 80.0,
    "impedance": 500,
    "bmi": 23.9,
    "bodyFatPercent": 18.5,
    "waterPercent": 55.2,
    "boneMass": 3.1,
    "muscleMass": 62.4,
    "visceralFat": 8,
    "physiqueRating": 5,
    "bmr": 1750,
    "metabolicAge": 30,
}

# Every add_body_composition argument the uploader fills from the payload.
# Weight is deliberately absent: it is the one value weight-only mode keeps.
DERIVED_ARGS = (
    "percent_fat",
    "percent_hydration",
    "bone_mass",
    "muscle_mass",
    "visceral_fat_rating",
    "physique_rating",
    "metabolic_age",
    "bmi",
    "basal_met",
)


def run_main_with(exc=None, stdout=None, data=None):
    """Run main() with upload() replaced; return the parsed stdout line and exit code.

    upload() raises `exc` when one is given, and returns `data` otherwise.
    """
    stdout = stdout if stdout is not None else io.StringIO()
    patch = (
        mock.patch.object(garmin_upload, "upload", side_effect=exc)
        if exc is not None
        else mock.patch.object(garmin_upload, "upload", return_value=data or {"weight": 80.0})
    )
    # main() parses sys.argv; leaving the test runner's own flags there
    # makes argparse exit before the code under test runs.
    with mock.patch.object(sys, "argv", ["garmin_upload.py"]):
        with patch:
            with mock.patch.object(sys, "stdin", io.StringIO("{}")):
                with mock.patch.object(sys, "stdout", stdout):
                    with mock.patch.object(sys, "stderr", io.StringIO()):
                        try:
                            garmin_upload.main()
                            code = None
                        except SystemExit as raised:
                            code = raised.code
    return json.loads(stdout.getvalue()), code


def run_upload(payload):
    """Run upload() against a mock client; return its call kwargs and result."""
    client = mock.Mock()
    with mock.patch.object(garmin_upload, "get_garmin_client", return_value=client):
        result = garmin_upload.upload(payload)
    client.add_body_composition.assert_called_once()
    return client.add_body_composition.call_args.kwargs, result


class DefaultUploadTest(unittest.TestCase):
    def test_sends_every_derived_metric(self):
        kwargs, _ = run_upload(dict(FULL_PAYLOAD))
        self.assertEqual(kwargs["weight"], 80.0)
        for name in DERIVED_ARGS:
            with self.subTest(argument=name):
                self.assertIsNotNone(kwargs[name])

    def test_forwards_the_payload_values_unchanged(self):
        kwargs, _ = run_upload(dict(FULL_PAYLOAD))
        self.assertEqual(kwargs["bmi"], 23.9)
        self.assertEqual(kwargs["percent_fat"], 18.5)
        self.assertEqual(kwargs["metabolic_age"], 30)
        self.assertEqual(kwargs["basal_met"], 1750)


class WeightOnlyUploadTest(unittest.TestCase):
    def test_nulls_every_derived_metric(self):
        kwargs, _ = run_upload({**FULL_PAYLOAD, "weight_only": True})
        for name in DERIVED_ARGS:
            with self.subTest(argument=name):
                self.assertIsNone(kwargs[name])

    def test_keeps_the_weight(self):
        kwargs, _ = run_upload({**FULL_PAYLOAD, "weight_only": True})
        self.assertEqual(kwargs["weight"], 80.0)

    def test_keeps_a_backdated_timestamp(self):
        kwargs, _ = run_upload(
            {**FULL_PAYLOAD, "weight_only": True, "timestamp": "2025-07-01T07:15:00+00:00"}
        )
        self.assertEqual(kwargs["timestamp"], "2025-07-01T07:15:00+00:00")
        self.assertIsNone(kwargs["bmi"])

    def test_result_does_not_report_metrics_that_were_not_sent(self):
        _, result = run_upload({**FULL_PAYLOAD, "weight_only": True})
        self.assertEqual(result["weight"], 80.0)
        for key in ("bodyFatPercent", "muscleMass", "visceralFat", "physiqueRating"):
            with self.subTest(key=key):
                self.assertIsNone(result[key])

    def test_false_behaves_like_absent(self):
        kwargs, _ = run_upload({**FULL_PAYLOAD, "weight_only": False})
        self.assertEqual(kwargs["bmi"], 23.9)


class FailureReportingTest(unittest.TestCase):
    """The orchestrator only ever sees what main() puts on stdout.

    A rejected token reaches it as "Failed to retrieve social profile" with the
    401 on __cause__, so dropping the chain left every retry logging the same
    line with nothing to act on.
    """

    def run_main(self, exc, cause=None):
        exc.__cause__ = cause if cause is not None else ConnectionError("API Error 401")
        return run_main_with(exc)

    def test_reports_the_chained_cause_to_the_orchestrator(self):
        result, _ = self.run_main(RuntimeError("Failed to retrieve social profile"))
        self.assertFalse(result["success"])
        self.assertIn("Failed to retrieve social profile", result["error"])
        self.assertIn("API Error 401", result["error"])

    def test_still_exits_nonzero(self):
        _, code = self.run_main(RuntimeError("Failed to retrieve social profile"))
        self.assertEqual(code, 1)

    def test_leaves_other_failures_retryable(self):
        result, _ = self.run_main(
            RuntimeError("Failed to retrieve social profile"),
            cause=ConnectionError("API Error 503 - Service Unavailable"),
        )
        self.assertNotIn("retryable", result)

    def test_marks_an_unusable_token_directory_as_not_retryable(self):
        # F-13: the TypeScript side would otherwise spawn this three times to
        # hit the same missing file.
        result, code = self.run_main(garmin_upload.TokenSetupError("Token directory not found"))
        self.assertIs(result["retryable"], False)
        self.assertEqual(code, 1)


class MissingTokenTest(unittest.TestCase):
    """#435: no token file used to surface as "Username and password are required"."""

    def test_names_the_missing_token_file_before_trying_to_log_in(self):
        import tempfile

        with tempfile.TemporaryDirectory() as empty_dir:
            with mock.patch.object(garmin_upload, "Garmin") as garmin_cls:
                with self.assertRaises(RuntimeError) as ctx:
                    garmin_upload.get_garmin_client(empty_dir)

        self.assertIn("garmin_tokens.json is missing", str(ctx.exception))
        self.assertIsInstance(ctx.exception, garmin_upload.TokenSetupError)
        garmin_cls.assert_not_called()

    def test_a_missing_token_directory_is_a_setup_error(self):
        import tempfile

        with tempfile.TemporaryDirectory() as parent:
            with self.assertRaises(garmin_upload.TokenSetupError):
                garmin_upload.get_garmin_client(os.path.join(parent, "absent"))

    def test_logs_in_when_the_token_file_is_there(self):
        import tempfile

        with tempfile.TemporaryDirectory() as token_dir:
            open(os.path.join(token_dir, "garmin_tokens.json"), "w").close()
            with mock.patch.object(garmin_upload, "Garmin") as garmin_cls:
                garmin_upload.get_garmin_client(token_dir)

        garmin_cls.return_value.login.assert_called_once_with(token_dir)


def chained(outer, cause):
    outer.__cause__ = cause
    return outer


class RejectedTokenTest(unittest.TestCase):
    """F-13: a 401 is Garmin refusing the saved token, which no retry fixes.

    The shapes are the ones garminconnect 0.3.17 produces. Client._run_request
    raises GarminConnectConnectionError("API Error 401 ...") once its own
    refresh-and-retry has failed. At login, Garmin._load_social_profile wraps
    whatever its third attempt raised in GarminConnectAuthenticationError(
    "Failed to retrieve social profile"); the upload POST raises the
    connection error as it is. The wrapper is used for 5xx and network errors
    too, so its class alone does not mean a 401.
    """

    def test_a_token_rejected_at_login_is_not_retryable(self):
        result, code = run_main_with(
            chained(
                GarminConnectAuthenticationError("Failed to retrieve social profile"),
                GarminConnectConnectionError("API Error 401 - Unauthorized"),
            )
        )
        self.assertIs(result.get("retryable"), False)
        self.assertEqual(code, 1)

    def test_a_token_rejected_by_the_upload_is_not_retryable(self):
        result, _ = run_main_with(GarminConnectConnectionError("API Error 401"))
        self.assertIs(result.get("retryable"), False)

    def test_says_to_run_the_setup_again_and_keeps_the_detail(self):
        result, _ = run_main_with(
            chained(
                GarminConnectAuthenticationError("Failed to retrieve social profile"),
                GarminConnectConnectionError("API Error 401 - Unauthorized"),
            )
        )
        self.assertIn("setup-garmin", result["error"])
        self.assertIn("API Error 401", result["error"])

    def test_a_server_error_behind_the_same_wrapper_stays_retryable(self):
        result, _ = run_main_with(
            chained(
                GarminConnectAuthenticationError("Failed to retrieve social profile"),
                GarminConnectConnectionError("API Error 503 - Service Unavailable"),
            )
        )
        self.assertNotIn("retryable", result)

    def test_a_network_failure_stays_retryable(self):
        result, _ = run_main_with(
            chained(
                GarminConnectAuthenticationError("Failed to retrieve social profile"),
                ConnectionError("Connection reset by peer"),
            )
        )
        self.assertNotIn("retryable", result)


class FlushRecorder(io.StringIO):
    """A stdout that remembers what had been written at each flush()."""

    def __init__(self):
        super().__init__()
        self.flushed = []

    def flush(self):
        self.flushed.append(self.getvalue())
        super().flush()


class ResultIsFlushedTest(unittest.TestCase):
    """F-04: the result line has to be in the pipe before the process can die.

    stdout to a pipe is block-buffered. The orchestrator kills the uploader with
    SIGTERM at upload_timeout_sec, and a SIGTERM between print() and the
    flush at exit lost a success that had already happened, so the upload was
    sent again.
    """

    def test_the_success_line_is_flushed_before_exit(self):
        stdout = FlushRecorder()
        run_main_with(stdout=stdout)
        self.assertTrue(any('"success": true' in s for s in stdout.flushed))

    def test_a_failure_line_is_flushed_before_exit(self):
        stdout = FlushRecorder()
        run_main_with(RuntimeError("boom"), stdout=stdout)
        self.assertTrue(any('"success": false' in s for s in stdout.flushed))


class NoPackageDotenvTest(unittest.TestCase):
    """F-11: the uploader takes its environment from the app that spawns it.

    The app has already loaded the .env that belongs to its config.yaml, and
    the child inherits it. Loading the package directory's .env on top added
    keys (TOKEN_DIR among them) from another installation's file whenever
    the two directories differ, which is every npm or npx install.
    """

    def test_importing_the_uploader_reads_no_env_file(self):
        import importlib

        with mock.patch("dotenv.load_dotenv") as load_dotenv:
            importlib.reload(garmin_upload)
        load_dotenv.assert_not_called()


if __name__ == "__main__":
    unittest.main()
