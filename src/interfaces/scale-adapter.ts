import type { MatchDescriptor } from '../scales/match-descriptor.js';
import type { WeightUnit } from '../config/schema.js';
export type { MatchDescriptor };

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

/**
 * A weight the scale is DISPLAYING but has not committed to (#356).
 *
 * Broadcast scales stream their settling weights while somebody steps on. A
 * Silvergear 108 capture that ends at 108.48 kg runs 39.60, 55.48, 83.46 and
 * 107.03 on the way, so none of it is a measurement and publishing any of it
 * would write a number the scale never showed.
 *
 * Deliberately NOT a `ScaleReading`, and deliberately missing the `impedance`
 * that `ScaleReading` requires. Every exporter path takes a `ScaleReading` or a
 * `RawReading`, so a value of this type cannot be handed to one: the type
 * checker refuses it rather than a reviewer having to notice. That is the whole
 * design. If this ever grows an `impedance`, the guarantee is gone.
 */
export interface LiveWeight {
  /** Kilograms. Provisional: correct for a display, wrong for a record. */
  weight: number;
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
  /**
   * ISO birth date (YYYY-MM-DD) when config supplied one. Body composition uses
   * `age`; this exists for scales that store a date of birth on the device, so
   * provisioning does not have to invent a 1 January anniversary (#229).
   */
  birthDate?: string;
  /**
   * Best estimate of what this person weighs, in kg, for protocols that send a
   * weight anchor to the scale before the weigh-in (QN, #75/#235).
   *
   * Not used by body composition, which derives everything from the measured
   * weight. Resolved from `users[].last_known_weight` when config has one and
   * from the midpoint of `users[].weight_range` otherwise, so it is populated
   * for every configured user without a new setting.
   */
  lastKnownWeight?: number;
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
  /** Write the configured profile into a scale that has nothing stored (#229). */
  provision?: boolean;
  /**
   * Create a SIG user record on the scale (User Control Point 0x01) instead of
   * consenting to an existing one (#335).
   *
   * A SIG user exists only after that operation, and only the vendor app
   * normally performs it, so a scale whose user was registered by the app
   * refuses every consent from another client. Opt-in and one-shot: it writes a
   * record to the device and the slots are finite.
   */
  registerNewUser?: boolean;
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
  /**
   * Configured display unit (`scale.weight_unit`). Adapters whose protocol tells
   * the scale which unit to show (e.g. the QN 0x13 config command) honour this so
   * a read does not flip the scale's display (#269). Optional and ignored by
   * adapters that do not write a unit.
   */
  weightUnit?: WeightUnit;
  /**
   * Protocol byte the QN handshake echoes back (`ble.qn_protocol_byte`).
   *
   * The value the firmware accepts differs across the family and cannot be
   * detected: a scale on the wrong byte acknowledges every command and simply
   * never streams a weight, which looks identical to nobody standing on it.
   * The frame length picks a default; this overrides it (#75, #331).
   */
  qnProtocolByte?: number;
  /**
   * Payload byte of the QN A00D history-response frame (`ble.qn_report_byte`).
   *
   * Defaults to 0xFE, the value openScale's ES-30M capture uses. Two vendor-app
   * captures on other firmware in the family send 0xFC instead, from sessions
   * that read successfully where this adapter saw the whole handshake
   * acknowledged and then silence. What the byte selects is not decoded, so it
   * is a setting rather than a changed default (#235, #75, #331).
   */
  qnReportByte?: number;
  /**
   * Acknowledge every live QN weight frame with its own weight
   * (`ble.qn_weight_ack`).
   *
   * The vendor app answers each 0x10 frame with `a2 06 01 <that frame's weight>`
   * (#235). The adapter does this on the 20-byte extended dialect, which is the
   * only one a capture covers. Unset keeps that gate; true enables it on every
   * dialect, for a scale that completes the handshake and then goes quiet;
   * false disables it everywhere.
   */
  qnWeightAck?: boolean;
}

/**
 * The always-present contract every scale adapter satisfies, plus the
 * cross-cutting optional hooks/flags the BLE handler and composition root read
 * generically (selection metadata, init hook, link-security flag, unit flag,
 * runtime-config injection). Capability bundles that only SOME adapters provide
 * live in the separate mixin interfaces below; an adapter opts into them with
 * `implements ScaleAdapterCore, GattWiring, ...`.
 */
export interface ScaleAdapterCore {
  readonly name: string;

  /**
   * Declarative match descriptor: precedence (`priority`) plus the names,
   * services, characteristics, and manufacturer id this adapter claims.
   * OPTIONAL on the interface (so test mocks may omit it) but REQUIRED for every
   * adapter in the production registry, enforced by registry-check. Selection
   * metadata, not a capability: the resolver reads it off every array element.
   */
  readonly match?: MatchDescriptor;

