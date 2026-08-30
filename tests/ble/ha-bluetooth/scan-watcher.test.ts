import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BleDeviceInfo, ScaleAdapter } from '../../../src/interfaces/scale-adapter.js';
import type { AdvertCallback } from '../../../src/ble/handler-ha-bluetooth/client.js';

// ─── Fake client (replaces the websocket layer) ───────────────────────────────

class FakeHaBluetoothClient {
  static instances: FakeHaBluetoothClient[] = [];
  static failStart: Error | null = null;
  readonly subscribers = new Set<AdvertCallback>();
  started = false;
  stopped = false;
  constructor(
    public readonly config: unknown,
    public readonly opts: unknown,
  ) {
    FakeHaBluetoothClient.instances.push(this);
  }
  async start(): Promise<void> {
    if (FakeHaBluetoothClient.failStart) throw FakeHaBluetoothClient.failStart;
    this.started = true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  onAdvertisement(cb: AdvertCallback): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
  emit(info: BleDeviceInfo, address: string): void {
    for (const cb of this.subscribers) cb(info, address, {} as never);
  }
}

vi.mock('../../../src/ble/handler-ha-bluetooth/client.js', () => ({
  HaBluetoothClient: FakeHaBluetoothClient,
}));

const { scanAndReadRaw, scanDevices, ReadingWatcher } =
  await import('../../../src/ble/handler-ha-bluetooth/index.js');

// ─── Adapter doubles ──────────────────────────────────────────────────────────

const CONFIG = { url: 'http://ha.local:8123', token: 'tok' };
const PROFILE = { height: 180, age: 30, gender: 'male' as const, isAthlete: false };
const MAC = 'F8:83:06:4E:B6:7E';

/** Broadcast adapter: any manufacturer frame is a complete reading. */
function makeBroadcastAdapter(): ScaleAdapter {
  return {
    name: 'Broadcast Test',
    match: { priority: 50, custom: true },
    matches: (d) => d.localName === 'BCAST',
    parseBroadcast: (data) => ({ weight: data[0], impedance: 0 }),
    parseNotification: () => null,
    isComplete: () => true,
    computeMetrics: (r) => ({
      weight: r.weight,
      impedance: r.impedance,
      bmi: 22,
      bodyFatPercent: 15,
      waterPercent: 55,
      boneMass: 3,
      muscleMass: 40,
      visceralFat: 5,
      physiqueRating: 5,
      bmr: 1700,
      metabolicAge: 30,
    }),
  } as unknown as ScaleAdapter;
}

/** Passive adapter (Mi-Scale-like): weight-only frames are partial until impedance arrives. */
function makePassiveAdapter(): ScaleAdapter {
  return {
    ...makeBroadcastAdapter(),
    name: 'Passive Test',
    preferPassive: true,
    matches: (d: BleDeviceInfo) => d.localName === 'PASSIVE',
    parseServiceData: (_uuid: string, data: Buffer) => ({ weight: data[0], impedance: data[1] }),
    parseBroadcast: undefined,
    isComplete: (r: { impedance: number }) => r.impedance > 0,
  } as unknown as ScaleAdapter;
}

/** GATT-only adapter: no broadcast parser, needs a connection. */
function makeGattAdapter(): ScaleAdapter {
  return {
    ...makeBroadcastAdapter(),
    name: 'GATT Test',
    matches: (d: BleDeviceInfo) => d.localName === 'GATT',
    parseBroadcast: undefined,
    charNotifyUuid: 'fff4',
  } as unknown as ScaleAdapter;
}

const bcast = (kg: number): BleDeviceInfo => ({
  localName: 'BCAST',
  serviceUuids: [],
  manufacturerData: { id: 1, data: Buffer.from([kg]) },
});
const passive = (kg: number, z: number): BleDeviceInfo => ({
  localName: 'PASSIVE',
  serviceUuids: [],
  serviceData: [{ uuid: '181b', data: Buffer.from([kg, z]) }],
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeHaBluetoothClient.instances = [];
  FakeHaBluetoothClient.failStart = null;
});
afterEach(() => vi.useRealTimers());

function client(): FakeHaBluetoothClient {
  return FakeHaBluetoothClient.instances[0];
}

// ─── scanAndReadRaw ───────────────────────────────────────────────────────────

describe('ha-bluetooth scanAndReadRaw', () => {
  it('throws when ha_bluetooth config is missing', async () => {
    await expect(scanAndReadRaw({ adapters: [], profile: PROFILE })).rejects.toThrow(
      /ha_bluetooth config is required/,
    );
  });

  it('resolves with a broadcast reading and stops the client', async () => {
    const p = scanAndReadRaw({
      adapters: [makeBroadcastAdapter()],
      profile: PROFILE,
      haBluetooth: CONFIG,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client().opts).toMatchObject({ reconnect: false });
    client().emit(bcast(75), MAC);
    const raw = await p;
    expect(raw.reading).toEqual({ weight: 75, impedance: 0 });
    expect(raw.adapter.name).toBe('Broadcast Test');
    expect(client().stopped).toBe(true);
  });

  it('filters by targetMac', async () => {
    const p = scanAndReadRaw({
      adapters: [makeBroadcastAdapter()],
      profile: PROFILE,
      haBluetooth: CONFIG,
      targetMac: MAC,
    });
    await vi.advanceTimersByTimeAsync(0);
    client().emit(bcast(60), '11:22:33:44:55:66');
    client().emit(bcast(75), MAC.toLowerCase());
    expect((await p).reading.weight).toBe(75);
  });

  it('holds a partial passive frame and completes on the impedance frame', async () => {
    const p = scanAndReadRaw({
      adapters: [makePassiveAdapter()],
      profile: PROFILE,
      haBluetooth: CONFIG,
    });
    await vi.advanceTimersByTimeAsync(0);
    client().emit(passive(70, 0), MAC);
    await vi.advanceTimersByTimeAsync(3_000);
    client().emit(passive(70, 120), MAC);
    expect((await p).reading).toEqual({ weight: 70, impedance: 120 });
  });

  it('falls back to the weight-only frame after the grace window', async () => {
    const p = scanAndReadRaw({
      adapters: [makePassiveAdapter()],
      profile: PROFILE,
      haBluetooth: CONFIG,
    });
    await vi.advanceTimersByTimeAsync(0);
    client().emit(passive(70, 0), MAC);
    await vi.advanceTimersByTimeAsync(12_001);
    expect((await p).reading).toEqual({ weight: 70, impedance: 0 });
  });

  it('times out when nothing matches', async () => {
    const p = scanAndReadRaw({
      adapters: [makeBroadcastAdapter()],
      profile: PROFILE,
      haBluetooth: CONFIG,
    });
    const assertion = expect(p).rejects.toThrow(/Timed out waiting for any recognized scale/);
    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;
    expect(client().stopped).toBe(true);
  });

  it('propagates a client start failure', async () => {
    FakeHaBluetoothClient.failStart = new Error('auth_invalid');
    await expect(
      scanAndReadRaw({ adapters: [makeBroadcastAdapter()], profile: PROFILE, haBluetooth: CONFIG }),
    ).rejects.toThrow('auth_invalid');
  });
});

// ─── scanDevices ──────────────────────────────────────────────────────────────

describe('ha-bluetooth scanDevices', () => {
  it('collects unique devices with their matched adapter and keeps late names', async () => {
    const p = scanDevices([makeBroadcastAdapter()], 5_000, CONFIG);
    await vi.advanceTimersByTimeAsync(0);
    client().emit({ localName: '', serviceUuids: [] }, MAC);
    client().emit(bcast(70), MAC);
    client().emit({ localName: 'Other', serviceUuids: ['180f'] }, 'AA:AA:AA:AA:AA:AA');
    await vi.advanceTimersByTimeAsync(5_000);
    const results = await p;
    expect(results).toEqual([
      { address: MAC, name: 'BCAST', matchedAdapter: 'Broadcast Test' },
      { address: 'AA:AA:AA:AA:AA:AA', name: 'Other', matchedAdapter: undefined },
    ]);
    expect(client().stopped).toBe(true);
  });
});

// ─── ReadingWatcher ───────────────────────────────────────────────────────────

describe('ha-bluetooth ReadingWatcher', () => {
  it('enqueues broadcast readings, dedups repeats, and stamps liveness', async () => {
    const w = new ReadingWatcher(CONFIG, [makeBroadcastAdapter()], undefined, PROFILE);
    expect(w.lastTransportActivityMs()).toBeNull();
    await w.start();
    await w.start(); // idempotent
    expect(FakeHaBluetoothClient.instances).toHaveLength(1);
    const t0 = w.lastTransportActivityMs();
    expect(t0).not.toBeNull();

    vi.advanceTimersByTime(1000);
    client().emit(bcast(75), MAC);
    client().emit(bcast(75), MAC); // dedup window
    expect(w.lastTransportActivityMs()).toBeGreaterThan(t0!);
    const first = await w.nextReading();
    expect(first.reading.weight).toBe(75);

    vi.advanceTimersByTime(31_000);
    client().emit(bcast(75), MAC);
    expect((await w.nextReading()).reading.weight).toBe(75);
    await w.stop();
    expect(client().stopped).toBe(true);
    expect(w.lastTransportActivityMs()).toBeNull();
  });

  it('stamps liveness for non-target devices but does not read them', async () => {
    const w = new ReadingWatcher(CONFIG, [makeBroadcastAdapter()], MAC, PROFILE);
    await w.start();
    const t0 = w.lastTransportActivityMs()!;
    vi.advanceTimersByTime(500);
    client().emit(bcast(50), '11:11:11:11:11:11');
    expect(w.lastTransportActivityMs()).toBeGreaterThan(t0);
    client().emit(bcast(80), MAC);
    expect((await w.nextReading()).reading.weight).toBe(80);
    await w.stop();
  });

  it('applies the grace fallback for passive adapters', async () => {
    const w = new ReadingWatcher(CONFIG, [makePassiveAdapter()], undefined, PROFILE);
    await w.start();
    client().emit(passive(70, 0), MAC);
    await vi.advanceTimersByTimeAsync(12_001);
    expect((await w.nextReading()).reading).toEqual({ weight: 70, impedance: 0 });
    await w.stop();
  });

  it('warns once for GATT-only scales instead of connecting', async () => {
    const { bleLog } = await import('../../../src/ble/types.js');
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const w = new ReadingWatcher(CONFIG, [makeGattAdapter()], undefined, PROFILE);
    await w.start();
    warn.mockClear();
    client().emit({ localName: 'GATT', serviceUuids: ['fff0'] }, MAC);
    client().emit({ localName: 'GATT', serviceUuids: ['fff0'] }, MAC);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/needs a GATT connection/);
    await w.stop();
    warn.mockRestore();
  });

  it('updateConfig swaps adapters and target', async () => {
    const w = new ReadingWatcher(CONFIG, [makeBroadcastAdapter()], undefined, PROFILE);
    await w.start();
    w.updateConfig({ adapters: [makePassiveAdapter()], targetMac: MAC });
    client().emit(bcast(75), MAC); // no longer matched
    client().emit(passive(66, 200), MAC);
    expect((await w.nextReading()).reading).toEqual({ weight: 66, impedance: 200 });
    await w.stop();
  });

  it('propagates start failures and resets state', async () => {
    FakeHaBluetoothClient.failStart = new Error('nope');
    const w = new ReadingWatcher(CONFIG, [makeBroadcastAdapter()], undefined, PROFILE);
    await expect(w.start()).rejects.toThrow('nope');
    FakeHaBluetoothClient.failStart = null;
    await w.start();
    expect(FakeHaBluetoothClient.instances).toHaveLength(2);
    await w.stop();
  });
});
