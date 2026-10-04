import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the two watcher modules so the factory constructs arg-capturing fakes
// (and so the real mqtt/esphome transport deps are never loaded).
const h = vi.hoisted(() => {
  class FakeMqttWatcher {
    args: unknown[];
    constructor(...a: unknown[]) {
      this.args = a;
    }
  }
  class FakeEsphomeWatcher {
    args: unknown[];
    constructor(...a: unknown[]) {
      this.args = a;
    }
  }
  return { FakeMqttWatcher, FakeEsphomeWatcher };
});

vi.mock('../../src/ble/handler-mqtt-proxy/index.js', () => ({ ReadingWatcher: h.FakeMqttWatcher }));
vi.mock('../../src/ble/handler-esphome-proxy/index.js', () => ({
  ReadingWatcher: h.FakeEsphomeWatcher,
}));

const { createReadingSource } = await import('../../src/ble/index.js');
import type { ScaleAdapter, UserProfile, ScaleAuth } from '../../src/interfaces/scale-adapter.js';

const ADAPTERS = [{ name: 'A' }] as unknown as ScaleAdapter[];
const PROFILE = { height: 170, age: 30, gender: 'male', isAthlete: false } as UserProfile;
const AUTH = { pin: 1234, userIndex: 2 } as ScaleAuth;

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
  it('mqtt-proxy returns a watcher with scaleAuth and weightUnit forwarded + mqtt prefix', async () => {
    const mqttProxy = { broker_url: 'x' } as never;
    const plan = await createReadingSource({
      bleHandler: 'mqtt-proxy',
      mqttProxy,
      adapters: ADAPTERS,
      targetMac: 'AA:BB:CC:DD:EE:FF',
      profile: PROFILE,
      scaleAuth: AUTH,
      weightUnit: 'lbs',
    });
    expect(plan.kind).toBe('watcher');
    if (plan.kind !== 'watcher') return;
    expect(plan.failureLogPrefix).toBe('Error processing reading');
    expect(plan.watcher).toBeInstanceOf(h.FakeMqttWatcher);
    // scaleAuth is forwarded like it is to the ESPHome watcher. Dropping it here
    // left a configured consent PIN unseen on this transport (B-15).
    expect((plan.watcher as unknown as { args: unknown[] }).args).toEqual([
      mqttProxy,
      ADAPTERS,
      'AA:BB:CC:DD:EE:FF',
      PROFILE,
      AUTH,
      'lbs',
    ]);
  });

  it('esphome-proxy returns a watcher with 6 ctor args (scaleAuth, weightUnit forwarded) + esphome prefix', async () => {
    const esphomeProxy = { host: 'h' } as never;
    const plan = await createReadingSource({
      bleHandler: 'esphome-proxy',
      esphomeProxy,
      adapters: ADAPTERS,
      targetMac: 'AA:BB:CC:DD:EE:FF',
      profile: PROFILE,
      scaleAuth: AUTH,
      weightUnit: 'lbs',
    });
    expect(plan.kind).toBe('watcher');
    if (plan.kind !== 'watcher') return;
    expect(plan.failureLogPrefix).toBe('Error processing ESPHome reading');
    expect(plan.watcher).toBeInstanceOf(h.FakeEsphomeWatcher);
    expect((plan.watcher as unknown as { args: unknown[] }).args).toEqual([
      esphomeProxy,
      ADAPTERS,
      'AA:BB:CC:DD:EE:FF',
      PROFILE,
      AUTH,
      'lbs',
    ]);
  });

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
