"""Tests for the shared Garmin error renderer.

garminconnect reports a rejected token as "Failed to retrieve social profile"
and puts the 401 that explains it on __cause__, so both Garmin scripts render
the chain rather than str(exc) alone.

Run: python -m unittest discover -s garmin-scripts/tests
"""

import os
import sys
import unittest

_SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from garmin_errors import format_error_chain  # noqa: E402


class FormatErrorChainTest(unittest.TestCase):
    def test_renders_a_bare_exception(self):
        self.assertEqual(format_error_chain(ValueError("nope")), "nope")

    def test_appends_an_explicit_cause(self):
        try:
            try:
                raise ConnectionError("API Error 401")
            except ConnectionError as inner:
                raise RuntimeError("Failed to retrieve social profile") from inner
        except RuntimeError as outer:
            rendered = format_error_chain(outer)

        self.assertIn("Failed to retrieve social profile", rendered)
        self.assertIn("caused by: ConnectionError: API Error 401", rendered)

    def test_appends_an_implicit_context(self):
        try:
            try:
                raise ConnectionError("API Error 401")
            except ConnectionError:
                raise RuntimeError("wrapped")
        except RuntimeError as outer:
            rendered = format_error_chain(outer)

        self.assertIn("caused by: ConnectionError: API Error 401", rendered)

    def test_renders_every_link_of_a_longer_chain(self):
        try:
            try:
                try:
                    raise OSError("connection reset")
                except OSError as first:
                    raise ConnectionError("API Error 401") from first
            except ConnectionError as second:
                raise RuntimeError("Failed to retrieve social profile") from second
        except RuntimeError as outer:
            rendered = format_error_chain(outer)

        self.assertIn("caused by: ConnectionError: API Error 401", rendered)
        self.assertIn("caused by: OSError: connection reset", rendered)

    def test_terminates_on_a_self_referential_chain(self):
        looped = RuntimeError("outer")
        inner = RuntimeError("inner")
        looped.__cause__ = inner
        inner.__cause__ = looped

        rendered = format_error_chain(looped)

        self.assertIn("caused by: RuntimeError: inner", rendered)
        self.assertEqual(rendered.count("caused by:"), 1)


if __name__ == "__main__":
    unittest.main()
