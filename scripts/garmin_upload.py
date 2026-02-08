"""
Garmin Connect uploader.

Reads a JSON payload from stdin and uploads body composition data
to Garmin Connect using stored authentication tokens.

Usage (called automatically by Node.js):
    echo '{"weight": 80.5, ...}' | python scripts/garmin_upload.py
"""

import json
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
    """Resolve token storage directory from env or default."""
    custom = os.environ.get("TOKEN_DIR", "").strip()
    if custom:
        return str(Path(custom).expanduser())
    return str(Path.home() / ".garmin_renpho_tokens")


def get_garmin_client():
    token_dir = get_token_dir()
    print(f"[Garmin] Loading tokens from {token_dir}")

    if not os.path.isdir(token_dir):
        print(
            f"[Garmin] Token directory not found: {token_dir}\n"
            "Run 'npm run setup-garmin' first to authenticate."
        )
        return None

    try:
        garmin = Garmin()
        garmin.garth.sess.headers.update({"User-Agent": FAKE_USER_AGENT})
        garmin.login(tokenstore=token_dir)
        print("[Garmin] Authenticated.")
        return garmin
    except Exception as e:
        print(f"[Garmin] Token auth failed: {e}")
        print("Try re-running 'npm run setup-garmin' to refresh tokens.")
        return None


def upload(payload):
    garmin = get_garmin_client()
    if not garmin:
        return False

    print("[Garmin] Uploading body composition...")
    try:
        garmin.add_body_composition(
            timestamp=None,
            weight=payload["weight"],
            percent_fat=payload["bodyFatPercent"],
            percent_hydration=payload["waterPercent"],
            bone_mass=payload["boneMass"],
            muscle_mass=payload["muscleMass"],
            visceral_fat_rating=payload["visceralFat"],
            physique_rating=payload["physiqueRating"],
            metabolic_age=payload["metabolicAge"],
            bmi=payload["bmi"],
        )
        print("[Garmin] Upload successful!")
        print(f"  Weight:          {payload['weight']} kg")
        print(f"  Body Fat:        {payload['bodyFatPercent']}%")
        print(f"  Muscle Mass:     {payload['muscleMass']} kg")
        print(f"  Visceral Fat:    {payload['visceralFat']}")
        print(f"  Physique Rating: {payload['physiqueRating']}")
        return True
    except Exception as e:
        print(f"[Garmin] API error: {e}")
        return False


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        print(f"[Garmin] Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(1)

    success = upload(payload)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
