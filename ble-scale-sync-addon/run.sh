#!/bin/sh
set -e

OPTIONS="/data/options.json"
# Config lives in /data (persistent) so last_known_weight survives add-on
# restarts. The app is launched with --config to read from this path.
CONFIG="/data/config.yaml"
FRESH="/tmp/config-fresh.yaml"
mkdir -p /data

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
  if ! cp "$CUSTOM_PATH" "$FRESH"; then
    log "ERROR: Failed to copy custom config from $CUSTOM_PATH"
    exit 1
  fi
  # In this mode the whole option-to-config generation below is skipped, so any
  # UI option set here does nothing. Say so for the two QN bytes specifically:
  # they are diagnostic knobs handed to reporters who are chasing a scale that
  # reads nothing, and someone who already moved to custom_config to set one by
  # hand is exactly the person who would toggle the UI option, see no change and
  # report a false negative. A wrong value for either is silent by nature, so a
  # setting that is silently ignored is worse here than almost anywhere else.
  for _qn in qn_protocol_byte qn_report_byte qn_weight_ack auto_clear_stale_bond; do
    if [ -n "$(opt "$_qn")" ]; then
      log "WARNING: custom_config is enabled, so the '$_qn' option is ignored."
      log "Set 'ble.$_qn' in $CUSTOM_PATH instead."
    fi
  done
else

  # ── Read all options ────────────────────────────────────────────────────

  SCALE_MAC=$(opt scale_mac)
  FORCE_SCALE_ADAPTER=$(opt force_scale_adapter)
  QN_PROTOCOL_BYTE=$(opt qn_protocol_byte)
  QN_REPORT_BYTE=$(opt qn_report_byte)
  # Free-text rather than a list, matching the sibling QN options, so normalise
  # it here: only an exact true/false reaches config.yaml. Anything else is
  # dropped with a warning rather than written through to fail Zod at startup,
  # and an empty value keeps the per-dialect default.
  QN_WEIGHT_ACK=$(opt qn_weight_ack)
  case "$(echo "$QN_WEIGHT_ACK" | tr '[:upper:]' '[:lower:]')" in
    "") QN_WEIGHT_ACK="" ;;
    true | yes | on | 1) QN_WEIGHT_ACK="true" ;;
    false | no | off | 0) QN_WEIGHT_ACK="false" ;;
    *)
      log "WARNING: ignoring qn_weight_ack='$QN_WEIGHT_ACK' (expected true or false)."
      QN_WEIGHT_ACK=""
      ;;
  esac
  AUTO_CLEAR_STALE_BOND=$(opt_bool auto_clear_stale_bond)
  PROXY_LIVENESS_MIN=$(opt_int proxy_liveness_timeout_min 30)

  WEIGHT_UNIT=$(opt weight_unit)
  HEIGHT_UNIT=$(opt height_unit)
  [ -z "$WEIGHT_UNIT" ] && WEIGHT_UNIT="kg"
  [ -z "$HEIGHT_UNIT" ] && HEIGHT_UNIT="cm"

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

  cat > "$FRESH" <<YAML
version: 1

