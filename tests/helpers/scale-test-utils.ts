import { expect } from 'vitest';
import type { Peripheral } from '@abandonware/noble';
import type { UserProfile, GarminPayload } from '../../src/interfaces/scale-adapter.js';

export function mockPeripheral(name: string, uuids: string[] = []): Partial<Peripheral> {
  return {
    id: 'aa:bb:cc:dd:ee:ff',
    address: 'aa:bb:cc:dd:ee:ff',
    advertisement: {
      localName: name,
      serviceUuids: uuids,
      txPowerLevel: 0,
      manufacturerData: Buffer.alloc(0),
      serviceData: [],
    },
  } as Partial<Peripheral>;
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

export function assertPayloadRanges(payload: GarminPayload): void {
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
