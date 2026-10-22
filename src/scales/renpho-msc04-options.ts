import { z } from 'zod';

const PROFILE_BYTE_HINT = 'Must be one byte as two hex digits (0-9, a-f) in quotes';

/**
 * The `ble.rmsc04_*` config keys, owned here and placed into BleSchema by
 * src/config/schema.ts (D076). configure() gets each one camelCased
 * (`rmsc04_profile_byte` -> `rmsc04ProfileByte`), see AdapterOptions.
 */
export const RMSC04_BLE_OPTIONS = {
  /**
   * The b2 [11] byte the Renpho app writes to the R-MSC04 for its own user
   * (#434). It is not decoded; most likely it carries sex and age. Copy it from
   * an HCI snoop log of the app.
   *
   * Set, the guest b2 carries this byte instead of a9, and the scale's own body
   * fat and visceral fat are exported for the first user, but only when the
   * scale computed them for the profile we sent. Unset, the guest byte a9 goes
   * out and the payload is the estimate, as before.
   *
   * A string, because YAML reads an unquoted 99 as a decimal number. The byte is
   * personal and is never logged. Not yet confirmed on hardware.
   */
  rmsc04_profile_byte: z
    .string(PROFILE_BYTE_HINT)
    .regex(/^[0-9a-fA-F]{2}$/, PROFILE_BYTE_HINT)
    .optional()
    .nullable(),
};