  /** True if parseNotification() already converts any non-kg reading to kg. */
  readonly normalizesWeight?: boolean;

  /**
   * True if this adapter's characteristics need a bonded/encrypted BLE link
   * (e.g. the SIG User Data Service on the Beurer BF720). The node-ble handler
   * attempts a best-effort BLE pairing after connect and before subscribing.
   * Best-effort: a pairing failure is logged and the read proceeds unbonded.
   */
  readonly requiresBonding?: boolean;

  /**
   * Receive per-device runtime config (e.g. a MiBeacon bind key) from the
   * composition root at startup and on config reload. Optional: only adapters
   * that decrypt a per-device secret implement it.
   */
  configure?(opts: AdapterRuntimeConfig): void;

  /**
   * Multi-step init hook called after BLE connection and service discovery.
   * When defined, replaces the legacy unlockCommand periodic-write logic
   * entirely (see Unlockable). Use the ConnectionContext helpers to write,
   * read, subscribe during init. Kept on core rather than a mixin because it is
   * the primary init path that PRE-EMPTS Unlockable, not a capability layered on
   * top of it.
   */
  onConnected?(context: ConnectionContext): Promise<void> | void;

  /**
   * Called once when a GATT session ends, however it ends: a completed reading,
   * a disconnect, a timeout or an init failure.
   *
   * Adapters are shared singletons, so anything captured from a
   * `ConnectionContext` (a write function, a queued frame, a negotiated
   * password) outlives the link it belongs to. Without a teardown signal an
   * adapter cannot tell "no connection yet" from "the previous connection", and
   * writing through a stale context is silent data loss at best (#138).
   *
   * Must not throw and must not perform I/O: the session is already gone.
   */
  onSessionEnd?(): void;

  /**
   * Set only on the wrapper produced by `ble.force_scale_adapter`.
   *
   * Detection normally guarantees that an adapter was selected BY the
   * advertisement in front of it, and parts of the pipeline lean on that. A
   * forced adapter breaks the guarantee on purpose, so those places need to be
   * able to tell (see `hasParseableBroadcastSource`).
   */
  readonly isForcedOverride?: boolean;

  matches(device: BleDeviceInfo): boolean;
  parseNotification(data: Buffer): ScaleReading | null;
  isComplete(reading: ScaleReading): boolean;
  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition;
}

/**
 * Legacy single/dual GATT characteristic wiring. An adapter that connects over
 * GATT and is driven by the handler's notify+write seam declares this. Adapters
 * that are broadcast-only (no GATT) omit it entirely.
 */
export interface GattWiring {
  readonly charNotifyUuid: string;
  readonly charWriteUuid: string;
  /** Fallback notify UUID when the primary isn't found (e.g. QN Type 1 FFE1). */
  readonly altCharNotifyUuid?: string;
  /** Fallback write UUID when the primary isn't found (e.g. QN Type 1 FFE3). */
  readonly altCharWriteUuid?: string;
  /**
   * All characteristics this adapter needs (notify, write, read). When defined,
   * the handler subscribes to ALL 'notify' bindings and discovers all
   * 'write'/'read' ones. When absent, the handler falls back to the
   * charNotifyUuid + charWriteUuid pair.
   */
  readonly characteristics?: CharacteristicBinding[];
}

/**
 * Legacy periodic unlock-command capability. An adapter WITHOUT an `onConnected`
 * hook that needs the scale woken by a repeated write declares this. The handler
 * writes `unlockCommand` (or each of `unlockCommands`) to the write
 * characteristic every `unlockIntervalMs`. Adapters that handshake in
 * `onConnected` (which pre-empts this path) MUST NOT declare Unlockable; doing so
 * would be a placeholder, which this refactor removes.
 */
export interface Unlockable {
  readonly unlockCommand: number[];
  /** Multiple unlock commands to try in sequence (e.g. firmware variants). */
  readonly unlockCommands?: number[][];
  readonly unlockIntervalMs: number;
}

/**
 * Passive advertisement / broadcast parsing capability. Adapters that read a
 * weight (and sometimes impedance) directly from advertisement manufacturer or
 * service data declare the relevant members. All members are optional within the
 * capability because adapters mix and match (broadcast-only, service-data-only,
 * dual GATT+broadcast). This is a NAMED OPTIONAL GROUPING, not a hard contract:
 * `implements BroadcastSource` documents intent and shape-checks whatever member
 * the class declares, but does not force any single member to exist.
 */
export interface BroadcastSource {
  /**
   * True if this adapter prefers passive advertisement scanning over a GATT
   * connection. When set, broadcastScan is used even for connectable devices.
   * Adapters that set this must implement parseServiceData or parseBroadcast.
   */
  readonly preferPassive?: boolean;

  /**
   * Parse a weight reading from BLE advertisement manufacturer data. When
   * defined, the handler can extract a reading during scan without connecting.
   */
  parseBroadcast?(manufacturerData: Buffer): ScaleReading | null;

