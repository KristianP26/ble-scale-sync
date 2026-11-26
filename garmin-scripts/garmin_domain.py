"""Which Garmin region an account belongs to: garmin.com or garmin.cn (China).

Shared by setup_garmin.py and garmin_upload.py so both read the same switch.
garminconnect does not store the region in its token dump, so setup leaves a
marker next to garmin_tokens.json for the uploader to find.

Nothing here prints: the uploader's stdout carries one JSON result line for
the app, so each caller logs the warnings in its own way.
"""

import os
import tempfile
from pathlib import Path
from typing import NamedTuple

ENV_NAME = "GARMIN_IS_CN"
MARKER_NAME = "garmin_domain.txt"

# "cn" or "com" plus a newline or a byte order mark is well below this; a
# larger file is not ours, so it is not read further.
_MARKER_MAX_BYTES = 16

_ENV_CN = ("1", "true", "yes", "on", "cn")
_ENV_COM = ("0", "false", "no", "off", "com")


class Region(NamedTuple):
    is_cn: bool
    # "env", "marker" or "default"
    source: str
    warnings: tuple


def _read_marker(token_dir):
    """The marker's region as (is_cn or None, warning or None).

    A missing marker is the normal case for a token from before the marker
    existed and warns about nothing. Whatever else is wrong with it, the
    content is never repeated: it is not ours.
    """
    path = Path(token_dir) / MARKER_NAME
    try:
        with open(path, "rb") as f:
            raw = f.read(_MARKER_MAX_BYTES + 1)
    except FileNotFoundError:
        return None, None
    except OSError as e:
        return None, f"could not read {path}: {e.strerror or type(e).__name__}"
    if len(raw) <= _MARKER_MAX_BYTES and b"\x00" not in raw:
        try:
            text = raw.decode("utf-8-sig").strip().lower()
        except UnicodeDecodeError:
            text = None
        if text in ("cn", "com"):
            return text == "cn", None
    return None, f"{path} does not say cn or com, so it is ignored"


def marker_region(token_dir):
    """True for a cn marker, False for com, None without a usable one.

    This is the region the uploader falls back to when GARMIN_IS_CN is not set.
    """
    return _read_marker(token_dir)[0]


def resolve_region(token_dir=None):
    """The region to log in to, where that came from, and what to warn about.

    GARMIN_IS_CN wins; otherwise the marker in token_dir; the default is
    garmin.com. A value or a marker that is not understood is ignored with a
    warning, so a typo cannot silently pick a region.
    """
    warnings = []
    env = os.environ.get(ENV_NAME, "").strip().lower()
    if env in _ENV_CN:
        return Region(True, "env", tuple(warnings))
    if env in _ENV_COM:
        return Region(False, "env", tuple(warnings))
    if env:
        warnings.append(f"{ENV_NAME} is not true or false, so it is ignored")
    if token_dir:
        is_cn, warning = _read_marker(token_dir)
        if warning:
            warnings.append(warning)
        if is_cn is not None:
            return Region(is_cn, "marker", tuple(warnings))
    return Region(False, "default", tuple(warnings))


def describe_region(region):
    """One log line: the host the login goes to and why."""
    host = "garmin.cn" if region.is_cn else "garmin.com"
    reason = {
        "env": f"from {ENV_NAME}",
        "marker": f"from {MARKER_NAME}",
        "default": "default",
    }[region.source]
    return f"Region: {host} ({reason})"


def write_domain_marker(token_dir, is_cn):
    """Record the region next to the token, for the uploader.

    Written to a temporary file and moved into place, so a reader never sees
    half a marker. mkstemp() creates it owner-only, like the token beside it.
    Raises OSError when it cannot be written.
    """
    target = Path(token_dir) / MARKER_NAME
    fd, tmp = tempfile.mkstemp(dir=token_dir, prefix=MARKER_NAME + ".")
    try:
        with os.fdopen(fd, "w") as f:
            f.write("cn" if is_cn else "com")
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