YAML

  # Validate BLE_ADAPTER format before writing to config
  if [ -n "$BLE_ADAPTER" ]; then
    if ! printf '%s\n' "$BLE_ADAPTER" | grep -Eq '^hci[0-9]+$'; then
      log "WARNING: Invalid ble_adapter '$BLE_ADAPTER' (expected hci0, hci1, ...). Ignoring."
      BLE_ADAPTER=""
    fi
  fi

  # force_scale_adapter matches every device it is shown, so it is only safe with
  # a target MAC. Drop it rather than generate a config the app refuses to load.
  if [ -n "$FORCE_SCALE_ADAPTER" ] && [ -z "$SCALE_MAC" ]; then
    echo "[ble-scale-sync] WARNING: force_scale_adapter needs scale_mac; ignoring it"
    FORCE_SCALE_ADAPTER=""
  fi

  # The two QN bytes are text options so that "unset" stays distinguishable from
  # 0, which is a meaningful value for both. Anything that is not a plain 0 to
  # 255 integer is dropped with a warning rather than written into config.yaml,
  # where it would fail schema validation and stop the add-on from starting.
  #
  # The value is normalised to decimal before it is written. This file is later
  # round-tripped through PyYAML, which is YAML 1.1 and reads a leading zero as
  # octal: "010" would reach the adapter as 8 and "064" as 52. Both of these
  # settings fail silently when wrong (every command acknowledged, no weight
  # ever arriving), so a reporter told to try a value and typing a leading zero
  # would run a different experiment and report a false negative. Surrounding
  # whitespace is trimmed for the same reason: it comes free from a text field.
  for _qn in QN_PROTOCOL_BYTE QN_REPORT_BYTE; do
    eval "_qv=\$$_qn"
    _qv=$(printf '%s' "$_qv" | tr -d '[:space:]')
    [ -z "$_qv" ] && continue
    _raw="$_qv"
    case "$_qv" in
      *[!0-9]*) _ok=0 ;;
      *)
        # Strip leading zeros with sed, not with `$((10#$_qv))`: that form is a
        # bashism, this script runs under /bin/sh, and /bin/sh on the add-on
        # base image is dash, which rejects base#digits outright.
        _qv=$(printf '%s' "$_qv" | sed 's/^0*//')
        [ -z "$_qv" ] && _qv=0
        case "$_qv" in
          # Bound the length before the numeric test: an overlong digit string
          # makes `[ -le ]` emit a raw "integer expression expected" line ahead
          # of the friendly warning, and that raw line is what ends up pasted
          # into an issue.
          ????*) _ok=0 ;;
          *) [ "$_qv" -le 255 ] && _ok=1 || _ok=0 ;;
        esac
        ;;
    esac
    if [ "$_ok" != "1" ]; then
      log "WARNING: Invalid $(echo "$_qn" | tr '[:upper:]' '[:lower:]') '$_raw' (expected 0 to 255). Ignoring."
      eval "$_qn=''"
    else
      eval "$_qn=\$_qv"
    fi
  done

  # BLE section (only if scale_mac, adapter, a forced scale adapter or a QN byte is set)
  if [ -n "$SCALE_MAC" ] || [ -n "$BLE_ADAPTER" ] || [ -n "$FORCE_SCALE_ADAPTER" ]     || [ -n "$QN_PROTOCOL_BYTE" ] || [ -n "$QN_REPORT_BYTE" ] || [ -n "$QN_WEIGHT_ACK" ]     || [ "$AUTO_CLEAR_STALE_BOND" = "true" ] || [ "$PROXY_LIVENESS_MIN" != "30" ]; then
    echo "ble:" >> "$FRESH"
    [ -n "$SCALE_MAC" ] && echo "  scale_mac: \"$(yaml_escape "$SCALE_MAC")\"" >> "$FRESH"
    [ -n "$BLE_ADAPTER" ] && echo "  adapter: \"$(yaml_escape "$BLE_ADAPTER")\"" >> "$FRESH"
    [ -n "$FORCE_SCALE_ADAPTER" ] && echo "  force_scale_adapter: \"$(yaml_escape "$FORCE_SCALE_ADAPTER")\"" >> "$FRESH"
    [ -n "$QN_PROTOCOL_BYTE" ] && echo "  qn_protocol_byte: $QN_PROTOCOL_BYTE" >> "$FRESH"
    [ -n "$QN_REPORT_BYTE" ] && echo "  qn_report_byte: $QN_REPORT_BYTE" >> "$FRESH"
    [ -n "$QN_WEIGHT_ACK" ] && echo "  qn_weight_ack: $QN_WEIGHT_ACK" >> "$FRESH"
    [ "$AUTO_CLEAR_STALE_BOND" = "true" ] && echo "  auto_clear_stale_bond: true" >> "$FRESH"
    [ "$PROXY_LIVENESS_MIN" != "30" ] && echo "  proxy_liveness_timeout_min: $PROXY_LIVENESS_MIN" >> "$FRESH"
    echo "" >> "$FRESH"
  fi

  cat >> "$FRESH" <<YAML
scale:
  weight_unit: $WEIGHT_UNIT
  height_unit: $HEIGHT_UNIT

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
    echo "global_exporters:" >> "$FRESH"

    # MQTT exporter
    if [ "$MQTT_ENABLED" = "true" ] && [ -n "$MQTT_BROKER_URL" ]; then
      MQTT_TOPIC="${MQTT_TOPIC:-scale/body-composition}"
      cat >> "$FRESH" <<YAML
  - type: mqtt
    broker_url: "$(yaml_escape "$MQTT_BROKER_URL")"
    topic: "$(yaml_escape "$MQTT_TOPIC")"
    qos: 1
    retain: true
    ha_discovery: $MQTT_HA_DISCOVERY
    ha_device_name: "$(yaml_escape "$MQTT_HA_DEVICE_NAME")"
