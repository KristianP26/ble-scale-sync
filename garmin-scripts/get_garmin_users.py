#!/usr/bin/env python3
"""
Extract Garmin user configurations from config.yaml for Docker setup.
Outputs format: USERNAME|EMAIL|PASSWORD|TOKEN_DIR (one per line)
"""
import os
import re
import sys

try:
    import yaml
except ImportError:
    print("Error: PyYAML is required. Install with: pip install pyyaml", file=sys.stderr)
    sys.exit(1)


def resolve_env_ref(value):
    """Resolve ${ENV_VAR} or $ENV_VAR references in config values."""
    if not isinstance(value, str):
        return value

    def replacer(match):
        var_name = match.group(1) or match.group(2)
        env_val = os.environ.get(var_name, '')
        return env_val

    # Handle both ${VAR} and $VAR syntax
    result = re.sub(r'\$\{([^}]+)\}|\$(\w+)', replacer, value)
    return result


def get_garmin_entries(entries):
    """Extract Garmin exporter entries from a list of exporters."""
    result = []
    for entry in entries:
        if entry.get('type') == 'garmin':
            email = resolve_env_ref(entry.get('email', ''))
            password = resolve_env_ref(entry.get('password', ''))
            token_dir = entry.get('token_dir', '')
            # Expand ~ to home
            if token_dir.startswith('~'):
                home = os.environ.get('HOME', '/home/node')
                token_dir = home + token_dir[1:]
            result.append({
                'email': email,
                'password': password,
                'token_dir': token_dir
            })
    return result


def main():
    config_path = '/app/config.yaml'

    try:
        with open(config_path, 'r') as f:
            config = yaml.safe_load(f)
    except FileNotFoundError:
        print(f"Error: Config file not found: {config_path}", file=sys.stderr)
        sys.exit(1)
    except yaml.YAMLError as e:
        print(f"Error parsing config: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error reading config: {e}", file=sys.stderr)
        sys.exit(1)

    users = config.get('users', [])
    global_exporters = config.get('global_exporters', [])

    garmin_users = []

    # Check per-user exporters first
    for user in users:
        user_exporters = user.get('exporters', [])
        user_garmin = get_garmin_entries(user_exporters)
        if user_garmin:
            garmin_users.append({
                'name': user.get('name', 'Unknown'),
                'entries': user_garmin
            })

    # If no per-user Garmin entries, use global exporters for all users
    if not garmin_users:
        global_garmin = get_garmin_entries(global_exporters)
        if global_garmin:
            for user in users:
                garmin_users.append({
                    'name': user.get('name', 'Unknown'),
                    'entries': global_garmin
                })

    # Output as simple format: USERNAME|EMAIL|PASSWORD|TOKEN_DIR
    for user in garmin_users:
        for entry in user['entries']:
            print(f"{user['name']}|{entry['email']}|{entry['password']}|{entry['token_dir']}")


if __name__ == '__main__':
    main()
