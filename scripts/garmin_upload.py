import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from garminconnect import Garmin

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

FAKE_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/121.0.0.0 Safari/537.36"
)


def log(msg):
    print(msg, file=sys.stderr)


def get_token_dir():
    custom = os.environ.get("TOKEN_DIR", "").strip()
    if custom:
        return str(Path(custom).expanduser())
    new = Path.home() / ".garmin_tokens"
    old = Path.home() / ".garmin_renpho_tokens"
    if old.is_dir() and not new.is_dir():
        return str(old)
    return str(new)


def get_garmin_client():
    token_dir = get_token_dir()
    log(f"[Garmin] Loading tokens from {token_dir}")

    if not os.path.isdir(token_dir):
        raise RuntimeError(
            f"Token directory not found: {token_dir}. "
            "Run 'npm run setup-garmin' first."
        )

    garmin = Garmin()
    garmin.garth.sess.headers.update({"User-Agent": FAKE_USER_AGENT})
    garmin.login(tokenstore=token_dir)
    log("[Garmin] Authenticated.")
    return garmin


def upload(payload):
    garmin = get_garmin_client()

    log("[Garmin] Uploading body composition...")
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

    log("[Garmin] Upload successful!")
    return {
        "weight": payload["weight"],
        "bodyFatPercent": payload["bodyFatPercent"],
        "muscleMass": payload["muscleMass"],
        "visceralFat": payload["visceralFat"],
        "physiqueRating": payload["physiqueRating"],
    }


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        log(f"[Garmin] Invalid JSON input: {e}")
        print(json.dumps({"success": False, "error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    try:
        data = upload(payload)
        print(json.dumps({"success": True, "data": data}))
        sys.exit(0)
    except Exception as e:
        log(f"[Garmin] Error: {e}")
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
