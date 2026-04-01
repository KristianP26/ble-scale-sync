#!/bin/sh
set -e

OPTIONS="/data/options.json"
CONFIG="/app/config.yaml"

log() { echo "[ble-scale-sync] $*"; }

# ── Read options ────────────────────────────────────────────────────────────

opt() { jq -r ".$1 // empty" "$OPTIONS"; }
opt_bool() { jq -r ".$1 // false" "$OPTIONS"; }
opt_int() { jq -r ".$1 // $2" "$OPTIONS"; }

# Escape a string for safe YAML double-quoted output (backslash, quotes, CR, LF)
yaml_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\r/\\r/g' | tr '\n' ' '; }

# Read BLE_ADAPTER early (needed for adapter reset in both modes)
# Normalize: trim whitespace, lowercase (app schema requires /^hci\d+$/)
BLE_ADAPTER=$(opt ble_adapter | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
RESET_BLUETOOTH=$(opt_bool reset_bluetooth)
CUSTOM_CONFIG=$(opt_bool custom_config)

# ── Custom config mode ──────────────────────────────────────────────────────

if [ "$CUSTOM_CONFIG" = "true" ]; then
  CUSTOM_PATH="/share/ble-scale-sync/config.yaml"
  if [ ! -f "$CUSTOM_PATH" ]; then
    log "ERROR: custom_config is enabled but $CUSTOM_PATH does not exist"
    log "Create the file or disable custom_config in the add-on settings"
    exit 1
  fi
  log "Using custom config from $CUSTOM_PATH"
  if ! cp "$CUSTOM_PATH" "$CONFIG"; then
    log "ERROR: Failed to copy custom config from $CUSTOM_PATH"
    exit 1
  fi
else

  # ── Read all options ────────────────────────────────────────────────────

  SCALE_MAC=$(opt scale_mac)

  USER_NAME=$(opt user_name)
  USER_HEIGHT=$(opt_int user_height 170)
  USER_BIRTH_DATE=$(opt user_birth_date)
  USER_GENDER=$(opt user_gender)
  USER_IS_ATHLETE=$(opt_bool user_is_athlete)
  USER_WEIGHT_MIN=$(opt_int user_weight_min 40)
  USER_WEIGHT_MAX=$(opt_int user_weight_max 150)

  MQTT_ENABLED=$(opt_bool mqtt_enabled)
  MQTT_AUTO=$(opt_bool mqtt_auto)
  MQTT_BROKER_URL=$(opt mqtt_broker_url)
  MQTT_USERNAME=$(opt mqtt_username)
  MQTT_PASSWORD=$(opt mqtt_password)
  MQTT_TOPIC=$(opt mqtt_topic)
  MQTT_HA_DISCOVERY=$(opt_bool mqtt_ha_discovery)
  MQTT_HA_DEVICE_NAME=$(opt mqtt_ha_device_name)

  GARMIN_ENABLED=$(opt_bool garmin_enabled)
  GARMIN_EMAIL=$(opt garmin_email)
  GARMIN_PASSWORD=$(opt garmin_password)

  SCAN_COOLDOWN=$(opt_int scan_cooldown 30)
  DEBUG=$(opt_bool debug)

  # ── MQTT auto-detection from HA Mosquitto add-on ──────────────────────

  if [ "$MQTT_ENABLED" = "true" ] && [ "$MQTT_AUTO" = "true" ]; then
    if [ -n "$SUPERVISOR_TOKEN" ]; then
      MQTT_INFO=$(curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
        http://supervisor/services/mqtt 2>/dev/null || echo '{}')
      MQTT_HOST=$(echo "$MQTT_INFO" | jq -r '.data.host // empty')
      MQTT_PORT=$(echo "$MQTT_INFO" | jq -r '.data.port // empty')
      AUTO_USER=$(echo "$MQTT_INFO" | jq -r '.data.username // empty')
      AUTO_PASS=$(echo "$MQTT_INFO" | jq -r '.data.password // empty')

      if [ -n "$MQTT_HOST" ]; then
        MQTT_BROKER_URL="mqtt://${MQTT_HOST}:${MQTT_PORT:-1883}"
        MQTT_USERNAME="${AUTO_USER}"
        MQTT_PASSWORD="${AUTO_PASS}"
        log "MQTT auto-detected: $MQTT_BROKER_URL"
      else
        log "MQTT auto-detection failed, using manual settings"
      fi
    else
      log "No SUPERVISOR_TOKEN, MQTT auto-detection unavailable"
    fi
  fi

  # ── Generate slug from user name ──────────────────────────────────────

  USER_SLUG=$(echo "$USER_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  [ -z "$USER_SLUG" ] && USER_SLUG="default"

  # ── Validate inputs ──────────────────────────────────────────────────

  if [ -z "$USER_BIRTH_DATE" ] || ! printf '%s\n' "$USER_BIRTH_DATE" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
    log "WARNING: Invalid birth date '$USER_BIRTH_DATE' (expected YYYY-MM-DD). Using 2000-01-01."
    USER_BIRTH_DATE="2000-01-01"
  fi

  # ── Generate config.yaml ──────────────────────────────────────────────

  log "Generating config.yaml..."

  cat > "$CONFIG" <<YAML
version: 1

YAML

  # Validate BLE_ADAPTER format before writing to config
  if [ -n "$BLE_ADAPTER" ]; then
    if ! printf '%s\n' "$BLE_ADAPTER" | grep -Eq '^hci[0-9]+$'; then
      log "WARNING: Invalid ble_adapter '$BLE_ADAPTER' (expected hci0, hci1, ...). Ignoring."
      BLE_ADAPTER=""
    fi
  fi

  # BLE section (only if scale_mac or adapter is set)
  if [ -n "$SCALE_MAC" ] || [ -n "$BLE_ADAPTER" ]; then
    echo "ble:" >> "$CONFIG"
    [ -n "$SCALE_MAC" ] && echo "  scale_mac: \"$(yaml_escape "$SCALE_MAC")\"" >> "$CONFIG"
    [ -n "$BLE_ADAPTER" ] && echo "  adapter: \"$(yaml_escape "$BLE_ADAPTER")\"" >> "$CONFIG"
    echo "" >> "$CONFIG"
  fi

  cat >> "$CONFIG" <<YAML
scale:
  weight_unit: kg
  height_unit: cm

unknown_user: nearest

users:
  - name: "$(yaml_escape "$USER_NAME")"
    slug: $USER_SLUG
    height: $USER_HEIGHT
    birth_date: "$(yaml_escape "$USER_BIRTH_DATE")"
    gender: $USER_GENDER
    is_athlete: $USER_IS_ATHLETE
    weight_range: { min: $USER_WEIGHT_MIN, max: $USER_WEIGHT_MAX }
    last_known_weight: null

YAML

  # ── Exporters ─────────────────────────────────────────────────────────

  HAVE_EXPORTERS=false

  if [ "$MQTT_ENABLED" = "true" ] && [ -n "$MQTT_BROKER_URL" ]; then
    HAVE_EXPORTERS=true
  fi

  if [ "$GARMIN_ENABLED" = "true" ] && [ -n "$GARMIN_EMAIL" ] && [ -n "$GARMIN_PASSWORD" ]; then
    HAVE_EXPORTERS=true
  fi

  if [ "$MQTT_ENABLED" = "true" ] && [ -z "$MQTT_BROKER_URL" ]; then
    log "WARNING: MQTT is enabled but no broker URL is available"
    log "Install the Mosquitto add-on or provide a broker URL manually"
  fi

  if [ "$HAVE_EXPORTERS" = "true" ]; then
    echo "global_exporters:" >> "$CONFIG"

    # MQTT exporter
    if [ "$MQTT_ENABLED" = "true" ] && [ -n "$MQTT_BROKER_URL" ]; then
      MQTT_TOPIC="${MQTT_TOPIC:-scale/body-composition}"
      cat >> "$CONFIG" <<YAML
  - type: mqtt
    broker_url: "$(yaml_escape "$MQTT_BROKER_URL")"
    topic: "$(yaml_escape "$MQTT_TOPIC")"
    qos: 1
    retain: true
    ha_discovery: $MQTT_HA_DISCOVERY
    ha_device_name: "$(yaml_escape "$MQTT_HA_DEVICE_NAME")"
YAML
      [ -n "$MQTT_USERNAME" ] && echo "    username: \"$(yaml_escape "$MQTT_USERNAME")\"" >> "$CONFIG"
      [ -n "$MQTT_PASSWORD" ] && echo "    password: \"$(yaml_escape "$MQTT_PASSWORD")\"" >> "$CONFIG"
    fi

    # Garmin exporter
    if [ "$GARMIN_ENABLED" = "true" ] && [ -n "$GARMIN_EMAIL" ] && [ -n "$GARMIN_PASSWORD" ]; then
      mkdir -p /data/garmin-tokens
      cat >> "$CONFIG" <<YAML
  - type: garmin
    email: "$(yaml_escape "$GARMIN_EMAIL")"
    password: "$(yaml_escape "$GARMIN_PASSWORD")"
    token_dir: /data/garmin-tokens
YAML
    fi

    echo "" >> "$CONFIG"
  fi

  # ── Runtime ───────────────────────────────────────────────────────────

  cat >> "$CONFIG" <<YAML
runtime:
  continuous_mode: true
  scan_cooldown: $SCAN_COOLDOWN
  dry_run: false
  debug: $DEBUG

update_check: true
YAML

  log "Config generated successfully"
fi

# ── Reset Bluetooth adapter ────────────────────────────────────────────────

if [ "$RESET_BLUETOOTH" != "true" ]; then
  log "Bluetooth adapter reset disabled (reset_bluetooth: false)"
elif ! command -v btmgmt >/dev/null 2>&1; then
  log "btmgmt not found; skipping Bluetooth adapter reset"
elif [ "$CUSTOM_CONFIG" = "true" ] && [ -z "$BLE_ADAPTER" ]; then
  log "Custom config mode without explicit ble_adapter; skipping Bluetooth adapter reset"
else
  ADAPTER_INDEX=0
  if [ -n "$BLE_ADAPTER" ]; then
    if printf '%s\n' "$BLE_ADAPTER" | grep -Eq '^hci[0-9]+$'; then
      ADAPTER_INDEX=${BLE_ADAPTER#hci}
    else
      log "WARNING: Invalid BLE adapter '$BLE_ADAPTER', falling back to hci0 for reset"
    fi
  fi
  log "Resetting Bluetooth adapter (hci$ADAPTER_INDEX)..."
  if btmgmt --index "$ADAPTER_INDEX" power off 2>/dev/null && \
     btmgmt --index "$ADAPTER_INDEX" power on 2>/dev/null; then
    log "Bluetooth adapter reset OK"
  else
    log "Bluetooth adapter reset failed (will retry in-app)"
  fi
  sleep 2
fi

# ── Start ───────────────────────────────────────────────────────────────────

log "Starting BLE Scale Sync..."
exec node dist/index.js