YAML
      [ -n "$MQTT_USERNAME" ] && echo "    username: \"$(yaml_escape "$MQTT_USERNAME")\"" >> "$FRESH"
      [ -n "$MQTT_PASSWORD" ] && echo "    password: \"$(yaml_escape "$MQTT_PASSWORD")\"" >> "$FRESH"
    fi

    # Garmin exporter
    if [ "$GARMIN_ENABLED" = "true" ] && [ -n "$GARMIN_EMAIL" ] && [ -n "$GARMIN_PASSWORD" ]; then
      mkdir -p /data/garmin-tokens
      cat >> "$FRESH" <<YAML
  - type: garmin
    email: "$(yaml_escape "$GARMIN_EMAIL")"
    password: "$(yaml_escape "$GARMIN_PASSWORD")"
    token_dir: /data/garmin-tokens
YAML
    fi

    echo "" >> "$FRESH"
  fi

  # ── Runtime ───────────────────────────────────────────────────────────

  cat >> "$FRESH" <<YAML
runtime:
  continuous_mode: true
  scan_cooldown: $SCAN_COOLDOWN
  dry_run: false
  debug: $DEBUG

update_check: true
YAML

  log "Config generated successfully"
fi

# ── Merge last_known_weight from previous run ────────────────────────────────
# merge_last_weights.py reads the freshly generated config and, if the
# persistent config.yaml already exists (from a previous run), copies each
# user's last_known_weight into the fresh config before overwriting.
# Result is written to $CONFIG so the app reads a merged view.

if ! python3 /app/merge_last_weights.py "$FRESH" "$CONFIG"; then
  log "WARNING: merge_last_weights.py failed, using fresh config without preserved weights"
  cp "$FRESH" "$CONFIG"
fi
rm -f "$FRESH"

# ── Garmin token bootstrap ──────────────────────────────────────────────────
# garmin_upload.py only loads tokens; it does not authenticate from email and
# password. On first start the token directory is empty, so we run
# setup_garmin.py to produce garmin_tokens.json from the credentials the user
# entered in the add-on UI. Skipped in custom config mode, where advanced
# users handle their own Garmin auth.
#
# garminconnect 0.3.x (2026-04) replaced the garth-based oauth1/oauth2 token
# files with a single garmin_tokens.json. Legacy oauth*_token.json files left
# over from pre-0.3 are stripped by setup_garmin.py before writing the new
# format.

if [ "$CUSTOM_CONFIG" != "true" ] && [ "$GARMIN_ENABLED" = "true" ] \
   && [ -n "$GARMIN_EMAIL" ] && [ -n "$GARMIN_PASSWORD" ]; then
  TOKEN_DIR="/data/garmin-tokens"
  SHARE_DIR="/share/ble-scale-sync/garmin-tokens"
  mkdir -p "$TOKEN_DIR"

  # If only legacy pre-0.3 tokens are present, treat the dir as empty so we
  # re-authenticate (or re-import from /share) and write the new format.
  if [ -f "$TOKEN_DIR/oauth1_token.json" ] \
     && [ ! -f "$TOKEN_DIR/garmin_tokens.json" ]; then
    log "Removing legacy garth tokens (incompatible with garminconnect 0.3.x)"
    rm -f "$TOKEN_DIR"/oauth*_token.json
  fi

  # Option 1: user pre-generated tokens on another machine (MFA workaround)
  if [ ! -f "$TOKEN_DIR/garmin_tokens.json" ] \
     && [ -f "$SHARE_DIR/garmin_tokens.json" ]; then
    log "Importing Garmin tokens from $SHARE_DIR"
    cp "$SHARE_DIR/garmin_tokens.json" "$TOKEN_DIR/" 2>/dev/null || true
  fi

  # Option 2: auto-authenticate if tokens still missing
  if [ ! -f "$TOKEN_DIR/garmin_tokens.json" ]; then
    log "Garmin tokens missing, authenticating with provided credentials..."
    if python3 /app/garmin-scripts/setup_garmin.py --from-config "$CONFIG"; then
      log "Garmin authentication successful, tokens saved to $TOKEN_DIR"
    else
      log "WARNING: Garmin authentication failed."
      log "If your account uses MFA or Garmin is blocking this IP, run"
      log "  python3 garmin-scripts/setup_garmin.py --from-config config.yaml"
      log "on another machine and copy garmin_tokens.json into"
      log "/share/ble-scale-sync/garmin-tokens/ on this HA host."
      log "Other exporters (MQTT, etc.) will continue to work."
    fi
  else
    log "Garmin tokens present at $TOKEN_DIR"
  fi
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
exec node dist/index.js --config "$CONFIG"