  /**
   * Parse a settling weight from advertisement manufacturer data (#356).
   *
   * Called only for frames `parseBroadcast` returned null for, so an adapter
   * MUST NOT return a value here for a frame it would have accepted there: one
   * frame reported through both channels would show a display a number twice
   * and, worse, blur the line this type exists to draw.
   *
   * The result reaches a live display and nothing else. It is not a reading, it
   * never completes a session, and it can never be exported.
   */
  parseLiveBroadcast?(manufacturerData: Buffer): LiveWeight | null;

  /**
   * Parse a weight reading from a single BLE advertisement service-data entry.
   * Called for each service-data UUID/value pair on each advertisement. Return
   * null to keep waiting. Combine with preferPassive=true to skip GATT entirely.
   */
  parseServiceData?(uuid: string, data: Buffer): ScaleReading | null;
}

/**
 * Multi-characteristic GATT notification dispatch capability. When an adapter
 * declares this, the handler calls parseCharNotification() INSTEAD OF
 * parseNotification() for every notify frame, passing the source characteristic
 * UUID so the adapter can route by char. This is a GATT notify concern (it pairs
 * with GattWiring `characteristics` and an `onConnected` handshake), NOT a
 * passive-broadcast parser, which is why it is its own mixin and not part of
 * BroadcastSource. Declared by trisa, beurer-bf720, eufy-p2, robi-s9, ade-a2,
 * renpho, renpho-msc04 and qn-scale.
 */
export interface MultiCharNotify {
  /**
   * Extended notification parser that receives the source characteristic UUID.
   * When defined, the handler calls this INSTEAD OF parseNotification() for every
   * notification. Enables multi-char dispatch.
   */
  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null;
}

/**
 * Per-frame acknowledgement capability. Some protocols gate multipart streaming
 * behind a per-frame echo (e.g. Beurer/Sanitas 0x59 composition). The handler
 * resolves the write char once and fires `buildAck` write-and-forget for every
 * notify frame, including frames that parseNotification drops.
 */
export interface AckProtocol {
  /**
   * Build an immediate per-frame acknowledgement to write back to the write
   * characteristic after each notification. Return null to write nothing.
   */
  buildAck(data: Buffer): Buffer | number[] | null;

  /**
   * Whether the ACK is written with a response. Defaults to true, which keeps
   * the Beurer/Sanitas behaviour. Vendor OEM write characteristics in the
   * 0xFFF0 and 0xFFB0 families are often write-without-response only, and there
   * a with-response write is rejected by BlueZ, so the ACK never lands and the
   * scale never starts streaming. Those adapters set this false.
   */
  readonly ackWithResponse?: boolean;
}

/**
 * Hold-open-for-composition capability. After `isComplete()` first returns true
 * for a non-final reading the handler keeps the GATT link open for up to
 * `completionHoldMs`, still feeding frames, so a richer reading (e.g.
 * bioimpedance composition arriving a few seconds after the weight settles) can
 * land. On timeout the last complete reading resolves.
 */
export interface HoldForComposition {
  /**
   * Hold window in milliseconds. OPTIONAL inside the mixin because a real
   * adapter (Beurer/Sanitas) exposes it through a getter typed
   * `number | undefined` that returns undefined for the BF700/800 variant
   * (no hold) and a number for the BF710/SBF70 variant. `shared.ts` already
   * treats absence as "no hold" (`adapter.completionHoldMs ?? 0` at the timer
   * site and `adapter.completionHoldMs && !final` at the gate), so undefined is
   * safe. See the grouping note: HoldForComposition is a NAMED optional
   * grouping, not a hard required-member contract.
   */
  readonly completionHoldMs?: number;
  /**
   * Return true when the reading is the rich/final one (e.g. carries
   * composition) so the handler resolves immediately instead of waiting out the
   * hold window. Only consulted while completionHoldMs is set.
   */
  isFinal?(reading: ScaleReading): boolean;
}

/**
 * The registry element type. Core is required; every capability mixin is folded
 * in as a Partial so ANY adapter (and any strict-object-literal test mock) is
 * assignable, the production `ScaleAdapter[]` registry stays homogeneous, and
 * every capability property name remains a known optional member (so the
 * handler's existing absence-guarded reads keep compiling). Individual adapter
 * CLASSES opt into the named mixins they satisfy via
 * `implements ScaleAdapterCore, GattWiring, Unlockable` for author-facing
 * clarity and compile-time checking of that specific bundle.
 */
export type ScaleAdapter = ScaleAdapterCore &
  Partial<GattWiring> &
  Partial<Unlockable> &
  Partial<BroadcastSource> &
  Partial<MultiCharNotify> &
  Partial<AckProtocol> &
  Partial<HoldForComposition>;
