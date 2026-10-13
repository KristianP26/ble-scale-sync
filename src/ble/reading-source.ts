import type { ScaleAdapter, UserProfile, ScaleAuth } from '../interfaces/scale-adapter.js';
import type { RawReading } from './shared.js';
import type { WeightUnit } from '../config/schema.js';

/**
 * The user profile a watcher hands to a GATT session: a fixed value, or a
 * function the watcher calls once at the start of every session.
 *
 * A function, because the profile is not static while the process runs: the
 * processor moves `last_known_weight` in memory after every export, and a QN or
 * R-MSC04 adapter writes that anchor to the scale. A value captured when the
 * watcher was built kept a proxy install on its startup anchor for good (#331).
 */
export type ProfileSource = UserProfile | (() => UserProfile);

/** Resolve a {@link ProfileSource} now; `undefined` stays `undefined`. */
export function currentProfile(src: ProfileSource | undefined): UserProfile | undefined {
  return typeof src === 'function' ? src() : src;
}

/**
 * Config delivered to a {@link Watcher} on construction and on hot reload. The
 * shape is uniform across transports; a watcher ignores fields it does not use
 * (ha-bluetooth reads no GATT, so it ignores `scaleAuth` and `weightUnit`).
 * See #246.
 */
export interface WatcherConfig {
  adapters: ScaleAdapter[];
  targetMac?: string;
  profile?: ProfileSource;
  scaleAuth?: ScaleAuth;
  /**
   * Configured `scale.weight_unit`, for the GATT reads: a reading from an
   * adapter without `normalizesWeight` is converted from lbs when this is
   * 'lbs', exactly as on the native transports.
   */
  weightUnit?: WeightUnit;
}

/**
 * Event-driven reading source for the proxy transports (mqtt-proxy,
 * esphome-proxy). Structurally a superset of the loop's `ReadingSource`
 * (start/stop/nextReading) plus a uniform `updateConfig` hot-reload hook, so a
 * single `createReadingSource` factory can return either a watcher or a poll
 * source and the orchestrator never branches on transport. See #246.
 */
export interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  nextReading(signal?: AbortSignal): Promise<RawReading>;
  updateConfig(config: WatcherConfig): void;
  /**
   * Epoch ms of the last advertisement the transport delivered, from ANY
   * device, or null before the first one.
   *
   * A wedged proxy and an idle house are indistinguishable from `nextReading`,
   * which never resolves in either case (#281). Advertisements are the one
   * signal that separates them, because they flow constantly while the link is
   * alive and stop entirely when it is not. Taken BEFORE any `targetMac`
   * filtering on purpose: the scale itself only advertises while somebody is
   * standing on it, so it proves nothing about the transport.
   */
  lastTransportActivityMs(): number | null;
}
