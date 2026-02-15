#!/bin/sh
set -e

CMD="${1:-start}"

# Source Garmin setup helper functions
if [ -f "garmin-scripts/setup-garmin.sh" ]; then
    . garmin-scripts/setup-garmin.sh
fi

case "$CMD" in
  start)
    exec npx tsx src/index.ts
    ;;
  setup)
    exec npx tsx src/wizard/index.ts
    ;;
  scan)
    exec npx tsx src/scan.ts
    ;;
  validate)
    exec npx tsx src/config/validate-cli.ts
    ;;
  setup-garmin)
    # Parse additional arguments for setup-garmin
    shift  # Remove 'setup-garmin' from args

    if [ $# -eq 0 ]; then
        # No additional args - use legacy behavior with env vars
        exec python3 garmin-scripts/setup_garmin.py
    elif [ "$1" = "--all-users" ]; then
        setup_garmin_all
    elif [ "$1" = "--user" ] && [ -n "$2" ]; then
        setup_garmin_for_user "$2"
    else
        # Pass through any other arguments to the Python script
        exec python3 garmin-scripts/setup_garmin.py "$@"
    fi
    ;;
  help|--help|-h)
    echo "BLE Scale Sync — Docker Commands"
    echo ""
    echo "Usage: docker run [options] ghcr.io/kristianp26/ble-scale-sync [command]"
    echo ""
    echo "Commands:"
    echo "  start                    Run the main sync flow (default)"
    echo "  setup                    Interactive setup wizard"
    echo "  scan                     Discover nearby BLE devices"
    echo "  validate                 Validate config.yaml"
    echo "  setup-garmin             Setup Garmin authentication"
    echo "    setup-garmin --user <username>    Setup for specific user"
    echo "    setup-garmin --all-users          Setup for all users"
    echo "    setup-garmin --email <email> --password <pass> [opts]"
    echo "  help                     Show this help message"
    echo ""
    echo "Any other command is executed directly (e.g. 'sh' for a debug shell)."
    ;;
  *)
    exec "$@"
    ;;
esac
