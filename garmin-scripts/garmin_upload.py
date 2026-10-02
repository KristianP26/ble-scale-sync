import argparse
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from garminconnect import Garmin

from garmin_errors import format_error_chain

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def log(msg):
    print(msg, file=sys.stderr)


def get_token_dir(token_dir=None):
    if token_dir:
        return str(Path(token_dir).expanduser())
    custom = os.environ.get("TOKEN_DIR", "").strip()
    if custom:
        return str(Path(custom).expanduser())
    new = Path.home() / ".garmin_tokens"
    old = Path.home() / ".garmin_renpho_tokens"
    if old.is_dir() and not new.is_dir():
        return str(old)
    return str(new)


def has_legacy_only_tokens(token_dir):
    """True when directory contains pre-0.3 garth tokens but no new-format token.

    Pre-0.3 garminconnect persisted oauth1_token.json + oauth2_token.json via garth.
    garminconnect 0.3.x uses a different format (single garmin_tokens.json).
    """
    path = Path(token_dir)
    if not path.is_dir():
        return False
    legacy = list(path.glob("oauth*_token.json"))
    new_token = path / "garmin_tokens.json"
    return bool(legacy) and not new_token.exists()


def get_garmin_client(token_dir=None):
    token_dir = get_token_dir(token_dir)
    log(f"[Garmin] Loading tokens from {token_dir}")

    if not os.path.isdir(token_dir):
        raise RuntimeError(
            f"Token directory not found: {token_dir}. "
            "Run 'ble-scale-sync setup-garmin' "
            "(or 'npm run setup-garmin' from a checkout) first."
        )

    if has_legacy_only_tokens(token_dir):
        raise RuntimeError(
            "Token format changed in garminconnect 0.3.x. "
            "Run 'ble-scale-sync setup-garmin' "
            "(or 'npm run setup-garmin' from a checkout) to re-authenticate."
        )

    # Without a token file, garminconnect falls through to a credential login
    # with none set and fails with "Username and password are required", which
    # sends people checking credentials that were never the problem (#435).
    if not (Path(token_dir) / "garmin_tokens.json").is_file():
        raise RuntimeError(
            f"No Garmin token in {token_dir} (garmin_tokens.json is missing), "
            "so Garmin authentication has not succeeded yet. "
            "Run 'ble-scale-sync setup-garmin' "
            "(or 'npm run setup-garmin' from a checkout); in the Home Assistant "
            "add-on, check the Garmin lines in the add-on's startup log."
        )

    garmin = Garmin()
    garmin.login(token_dir)
    log("[Garmin] Authenticated.")
    return garmin


def upload(payload, token_dir=None):
    garmin = get_garmin_client(token_dir)

    # ISO 8601 string when present; the orchestrator sets it for historical
    # readings replayed from a scale's offline cache (#164). When absent the
    # garminconnect library defaults to the current time.
    ts = payload.get("timestamp")
    if ts:
        log(f"[Garmin] Back-dating measurement to {ts}")

    # When the exporter is configured weight_only, every derived metric is sent
    # as None. garminconnect encodes None as the FIT basetype's "invalid"
    # marker, which is how the format says "no value here" - Garmin records the
    # weight and leaves the rest blank rather than storing a zero.
    weight_only = bool(payload.get("weight_only"))

    def derived(key):
        return None if weight_only else payload.get(key)

    if weight_only:
        log("[Garmin] Uploading weight only (derived metrics suppressed)...")
    else:
        log("[Garmin] Uploading body composition...")

    garmin.add_body_composition(
        timestamp=ts,
        weight=payload["weight"],
        percent_fat=derived("bodyFatPercent"),
        percent_hydration=derived("waterPercent"),
        bone_mass=derived("boneMass"),
        muscle_mass=derived("muscleMass"),
        visceral_fat_rating=derived("visceralFat"),
        physique_rating=derived("physiqueRating"),
        metabolic_age=derived("metabolicAge"),
        bmi=derived("bmi"),
        basal_met=derived("bmr"),
    )

    log("[Garmin] Upload successful!")
    # Echoes what was actually uploaded, so a weight_only run does not report
    # metrics Garmin never received.
    return {
        "weight": payload["weight"],
        "bodyFatPercent": derived("bodyFatPercent"),
        "muscleMass": derived("muscleMass"),
        "visceralFat": derived("visceralFat"),
        "physiqueRating": derived("physiqueRating"),
    }


def parse_args():
    parser = argparse.ArgumentParser(
        description="Upload body composition to Garmin Connect"
    )
    parser.add_argument(
        "--token-dir",
        help="Directory containing auth tokens (or set TOKEN_DIR env var, default: ~/.garmin_tokens)",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        log(f"[Garmin] Invalid JSON input: {e}")
        print(json.dumps({"success": False, "error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    try:
        data = upload(payload, args.token_dir)
        print(json.dumps({"success": True, "data": data}))
        sys.exit(0)
    except Exception as e:
        # The chained cause carries the status code that explains the failure.
        # garminconnect reports a rejected token as "Failed to retrieve social
        # profile" with the 401 only on __cause__, so str(e) alone leaves the
        # orchestrator logging the same opaque line on every retry.
        detail = format_error_chain(e)
        log(f"[Garmin] Error: {detail}")
        print(json.dumps({"success": False, "error": detail}))
        sys.exit(1)


if __name__ == "__main__":
    main()
