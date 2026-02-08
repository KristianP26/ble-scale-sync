"""
Garmin Connect authentication setup.

Run once to authenticate with Garmin and store tokens locally.
Subsequent runs of the sync tool will use these stored tokens.

Usage:
    npm run setup-garmin
    # or directly:
    python scripts/setup_garmin.py
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from garminconnect import Garmin

# Load .env from project root
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

FAKE_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/121.0.0.0 Safari/537.36"
)


def get_token_dir():
    custom = os.environ.get("TOKEN_DIR", "").strip()
    if custom:
        return str(Path(custom).expanduser())
    return str(Path.home() / ".garmin_renpho_tokens")


def main():
    email = os.environ.get("GARMIN_EMAIL", "").strip()
    password = os.environ.get("GARMIN_PASSWORD", "").strip()

    if not email or not password:
        print(
            "GARMIN_EMAIL and GARMIN_PASSWORD must be set in your .env file."
        )
        sys.exit(1)

    token_dir = get_token_dir()
    print(f"[Setup] Authenticating as {email}...")

    try:
        garmin = Garmin(email, password)
        garmin.garth.sess.headers.update({"User-Agent": FAKE_USER_AGENT})

        print("[Setup] Logging in...")
        garmin.login()

        os.makedirs(token_dir, exist_ok=True)
        garmin.garth.dump(token_dir)

        print(f"[Setup] Tokens saved to: {token_dir}")
        print("[Setup] You can now run 'npm start' to sync your scale.")

    except Exception as e:
        print(f"\n[Setup] Authentication failed: {e}")
        print(
            "\nIf Garmin is blocking your IP, try running this setup script "
            "from a different machine or network, then copy the token "
            f"directory ({token_dir}) to this machine."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
