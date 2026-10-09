#!/bin/sh
set -e

OPTIONS="/data/options.json"
# Config lives in /data (persistent) so last_known_weight survives add-on
# restarts. The app is launched with --config to read from this path.
CONFIG="/data/config.yaml"
FRESH="/tmp/config-fresh.yaml"
ADDON_CONFIG="/app/addon-config.mjs"
mkdir -p /data

log() { echo "[ble-scale-sync] $*"; }

# ── Read options ────────────────────────────────────────────────────────────

# tests/addon-run-sh.test.ts runs these readers on their own.
# >>> option readers
opt() { jq -r ".$1 // empty" "$OPTIONS"; }
# For options whose default is false: a missing key reads as false.
opt_bool() { jq -r ".$1 // false" "$OPTIONS"; }
# For options whose default is true. Neither helper above works for them:
# jq's // treats false as missing, so ".x // true" turns an explicit false into
# true, and opt_bool turns a missing key into false. Only an explicit false
# switches one of these off, and the answer is always exactly true or false.
opt_bool_default_true() {
  jq -r --arg k "$1" 'if .[$k] == false then "false" else "true" end' "$OPTIONS"
}
opt_int() { jq -r ".$1 // $2" "$OPTIONS"; }
# <<< option readers

# tests/addon-generate.test.ts runs the blocks marked here together, as the
# generated-config path of this script, and loads what they write.
# >>> yaml escape
# Escape a string for a YAML double-quoted value: backslash, double quote and
# CR are escaped, a newline becomes a space. The app also reads ${NAME} in any
# value as an environment variable, so a ${...} in an option becomes $${...},
# its escape for a literal one, and the value reaches the app as entered. Only
# a ${ with a closing } is a reference; anything else is left alone, since an
# escape the app would not undo would change the value instead. tr runs first
# so that a newline inside ${...} cannot split it across two sed lines.
#
# Write the result with printf '%s\n' or a heredoc, never with echo: dash's
# echo turns the \\ written here back into a single backslash.
yaml_escape() {
  printf '%s' "$1" | tr '\n' ' ' |
    sed 's/\\/\\\\/g; s/"/\\"/g; s/\r/\\r/g; s/\${\([^}][^}]*}\)/$${\1/g'
}
# <<< yaml escape

# ── Option checks that mirror the app's config schema ───────────────────────
# The Supervisor only checks each option's type, and the app refuses to start
# on a value its schema rejects. A bad value is therefore dropped here with a
# warning, the same as the QN bytes and out_of_range below, instead of taking
# the whole add-on down. tests/addon-run-sh.test.ts runs these on their own.
#
# The one exception is the Bluetooth transport: one that cannot run with the
# options given stops the add-on with an error. Falling back to the built-in
# adapter would scan, and power-cycle, an adapter the user chose not to use;
# with ha-bluetooth it is the very adapter Home Assistant reads from.
# >>> option checks

# src/ble/scale-id.ts: a MAC, or a CoreBluetooth UUID (dashed or 32 hex).
valid_scale_id() {
  printf '%s\n' "$1" | grep -Eq '^(([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|[0-9A-Fa-f]{32})$'
}

# src/config/schema.ts isRealCalendarDate: YYYY-MM-DD, a day that exists, not
# in the future (UTC). GNU date rejects 2024-02-31 outright. Years 0000 to
# 0099 are refused too: the schema builds the date with Date.UTC, which reads
# them as 1900 to 1999 and so rejects them.
valid_birth_date() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || return 1
  [ "$(date -u -d "$1" +%Y-%m-%d 2>/dev/null)" = "$1" ] || return 1
  case "$1" in 00*) return 1 ;; esac
  [ "$(printf '%s' "$1" | sed 's/-//g')" -le "$(date -u +%Y%m%d)" ]
}

# src/config/schema.ts WeightRangeSchema: both positive, max greater than min.
valid_weight_range() {
  case "$1:$2" in *[!0-9:]* | :* | *:) return 1 ;; esac
  [ "$1" -gt 0 ] 2>/dev/null && [ "$2" -gt "$1" ] 2>/dev/null
}

# The ESPHome API library (@2colors/esphome-native-api, lib/connection.js)
# refuses any encryption key that is not base64 of exactly 32 bytes, and it
# does so as the client is created. Every such key is 43 base64 characters
# and one = of padding.
valid_esphome_key() {
  printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9+/]{43}=$'
}

# <<< option checks

# ── Bluetooth transport ─────────────────────────────────────────────────────
# ble_transport picks how the app reaches the scale. local, the default, writes
# no ble.handler at all, so the config is what it was before the option existed.
# >>> ble transport

ESPHOME_OPTIONS="esphome_proxy_host esphome_proxy_port esphome_proxy_encryption_key"
MQTT_PROXY_EMBEDDED_OPTIONS="mqtt_proxy_embedded_broker_port mqtt_proxy_username mqtt_proxy_password"
MQTT_PROXY_OPTIONS="mqtt_proxy_broker mqtt_proxy_device_id mqtt_proxy_topic_prefix $MQTT_PROXY_EMBEDDED_OPTIONS"

# Names of the given transport options that differ from their defaults in the
# add-on manifest, comma separated. Names only: some of the values are secrets.
transport_options_set() {
  _set=""
  for _o in "$@"; do
    _v=$(opt "$_o")
    [ -n "$_v" ] || continue
    case "$_o=$_v" in
      esphome_proxy_port=6053 | mqtt_proxy_broker=shared | \
        mqtt_proxy_device_id=esp32-ble-proxy | mqtt_proxy_topic_prefix=ble-proxy | \
        mqtt_proxy_embedded_broker_port=1883)
        continue
        ;;
    esac
    _set="${_set:+$_set, }$_o"
  done
  printf '%s' "$_set"
  return 0
}

