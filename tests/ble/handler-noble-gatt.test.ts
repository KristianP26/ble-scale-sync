import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type {
  BleDeviceInfo,
  BodyComposition,
  ScaleAdapter,
  ScaleReading,
} from '../../src/interfaces/scale-adapter.js';
import { createNobleHandler, type NobleApi } from '../../src/ble/handler-noble-shared/index.js';
import { bleLog, normalizeUuid } from '../../src/ble/types.js';

/**
 * The noble GATT path is the only transport on Windows and macOS (B-11). These
 * tests drive scanAndReadRaw end to end through a scripted noble: discovery
 * (target MAC and auto), the broadcast-vs-GATT decision, connect with retry,
 * sequential service discovery with the WinRT retry, the post-connect adapter
 * resolution, the reading itself, and the disconnect on every exit.
 *
 * Driver-level fakes only; the adapters below are test doubles that check what
 * the handler hands them, not real scale protocols, so no capture is involved.
 */

const SVC = '181d';
const NOTIFY = '2a9d';
const WRITE = '2a9e';
const MAC = 'aa:bb:cc:dd:ee:ff';

class FakeChar extends EventEmitter {
  writes: Buffer[] = [];
  constructor(
    public uuid: string,
    public properties: string[],
    private readonly onSubscribed?: (c: FakeChar) => void,
  ) {
    super();
  }
  subscribeAsync = vi.fn(async () => {
    if (this.onSubscribed) setTimeout(() => this.onSubscribed!(this), 5);
  });
  writeAsync = vi.fn(async (data: Buffer) => {
    this.writes.push(data);
  });
  readAsync = vi.fn(async () => Buffer.alloc(0));
}

class FakeService {
  characteristics: FakeChar[] | undefined = undefined;
  constructor(
    public uuid: string,
    private readonly chars: FakeChar[],
    private failFirstCharDiscovery = false,
  ) {}
  discoverCharacteristicsAsync = vi.fn(async () => {
    if (this.failFirstCharDiscovery) {
      this.failFirstCharDiscovery = false;
      throw new Error('AccessDenied');
    }
    this.characteristics = this.chars;
    return this.chars;
  });
}

interface PeripheralSpec {
  address?: string;
  localName?: string;
  serviceUuids?: string[];
  manufacturerData?: Buffer;
  serviceData?: Array<{ uuid: string; data: Buffer }>;
  connectable?: boolean;
  services?: FakeService[];
  connectFailures?: number;
  /** disconnectAsync settles without a 'disconnect' event (a dead WinRT link). */
  silentDisconnect?: boolean;
}

class FakePeripheral extends EventEmitter {
  id: string;
  address: string;
  connectable: boolean;
  advertisement: Pick<
    PeripheralSpec,
    'localName' | 'serviceUuids' | 'manufacturerData' | 'serviceData'
  >;
  private failuresLeft: number;
  constructor(private readonly spec: PeripheralSpec) {
    super();
    this.address = spec.address ?? MAC;
    this.id = this.address.replace(/:/g, '');
    this.connectable = spec.connectable ?? true;
    this.advertisement = {
      localName: spec.localName,
      serviceUuids: spec.serviceUuids ?? [],
      manufacturerData: spec.manufacturerData,
      serviceData: spec.serviceData ?? [],
    };
    this.failuresLeft = spec.connectFailures ?? 0;
  }
  connectAsync = vi.fn(async () => {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('connect failed');
    }
  });
  disconnectAsync = vi.fn(async () => {
    if (!this.spec.silentDisconnect) this.emit('disconnect');
  });
  discoverServicesAsync = vi.fn(async () => this.spec.services ?? []);
}

class FakeNoble extends EventEmitter {
  peripherals: FakePeripheral[] = [];
  startScanningAsync = vi.fn(async () => {
    // Every scan start re-delivers the scripted advertisements, like a radio
    // with allowDuplicates on.
    setTimeout(() => {
      for (const p of this.peripherals) this.emit('discover', p);
    }, 1);
  });
  stopScanningAsync = vi.fn(async () => {});
}

/** A reading arrives as one notification: byte 0 is the weight in kg. */
function weightOn(c: FakeChar): void {
  c.emit('data', Buffer.from([72]));
}

