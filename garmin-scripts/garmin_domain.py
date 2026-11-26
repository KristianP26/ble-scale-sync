"""Which Garmin region an account belongs to: garmin.com or garmin.cn (China).

Shared by setup_garmin.py and garmin_upload.py so both read the same switch.
garminconnect does not store the region in its token dump, so setup leaves a
marker next to garmin_tokens.json for the uploader to find.
"""

import os
from pathlib import Path

ENV_NAME = "GARMIN_IS_CN"
MARKER_NAME = "garmin_domain.txt"


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
        marker = Path(token_dir) / MARKER_NAME
        if marker.is_file():
            return marker.read_text().strip().lower() == "cn"
    return False


def write_domain_marker(token_dir, is_cn):
    """Record the region next to the token, for the uploader."""
    (Path(token_dir) / MARKER_NAME).write_text("cn" if is_cn else "com")
