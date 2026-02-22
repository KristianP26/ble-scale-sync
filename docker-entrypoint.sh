#!/bin/sh
set -e

CMD="${1:-start}"

reset_bt_adapter() {
  if command -v btmgmt >/dev/null 2>&1; then
    echo "Resetting Bluetooth adapter..."
    if btmgmt --index 0 power off 2>/dev/null && btmgmt --index 0 power on 2>/dev/null; then
      echo "Bluetooth adapter reset OK"
    else
      echo "Bluetooth adapter reset failed (will retry in-app)"
    fi
    sleep 2
  fi
}

case "$CMD" in
  start)
    reset_bt_adapter
    exec npx tsx src/index.ts
    ;;
  setup)
    exec npx tsx src/wizard/index.ts
    ;;
  scan)
    reset_bt_adapter
    exec npx tsx src/scan.ts
    ;;
  validate)
    exec npx tsx src/config/validate-cli.ts
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