# Why the chosen transport cannot run with these options, on one line, or
# nothing. Option names only, never a value: some are secrets. Always returns
# 0, since the caller reads the output under set -e.
ble_transport_problem() {
  case "$BLE_TRANSPORT" in
    local) ;;
    esphome-proxy)
      if [ -z "$ESPHOME_HOST" ]; then
        echo "ble_transport is esphome-proxy, but esphome_proxy_host is empty."
      elif printf '%s' "$ESPHOME_HOST" | grep -q /; then
        echo "esphome_proxy_host takes a host name or IP address, not a URL."
      elif [ -n "$ESPHOME_KEY" ] && ! valid_esphome_key "$ESPHOME_KEY"; then
        echo "esphome_proxy_encryption_key is not a valid ESPHome API key. Copy the 44-character key (it ends in =) from api: encryption: key: in the device's YAML."
      fi
      ;;
    mqtt-proxy)
      if [ "$MQTT_PROXY_BROKER" != "shared" ] && [ "$MQTT_PROXY_BROKER" != "embedded" ]; then
        printf '%s\n' "mqtt_proxy_broker '$MQTT_PROXY_BROKER' is not one of shared, embedded."
      elif printf '%s' "$MQTT_PROXY_DEVICE_ID$MQTT_PROXY_TOPIC_PREFIX" | grep -q '[+#]'; then
        echo "mqtt_proxy_device_id and mqtt_proxy_topic_prefix cannot contain + or #."
      elif [ "$MQTT_PROXY_BROKER" = "embedded" ] &&
        { [ -z "$MQTT_PROXY_USERNAME" ] || [ -z "$MQTT_PROXY_PASSWORD" ]; }; then
        echo "mqtt_proxy_broker embedded listens on this host's network, so it needs mqtt_proxy_username and mqtt_proxy_password; the ESP32 logs in with them."
      elif [ "$MQTT_PROXY_BROKER" = "shared" ] && [ -z "$MQTT_BROKER_URL" ]; then
        echo "ble_transport is mqtt-proxy with mqtt_proxy_broker shared, but no MQTT broker is available. Start the Mosquitto broker add-on with MQTT auto-detect on, set mqtt_broker_url, or set mqtt_proxy_broker to embedded."
      fi
      ;;
    ha-bluetooth)
      [ -n "$SUPERVISOR_TOKEN" ] ||
        echo "ble_transport is ha-bluetooth, but the Supervisor gave this add-on no SUPERVISOR_TOKEN. Please report this."
      ;;
    *)
      printf '%s\n' "ble_transport '$BLE_TRANSPORT' is not one of local, ha-bluetooth, esphome-proxy, mqtt-proxy."
      ;;
  esac
  return 0
}

ble_transport_error() {
  log "ERROR: $1"
  log "Not falling back to the built-in Bluetooth adapter: fix the option above, or set ble_transport to local."
  exit 1
}

# The ble: lines of the chosen transport, for any transport but local.
emit_ble_transport() {
  case "$BLE_TRANSPORT" in
    esphome-proxy)
      printf '%s\n' "  handler: esphome-proxy" "  esphome_proxy:" \
        "    host: \"$(yaml_escape "$ESPHOME_HOST")\"" "    port: $ESPHOME_PORT"
      [ -z "$ESPHOME_KEY" ] ||
        printf '%s\n' "    encryption_key: \"$(yaml_escape "$ESPHOME_KEY")\""
      ;;
    mqtt-proxy)
      printf '%s\n' "  handler: mqtt-proxy" "  mqtt_proxy:"
      if [ "$MQTT_PROXY_BROKER" = "shared" ]; then
        printf '%s\n' "    broker_url: \"$(yaml_escape "$MQTT_BROKER_URL")\""
        [ -z "$MQTT_USERNAME" ] ||
          printf '%s\n' "    username: \"$(yaml_escape "$MQTT_USERNAME")\""
        [ -z "$MQTT_PASSWORD" ] ||
          printf '%s\n' "    password: \"$(yaml_escape "$MQTT_PASSWORD")\""
      else
        # No broker_url: the app then runs its own broker, on every interface
        # of this host (embedded_broker_bind keeps its default, 0.0.0.0).
        printf '%s\n' "    embedded_broker_port: $MQTT_PROXY_PORT" \
          "    username: \"$(yaml_escape "$MQTT_PROXY_USERNAME")\"" \
          "    password: \"$(yaml_escape "$MQTT_PROXY_PASSWORD")\""
      fi
      [ -z "$MQTT_PROXY_DEVICE_ID" ] ||
        printf '%s\n' "    device_id: \"$(yaml_escape "$MQTT_PROXY_DEVICE_ID")\""
      [ -z "$MQTT_PROXY_TOPIC_PREFIX" ] ||
        printf '%s\n' "    topic_prefix: \"$(yaml_escape "$MQTT_PROXY_TOPIC_PREFIX")\""
      ;;
    ha-bluetooth)
      # Home Assistant through the Supervisor's websocket proxy, which this
      # add-on may use because the manifest sets homeassistant_api. The token
      # is a reference, never the value: the Supervisor issues a new one on
      # every add-on start, and the app resolves ${...} from its environment
      # on load. The path must be written out in full: a bare
      # http://supervisor/core would become ws://supervisor/core.
      printf '%s\n' '  handler: ha-bluetooth' '  ha_bluetooth:' \
        '    url: "ws://supervisor/core/websocket"' '    token: "${SUPERVISOR_TOKEN}"'
      ;;
  esac
  return 0
}
# <<< ble transport

