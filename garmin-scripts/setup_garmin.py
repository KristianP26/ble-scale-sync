import argparse
import os
import re
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


def resolve_env_ref(value):
    """Resolve ${ENV_VAR} references in config values (matching TS behavior)."""
    if not isinstance(value, str):
        return value

    def replacer(match):
        var_name = match.group(1)
        env_val = os.environ.get(var_name)
        if env_val is None:
            print(
                f"[Setup] Warning: environment variable '{var_name}' is not set",
                file=sys.stderr,
            )
            return match.group(0)
        return env_val

    return re.sub(r"\$\{([^}]+)\}", replacer, value)


def authenticate(email, password, token_dir):
    """Authenticate with Garmin and save tokens (with 2FA/MFA support)."""
    print(f"[Setup] Authenticating as {email}...")

    try:
        garmin = Garmin(email, password, return_on_mfa=True)
        garmin.garth.sess.headers.update({"User-Agent": FAKE_USER_AGENT})

        print("[Setup] Logging in...")
        result = garmin.login()

        # Handle 2FA/MFA challenge
        if isinstance(result, tuple) and result[0] == "needs_mfa":
            print("[Setup] Two-factor authentication required.")
            mfa_code = input("[Setup] Enter the MFA code from your authenticator app: ").strip()
            garmin.resume_login(result[1], mfa_code)
            print("[Setup] MFA verification successful.")

        os.makedirs(token_dir, exist_ok=True)
        garmin.garth.dump(token_dir)

        print(f"[Setup] Tokens saved to: {token_dir}")
        return True

    except Exception as e:
        print(f"\n[Setup] Authentication failed: {e}")
        print(
            "\nIf Garmin is blocking your IP, try running this setup script "
            "from a different machine or network, then copy the token "
            f"directory ({token_dir}) to this machine."
        )
        return False


def load_config(config_path):
    """Load and parse config.yaml."""
    try:
        import yaml
    except ImportError:
        print(
            "Error: PyYAML is required for --from-config mode. "
            "Install with: pip install pyyaml",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        with open(config_path, "r") as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        print(f"Error: Config file not found: {config_path}", file=sys.stderr)
        sys.exit(1)
    except yaml.YAMLError as e:
        print(f"Error parsing config: {e}", file=sys.stderr)
        sys.exit(1)


def get_garmin_users(config):
    """Extract Garmin users from config. Returns list of (name, email, password, token_dir)."""
    users = config.get("users", [])
    global_exporters = config.get("global_exporters", [])
    results = []

    # Per-user garmin entries
    for user in users:
        for entry in user.get("exporters", []):
            if entry.get("type") == "garmin":
                results.append(
                    {
                        "name": user.get("name", "Unknown"),
                        "email": resolve_env_ref(entry.get("email", "")),
                        "password": resolve_env_ref(entry.get("password", "")),
                        "token_dir": entry.get("token_dir", ""),
                    }
                )

    # Global garmin entries apply to all users (only if no per-user entries found)
    if not results:
        for entry in global_exporters:
            if entry.get("type") == "garmin":
                for user in users:
                    results.append(
                        {
                            "name": user.get("name", "Unknown"),
                            "email": resolve_env_ref(entry.get("email", "")),
                            "password": resolve_env_ref(entry.get("password", "")),
                            "token_dir": entry.get("token_dir", ""),
                        }
                    )

    return results


def run_from_config(config_path, target_user=None, cli_token_dir=None):
    """Authenticate Garmin users from config.yaml."""
    config = load_config(config_path)
    garmin_users = get_garmin_users(config)

    if not garmin_users:
        print("[Setup] No Garmin exporters found in config.")
        sys.exit(1)

    if target_user:
        garmin_users = [u for u in garmin_users if u["name"] == target_user]
        if not garmin_users:
            print(
                f"[Setup] User '{target_user}' not found in config "
                "or has no Garmin exporter."
            )
            sys.exit(1)

    has_error = False
    for user in garmin_users:
        print(f"\n[Setup] ===========================================")
        print(f"[Setup] Setting up Garmin for user: {user['name']}")
        print(f"[Setup] ===========================================")

        email = (user.get("email") or "").strip()
        password = (user.get("password") or "").strip()

        if not email or not password:
            print(
                f"[Setup] Error: Missing email or password for user {user['name']}."
            )
            print("[Setup] Add credentials to config.yaml or set env vars.")
            has_error = True
            continue

        token_dir = get_token_dir(cli_token_dir or user.get("token_dir") or None)

        if not authenticate(email, password, token_dir):
            has_error = True

    if has_error:
        sys.exit(1)

    print("\n[Setup] All done! You can now run 'npm start' to sync your scale.")


def run_legacy(cli_token_dir=None):
    """Original env-var-based authentication (backward compatible)."""
    email = os.environ.get("GARMIN_EMAIL", "").strip()
    password = os.environ.get("GARMIN_PASSWORD", "").strip()

    if not email or not password:
        print(
            "GARMIN_EMAIL and GARMIN_PASSWORD must be set in your .env file."
        )
        sys.exit(1)

    token_dir = get_token_dir(cli_token_dir)

    if not authenticate(email, password, token_dir):
        sys.exit(1)

    print("[Setup] You can now run 'npm start' to sync your scale.")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Setup Garmin Connect authentication"
    )
    parser.add_argument(
        "--from-config",
        action="store_true",
        help="Read users and credentials from config.yaml",
    )
    parser.add_argument(
        "--config-path",
        default="config.yaml",
        help="Path to config.yaml (default: config.yaml)",
    )
    parser.add_argument(
        "--user",
        help="Setup only this user (requires --from-config)",
    )
    parser.add_argument(
        "--token-dir",
        help="Override token directory (or set TOKEN_DIR env var)",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    if args.from_config:
        run_from_config(args.config_path, args.user, args.token_dir)
    else:
        run_legacy(args.token_dir)


if __name__ == "__main__":
    main()
