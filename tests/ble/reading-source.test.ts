import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createReadingSource } from '../../src/ble/index.js';
import type { ScaleAdapter, UserProfile } from '../../src/interfaces/scale-adapter.js';

const ADAPTERS = [{ name: 'A' }] as unknown as ScaleAdapter[];
const PROFILE = { height: 170, age: 30, gender: 'male', isAthlete: false } as UserProfile;

const ORIG_PLATFORM = process.platform;
const ORIG_DRIVER = process.env.NOBLE_DRIVER;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  delete process.env.NOBLE_DRIVER;
});
afterEach(() => {
  setPlatform(ORIG_PLATFORM);
  if (ORIG_DRIVER === undefined) delete process.env.NOBLE_DRIVER;
  else process.env.NOBLE_DRIVER = ORIG_DRIVER;
});

describe('createReadingSource (#246)', () => {
  it('mqtt-proxy selected but mqttProxy undefined falls through to poll', async () => {
    const plan = await createReadingSource({
      bleHandler: 'mqtt-proxy',
      adapters: ADAPTERS,
      profile: PROFILE,
    });
    expect(plan).toEqual({ kind: 'poll', appliesGraceFloor: false });
  });

  it('esphome-proxy selected but esphomeProxy undefined falls through to poll', async () => {
    const plan = await createReadingSource({
      bleHandler: 'esphome-proxy',
      adapters: ADAPTERS,
      profile: PROFILE,
    });
    expect(plan).toEqual({ kind: 'poll', appliesGraceFloor: false });
  });

  it('native Linux default resolves to a poll plan with the node-ble grace floor', async () => {
    setPlatform('linux');
    const plan = await createReadingSource({ adapters: ADAPTERS, profile: PROFILE });
    expect(plan).toEqual({ kind: 'poll', appliesGraceFloor: true });
  });

  it('native macOS default resolves to a poll plan without the grace floor', async () => {
    setPlatform('darwin');
    const plan = await createReadingSource({ adapters: ADAPTERS, profile: PROFILE });
    expect(plan).toEqual({ kind: 'poll', appliesGraceFloor: false });
  });
});
