export type Gender = 'male' | 'female';

/** Minimal BLE advertisement info needed for adapter matching. */
export interface BleDeviceInfo {
  localName: string;
  serviceUuids: string[];
  /** Manufacturer-specific data from the BLE advertisement (if present). */
  manufacturerData?: { id: number; data: Buffer };
  /** Service data entries from the BLE advertisement (if present). */
  serviceData?: Array<{ uuid: string; data: Buffer }>;
  /**
   * GATT characteristic UUIDs (full 128-bit lowercase form), populated only
   * post-discovery. Lets adapters that share a vendor service (e.g. 0xFFF0:
   * 1byone vs Inlife) disambiguate by their own characteristics. Absent on
   * pre-connect / broadcast match paths.
   */
  characteristicUuids?: string[];
}

export interface ScaleReading {
  weight: number;
  impedance: number;
  /**
   * When set, marks this reading as historical: the scale dumped it from its
   * onboard cache rather than producing it live. Adapters populate it for
   * offline frames whose protocol carries an age field (e.g. ES-26BB-B 0x15
   * `secondsAgo`). Consumers route timestamped readings into the cache-replay
   * pipeline; live readings leave it undefined.
   */
  timestamp?: Date;
}

export interface UserProfile {
  height: number;
  age: number;
  gender: Gender;
  isAthlete: boolean;
}

export interface BodyComposition {
  weight: number;
  impedance: number;
  bmi: number;
  bodyFatPercent: number;
  waterPercent: number;
  boneMass: number;
  muscleMass: number;
  visceralFat: number;
  physiqueRating: number;
  bmr: number;
  metabolicAge: number;
}

/** Describes a BLE characteristic binding for multi-char adapters. */
export interface CharacteristicBinding {
  /** Service UUID (optional — omit when the device has only one relevant service). */
  service?: string;
  /** Characteristic UUID. */
  uuid: string;
  /** How this characteristic is used. */
  type: 'notify' | 'write' | 'read';
  /**
   * Mark the binding as optional. When true, the BLE handler will not fail if
   * the characteristic is missing, and will skip auto-subscribing to it when
   * `type === 'notify'`. Used by adapters that handle multiple firmware
   * variants where some chars are present on one variant but not the other
   * (e.g. Trisa + ADE BA 1600).
   *
   * NOTE: only `notify` bindings are auto-skipped. For optional `write`/`read`
   * bindings the adapter's `onConnected` MUST consult `ctx.availableChars`
   * before issuing the write/read; otherwise the call throws at runtime when
   * the char is missing.
   */
  optional?: boolean;
}

/**
 * Provided to `onConnected()` so the adapter can perform multi-step handshakes,
 * subscribe to additional characteristics, and read/write data during init.
 */
/**
 * Optional device-authentication material resolved from the primary user's
 * config (config.yaml `users[].beurer_pin` / `beurer_user_index`). Used by
 * adapters whose scale gates measurements behind a consent code (Beurer SIG
 * BF720 / BF105). Absent for every other adapter.
 */
export interface ScaleAuth {
  /** Consent code (0-9999) the scale was paired with. */
  pin?: number;
  /** Scale user slot index the consent applies to (defaults to 1). */
  userIndex?: number;
}

export interface ConnectionContext {
  /** Write data to a characteristic identified by UUID. */
  write(charUuid: string, data: Buffer | number[], withResponse?: boolean): Promise<void>;
  /** Read data from a characteristic identified by UUID. */
  read(charUuid: string): Promise<Buffer>;
  /** Subscribe to notifications from an additional characteristic (dynamically). */
  subscribe(charUuid: string): Promise<void>;
  /** User profile from .env configuration. */
  profile: UserProfile;
  /** Optional consent material for scales that need a PIN (Beurer SIG). */
  scaleAuth?: ScaleAuth;
  /**
   * Device identifier used by adapters that derive keys from MAC (e.g. Eufy T9148/T9149).
   * Uppercase, no separators. Empty string when unavailable (e.g. macOS CoreBluetooth UUID).
   */
  deviceAddress: string;
  /**
   * Set of characteristic UUIDs (normalized 32-char hex, lowercase) that were
   * actually discovered on the connected device. Adapters with `optional`
   * bindings can use this to detect firmware variants and switch behavior.
   * Always populated for adapters with an `onConnected` hook, regardless of
   * whether `characteristics` is declared.
   */
  availableChars: ReadonlySet<string>;
}

/**
 * Per-device runtime configuration injected into adapters at startup (and on
 * config reload) by the composition root. Distinct from the static registry:
 * carries credentials that only exist in the user's config, e.g. the Xiaomi
 * S800 MiBeacon bind key. Adapters that do not need it omit `configure`.
 */
