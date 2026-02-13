#!/bin/sh
set -e

CMD="${1:-start}"

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
  help|--help|-h)
    echo "BLE Scale Sync — Docker Commands"
    echo ""
    echo "Usage: docker run [options] ghcr.io/kristianp26/ble-scale-sync [command]"
    echo ""
    echo "Commands:"
    echo "  start      Run the main sync flow (default)"
    echo "  setup      Interactive setup wizard"
    echo "  scan       Discover nearby BLE devices"
    echo "  validate   Validate config.yaml"
    echo "  help       Show this help message"
    echo ""
    echo "Any other command is executed directly (e.g. 'sh' for a debug shell)."
    ;;
  *)
    exec "$@"
    ;;
esac
