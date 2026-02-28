export type Gender = 'male' | 'female';

/** Minimal BLE advertisement info needed for adapter matching. */
export interface BleDeviceInfo {
  localName: string;
  serviceUuids: string[];
  /** Manufacturer-specific data from the BLE advertisement (if present). */
  manufacturerData?: { id: number; data: Buffer };
}

export interface ScaleReading {
  weight: number;
  impedance: number;
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
}

/**
 * Provided to `onConnected()` so the adapter can perform multi-step handshakes,
 * subscribe to additional characteristics, and read/write data during init.
 */
export interface ConnectionContext {
  /** Write data to a characteristic identified by UUID. */
  write(charUuid: string, data: Buffer | number[], withResponse?: boolean): Promise<void>;
  /** Read data from a characteristic identified by UUID. */
  read(charUuid: string): Promise<Buffer>;
  /** Subscribe to notifications from an additional characteristic (dynamically). */
  subscribe(charUuid: string): Promise<void>;
  /** User profile from .env configuration. */
  profile: UserProfile;
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
  readonly unlockIntervalMs: number;
  /** True if parseNotification() already converts any non-kg reading to kg. */
  readonly normalizesWeight?: boolean;

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

  matches(device: BleDeviceInfo): boolean;
  parseNotification(data: Buffer): ScaleReading | null;
  isComplete(reading: ScaleReading): boolean;
  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition;
}
