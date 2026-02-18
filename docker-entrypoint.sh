#!/bin/sh
set -e

CMD="${1:-start}"

case "$CMD" in
  start)
    exec node dist/index.js
    ;;
  setup)
    exec node dist/wizard/index.js
    ;;
  scan)
    exec node dist/scan.js
    ;;
  validate)
    exec node dist/config/validate-cli.js
    ;;
  setup-garmin)
    shift
    if [ $# -eq 0 ]; then
      exec python3 garmin-scripts/setup_garmin.py
    elif [ "$1" = "--all-users" ]; then
      exec python3 garmin-scripts/setup_garmin.py --from-config
    elif [ "$1" = "--user" ] && [ -n "$2" ]; then
      exec python3 garmin-scripts/setup_garmin.py --from-config --user "$2"
    else
      exec python3 garmin-scripts/setup_garmin.py "$@"
    fi
    ;;
  help|--help|-h)
    echo "BLE Scale Sync — Docker Commands"
    echo ""
    echo "Usage: docker run [options] ghcr.io/kristianp26/ble-scale-sync [command]"
    echo ""
    echo "Commands:"
    echo "  start                         Run the main sync flow (default)"
    echo "  setup                         Interactive setup wizard"
    echo "  scan                          Discover nearby BLE devices"
    echo "  validate                      Validate config.yaml"
    echo "  setup-garmin                  Garmin auth (env vars: GARMIN_EMAIL, GARMIN_PASSWORD)"
    echo "  setup-garmin --user <name>    Garmin auth for a specific user from config.yaml"
    echo "  setup-garmin --all-users      Garmin auth for all users from config.yaml"
    echo "  help                          Show this help message"
    echo ""
    echo "Any other command is executed directly (e.g. 'sh' for a debug shell)."
    ;;
  *)
    exec "$@"
    ;;
esac
