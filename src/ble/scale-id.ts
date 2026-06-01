/**
 * Validation for a BLE scale identifier: a MAC address (Windows/Linux) or a
 * CoreBluetooth UUID (macOS).
 *
 * noble reports the macOS identifier as `peripheral.id`, which is the bare 32-hex
 * form with no dashes (e.g. `360c96baf290475b14ce7c28aa3b8e81`). The setup wizard
 * stores that value verbatim, so the config schema, the env-var loader and the
 * wizard must all accept it. The standard dashed 8-4-4-4-12 form is accepted too,
 * so a value pasted from another tool still validates (#212).
 *
 * Leaf module with no imports: `config/` and `wizard/` import it without any risk
 * of an import cycle.
 */
const MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const CB_UUID_REGEX =
  /^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|[0-9A-Fa-f]{32})$/;

/** Human-readable hint reused in every "invalid scale id" message. */
export const SCALE_ID_HINT = 'a MAC address (XX:XX:XX:XX:XX:XX) or CoreBluetooth UUID';

/** True when `v` is a valid scale identifier (MAC or CoreBluetooth UUID). */
export function isValidScaleId(v: string): boolean {
  return MAC_REGEX.test(v) || CB_UUID_REGEX.test(v);
}
