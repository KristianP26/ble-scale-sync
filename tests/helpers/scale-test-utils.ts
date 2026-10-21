import { expect, vi } from 'vitest';
import type {
  BleDeviceInfo,
  ConnectionContext,
  UserProfile,
  BodyComposition,
  ScaleReading,
  ScaleAdapter,
} from '../../src/interfaces/scale-adapter.js';

export function mockPeripheral(
  name: string,
  uuids: string[] = [],
  manufacturerData?: BleDeviceInfo['manufacturerData'],
  charUuids?: string[],
): BleDeviceInfo {
  return {
    localName: name,
    serviceUuids: uuids,
    manufacturerData,
    ...(charUuids ? { characteristicUuids: charUuids } : {}),
  };
}

/**
 * A complete ConnectionContext with inert defaults. Typed on purpose: a test
 * that spells the literal out by hand drifts the moment the contract grows a
 * required member, and a renamed member must fail tsc, not read `undefined`.
 */
export function makeConnectionContext(
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    subscribe: vi.fn().mockResolvedValue(undefined),
    profile: defaultProfile(),
    deviceAddress: '',
    availableChars: new Set(),
    ...overrides,
  };
}

/** A complete BodyComposition, zeros except what the test sets. */
export function makeBodyComposition(overrides: Partial<BodyComposition> = {}): BodyComposition {
  return {
    weight: 0,
    impedance: 0,
    bmi: 0,
    bodyFatPercent: 0,
    waterPercent: 0,
    boneMass: 0,
    muscleMass: 0,
    visceralFat: 0,
    physiqueRating: 0,
    bmr: 0,
    metabolicAge: 0,
    ...overrides,
  };
}

export function defaultProfile(overrides?: Partial<UserProfile>): UserProfile {
  return {
    height: 183,
    age: 30,
    gender: 'male',
    isAthlete: false,
    ...overrides,
  };
}

export function assertPayloadRanges(payload: BodyComposition): void {
  if (payload.bmi !== 0) {
    expect(payload.bmi).toBeGreaterThanOrEqual(10);
    expect(payload.bmi).toBeLessThanOrEqual(60);
  }
  expect(payload.bodyFatPercent).toBeGreaterThanOrEqual(3);
  expect(payload.bodyFatPercent).toBeLessThanOrEqual(60);
  expect(payload.waterPercent).toBeGreaterThanOrEqual(20);
  expect(payload.waterPercent).toBeLessThanOrEqual(80);
  expect(payload.boneMass).toBeGreaterThanOrEqual(0);
  expect(payload.muscleMass).toBeGreaterThan(0);
  expect(payload.visceralFat).toBeGreaterThanOrEqual(1);
  expect(payload.visceralFat).toBeLessThanOrEqual(59);
  expect(payload.physiqueRating).toBeGreaterThanOrEqual(1);
  expect(payload.physiqueRating).toBeLessThanOrEqual(9);
  expect(payload.bmr).toBeGreaterThan(0);
  expect(payload.metabolicAge).toBeGreaterThanOrEqual(12);
}

// ─── Shared adapter harness (#185) ───────────────────────────────────────────
// Opt-in assertion helpers that collapse the per-file boilerplate (matches
// matrix, parse-then-assert-non-null, computeMetrics happy-path). They are
// plain assertion helpers — they do NOT generate describe/it, so bespoke
// per-adapter cases stay inline and readable alongside them.

/** A device under test: a bare local name (→ mockPeripheral) or a full BleDeviceInfo. */
export type DeviceLike = string | BleDeviceInfo;

function toDevice(d: DeviceLike): BleDeviceInfo {
  return typeof d === 'string' ? mockPeripheral(d) : d;
}

/**
 * Assert `matches()` is true for every `yes` device and false for every `no`
 * device. The failing device is named in the assertion message so a single
 * combined assertion still pinpoints the offender.
 */
export function expectMatches(
  adapter: Pick<ScaleAdapter, 'matches'>,
  cases: { yes?: DeviceLike[]; no?: DeviceLike[] },
): void {
  for (const d of cases.yes ?? []) {
    const dev = toDevice(d);
    expect(
      adapter.matches(dev),
      `expected matches(${dev.localName || JSON.stringify(dev)}) true`,
    ).toBe(true);
  }
  for (const d of cases.no ?? []) {
    const dev = toDevice(d);
    expect(
      adapter.matches(dev),
      `expected matches(${dev.localName || JSON.stringify(dev)}) false`,
    ).toBe(false);
  }
}

/**
 * Run `parseNotification`, assert it returned a reading, optionally assert
 * specific numeric fields, and return the (non-null) reading.
 */
export function parseOk(
  adapter: Pick<ScaleAdapter, 'parseNotification'>,
  data: Buffer,
  expected?: Partial<Record<keyof ScaleReading, number>>,
): ScaleReading {
  const reading = adapter.parseNotification(data);
  expect(reading).not.toBeNull();
  if (expected) {
    for (const [key, value] of Object.entries(expected)) {
      expect(reading![key as keyof ScaleReading], `reading.${key}`).toBeCloseTo(value as number, 4);
    }
  }
  return reading!;
}

/**
 * computeMetrics happy-path: assert the weight is echoed and the payload
 * passes the standard range sanity, then return it for any extra assertions.
 */
export function expectValidMetrics(
  adapter: Pick<ScaleAdapter, 'computeMetrics'>,
  reading: ScaleReading,
  profile: UserProfile = defaultProfile(),
): BodyComposition {
  const payload = adapter.computeMetrics(reading, profile);
  expect(payload.weight).toBeCloseTo(reading.weight, 4);
  assertPayloadRanges(payload);
  return payload;
}