export interface AdapterRuntimeConfig {
  /** MiBeacon bind key (32 hex chars) for broadcast-encrypted scales (Xiaomi S800). */
  bindKey?: string;
}

export interface ScaleAdapter {
  readonly name: string;
  readonly charNotifyUuid: string;
  readonly charWriteUuid: string;
  /** Fallback notify UUID when the primary isn't found (e.g. QN Type 1 FFE1). */
  readonly altCharNotifyUuid?: string;
  /** Fallback write UUID when the primary isn't found (e.g. QN Type 1 FFE3). */
  readonly altCharWriteUuid?: string;
  readonly unlockCommand: number[];
  /** Multiple unlock commands to try in sequence (e.g. different firmware variants). */
  readonly unlockCommands?: number[][];
  readonly unlockIntervalMs: number;
  /** True if parseNotification() already converts any non-kg reading to kg. */
  readonly normalizesWeight?: boolean;
  /**
   * True if this adapter prefers passive advertisement scanning over a GATT
   * connection. When set, broadcastScan is used even for connectable devices.
   * Adapters that set this must implement parseServiceData or parseBroadcast.
   */
  readonly preferPassive?: boolean;

  /**
   * Receive per-device runtime config (e.g. a MiBeacon bind key) from the
   * composition root at startup and on config reload. Optional: only adapters
   * that decrypt a per-device secret implement it.
   */
  configure?(opts: AdapterRuntimeConfig): void;

  /**
   * True if this adapter's characteristics need a bonded/encrypted BLE link
   * (e.g. the SIG User Data Service on the Beurer BF720). The node-ble handler
   * attempts a best-effort BLE pairing after connect and before subscribing.
   * Best-effort: a pairing failure is logged and the read proceeds unbonded.
   */
  readonly requiresBonding?: boolean;

  /**
   * All characteristics this adapter needs (notify, write, read).
   * When defined, ble.ts subscribes to ALL 'notify' bindings and discovers all 'write'/'read' ones.
   * When absent, ble.ts falls back to the legacy charNotifyUuid + charWriteUuid pair.
   */
  readonly characteristics?: CharacteristicBinding[];

  /**
   * Multi-step init hook called after BLE connection and service discovery.
   * When defined, replaces the legacy unlockCommand periodic-write logic entirely.
   * Use the ConnectionContext helpers to write, read, subscribe during init.
   */
  onConnected?(context: ConnectionContext): Promise<void> | void;

  /**
   * Extended notification parser that receives the source characteristic UUID.
   * When defined, ble.ts calls this INSTEAD OF parseNotification() for every notification.
   * Enables multi-char dispatch (different data from different characteristics).
   */
  parseCharNotification?(charUuid: string, data: Buffer): ScaleReading | null;

  /**
   * Parse a weight reading from BLE advertisement manufacturer data.
   * When defined, the handler can extract a reading during scan without connecting.
   * Used by broadcast-only scales that embed weight in advertisement data.
   */
  parseBroadcast?(manufacturerData: Buffer): ScaleReading | null;

  /**
   * Parse a weight reading from a single BLE advertisement service-data entry.
   * Called for each service-data UUID/value pair on each advertisement.
   * Return null to keep waiting (wrong UUID, unstable frame, etc.).
   * Combine with preferPassive=true to skip the GATT path entirely.
   */
  parseServiceData?(uuid: string, data: Buffer): ScaleReading | null;

  /**
   * Build an immediate per-frame acknowledgement to write back to the write
   * characteristic after each notification. Some protocols gate multipart
   * streaming behind a per-frame echo (e.g. Beurer/Sanitas 0x59 composition).
   * The handler resolves the write char once and fires this write-and-forget
   * for every notify frame, including frames that `parseNotification` drops.
   * Return null to write nothing.
   */
  buildAck?(data: Buffer): Buffer | number[] | null;

  /**
   * When set, after `isComplete()` first returns true for a non-final reading
   * the handler keeps the GATT link open for up to this many milliseconds,
   * still feeding frames to the adapter, so a richer reading (e.g. bioimpedance
   * composition that the scale only sends a few seconds after the weight
   * settles) can arrive. On timeout the last complete reading resolves. Leave
   * unset for adapters that resolve immediately on a complete reading.
   */
  readonly completionHoldMs?: number;

  /**
   * Only consulted while `completionHoldMs` is set. Return true when the reading
   * is the rich/final one (e.g. carries composition) so the handler resolves
   * immediately instead of waiting out the hold window.
   */
  isFinal?(reading: ScaleReading): boolean;

  matches(device: BleDeviceInfo): boolean;
  parseNotification(data: Buffer): ScaleReading | null;
  isComplete(reading: ScaleReading): boolean;
  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition;
}