# >>> mode
# Read BLE_ADAPTER early (needed for adapter reset in both modes)
# Normalize: trim whitespace, lowercase (app schema requires /^hci\d+$/)
BLE_ADAPTER=$(opt ble_adapter | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
RESET_BLUETOOTH=$(opt_bool_default_true reset_bluetooth)
CUSTOM_CONFIG=$(opt_bool custom_config)
# Needed in both modes too: the adapter reset below is skipped for a proxy.
BLE_TRANSPORT=$(opt ble_transport)
[ -n "$BLE_TRANSPORT" ] || BLE_TRANSPORT=local
# <<< mode

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
  for _qn in qn_protocol_byte qn_report_byte qn_weight_ack qn_a4_prelude \
    qn_time_sync_long qn_config_long auto_clear_stale_bond adapter_privacy; do
    if [ -n "$(opt "$_qn")" ]; then
      log "WARNING: custom_config is enabled, so the '$_qn' option is ignored."
      log "Set 'ble.$_qn' in $CUSTOM_PATH instead."
    fi
  done
  # preemptive_adapter_reset defaults to true, and the loop above cannot see a
  # false (jq's // treats false as missing), so it gets its own check. Only
  # false is worth a warning: true is what every install has.
  if [ "$(opt_bool_default_true preemptive_adapter_reset)" = "false" ]; then
    log "WARNING: custom_config is enabled, so the 'preemptive_adapter_reset' option is ignored."
    log "Set 'ble.preemptive_adapter_reset' in $CUSTOM_PATH instead."
  fi
  # Same for update_check, a top-level key in the file.
  if [ "$(opt_bool_default_true update_check)" = "false" ]; then
    log "WARNING: custom_config is enabled, so the 'update_check' option is ignored."
    log "Set 'update_check: false' in $CUSTOM_PATH instead."
  fi
  # The transport options are named together: each of them maps to a key of a
  # ble section in the file, not to a ble.<option> as the loop above says.
  _transport=$(transport_options_set $ESPHOME_OPTIONS $MQTT_PROXY_OPTIONS)
  if [ "$BLE_TRANSPORT" != "local" ]; then
    _transport="ble_transport${_transport:+, $_transport}"
  fi
  if [ -n "$_transport" ]; then
    log "WARNING: custom_config is enabled, so the transport options ($_transport) are ignored."
    log "Set 'ble.handler' and its section (ble.esphome_proxy, ble.mqtt_proxy or ble.ha_bluetooth) in $CUSTOM_PATH instead."
  fi
  # proxy_liveness_timeout_min is the one UI option applied in this mode too:
  # the liveness check runs only on the proxy transports (mqtt-proxy,
  # esphome-proxy, ha-bluetooth), and here only the file can choose one. So
  # unlike the options above it is applied rather than ignored, but only when
  # the file does not set its own value, which always wins. The default (30)
  # is the app's own default and needs no write.
  PROXY_LIVENESS_MIN=$(opt_int proxy_liveness_timeout_min 30)
  if [ "$PROXY_LIVENESS_MIN" != "30" ]; then
    _plrc=0
    # Edited with the app's own YAML parser, not PyYAML: see addon-config.mjs.
    node "$ADDON_CONFIG" proxy-liveness "$FRESH" "$PROXY_LIVENESS_MIN" 2>/dev/null || _plrc=$?
    case "$_plrc" in
      0) log "Applied proxy_liveness_timeout_min=$PROXY_LIVENESS_MIN from the add-on options." ;;
      3)
        log "WARNING: 'ble.proxy_liveness_timeout_min' is set in $CUSTOM_PATH, so the add-on option ($PROXY_LIVENESS_MIN) is ignored."
        ;;
      4) log "WARNING: ignoring proxy_liveness_timeout_min='$PROXY_LIVENESS_MIN' (expected 0 to 1440)." ;;
      *)
        log "WARNING: could not apply proxy_liveness_timeout_min to $CUSTOM_PATH; set 'ble.proxy_liveness_timeout_min' there instead."
        ;;
    esac
  fi
