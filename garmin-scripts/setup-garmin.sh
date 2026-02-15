#!/bin/sh
# Garmin setup helper functions for Docker entrypoint
# This script is sourced by docker-entrypoint.sh

# Function to extract Garmin users from config.yaml
get_garmin_users() {
    python3 garmin-scripts/get_garmin_users.py
}

# Function to setup Garmin for a specific user
setup_garmin_user() {
    local user_name="$1"
    local email="$2"
    local password="$3"
    local token_dir="$4"

    echo "[Setup] Configuring Garmin for user: $user_name"
    python3 garmin-scripts/setup_garmin.py \
        --email "$email" \
        --password "$password" \
        --token-dir "$token_dir"
}

# Function to setup Garmin for all users
setup_garmin_all() {
    local has_error=0

    get_garmin_users | while IFS='|' read -r user_name email password token_dir; do
        echo ""
        echo "[Setup] ==========================================="
        echo "[Setup] Setting up Garmin for user: $user_name"
        echo "[Setup] ==========================================="

        if [ -z "$email" ] || [ -z "$password" ]; then
            echo "[Setup] Warning: Missing email or password for user $user_name"
            has_error=1
            continue
        fi

        # Use default token_dir if not specified
        if [ -z "$token_dir" ]; then
            token_dir="/home/node/.garmin_tokens"
        fi

        if ! setup_garmin_user "$user_name" "$email" "$password" "$token_dir"; then
            echo "[Setup] Failed to setup Garmin for user: $user_name"
            has_error=1
        fi
    done

    return $has_error
}

# Function to setup Garmin for a specific user by name
setup_garmin_for_user() {
    local target_user="$1"
    local found=0

    get_garmin_users | while IFS='|' read -r user_name email password token_dir; do
        if [ "$user_name" = "$target_user" ]; then
            found=1
            echo "[Setup] Setting up Garmin for user: $user_name"

            if [ -z "$email" ] || [ -z "$password" ]; then
                echo "[Setup] Error: Missing email or password for user $user_name"
                exit 1
            fi

            # Use default token_dir if not specified
            if [ -z "$token_dir" ]; then
                token_dir="/home/node/.garmin_tokens"
            fi

            setup_garmin_user "$user_name" "$email" "$password" "$token_dir"
            return $?
        fi
    done

    if [ "$found" -eq 0 ]; then
        echo "[Setup] Error: User '$target_user' not found in config or has no Garmin exporter"
        exit 1
    fi
}
