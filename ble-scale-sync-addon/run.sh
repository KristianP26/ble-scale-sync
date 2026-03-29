#!/bin/sh
set -e

OPTIONS="/data/options.json"
CONFIG="/app/config.yaml"

log() { echo "[ble-scale-sync] $*"; }

# ── Read options ────────────────────────────────────────────────────────────

opt() { jq -r ".$1 // empty" "$OPTIONS"; }
opt_bool() { jq -r ".$1 // false" "$OPTIONS"; }
opt_int() { jq -r ".$1 // $2" "$OPTIONS"; }

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
  cp "$CUSTOM_PATH" "$CONFIG"
else

  # ── Read all options ────────────────────────────────────────────────────

  SCALE_MAC=$(opt scale_mac)
  BLE_ADAPTER=$(opt ble_adapter)

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

  # ── Generate config.yaml ──────────────────────────────────────────────

  log "Generating config.yaml..."

  cat > "$CONFIG" <<YAML
version: 1

YAML

  # BLE section (only if scale_mac or adapter is set)
  if [ -n "$SCALE_MAC" ] || [ -n "$BLE_ADAPTER" ]; then
    echo "ble:" >> "$CONFIG"
    [ -n "$SCALE_MAC" ] && echo "  scale_mac: \"$SCALE_MAC\"" >> "$CONFIG"
    [ -n "$BLE_ADAPTER" ] && echo "  adapter: $BLE_ADAPTER" >> "$CONFIG"
    echo "" >> "$CONFIG"
  fi

  cat >> "$CONFIG" <<YAML
scale:
  weight_unit: kg
  height_unit: cm

unknown_user: nearest

users:
  - name: "$USER_NAME"
    slug: $USER_SLUG
    height: $USER_HEIGHT
    birth_date: "$USER_BIRTH_DATE"
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

  if [ "$HAVE_EXPORTERS" = "true" ]; then
    echo "global_exporters:" >> "$CONFIG"

    # MQTT exporter
    if [ "$MQTT_ENABLED" = "true" ] && [ -n "$MQTT_BROKER_URL" ]; then
      cat >> "$CONFIG" <<YAML
  - type: mqtt
    broker_url: "$MQTT_BROKER_URL"
    topic: "$MQTT_TOPIC"
    qos: 1
    retain: true
    ha_discovery: $MQTT_HA_DISCOVERY
    ha_device_name: "$MQTT_HA_DEVICE_NAME"
YAML
      [ -n "$MQTT_USERNAME" ] && echo "    username: \"$MQTT_USERNAME\"" >> "$CONFIG"
      [ -n "$MQTT_PASSWORD" ] && echo "    password: \"$MQTT_PASSWORD\"" >> "$CONFIG"
    fi

    # Garmin exporter
    if [ "$GARMIN_ENABLED" = "true" ] && [ -n "$GARMIN_EMAIL" ] && [ -n "$GARMIN_PASSWORD" ]; then
      cat >> "$CONFIG" <<YAML
  - type: garmin
    email: "$GARMIN_EMAIL"
    password: "$GARMIN_PASSWORD"
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

if command -v btmgmt >/dev/null 2>&1; then
  ADAPTER_INDEX=0
  if [ -n "$BLE_ADAPTER" ]; then
    ADAPTER_INDEX=$(echo "$BLE_ADAPTER" | sed 's/hci//')
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