function gattAdapter(name: string, matches: (info: BleDeviceInfo) => boolean): ScaleAdapter {
  return {
    name,
    charNotifyUuid: NOTIFY,
    charWriteUuid: WRITE,
    unlockCommand: [0x01],
    unlockIntervalMs: 0,
    normalizesWeight: true,
    matches: vi.fn(matches),
    parseNotification: (data: Buffer): ScaleReading | null =>
      data.length > 0 ? { weight: data[0], impedance: 500 } : null,
    isComplete: (r: ScaleReading) => r.weight > 0 && r.impedance > 0,
    computeMetrics: (r: ScaleReading): BodyComposition => ({ weight: r.weight }) as BodyComposition,
  } as unknown as ScaleAdapter;
}

function standardServices(onSubscribed?: (c: FakeChar) => void, failFirst = false) {
  const notify = new FakeChar(NOTIFY, ['notify'], onSubscribed);
  const write = new FakeChar(WRITE, ['write']);
  return { notify, write, services: [new FakeService(SVC, [notify, write], failFirst)] };
}

const PROFILE = { height: 180, age: 30, gender: 'male', isAthlete: false } as const;

let noble: FakeNoble;
let handler: ReturnType<typeof createNobleHandler>;

beforeEach(() => {
  for (const level of ['debug', 'info', 'warn'] as const) {
    vi.spyOn(bleLog, level).mockImplementation(() => {});
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  noble = new FakeNoble();
  handler = createNobleHandler({
    noble: noble as unknown as NobleApi,
    getState: () => 'poweredOn',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Bound a discovery that would otherwise run for the full 120 s timeout. */
function shortScan(ms = 300): AbortSignal {
  return AbortSignal.timeout(ms);
}

describe('noble GATT path (B-11)', () => {
  it('target MAC: connects, discovers, resolves with advert + GATT evidence, reads, disconnects', async () => {
    const { notify, write, services } = standardServices(weightOn);
    const p = new FakePeripheral({
      localName: 'OEM-123',
      manufacturerData: Buffer.from([0x34, 0x12, 0xaa]),
      services,
    });
    noble.peripherals = [p];
    // Needs both the manufacturer id from the advertisement and the
    // characteristic found by discovery, so it can only match post-connect,
    // and only when that resolution carries both (#278).
    const adapter = gattAdapter(
      'NeedsBoth',
      (info) =>
        info.manufacturerData?.id === 0x1234 &&
        (info.characteristicUuids ?? []).includes(normalizeUuid(NOTIFY)),
    );

    const raw = await handler.scanAndReadRaw({
      targetMac: MAC.toUpperCase(),
      adapters: [adapter],
      profile: PROFILE,
    });

    expect(raw.adapter.name).toBe('NeedsBoth');
    expect(raw.reading.weight).toBe(72);
    expect(p.connectAsync).toHaveBeenCalledTimes(1);
    expect(services[0].discoverCharacteristicsAsync).toHaveBeenCalledTimes(1);
    expect(notify.subscribeAsync).toHaveBeenCalled();
    expect(write.writes[0]).toEqual(Buffer.from([0x01]));
    expect(p.disconnectAsync).toHaveBeenCalledTimes(1);
    // The resolver also asks on the advertisement alone, so pick the record
    // that carries the discovered characteristics.
    const resolved = vi
      .mocked(adapter.matches)
      .mock.calls.map((c) => c[0])
      .find((info) => info.characteristicUuids !== undefined)!;
    expect(resolved.address).toBe(MAC.toUpperCase());
    expect(resolved.serviceUuids).toContain(normalizeUuid(SVC));
  });

  it('auto-discovery: skips devices no adapter claims and reads the first one that matches', async () => {
    const { services } = standardServices(weightOn);
    const stranger = new FakePeripheral({ address: '11:22:33:44:55:66', localName: 'Headphones' });
    const scale = new FakePeripheral({ localName: 'FakeScale', services });
    noble.peripherals = [stranger, scale];
    const adapter = gattAdapter('ByName', (info) => info.localName === 'FakeScale');

    const raw = await handler.scanAndReadRaw({ adapters: [adapter], profile: PROFILE });

    expect(raw.adapter.name).toBe('ByName');
    expect(stranger.connectAsync).not.toHaveBeenCalled();
    expect(scale.disconnectAsync).toHaveBeenCalledTimes(1);
  });

  it('retries a failed connect and a failed WinRT characteristic discovery', async () => {
    const { services } = standardServices(weightOn, true);
    const p = new FakePeripheral({ localName: 'FakeScale', services, connectFailures: 1 });
    noble.peripherals = [p];
    const adapter = gattAdapter('ByName', (info) => info.localName === 'FakeScale');

    const raw = await handler.scanAndReadRaw({ adapters: [adapter], profile: PROFILE });

    expect(raw.reading.weight).toBe(72);
    expect(p.connectAsync).toHaveBeenCalledTimes(2);
    // Once between the two connect attempts, once at the end of the session.
    expect(p.disconnectAsync).toHaveBeenCalledTimes(2);
    expect(services[0].discoverCharacteristicsAsync).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('disconnects when no adapter recognizes the device after connecting', async () => {
    const { services } = standardServices();
    const p = new FakePeripheral({ localName: 'Mystery', services });
    noble.peripherals = [p];
    const adapter = gattAdapter('Nope', () => false);

    await expect(
      handler.scanAndReadRaw({ targetMac: MAC, adapters: [adapter], profile: PROFILE }),
    ).rejects.toThrow(/no adapter recognized it/);
    expect(p.connectAsync).toHaveBeenCalledTimes(1);
    expect(p.disconnectAsync).toHaveBeenCalledTimes(1);
  });

  it('abandons a stalled session: times out, drops the listener, disconnects', async () => {
    const { notify, services } = standardServices(); // never notifies
    // No 'disconnect' event either, so only the handler's own abandonment
    // cleanup can release the session's notify listener.
    const p = new FakePeripheral({ localName: 'FakeScale', services, silentDisconnect: true });
    noble.peripherals = [p];
    const adapter = gattAdapter('ByName', (info) => info.localName === 'FakeScale');

    await expect(
      handler.scanAndReadRaw({ adapters: [adapter], profile: PROFILE, readingTimeoutMs: 100 }),
    ).rejects.toThrow(/Timed out waiting for a complete scale reading/);
    expect(notify.listenerCount('data')).toBe(0);
    expect(p.disconnectAsync).toHaveBeenCalledTimes(1);
  });
});

describe('noble passes advertised service data to the adapter resolver (B-10)', () => {
  const FE95 = [{ uuid: 'fe95', data: Buffer.from([0x30, 0x58]) }];
  const byServiceData = (info: BleDeviceInfo): boolean =>
    (info.serviceData ?? []).some((sd) => sd.uuid === normalizeUuid('fe95'));

  it('auto-discovery matches a nameless device on its service data', async () => {
    const { services } = standardServices(weightOn);
    noble.peripherals = [new FakePeripheral({ serviceData: FE95, services })];
    const adapter = gattAdapter('ByServiceData', byServiceData);

    await expect(
      handler.scanAndReadRaw({ adapters: [adapter], profile: PROFILE, abortSignal: shortScan() }),
    ).resolves.toMatchObject({ adapter: { name: 'ByServiceData' } });
  });

  it('target MAC: a passive adapter matched on service data reads the broadcast, no connect', async () => {
    const p = new FakePeripheral({ serviceData: FE95 });
    noble.peripherals = [p];
    const adapter = {
      ...gattAdapter('PassiveFe95', byServiceData),
      preferPassive: true,
      parseServiceData: (): ScaleReading => ({ weight: 72, impedance: 500 }),
    } as unknown as ScaleAdapter;

    await expect(
      handler.scanAndReadRaw({
        targetMac: MAC,
        adapters: [adapter],
        profile: PROFILE,
        abortSignal: shortScan(2_000),
      }),
    ).resolves.toMatchObject({ reading: { weight: 72 } });
    expect(p.connectAsync).not.toHaveBeenCalled();
  });

  it('target MAC: the post-connect resolution still sees the service data', async () => {
    const { services } = standardServices(weightOn);
    noble.peripherals = [new FakePeripheral({ serviceData: FE95, services })];
    const adapter = gattAdapter('ByServiceData', byServiceData);

    await expect(
      handler.scanAndReadRaw({ targetMac: MAC, adapters: [adapter], profile: PROFILE }),
    ).resolves.toMatchObject({ adapter: { name: 'ByServiceData' } });
  });
});

// #463: both noble drivers fold every report into one Peripheral, and a report
// without manufacturer data overwrites it with an empty buffer on Windows and
// macOS. The session gets the last one the address advertised in this run;
// the resolver keeps what the advertisement shows (D071).
describe('noble hands a session the manufacturer data its scale advertised earlier (#463, D071)', () => {
  /** The #463 Physiq's advertisement of 2026-10-20 17:57:58.247 with its company id 0xffff. */
  const MSD_1020 = Buffer.from('ffff081401000325e0160005ff6108020015', 'hex');
  const PAYLOAD_1020 = MSD_1020.subarray(2);

  /** A GATT adapter that claims the device by name and notes what its session got. */
  function recordingAdapter(seen: unknown[], matched: unknown[]): ScaleAdapter {
    const base = gattAdapter('ByName', (info) => {
      matched.push(info.manufacturerData);
      return info.localName === 'QN-Scale';
    });
    return {
      ...base,
      onConnected: async (ctx: { manufacturerData?: unknown; write: unknown }) => {
        seen.push(ctx.manufacturerData);
      },
    } as unknown as ScaleAdapter;
  }

  it.each([
    ['target MAC', MAC.toUpperCase()],
    ['auto-discovery', undefined],
  ])(
    '%s: gives the session the earlier data when the last report had none',
    async (_label, targetMac) => {
      const { services } = standardServices(weightOn);
      const p = new FakePeripheral({ localName: 'QN-Scale', manufacturerData: MSD_1020, services });
      noble.peripherals = [p];
      const seen: unknown[] = [];
      const matched: unknown[] = [];
      const adapter = recordingAdapter(seen, matched);

      await handler.scanAndReadRaw({ targetMac, adapters: [adapter], profile: PROFILE });
      // The WinRT binding's buffer for a report without manufacturer data.
      p.advertisement.manufacturerData = Buffer.alloc(0);
      matched.length = 0;
      await handler.scanAndReadRaw({ targetMac, adapters: [adapter], profile: PROFILE });

      expect(seen).toEqual([
        { id: 0xffff, data: PAYLOAD_1020 },
        { id: 0xffff, data: PAYLOAD_1020 },
      ]);
      expect(matched.length).toBeGreaterThan(0);
      expect(matched.every((md) => md === undefined)).toBe(true);
    },
  );

  it('remembers the data of a cycle whose connect failed', async () => {
    vi.useFakeTimers();
    try {
      const { services } = standardServices(weightOn);
      const p = new FakePeripheral({
        localName: 'QN-Scale',
        manufacturerData: MSD_1020,
        services,
        connectFailures: 6,
      });
      noble.peripherals = [p];
      const seen: unknown[] = [];
      const adapter = recordingAdapter(seen, []);
      const failed = handler.scanAndReadRaw({ adapters: [adapter], profile: PROFILE }).then(
        () => 'read',
        () => 'failed',
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await failed).toBe('failed');
      expect(seen).toEqual([]);

      p.advertisement.manufacturerData = Buffer.alloc(0);
      const read = handler.scanAndReadRaw({ adapters: [adapter], profile: PROFILE });
      await vi.advanceTimersByTimeAsync(5_000);
      await read;
      expect(seen).toEqual([{ id: 0xffff, data: PAYLOAD_1020 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a session its own data, and another address none', async () => {
    const { services } = standardServices(weightOn);
    const p = new FakePeripheral({ localName: 'QN-Scale', manufacturerData: MSD_1020, services });
    noble.peripherals = [p];
    const seen: unknown[] = [];
    const adapter = recordingAdapter(seen, []);
    await handler.scanAndReadRaw({ adapters: [adapter], profile: PROFILE });

    const own = Buffer.from('ffff081401000125e0160005ff6108010015', 'hex');
    p.advertisement.manufacturerData = own;
    await handler.scanAndReadRaw({ adapters: [adapter], profile: PROFILE });

    const other = new FakePeripheral({
      address: '11:22:33:44:55:66',
      localName: 'QN-Scale',
      services: standardServices(weightOn).services,
    });
    noble.peripherals = [other];
    await handler.scanAndReadRaw({ adapters: [adapter], profile: PROFILE });

    expect(seen).toEqual([
      { id: 0xffff, data: PAYLOAD_1020 },
      { id: 0xffff, data: own.subarray(2) },
      undefined,
    ]);
  });
});
