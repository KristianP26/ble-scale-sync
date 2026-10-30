import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SenssunIfB2Adapter,
  IfB2Reassembler,
  buildCloudProfileCommand,
  decodeIfB2Frame,
  IF_B2_MAX_PROFILE_WRITES,
  IF_B2_RECORD_WAIT_MS,
} from '../../src/scales/senssun-if-b2.js';
import { buildPayload, uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { UserProfile } from '../../src/interfaces/scale-adapter.js';
import { buildAdapterRuntimeConfig } from '../../src/config/resolve.js';
import type { AppConfig, UserConfig } from '../../src/config/schema.js';
import { bleLog } from '../../src/ble/types.js';
import { session as LOGGED } from '../fixtures/senssun/if-b2.js';

// These frames and profiles are synthetic and contain no hardware-captured measurements.
// Expected composition values were calculated independently from the protocol equations.
const live = Buffer.from('100000c50e038002d6064101aa5b', 'hex');
const historicalHealth = Buffer.from(
  '100000c51d03820f000102d600d00208023001a4001e05dc00000078b2',
  'hex',
);
// Derived: the current slot and no age, as every record in the reporter's log has.
const health = Buffer.from(historicalHealth);
health[7] = 0x00;
health.writeUInt32BE(0, 24);
health[28] = health.subarray(4, 28).reduce((sum, value) => (sum + value) & 0xff, 0);
const alternateLive = Buffer.from('100000c50e038002ac05e401a0c9', 'hex');
const alternateHealth = Buffer.from(
  '100000c51d038200000102ac00bb014a023001a4001e05dc000000002d',
  'hex',
);
const profileCommand = Buffer.from('100000c51303010000000101b02a000000483b', 'hex');
function profileAcknowledgement(status: number, pin = 1): Buffer {
  const frame = Buffer.from([0x10, 0x00, 0x00, 0xc5, 0x0b, 0x03, 0x81, status, 0x00, pin, 0x00]);
  frame[10] = frame.subarray(4, 10).reduce((sum, value) => (sum + value) & 0xff, 0);
  return frame;
}

const profileCreated = profileAcknowledgement(0);
const profileUpdated = profileAcknowledgement(1);
const profile = { height: 176, age: 42, gender: 'male' as const, isAthlete: false };

function liveFrame(weightTenths: number, control = 0xa0): Buffer {
  const frame = Buffer.from(live);
  frame.writeUInt16BE(weightTenths, 7);
  frame[12] = control;
  frame[frame.length - 1] = frame
    .subarray(4, frame.length - 1)
    .reduce((sum, value) => (sum + value) & 0xff, 0);
  return frame;
}

const quietLive = liveFrame(726);
const changedLive = liveFrame(725);
const zeroLive = liveFrame(0);

describe('Senssun IF_B2 protocol', () => {
  it('decodes stable live kilograms, pounds, unit, and AA flag', () => {
    expect(decodeIfB2Frame(live)).toMatchObject({
      frameType: 'live_weight',
      weightKg: 72.6,
      weightLb: 160.1,
      unitCode: 0x01,
      stable: true,
    });
  });
  it('decodes zero live weight so it can clear a provisional candidate', () => {
    expect(decodeIfB2Frame(zeroLive)).toMatchObject({
      frameType: 'live_weight',
      weightKg: 0,
      control: 0xa0,
    });
  });
  it('decodes transient A0 control and current slot zero', () => {
    expect(decodeIfB2Frame(alternateLive)).toMatchObject({
      frameType: 'live_weight',
      weightKg: 68.4,
      control: 0xa0,
      stable: false,
    });
    expect(decodeIfB2Frame(alternateHealth)).toMatchObject({
      frameType: 'health_record',
      recordSlot: 0,
      profilePin: '0001',
      weightKg: 68.4,
      impedanceOhms: 330,
      elapsedSeconds: 0,
    });
  });
  it('reassembles split and concatenated health frames', () => {
    const r = new IfB2Reassembler();
    expect(r.push(health.subarray(0, 20))).toEqual([]);
    expect(r.push(health.subarray(20))).toEqual([health]);
    const r2 = new IfB2Reassembler();
    expect(r2.push(Buffer.concat([live, health]))).toEqual([live, health]);
    const malformed = Buffer.from('100000c57f00', 'hex');
    expect(new IfB2Reassembler().push(Buffer.concat([malformed, live]))).toEqual([live]);
  });
  it('reassembles a profile acknowledgement followed by a live frame', () => {
    const r = new IfB2Reassembler();
    expect(r.push(Buffer.concat([profileUpdated, live]))).toEqual([profileUpdated, live]);
  });
  it('resynchronizes after a truncated acknowledgement prefix', () => {
    const reassembler = new IfB2Reassembler();
    expect(
      reassembler.push(Buffer.concat([profileUpdated.subarray(0, 5), profileUpdated])),
    ).toEqual([profileUpdated]);
  });
  it('recovers a complete acknowledgement behind an incomplete health-record prefix', () => {
    const reassembler = new IfB2Reassembler();
    expect(reassembler.push(Buffer.concat([health.subarray(0, 5), profileUpdated]))).toEqual([
      profileUpdated,
    ]);
  });
  it('keeps a complete checksum-valid outer frame containing an acknowledgement header', () => {
    const frame = Buffer.from(health);
    profileUpdated.copy(frame, 12);
    frame[28] = frame.subarray(4, 28).reduce((sum, value) => (sum + value) & 0xff, 0);
    expect(new IfB2Reassembler().push(frame)).toEqual([frame]);
  });
  it('preserves a fragmented outer record containing a complete acknowledgement in its payload', () => {
    const frame = Buffer.from(health);
    profileUpdated.copy(frame, 12);
    frame[28] = frame.subarray(4, 28).reduce((sum, value) => (sum + value) & 0xff, 0);
    const reassembler = new IfB2Reassembler();
    expect(reassembler.push(frame.subarray(0, 23))).toEqual([]);
    expect(reassembler.push(frame.subarray(23))).toEqual([frame]);
  });
  it('returns null for malformed, unsupported, end and invalid-profile frames', () => {
    const malformed = Buffer.from(live);
    malformed[13] ^= 1;
    expect(decodeIfB2Frame(malformed)).toBeNull();
    const unsupported = Buffer.concat([health.subarray(0, 28), Buffer.from([0x30, 0])]);
    unsupported[4] = 30;
    unsupported[29] = [...unsupported.subarray(4, 29)].reduce(
      (sum, value) => (sum + value) & 0xff,
      0,
    );
    expect(decodeIfB2Frame(unsupported)).toBeNull();
    const end = Buffer.from(health);
    end[7] = 0xff;
    end[28] = end.subarray(4, 28).reduce((sum, value) => (sum + value) & 0xff, 0);
    expect(decodeIfB2Frame(end)).toBeNull();
    const declaredMismatch = Buffer.from(live);
    declaredMismatch[4] = 15;
    declaredMismatch[13] = declaredMismatch
      .subarray(4, 13)
      .reduce((sum, value) => (sum + value) & 0xff, 0);
    expect(decodeIfB2Frame(declaredMismatch)).toBeNull();
  });
  it('builds the exact reusable cloud profile command', () => {
    expect(buildCloudProfileCommand(profile, 72.6)).toEqual(profileCommand);
    expect(
      buildCloudProfileCommand({ ...profile, gender: 'female', isAthlete: true }, 72.6),
    ).toMatchObject({ 11: 0, 14: 5 });
  });
  it.each([
    [167.64, '100000c51303010000000101a82a0000004833'],
    [171.4, '100000c51303010000000101ab2a0000004836'],
  ])('encodes fractional height %s as the nearest whole centimetre', (height, expected) => {
    expect(buildCloudProfileCommand({ ...profile, height }, 72.6)).toEqual(
      Buffer.from(expected, 'hex'),
    );
  });
  it('clamps profile command inputs outside the byte ranges', () => {
    expect(buildCloudProfileCommand({ ...profile, height: 49 }, 72.6)[12]).toBe(50);
    expect(buildCloudProfileCommand({ ...profile, height: 300 }, 72.6)[12]).toBe(250);
    expect(buildCloudProfileCommand({ ...profile, age: 121 }, 72.6)[13]).toBe(120);
    expect(buildCloudProfileCommand({ ...profile, age: 0 }, 72.6)[13]).toBe(1);
    expect(buildCloudProfileCommand(profile, 0).readUInt16BE(16)).toBe(0);
  });
  it.each([0, 1, 2, 3, 4])('decodes a profile acknowledgement with status %i', (status) => {
    expect(decodeIfB2Frame(profileAcknowledgement(status))).toEqual({
      frameType: 'profile_ack',
      status,
      profilePin: '0001',
      raw: profileAcknowledgement(status).toString('hex'),
    });
  });
  it('rejects a profile acknowledgement with an invalid checksum', () => {
    const malformed = Buffer.from(profileUpdated);
    malformed[8]++;
    expect(decodeIfB2Frame(malformed)).toBeNull();
  });
  it('decodes the PIN of a profile acknowledgement', () => {
    expect(decodeIfB2Frame(profileAcknowledgement(0, 2))).toMatchObject({ profilePin: '0002' });
  });
});
describe('Senssun IF_B2 session state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  type Lookup = (weightKg: number) => UserProfile | undefined;
  function context(
    writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [],
    transportProfile: UserProfile = profile,
  ) {
    return {
      write: vi.fn(async (uuid: string, data: Buffer | number[], withResponse: boolean) => {
        writes.push({ uuid, data: Buffer.from(data), withResponse });
      }),
      read: vi.fn(async () => Buffer.alloc(0)),
      subscribe: vi.fn(async () => {}),
      profile: transportProfile,
      deviceAddress: 'AA',
      availableChars: new Set([uuid16(0xfff1), uuid16(0xfff2)]),
    };
  }
  /** configure() with the lookup, then connect; without a lookup the adapter uses ctx.profile. */
  async function connect(
    adapter: SenssunIfB2Adapter,
    writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [],
    lookup?: Lookup,
    transportProfile: UserProfile = profile,
  ): Promise<void> {
    if (lookup) adapter.configure({ profileForWeight: lookup });
    await adapter.onConnected(context(writes, transportProfile));
  }
  function currentRecord(changes: (frame: Buffer) => void): Buffer {
    const frame = Buffer.from(health);
    changes(frame);
    frame[frame.length - 1] = frame
      .subarray(4, frame.length - 1)
      .reduce((sum, value) => (sum + value) & 0xff, 0);
    return frame;
  }
  async function settleSelection(adapter: SenssunIfB2Adapter, frame = quietLive): Promise<void> {
    adapter.parseNotification(frame);
    await vi.advanceTimersByTimeAsync(2_000);
  }
  async function selectedAdapter(ack?: Buffer, lookup?: Lookup): Promise<SenssunIfB2Adapter> {
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, [], lookup);
    await settleSelection(adapter);
    if (ack) adapter.parseNotification(ack);
    return adapter;
  }
  async function acknowledgedAdapter(ack = profileUpdated): Promise<SenssunIfB2Adapter> {
    return selectedAdapter(ack);
  }

  it('stores the active context without writing before stable weight', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);
    expect(writes).toEqual([]);
  });

  it('rejects a connection without both active FFF1 and FFF2 characteristics', async () => {
    const adapter = new SenssunIfB2Adapter();
    await expect(adapter.onConnected({ ...context(), availableChars: new Set() })).rejects.toThrow(
      /discovery race/,
    );
  });

  it('starts profile writes after one weight remains unchanged for two seconds', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const lookup = vi.fn(() => profile);
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes, lookup);

    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(writes).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([{ uuid: uuid16(0xfff2), data: profileCommand, withResponse: true }]);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(72.6);
  });

  it('looks the profile up once per weigh-in, on the settled weight', async () => {
    const lookup = vi.fn(() => profile);
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, [], lookup);
    for (let tenths = 100; tenths <= 726; tenths += 50)
      adapter.parseNotification(liveFrame(tenths));
    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(2_000);
    for (let i = 0; i < 5; i++) adapter.parseNotification(quietLive);
    adapter.parseNotification(profileUpdated);
    adapter.parseNotification(health);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(72.6);
  });

  it('writes the sex, height, age and athlete flag of the profile the lookup returns', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const other: UserProfile = { height: 158, age: 35, gender: 'female', isAthlete: true };
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes, () => other);
    await settleSelection(adapter);
    expect(writes[0]?.data).toEqual(buildCloudProfileCommand(other, 72.6));
    expect(writes[0]?.data.subarray(11, 15)).toEqual(Buffer.from([0, 158, 35, 5]));
  });

  it('writes the transport profile when the lookup matches nobody', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes, () => undefined);
    await settleSelection(adapter);
    expect(writes[0]?.data).toEqual(profileCommand);
  });

  it('calls the real matcher once and logs nothing while the weight ramps up', async () => {
    const user = (name: string, min: number, max: number): UserConfig => ({
      name,
      slug: name.toLowerCase(),
      height: 176,
      birth_date: '1984-01-01',
      gender: 'male',
      is_athlete: false,
      weight_range: { min, max },
      last_known_weight: null,
    });
    const config = {
      scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' },
      unknown_user: 'nearest',
      users: [user('Alice', 50, 60), user('Bob', 75, 85)],
    } as unknown as AppConfig;
    const real = buildAdapterRuntimeConfig(config, undefined).profileForWeight!;
    const lookup = vi.fn(real);
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, [], lookup);
    for (let tenths = 100; tenths <= 726; tenths += 2) adapter.parseNotification(liveFrame(tenths));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(lookup).toHaveBeenCalledOnce();
    const lines = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
    expect(lines.filter((line) => line.includes('UserMatch'))).toEqual([]);
    for (const spy of spies) spy.mockRestore();
  });

  it('uses the demographics the lookup returns when the quiet period ends', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    let current: UserProfile = profile;
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes, () => current);
    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(1_000);
    current = { ...profile, height: 170, age: 43 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes[0].data[12]).toBe(170);
    expect(writes[0].data[13]).toBe(43);
  });

  it('writes and completes with a fractional-centimetre selected profile', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const fractional = { ...profile, height: 167.64 };
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes, () => fractional);
    await settleSelection(adapter);
    expect(writes[0]?.data).toEqual(Buffer.from('100000c51303010000000101a82a0000004833', 'hex'));
    adapter.parseNotification(profileUpdated);
    expect(adapter.parseNotification(health)).toMatchObject({
      weight: 72.6,
      impedance: 0,
    });
  });

  it('clamps a profile outside the command ranges and writes it', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes, () => ({ ...profile, age: 121 }));
    await settleSelection(adapter);
    expect(() => adapter.parseNotification(health)).not.toThrow();
    expect(writes[0]?.data[13]).toBe(120);
  });
  it('does not restart the quiet timer for a duplicate frame', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);

    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(1_000);
    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(999);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
  });

  it('restarts the quiet timer when weight changes', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);

    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(1_500);
    adapter.parseNotification(changedLive);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes[0]?.data).toEqual(buildCloudProfileCommand(profile, 72.5));
  });

  it('clears a pending candidate when live weight returns to zero', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);

    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(1_000);
    const display = adapter.parseNotification(zeroLive);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).toEqual([]);
    expect(display && adapter.isComplete(display)).toBe(false);
  });

  it('does not let an AA frame bypass the quiet period', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);

    adapter.parseNotification(liveFrame(726, 0xaa));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
  });

  it('retries every 200 ms until an update acknowledgement', async () => {
    vi.useFakeTimers();
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);
    await settleSelection(adapter);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(201);
    expect(writes).toHaveLength(3);
    expect(adapter.parseNotification(profileUpdated)).toMatchObject({ weight: 72.6 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toHaveLength(3);
    expect(
      writes.every(({ data, withResponse }) => data.equals(profileCommand) && withResponse),
    ).toBe(true);
    vi.useRealTimers();
  });

  it('waits for an in-flight profile write before retrying', async () => {
    let resolveWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const write = vi.fn(() => pendingWrite);
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected({ ...context(), write });

    await settleSelection(adapter);
    expect(write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledOnce();

    resolveWrite();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(199);
    expect(write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it.each([profileCreated, profileUpdated])(
    'accepts a current record after a successful acknowledgement',
    async (ack) => {
      const adapter = await acknowledgedAdapter(ack);
      expect(adapter.parseNotification(health)).toMatchObject({ impedance: 0 });
    },
  );

  it('emits a record that arrives before any profile write, and writes nothing', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);
    expect(adapter.parseNotification(health)).toMatchObject({ weight: 72.6, impedance: 0 });
    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toEqual([]);
  });
  it('emits a record that arrives before the profile ack, once', async () => {
    const adapter = await selectedAdapter();
    expect(adapter.parseNotification(health)).toMatchObject({ weight: 72.6, impedance: 0 });
    expect(adapter.parseNotification(profileCreated)).toBeNull();
    expect(adapter.parseNotification(health)).toBeNull();
  });
  it('processes a concatenated current record and acknowledgement in order', async () => {
    const adapter = await selectedAdapter();
    expect(adapter.parseNotification(Buffer.concat([health, profileUpdated]))).toMatchObject({
      impedance: 0,
    });
  });

  it('emits a record with no age without a timestamp', async () => {
    const adapter = await acknowledgedAdapter();
    const reading = adapter.parseNotification(health)!;
    expect(reading).toMatchObject({ weight: 72.6 });
    expect(reading.timestamp).toBeUndefined();
  });

  it.each([1, 301, 600])(
    'ignores a record whose bytes 24-27 carry %s, with one debug line per session',
    async (age) => {
      const debug = vi.spyOn(bleLog, 'debug');
      const adapter = await acknowledgedAdapter();
      // Derived from health: bytes 24-27 set, checksum recomputed.
      const aged = currentRecord((frame) => frame.writeUInt32BE(age, 24));
      expect(adapter.parseNotification(aged)).toBeNull();
      expect(adapter.parseNotification(aged)).toBeNull();
      const lines = debug.mock.calls.filter(([msg]) => String(msg).includes('not this weigh-in'));
      expect(lines).toHaveLength(1);
      debug.mockRestore();
    },
  );

  it('emits the final record instead of an earlier live frame in the same notification', async () => {
    const adapter = await selectedAdapter();
    expect(
      adapter.isFinal(
        adapter.parseNotification(Buffer.concat([quietLive, health, profileUpdated]))!,
      ),
    ).toBe(true);
  });

  it.each([2, 3, 4])(
    'takes an ack with status %i without throwing and stops the writes',
    async (status) => {
      const debug = vi.spyOn(bleLog, 'debug');
      const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
      const adapter = new SenssunIfB2Adapter();
      await connect(adapter, writes);
      await settleSelection(adapter);
      // Derived from the logged ack: byte 7 set, checksum recomputed.
      expect(() => adapter.parseNotification(profileAcknowledgement(status))).not.toThrow();
      const count = writes.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writes).toHaveLength(count);
      expect(debug.mock.calls.some(([msg]) => String(msg).includes('ack status'))).toBe(true);
      debug.mockRestore();
    },
  );
  it('stops writing 5 s after the first write without an ack, with one info line', async () => {
    const info = vi.spyOn(bleLog, 'info');
    // Each write takes 400 ms, so the write cap is not what ends them.
    const write = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected({ ...context(), write });
    await settleSelection(adapter);
    await vi.advanceTimersByTimeAsync(5_000);
    const count = write.mock.calls.length;
    expect(count).toBeLessThan(IF_B2_MAX_PROFILE_WRITES);
    expect(() => adapter.parseNotification(alternateLive)).not.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(write).toHaveBeenCalledTimes(count);
    const lines = info.mock.calls.filter(([msg]) => String(msg).includes('did not confirm'));
    expect(lines).toHaveLength(1);
    info.mockRestore();
  });

  it('writes at most IF_B2_MAX_PROFILE_WRITES when a write returns at once', async () => {
    // As on mqtt-proxy, where a write only publishes.
    const write = vi.fn(async () => {});
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected({ ...context(), write });
    await settleSelection(adapter);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(IF_B2_MAX_PROFILE_WRITES);
  });
  it('keeps retrying after a rejected profile write, without throwing', async () => {
    const adapter = new SenssunIfB2Adapter();
    const rejected = {
      ...context(),
      write: vi.fn(async () => {
        throw new Error('gone');
      }),
    };
    await adapter.onConnected(rejected);
    await settleSelection(adapter);
    await vi.advanceTimersByTimeAsync(0);
    expect(() => adapter.parseNotification(alternateLive)).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rejected.write.mock.calls.length).toBeGreaterThan(1);
    expect(adapter.parseNotification(profileUpdated)).toMatchObject({ weight: 72.6 });
    expect(adapter.parseNotification(health)).toMatchObject({ weight: 72.6 });
  });
  it('returns the settled weight on the ack as a held, not final, reading', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);
    await settleSelection(adapter);
    const display = adapter.parseNotification(quietLive)!;
    expect(adapter.isComplete(display)).toBe(false);

    const held = adapter.parseNotification(profileUpdated)!;
    expect(held).toEqual({ weight: 72.6, impedance: 0 });
    expect(adapter.isComplete(held)).toBe(true);
    expect(adapter.isFinal(held)).toBe(false);
    expect(adapter.completionHoldMs).toBe(IF_B2_RECORD_WAIT_MS);

    const count = writes.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toHaveLength(count);

    const record = adapter.parseNotification(health)!;
    expect(adapter.isComplete(record)).toBe(true);
    expect(adapter.isFinal(record)).toBe(true);
  });

  it('ignores an in-flight write rejection after acknowledgement', async () => {
    let rejectWrite!: (error: Error) => void;
    const pendingWrite = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected({
      ...context(),
      write: vi.fn(() => pendingWrite),
    });
    await settleSelection(adapter);
    adapter.parseNotification(profileUpdated);
    rejectWrite(new Error('late'));
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.parseNotification(health)).toMatchObject({ impedance: 0 });
  });

  it('processes a concatenated acknowledgement and current record in order', async () => {
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter);
    await settleSelection(adapter);
    expect(adapter.parseNotification(Buffer.concat([profileUpdated, health]))).toMatchObject({
      impedance: 0,
    });
  });

  it('rejects historical slots and PINs other than 0001', async () => {
    const historical = await acknowledgedAdapter();
    expect(historical.parseNotification(historicalHealth)).toBeNull();
    const wrongPin = await acknowledgedAdapter();
    expect(
      wrongPin.parseNotification(
        currentRecord((frame) => {
          frame[9] = 0x02;
        }),
      ),
    ).toBeNull();
  });

  it('ignores a 30-byte record', async () => {
    const adapter = await acknowledgedAdapter();
    // Derived from health: one byte appended, length and checksum recomputed.
    const long = Buffer.concat([health.subarray(0, 28), Buffer.from([0x10, 0])]);
    long[4] = 30;
    long[29] = long.subarray(4, 29).reduce((sum, value) => (sum + value) & 0xff, 0);
    expect(adapter.parseNotification(long)).toBeNull();
    expect(adapter.parseNotification(health)).toMatchObject({ weight: 72.6 });
  });

  it('emits a record split over two notifications once', async () => {
    const adapter = await acknowledgedAdapter();
    expect(adapter.parseNotification(health.subarray(0, 20))).toBeNull();
    const reading = adapter.parseNotification(health.subarray(20))!;
    expect(reading).toMatchObject({ weight: 72.6, impedance: 0 });
    expect(adapter.isComplete(reading)).toBe(true);
    expect(adapter.parseNotification(health)).toBeNull();
  });

  // The two logged records: the first has bytes 12-13 and 16-19 out of any
  // plausible range, the second has them in range. Neither may matter.
  it.each(['if-b2-473-barefoot', 'if-b2-473-barefoot-second'])(
    'turns the record of %s into a weight-only reading',
    async (trace) => {
      const steps = LOGGED.traces[trace].steps.map((step) => Buffer.from(step.hex, 'hex'));
      const record = Buffer.concat(steps.slice(-2));
      const adapter = new SenssunIfB2Adapter();
      await connect(adapter);
      for (const frame of steps.slice(0, -2)) adapter.parseNotification(frame);
      const reading =
        adapter.parseNotification(steps.at(-2)!) ?? adapter.parseNotification(steps.at(-1)!);
      const weight = record.readUInt16BE(10) / 10;
      expect(reading).toEqual({ weight, impedance: 0 });
      expect(adapter.isFinal(reading!)).toBe(true);
      expect(adapter.computeMetrics(reading!, profile)).toEqual(
        buildPayload(weight, 0, {}, profile),
      );
    },
  );

  it('estimates from BMI for the profile computeMetrics gets, not the one written', async () => {
    const written: UserProfile = { ...profile, age: 62, gender: 'female' };
    const other: UserProfile = { height: 160, age: 25, gender: 'female', isAthlete: true };
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, [], () => written);
    await settleSelection(adapter);
    adapter.parseNotification(profileUpdated);
    const reading = adapter.parseNotification(health)!;

    expect(reading).toEqual({ weight: 72.6, impedance: 0 });
    for (const p of [profile, other])
      expect(adapter.computeMetrics(reading, p)).toEqual(buildPayload(72.6, 0, {}, p));
    const off = { ...profile, estimateBodyComposition: false };
    expect(adapter.computeMetrics(reading, off)).toEqual(buildPayload(72.6, 0, {}, off));
    expect(adapter.computeMetrics(reading, off).bodyFatPercent).toBeNull();
  });
  describe.each([
    ['onSessionStart', (adapter: SenssunIfB2Adapter) => adapter.onSessionStart()],
    ['onSessionEnd', (adapter: SenssunIfB2Adapter) => adapter.onSessionEnd()],
  ] as const)('%s lifecycle boundary', (_name, lifecycle) => {
    it('cancels a pending quiet-period candidate', async () => {
      const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
      const adapter = new SenssunIfB2Adapter();
      await connect(adapter, writes);
      adapter.parseNotification(quietLive);
      await vi.advanceTimersByTimeAsync(1_000);

      lifecycle(adapter);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(writes).toEqual([]);
    });

    it('stops the profile writes of a session that ends before the ack', async () => {
      const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
      const adapter = new SenssunIfB2Adapter();
      await connect(adapter, writes);
      await settleSelection(adapter);
      await vi.advanceTimersByTimeAsync(400);
      const count = writes.length;
      expect(count).toBeGreaterThan(0);

      lifecycle(adapter);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(writes).toHaveLength(count);
    });

    it('stops retries and clears the previous selection and acknowledgement', async () => {
      vi.useFakeTimers();
      const oldWrites: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
      const adapter = new SenssunIfB2Adapter();
      await adapter.onConnected(context(oldWrites));
      await settleSelection(adapter);
      adapter.parseNotification(profileUpdated);
      const count = oldWrites.length;
      lifecycle(adapter);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(oldWrites).toHaveLength(count);

      const nextWrites: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
      await connect(adapter, nextWrites, () => ({ ...profile, age: 28 }));
      await settleSelection(adapter);
      expect(nextWrites[0]?.data).toEqual(buildCloudProfileCommand({ ...profile, age: 28 }, 72.6));
      adapter.parseNotification(profileCreated);
      expect(adapter.parseNotification(health)).toMatchObject({ weight: 72.6 });
      vi.useRealTimers();
    });

    it('drops partial reassembly bytes after a rejected profile write', async () => {
      const adapter = new SenssunIfB2Adapter();
      const rejected = {
        ...context(),
        write: vi.fn(async () => {
          throw new Error('gone');
        }),
      };
      await adapter.onConnected(rejected);
      adapter.parseNotification(quietLive);
      vi.advanceTimersByTime(2_000);
      adapter.parseNotification(health.subarray(0, 7));
      await Promise.resolve();
      await Promise.resolve();
      lifecycle(adapter);
      expect(adapter.parseNotification(health.subarray(7))).toBeNull();
    });
  });
});
