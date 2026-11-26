"""Which Garmin region an account belongs to: garmin.com or garmin.cn (China).

Shared by setup_garmin.py and garmin_upload.py so both read the same switch.
garminconnect does not store the region in its token dump, so setup leaves a
marker next to garmin_tokens.json for the uploader to find.
"""

import os
import tempfile
from pathlib import Path

ENV_NAME = "GARMIN_IS_CN"
MARKER_NAME = "garmin_domain.txt"


def marker_region(token_dir):
    """True for a cn marker, False for com, None without a marker.

    This is the region the uploader falls back to when GARMIN_IS_CN is not set.
    """
    marker = Path(token_dir) / MARKER_NAME
    if marker.is_file():
        return marker.read_text().strip().lower() == "cn"
    return None


def is_cn_domain(token_dir=None):
    """True for a Garmin China account.

    GARMIN_IS_CN wins; otherwise the marker in token_dir; the default is
    garmin.com.
    """
    env = os.environ.get(ENV_NAME, "").strip().lower()
    if env in ("1", "true", "yes", "cn"):
        return True
    if env in ("0", "false", "no", "com"):
        return False
    if token_dir:
        return bool(marker_region(token_dir))
    return False


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