else

  # >>> generate config
  # ── Read all options ────────────────────────────────────────────────────

  # Only a hand-edited options.json gets past the Supervisor's list check.
  case "$BLE_TRANSPORT" in
    local | ha-bluetooth | esphome-proxy | mqtt-proxy) ;;
    *) ble_transport_error "$(ble_transport_problem)" ;;
  esac

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
  # Same free-text normalisation as qn_weight_ack above, for the same reason.
  QN_A4_PRELUDE=$(opt qn_a4_prelude)
  case "$(echo "$QN_A4_PRELUDE" | tr '[:upper:]' '[:lower:]')" in
    "") QN_A4_PRELUDE="" ;;
    true | yes | on | 1) QN_A4_PRELUDE="true" ;;
    false | no | off | 0) QN_A4_PRELUDE="false" ;;
    *)
      log "WARNING: ignoring qn_a4_prelude='$QN_A4_PRELUDE' (expected true or false)."
      QN_A4_PRELUDE=""
      ;;
  esac
  # Same free-text normalisation again, same reason.
  QN_TIME_SYNC_LONG=$(opt qn_time_sync_long)
  case "$(echo "$QN_TIME_SYNC_LONG" | tr '[:upper:]' '[:lower:]')" in
    "") QN_TIME_SYNC_LONG="" ;;
    true | yes | on | 1) QN_TIME_SYNC_LONG="true" ;;
    false | no | off | 0) QN_TIME_SYNC_LONG="false" ;;
    *)
      log "WARNING: ignoring qn_time_sync_long='$QN_TIME_SYNC_LONG' (expected true or false)."
      QN_TIME_SYNC_LONG=""
      ;;
  esac
  # Same free-text normalisation again, same reason.
  QN_CONFIG_LONG=$(opt qn_config_long)
  case "$(echo "$QN_CONFIG_LONG" | tr '[:upper:]' '[:lower:]')" in
    "") QN_CONFIG_LONG="" ;;
    true | yes | on | 1) QN_CONFIG_LONG="true" ;;
    false | no | off | 0) QN_CONFIG_LONG="false" ;;
    *)
      log "WARNING: ignoring qn_config_long='$QN_CONFIG_LONG' (expected true or false)."
      QN_CONFIG_LONG=""
      ;;
  esac
  AUTO_CLEAR_STALE_BOND=$(opt_bool auto_clear_stale_bond)
  # Defaults to true: only an explicit false switches it off (#417).
  PREEMPTIVE_ADAPTER_RESET=$(opt_bool_default_true preemptive_adapter_reset)
  ADAPTER_PRIVACY=$(opt_bool adapter_privacy)
  PROXY_LIVENESS_MIN=$(opt_int proxy_liveness_timeout_min 30)
  # Still written below, but the built-in Bluetooth transport has no liveness
  # check. Say so instead of letting the option look like it did something.
  if [ "$PROXY_LIVENESS_MIN" != "30" ] && [ "$BLE_TRANSPORT" = "local" ]; then
    log "NOTE: proxy_liveness_timeout_min only affects a proxy transport, so it has no effect with ble_transport local."
  fi

  ESPHOME_HOST=$(opt esphome_proxy_host | tr -d '[:space:]')
  ESPHOME_PORT=$(opt_int esphome_proxy_port 6053)
  # The ESPHome library refuses a key with as much as a trailing space.
  ESPHOME_KEY=$(opt esphome_proxy_encryption_key | tr -d '[:space:]')
  MQTT_PROXY_BROKER=$(opt mqtt_proxy_broker)
  [ -n "$MQTT_PROXY_BROKER" ] || MQTT_PROXY_BROKER=shared
  # Empty means the app's own default, the same as the manifest's.
  MQTT_PROXY_DEVICE_ID=$(opt mqtt_proxy_device_id | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  MQTT_PROXY_TOPIC_PREFIX=$(opt mqtt_proxy_topic_prefix | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  MQTT_PROXY_PORT=$(opt_int mqtt_proxy_embedded_broker_port 1883)
  MQTT_PROXY_USERNAME=$(opt mqtt_proxy_username)
  MQTT_PROXY_PASSWORD=$(opt mqtt_proxy_password)

  # The options that only steer the built-in adapter are not written for a
  # proxy transport, which has no use for them, so that the ble: block and its
  # condition below stay the same for every transport.
  if [ "$BLE_TRANSPORT" != "local" ]; then
    _host_only=""
    [ -z "$BLE_ADAPTER" ] || _host_only="ble_adapter"
    [ "$AUTO_CLEAR_STALE_BOND" != "true" ] || _host_only="${_host_only:+$_host_only, }auto_clear_stale_bond"
    [ "$PREEMPTIVE_ADAPTER_RESET" != "false" ] || _host_only="${_host_only:+$_host_only, }preemptive_adapter_reset"
    [ "$ADAPTER_PRIVACY" != "true" ] || _host_only="${_host_only:+$_host_only, }adapter_privacy"
    if [ -n "$_host_only" ]; then
      log "NOTE: ble_transport $BLE_TRANSPORT does not use the built-in Bluetooth adapter, so these options are ignored: $_host_only."
    fi
    BLE_ADAPTER=""
    AUTO_CLEAR_STALE_BOND=false
    PREEMPTIVE_ADAPTER_RESET=true
    ADAPTER_PRIVACY=false
  fi
  DISPLAY_UNIT=$(opt display_unit)

  WEIGHT_UNIT=$(opt weight_unit)
  HEIGHT_UNIT=$(opt height_unit)
  [ -z "$WEIGHT_UNIT" ] && WEIGHT_UNIT="kg"
  [ -z "$HEIGHT_UNIT" ] && HEIGHT_UNIT="cm"
  [ -z "$DISPLAY_UNIT" ] && DISPLAY_UNIT="weight_unit"
  OUT_OF_RANGE=$(opt out_of_range)
  # Anything but the two known values would fail schema validation and take the
  # whole add-on down, so an unrecognised value falls back to the default.
  case "$OUT_OF_RANGE" in
    warn | skip) ;;
    "") OUT_OF_RANGE="warn" ;;
    *)
      log "WARNING: ignoring out_of_range='$OUT_OF_RANGE' (expected warn or skip)."
      OUT_OF_RANGE="warn"
      ;;
  esac

  USER_NAME=$(opt user_name)
  USER_HEIGHT=$(opt_int user_height 170)
  USER_BIRTH_DATE=$(opt user_birth_date)
  USER_GENDER=$(opt user_gender)
  USER_IS_ATHLETE=$(opt_bool user_is_athlete)
  USER_WEIGHT_MIN=$(opt_int user_weight_min 40)
  USER_WEIGHT_MAX=$(opt_int user_weight_max 150)

  MQTT_ENABLED=$(opt_bool_default_true mqtt_enabled)
  MQTT_AUTO=$(opt_bool_default_true mqtt_auto)
  MQTT_BROKER_URL=$(opt mqtt_broker_url)
  MQTT_USERNAME=$(opt mqtt_username)
  MQTT_PASSWORD=$(opt mqtt_password)
  MQTT_TOPIC=$(opt mqtt_topic)
  MQTT_HA_DISCOVERY=$(opt_bool_default_true mqtt_ha_discovery)
  MQTT_HA_DEVICE_NAME=$(opt mqtt_ha_device_name)

  GARMIN_ENABLED=$(opt_bool garmin_enabled)
  GARMIN_EMAIL=$(opt garmin_email)
  GARMIN_PASSWORD=$(opt garmin_password)
  GARMIN_WEIGHT_ONLY=$(opt_bool garmin_weight_only)
  # opt_bool echoes the raw option, and this one is interpolated unquoted into
  # the generated YAML. The add-on schema declares it bool?, but a hand-edited
  # options.json is not bound by that, and a stray string would produce YAML
  # that fails to parse. Anything that is not exactly "true" is false.
  [ "$GARMIN_WEIGHT_ONLY" = "true" ] || GARMIN_WEIGHT_ONLY=false
  GARMIN_UPLOAD_TIMEOUT=$(opt_int garmin_upload_timeout_sec 180)

  SCAN_COOLDOWN=$(opt_int scan_cooldown 30)
  # jq's // falls back only on null/false, so an explicit 0 survives.
  IDLE_RESCAN_DELAY=$(opt_int idle_rescan_delay 5)
  # Always exactly true or false, so it is safe to interpolate unquoted.
  RETRY_FAILED_EXPORTS=$(opt_bool_default_true retry_failed_exports)
  DEBUG=$(opt_bool debug)
  UPDATE_CHECK=$(opt_bool_default_true update_check)

  # ── MQTT auto-detection from HA Mosquitto add-on ──────────────────────

  # The ESP32 proxy on the shared broker uses the same broker as the exporter.
  MQTT_FOR_PROXY=false
  if [ "$BLE_TRANSPORT" = "mqtt-proxy" ] && [ "$MQTT_PROXY_BROKER" = "shared" ]; then
    MQTT_FOR_PROXY=true
  fi
  MQTT_DETECTED=false
  if [ "$MQTT_AUTO" = "true" ] && { [ "$MQTT_ENABLED" = "true" ] || [ "$MQTT_FOR_PROXY" = "true" ]; }; then
    if [ -n "$SUPERVISOR_TOKEN" ]; then
      # The HTTP status is appended on its own line so a refusal can be told
      # apart from "no broker installed". Both used to collapse into the same
      # "auto-detection failed" line, which is how a missing `services:
      # mqtt:want` declaration (every call answered 403) went unnoticed.
      # Bounded, because nothing else in this script is: a Supervisor API that
      # accepts the connection and never answers would otherwise hold the
      # add-on here, before the app (and its health heartbeat) ever starts. A
      # timeout reports status 000, the "did not answer" case below.
      #
      # Without a broker the ESP32 proxy cannot start, and the add-on stops
      # before its restart loop, so for the proxy a Supervisor that did not
      # answer or failed (000, 5xx) is asked twice more. Its other answers do
      # not change on a retry: 400 means no broker, 403 a broken build.
      _tries=1
      [ "$MQTT_FOR_PROXY" != "true" ] || _tries=3
      while :; do
        MQTT_RESP=$(curl -s -w '\n%{http_code}' --connect-timeout 5 --max-time 10 \
          -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
          http://supervisor/services/mqtt 2>/dev/null || true)
        MQTT_HTTP=$(printf '%s\n' "$MQTT_RESP" | tail -n 1)
        _tries=$((_tries - 1))
        case "$MQTT_HTTP" in
          000 | "" | 5??) [ "$_tries" -gt 0 ] || break ;;
          *) break ;;
        esac
        log "MQTT auto-detection: no answer from the Supervisor (HTTP ${MQTT_HTTP:-000}), trying again in 5s."
        sleep 5
      done
      MQTT_INFO=$(printf '%s\n' "$MQTT_RESP" | sed '$d')
      [ -n "$MQTT_INFO" ] || MQTT_INFO='{}'
      MQTT_HOST=$(echo "$MQTT_INFO" | jq -r '.data.host // empty' 2>/dev/null || true)
      MQTT_PORT=$(echo "$MQTT_INFO" | jq -r '.data.port // empty' 2>/dev/null || true)
      AUTO_USER=$(echo "$MQTT_INFO" | jq -r '.data.username // empty' 2>/dev/null || true)
      AUTO_PASS=$(echo "$MQTT_INFO" | jq -r '.data.password // empty' 2>/dev/null || true)

      if [ "$MQTT_HTTP" = "200" ] && [ -n "$MQTT_HOST" ]; then
        MQTT_BROKER_URL="mqtt://${MQTT_HOST}:${MQTT_PORT:-1883}"
        MQTT_USERNAME="${AUTO_USER}"
        MQTT_PASSWORD="${AUTO_PASS}"
        MQTT_DETECTED=true
        log "MQTT auto-detected: $MQTT_BROKER_URL"
      else
        # Only the error message is logged, never the body: on success the
        # body carries the broker password.
        MQTT_ERR=$(echo "$MQTT_INFO" | jq -r '.message // empty' 2>/dev/null || true)
        case "$MQTT_HTTP" in
          403)
            log "MQTT auto-detection refused by the Supervisor (HTTP 403${MQTT_ERR:+: $MQTT_ERR})."
            log "This add-on build does not declare the mqtt service; please report it. Using manual settings."
            ;;
          000 | "")
            log "MQTT auto-detection failed: the Supervisor API did not answer. Using manual settings."
            ;;
          *)
            log "MQTT auto-detection failed (HTTP $MQTT_HTTP${MQTT_ERR:+: $MQTT_ERR})."
            log "Is the Mosquitto broker add-on installed and running? Using manual settings."
            ;;
        esac
      fi
    else
      log "No SUPERVISOR_TOKEN, MQTT auto-detection unavailable"
    fi
  fi

  # ── Bluetooth transport ───────────────────────────────────────────────

  _problem=$(ble_transport_problem)
  [ -z "$_problem" ] || ble_transport_error "$_problem"

  # A heuristic, hence only a warning: the Mosquitto add-on maps 1883 on the
  # host, but the mapping can be changed.
  if [ "$BLE_TRANSPORT" = "mqtt-proxy" ] && [ "$MQTT_PROXY_BROKER" = "embedded" ] &&
    [ "$MQTT_PROXY_PORT" = "1883" ] && [ "$MQTT_DETECTED" = "true" ]; then
    log "WARNING: mqtt_proxy_broker embedded wants port 1883, which the Mosquitto broker add-on usually holds on this host. If the broker fails to start, use mqtt_proxy_broker shared, or another mqtt_proxy_embedded_broker_port with the same mqtt_port in the ESP32's config.json."
  fi

  _other=""
  _unused=""
  case "$BLE_TRANSPORT" in
    esphome-proxy) _other=$(transport_options_set $MQTT_PROXY_OPTIONS) ;;
    mqtt-proxy)
      _other=$(transport_options_set $ESPHOME_OPTIONS)
      [ "$MQTT_PROXY_BROKER" != "shared" ] ||
        _unused=$(transport_options_set $MQTT_PROXY_EMBEDDED_OPTIONS)
      ;;
    *) _other=$(transport_options_set $ESPHOME_OPTIONS $MQTT_PROXY_OPTIONS) ;;
  esac
  if [ -n "$_other" ]; then
    log "NOTE: these options belong to another transport than ble_transport $BLE_TRANSPORT, so they are ignored: $_other."
  fi
  if [ -n "$_unused" ]; then
    log "NOTE: these options only apply to mqtt_proxy_broker embedded, so they are ignored: $_unused."
  fi

  case "$BLE_TRANSPORT" in
    esphome-proxy)
      _enc=unencrypted
      [ -z "$ESPHOME_KEY" ] || _enc=encrypted
      log "Bluetooth transport: esphome-proxy ($ESPHOME_HOST:$ESPHOME_PORT, $_enc)"
      ;;
    mqtt-proxy)
      # Not the broker URL: one set by hand can carry a password.
      if [ "$MQTT_PROXY_BROKER" = "shared" ]; then
        _broker="shared broker"
      else
        _broker="embedded broker on port $MQTT_PROXY_PORT"
      fi
      log "Bluetooth transport: mqtt-proxy ($_broker, device ${MQTT_PROXY_DEVICE_ID:-esp32-ble-proxy})"
      ;;
    ha-bluetooth)
      log "Bluetooth transport: ha-bluetooth (Home Assistant via the Supervisor, broadcast scales only)"
      ;;
  esac

  # ── Generate slug from user name ──────────────────────────────────────

  # The Supervisor accepts an empty `str`, and the schema requires a name.
  if [ -z "$(printf '%s' "$USER_NAME" | tr -d '[:space:]')" ]; then
    log "WARNING: user_name is empty. Using 'Default'."
    USER_NAME="Default"
  fi

  USER_SLUG=$(echo "$USER_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  [ -z "$USER_SLUG" ] && USER_SLUG="default"

  # ── Validate inputs ──────────────────────────────────────────────────

  if ! valid_birth_date "$USER_BIRTH_DATE"; then
    log "WARNING: Invalid birth date '$USER_BIRTH_DATE' (expected a real past date, YYYY-MM-DD). Using 2000-01-01."
    USER_BIRTH_DATE="2000-01-01"
  fi

  if ! valid_weight_range "$USER_WEIGHT_MIN" "$USER_WEIGHT_MAX"; then
    log "WARNING: Invalid weight range $USER_WEIGHT_MIN to $USER_WEIGHT_MAX (max must be greater than min). Using 40 to 150."
    USER_WEIGHT_MIN=40
    USER_WEIGHT_MAX=150
  fi

  # Surrounding whitespace comes free from a text field; anything else that is
  # not a MAC or UUID is dropped, which means scanning for any supported scale.
  SCALE_MAC=$(printf '%s' "$SCALE_MAC" | tr -d '[:space:]')
  if [ -n "$SCALE_MAC" ] && ! valid_scale_id "$SCALE_MAC"; then
    log "WARNING: Invalid scale_mac '$SCALE_MAC' (expected XX:XX:XX:XX:XX:XX). Ignoring it."
    SCALE_MAC=""
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
  # The value is normalised to decimal before it is written. A leading zero is
  # read as octal by any YAML 1.1 reader ("010" as 8, "064" as 52), and this
  # file used to pass through one (PyYAML) on its way to the app. Both of these
  # settings fail silently when wrong (every command acknowledged, no weight
  # ever arriving), so a reporter told to try a value and typing a leading zero
  # would run a different experiment and report a false negative. A plain
  # decimal means the same thing to every reader. Surrounding whitespace is
  # trimmed for the same reason: it comes free from a text field.
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

  # BLE section, emitted only when at least one of its options is set.
  # Every option written inside this block must also appear in the condition.
  # qn_a4_prelude did not, so an install whose only BLE option was that one
  # got no ble: block at all and the setting vanished without a word.
  if [ -n "$SCALE_MAC" ] || [ -n "$BLE_ADAPTER" ] || [ -n "$FORCE_SCALE_ADAPTER" ] ||
    [ -n "$QN_PROTOCOL_BYTE" ] || [ -n "$QN_REPORT_BYTE" ] || [ -n "$QN_WEIGHT_ACK" ] ||
    [ -n "$QN_A4_PRELUDE" ] || [ -n "$QN_TIME_SYNC_LONG" ] || [ -n "$QN_CONFIG_LONG" ] ||
    [ "$AUTO_CLEAR_STALE_BOND" = "true" ] || [ "$PREEMPTIVE_ADAPTER_RESET" = "false" ] ||
    [ "$ADAPTER_PRIVACY" = "true" ] || [ "$PROXY_LIVENESS_MIN" != "30" ] ||
    [ "$BLE_TRANSPORT" != "local" ]; then
    echo "ble:" >> "$FRESH"
    [ -n "$SCALE_MAC" ] && printf '%s\n' "  scale_mac: \"$(yaml_escape "$SCALE_MAC")\"" >> "$FRESH"
    [ -n "$BLE_ADAPTER" ] && printf '%s\n' "  adapter: \"$(yaml_escape "$BLE_ADAPTER")\"" >> "$FRESH"
    [ -n "$FORCE_SCALE_ADAPTER" ] && printf '%s\n' "  force_scale_adapter: \"$(yaml_escape "$FORCE_SCALE_ADAPTER")\"" >> "$FRESH"
    [ -n "$QN_PROTOCOL_BYTE" ] && echo "  qn_protocol_byte: $QN_PROTOCOL_BYTE" >> "$FRESH"
    [ -n "$QN_REPORT_BYTE" ] && echo "  qn_report_byte: $QN_REPORT_BYTE" >> "$FRESH"
    [ -n "$QN_WEIGHT_ACK" ] && echo "  qn_weight_ack: $QN_WEIGHT_ACK" >> "$FRESH"
    [ -n "$QN_A4_PRELUDE" ] && echo "  qn_a4_prelude: $QN_A4_PRELUDE" >> "$FRESH"
    [ -n "$QN_TIME_SYNC_LONG" ] && echo "  qn_time_sync_long: $QN_TIME_SYNC_LONG" >> "$FRESH"
    [ -n "$QN_CONFIG_LONG" ] && echo "  qn_config_long: $QN_CONFIG_LONG" >> "$FRESH"
    [ "$AUTO_CLEAR_STALE_BOND" = "true" ] && echo "  auto_clear_stale_bond: true" >> "$FRESH"
    [ "$PREEMPTIVE_ADAPTER_RESET" = "false" ] && echo "  preemptive_adapter_reset: false" >> "$FRESH"
    [ "$ADAPTER_PRIVACY" = "true" ] && echo "  adapter_privacy: true" >> "$FRESH"
    [ "$PROXY_LIVENESS_MIN" != "30" ] && echo "  proxy_liveness_timeout_min: $PROXY_LIVENESS_MIN" >> "$FRESH"
    [ "$BLE_TRANSPORT" != "local" ] && emit_ble_transport >> "$FRESH"
    echo "" >> "$FRESH"
  fi

  cat >> "$FRESH" <<YAML
scale:
  weight_unit: $WEIGHT_UNIT
  height_unit: $HEIGHT_UNIT
  display_unit: $DISPLAY_UNIT

unknown_user: nearest
out_of_range: $OUT_OF_RANGE

users:
  - name: "$(yaml_escape "$USER_NAME")"
    slug: "$USER_SLUG"
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
      [ -n "$MQTT_USERNAME" ] && printf '%s\n' "    username: \"$(yaml_escape "$MQTT_USERNAME")\"" >> "$FRESH"
      [ -n "$MQTT_PASSWORD" ] && printf '%s\n' "    password: \"$(yaml_escape "$MQTT_PASSWORD")\"" >> "$FRESH"
    fi

    # Garmin exporter
    if [ "$GARMIN_ENABLED" = "true" ] && [ -n "$GARMIN_EMAIL" ] && [ -n "$GARMIN_PASSWORD" ]; then
      mkdir -p /data/garmin-tokens
      cat >> "$FRESH" <<YAML
  - type: garmin
    email: "$(yaml_escape "$GARMIN_EMAIL")"
    password: "$(yaml_escape "$GARMIN_PASSWORD")"
    token_dir: /data/garmin-tokens
    weight_only: $GARMIN_WEIGHT_ONLY
    upload_timeout_sec: $GARMIN_UPLOAD_TIMEOUT
YAML
    fi

    echo "" >> "$FRESH"
  fi

  # ── Runtime ───────────────────────────────────────────────────────────

  cat >> "$FRESH" <<YAML
runtime:
  continuous_mode: true
  scan_cooldown: $SCAN_COOLDOWN
  idle_rescan_delay: $IDLE_RESCAN_DELAY
  retry_failed_exports: $RETRY_FAILED_EXPORTS
  dry_run: false
  debug: $DEBUG

update_check: $UPDATE_CHECK
YAML

  log "Config generated successfully"
  # <<< generate config
fi

# ── Merge last_known_weight from previous run ────────────────────────────────
# addon-config.mjs reads the fresh config (generated or copied) and, if the
# persistent config.yaml already exists (from a previous run), copies each
# user's last_known_weight into it before overwriting. Result is written to
# $CONFIG so the app reads a merged view. It parses with the app's own YAML
# library, so no other value in the file can change type on the way through.

if ! node "$ADDON_CONFIG" merge-weights "$FRESH" "$CONFIG"; then
  log "WARNING: merging last_known_weight failed, using fresh config without preserved weights"
  cp "$FRESH" "$CONFIG"
fi
rm -f "$FRESH"
# The file holds passwords, and nothing above sets its mode: on the first start
# it was created 0644 and stayed so until the app saved a weight (the app
# writes it 0600, and later merges keep that). Only this file: a umask here
# would also reach every file the app writes elsewhere, /share included.
chmod 600 "$CONFIG"

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

TOKEN_DIR="/data/garmin-tokens"
SHARE_DIR="/share/ble-scale-sync/garmin-tokens"

# Default token directory for every garmin entry without its own token_dir.
# The generated config always sets token_dir, so this only changes custom
# config mode, where the default used to be ~/.garmin_tokens: a path inside the
# container that a restart wipes and that the /share import below never wrote
# to, so a token pre-seeded as the documentation describes was never used.
# garmin_upload.py, setup_garmin.py and the app's token directory check all
# read TOKEN_DIR.
export TOKEN_DIR

GARMIN_BOOTSTRAP=false
if [ "$CUSTOM_CONFIG" != "true" ] && [ "$GARMIN_ENABLED" = "true" ] \
   && [ -n "$GARMIN_EMAIL" ] && [ -n "$GARMIN_PASSWORD" ]; then
  GARMIN_BOOTSTRAP=true
fi

# Custom config mode gets the /share import too, but not the authentication
# step. Importing there hands a writer of /share nothing new: in that mode the
# whole config, Garmin credentials and token_dir included, is read from /share
# already. In the generated mode the import is a separate trust decision (the
# token decides which Garmin account receives the measurements) and it is left
# exactly as it was.
if [ "$GARMIN_BOOTSTRAP" = "true" ] \
   || { [ "$CUSTOM_CONFIG" = "true" ] && [ -f "$SHARE_DIR/garmin_tokens.json" ]; }; then
  mkdir -p "$TOKEN_DIR"

  # If only legacy pre-0.3 tokens are present, treat the dir as empty so we
  # re-authenticate (or re-import from /share) and write the new format.
  if [ -f "$TOKEN_DIR/oauth1_token.json" ] \
     && [ ! -f "$TOKEN_DIR/garmin_tokens.json" ]; then
    log "Removing legacy garth tokens (incompatible with garminconnect 0.3.x)"
    rm -f "$TOKEN_DIR"/oauth*_token.json
  fi

  # Option 1: user pre-generated tokens on another machine (MFA workaround).
  #
  # Imported ONLY while /data holds no token at all (review S-04). /share is
  # writable by every add-on with share access and by Samba users, and the
  # token decides which Garmin account receives the measurements. Replacing
  # an existing token whenever the /share copy looked newer let any of them
  # redirect every later upload, retry queue included, to another account on
  # the next restart. An existing token is therefore never replaced from
  # /share; the hint further down says so whenever a different token sits
  # there. The import itself is logged loudly for the same reason.
  SHARE_TOKEN_IMPORTED=false
  # Hash of the /share file last imported. garminconnect re-dumps the token in
  # /data after every refresh, so after an import the two files differ for good;
  # the hint below must not read that as a skipped import.
  SHARE_MARKER="$TOKEN_DIR/.share_token_imported.sha256"
  if [ -f "$SHARE_DIR/garmin_tokens.json" ] && [ ! -f "$TOKEN_DIR/garmin_tokens.json" ]; then
    log "=================================================================="
    log "IMPORTING a Garmin token from $SHARE_DIR/garmin_tokens.json"
    log "into $TOKEN_DIR. Measurements now go to the Garmin account that"
    log "token belongs to. If you did not put this file there, stop the"
    log "add-on and check who can write to /share."
    log "=================================================================="
    if cp "$SHARE_DIR/garmin_tokens.json" "$TOKEN_DIR/" 2>/dev/null; then
      SHARE_TOKEN_IMPORTED=true
      sha256sum < "$SHARE_DIR/garmin_tokens.json" | cut -d' ' -f1 > "$SHARE_MARKER" 2>/dev/null || true
    fi
  fi

  # Option 2: auto-authenticate if tokens still missing. Generated mode only:
  # custom config mode gets this far only with a token in /share to import.
  if [ ! -f "$TOKEN_DIR/garmin_tokens.json" ] && [ "$GARMIN_BOOTSTRAP" != "true" ]; then
    log "WARNING: could not import $SHARE_DIR/garmin_tokens.json into $TOKEN_DIR"
  elif [ ! -f "$TOKEN_DIR/garmin_tokens.json" ]; then
    log "Garmin tokens missing, authenticating with provided credentials..."
    if python3 /app/garmin-scripts/setup_garmin.py --from-config --config-path "$CONFIG"; then
      log "Garmin authentication successful, tokens saved to $TOKEN_DIR"
    else
      log "WARNING: Garmin authentication failed."
      log "If your account uses MFA or Garmin is blocking this IP, run"
      log "  python3 garmin-scripts/setup_garmin.py --from-config --config-path config.yaml"
      log "on another machine and copy garmin_tokens.json into"
      log "/share/ble-scale-sync/garmin-tokens/ on this HA host."
      log "Other exporters (MQTT, etc.) will continue to work."
    fi
  else
    log "Garmin tokens present at $TOKEN_DIR"
    # Says why a token sitting in /share was passed over. Without this the
    # skip is invisible, and the add-on looks like it ignored the file. Only
    # when it really was passed over: not on the start that just imported it,
    # not when /share holds the token already in use, and not when it is the
    # file imported earlier (the /data copy has since been refreshed; copying
    # the old one back would undo that).
    if [ "$SHARE_TOKEN_IMPORTED" != "true" ] \
       && [ -f "$SHARE_DIR/garmin_tokens.json" ] \
       && ! cmp -s "$SHARE_DIR/garmin_tokens.json" "$TOKEN_DIR/garmin_tokens.json" \
       && [ "$(sha256sum < "$SHARE_DIR/garmin_tokens.json" | cut -d' ' -f1)" \
            != "$(cat "$SHARE_MARKER" 2>/dev/null)" ]; then
      log "NOTE: the Garmin token in $SHARE_DIR was NOT imported, because"
      log "$TOKEN_DIR already holds one. The add-on never replaces an existing"
      log "token from /share: anything that can write to /share could otherwise"
      log "send your measurements to another Garmin account. To switch tokens on"
      log "purpose, uninstall and reinstall the add-on (this clears /data,"
      log "including remembered weights and queued exports), then start it with"
      log "the new token in $SHARE_DIR."
    fi
  fi
fi

# ── Strava token directory ─────────────────────────────────────────────────
# A strava exporter without its own token_dir keeps its tokens in
# ./strava-tokens, relative to the app's working directory /app. That is the
# container's own filesystem, which every add-on restart or update replaces, and
# Strava rotates the refresh token on every exchange: losing the file breaks
# uploads until someone authorises again. Only custom config mode can define a
# strava exporter, but the link costs nothing in the generated mode either.
#
# The app's YAML config path reads no environment variable for this default
# (src/exporters/registry.ts), so the directory itself is made persistent: it
# becomes a link into /data. STRAVA_TOKEN_DIR is exported as well for the
# app's environment-only config path, which does read it.
# >>> strava token dir
STRAVA_DATA_DIR="/data/strava-tokens"
STRAVA_APP_DIR="/app/strava-tokens"
STRAVA_TOKEN_DIR="$STRAVA_DATA_DIR"
export STRAVA_TOKEN_DIR
mkdir -p "$STRAVA_DATA_DIR"
if [ -L "$STRAVA_APP_DIR" ]; then
  :
elif [ -e "$STRAVA_APP_DIR" ]; then
  # Never deleted here: the image does not ship this directory, so whatever is
  # in it was put there on purpose.
  log "WARNING: $STRAVA_APP_DIR already exists, so Strava tokens kept there do not"
  log "survive a restart. Set 'token_dir: $STRAVA_DATA_DIR' on the strava exporter."
else
  ln -s "$STRAVA_DATA_DIR" "$STRAVA_APP_DIR"
fi
# <<< strava token dir

# ── Reset Bluetooth adapter ────────────────────────────────────────────────

if [ "$RESET_BLUETOOTH" != "true" ]; then
  log "Bluetooth adapter reset disabled (reset_bluetooth: false)"
elif [ "$CUSTOM_CONFIG" != "true" ] && [ "$BLE_TRANSPORT" != "local" ]; then
  # A proxy does not use this adapter, and with ha-bluetooth a power cycle
  # would cut off the very Bluetooth integration the transport reads from.
  log "Bluetooth adapter reset skipped: ble_transport is $BLE_TRANSPORT, which does not use this host's adapter."
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
  # Bounded like the standalone image's entrypoint: a wedged mgmt socket must
  # not hold the add-on here, before the app and its heartbeat start.
  if timeout 5 btmgmt --index "$ADAPTER_INDEX" power off 2>/dev/null && \
     timeout 5 btmgmt --index "$ADAPTER_INDEX" power on 2>/dev/null; then
    log "Bluetooth adapter reset OK"
  else
    log "Bluetooth adapter reset failed (will retry in-app)"
  fi
  sleep 2
fi

# ── Start, and restart after the app exits ─────────────────────────────────
# The app exits on purpose when it cannot recover in-process (the BLE scan
# watchdog, the proxy liveness check, a hard exit) and expects a supervisor to
# start it again. The Supervisor restarts a stopped add-on only when its
# Watchdog switch is on, and that switch is off by default, so the add-on used
# to stay down after the first such exit (ADR D030, review I-02). This loop is
# that supervisor: every exit is logged with its code and followed by a new
# start, after a delay that doubles from 5 s up to 5 minutes while the app keeps
# exiting soon after it starts, and drops back to 5 s after a run of 10 minutes
# or more.
#
# Stopping the add-on is different. The Supervisor sends SIGTERM, which tini
# (PID 1 here, or the child of Docker's own init) passes to this script only, so
# the trap below passes it on to the app, waits for the app's own shutdown and
# leaves the loop without another start. The app is not exec'd any more for the
# same reason: this script has to outlive it to restart it. Orphans the app
# leaves behind are reaped by PID 1 (tini, or Docker's init under the
# Supervisor's default `init: true`).

# exec inside the background subshell, so the PID in $! is the app itself and
# the TERM below reaches it. tests/addon-run-sh.test.ts runs the block between
# the markers with a stub in place of this function.
start_app() { exec node dist/index.js --config "$CONFIG"; }

# >>> app supervisor
RESTART_DELAY_MIN=5
RESTART_DELAY_MAX=300
RESTART_RESET_AFTER=600
APP_PID=""
SLEEP_PID=""
STOPPING=false

on_stop() {
  STOPPING=true
  # TERM even for INT: a background job of a non-interactive shell ignores
  # SIGINT, and TERM is what the app's graceful shutdown listens for.
  # `|| true`: under set -e a failed kill (the process is already gone) would
  # end the script right here, inside the trap.
  [ -z "$APP_PID" ] || kill -TERM "$APP_PID" 2>/dev/null || true
  [ -z "$SLEEP_PID" ] || kill -TERM "$SLEEP_PID" 2>/dev/null || true
}
trap on_stop TERM INT

# Wait for the app and leave its exit code in APP_RC. A trapped signal cuts
# `wait` short while the app is still shutting down, so wait again until it is
# really gone (`kill -0` still finds a child that exited but is not yet reaped).
wait_app() {
  while :; do
    APP_RC=0
    wait "$APP_PID" || APP_RC=$?
    kill -0 "$APP_PID" 2>/dev/null || return 0
  done
}

RESTARTS=0
DELAY=$RESTART_DELAY_MIN
while :; do
  log "Starting BLE Scale Sync..."
  STARTED=$(date +%s)
  start_app &
  APP_PID=$!
  # A stop that arrived between the start and the line above found no PID.
  [ "$STOPPING" != "true" ] || kill -TERM "$APP_PID" 2>/dev/null || true
  wait_app
  APP_PID=""
  if [ "$STOPPING" = "true" ]; then
    log "Add-on stopping: BLE Scale Sync exited with code $APP_RC, not restarting."
    exit "$APP_RC"
  fi

  RAN=$(($(date +%s) - STARTED))
  [ "$RAN" -lt "$RESTART_RESET_AFTER" ] || DELAY=$RESTART_DELAY_MIN
  RESTARTS=$((RESTARTS + 1))
  log "BLE Scale Sync exited with code $APP_RC after ${RAN}s; restart #$RESTARTS in ${DELAY}s."
  sleep "$DELAY" &
  SLEEP_PID=$!
  wait "$SLEEP_PID" || true
  SLEEP_PID=""
  if [ "$STOPPING" = "true" ]; then
    log "Add-on stopping: not restarting BLE Scale Sync."
    exit 0
  fi
  DELAY=$((DELAY * 2))
  [ "$DELAY" -le "$RESTART_DELAY_MAX" ] || DELAY=$RESTART_DELAY_MAX
done
# <<< app supervisor
