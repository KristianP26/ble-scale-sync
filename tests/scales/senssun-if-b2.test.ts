import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SenssunIfB2Adapter,
  IfB2Reassembler,
  buildCloudProfileCommand,
  decodeIfB2Frame,
} from '../../src/scales/senssun-if-b2.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { SessionProfileSelector, UserProfile } from '../../src/interfaces/scale-adapter.js';
import { isHistoricalReading } from '../../src/interfaces/reading-time.js';

// These frames and profiles are synthetic and contain no hardware-captured measurements.
// Expected composition values were calculated independently from the protocol equations.
const live = Buffer.from('100000c50e038002d6064101aa5b', 'hex');
const historicalHealth = Buffer.from(
  '100000c51d03820f000102d600d00208023001a4001e05dc00000078b2',
  'hex',
);
const health = Buffer.from(historicalHealth);
health[7] = 0x00;
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
const profileDeleted = profileAcknowledgement(2);
const profileFull = profileAcknowledgement(3);
const profile = { height: 176, age: 42, gender: 'male' as const, isAthlete: false };
const profileUnsupported = profileAcknowledgement(4);

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
    expect(decodeIfB2Frame(alternateHealth, profile)).toMatchObject({
      frameType: 'health_record',
      recordSlot: 0,
      profilePin: '0001',
      weightKg: 68.4,
      impedanceOhms: 330,
      fatPercent: 18.7,
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
  it('decodes verified health fields and derived metrics', () => {
    const decoded = decodeIfB2Frame(health, profile);
    expect(decoded).toMatchObject({
      frameType: 'health_record',
      weightKg: 72.6,
      impedanceOhms: 520,
      fatPercent: 20.8,
      waterPercent: 54.4,
      musclePercent: 40.8,
      boneKg: 4.1,
      bmr: 1687,
      bodyAge: 47,
    });
    const near = Buffer.from(health);
    near[12] = 0x00;
    near[13] = 0xd2;
    near[28] = near.subarray(4, 28).reduce((sum, value) => (sum + value) & 0xff, 0);
    expect(decodeIfB2Frame(near, profile)).toMatchObject({ fatPercent: 21, waterPercent: 54.4 });
  });
  it('rejects malformed, unsupported, end, and invalid-profile records', () => {
    const malformed = Buffer.from(live);
    malformed[13] ^= 1;
    expect(() => decodeIfB2Frame(malformed)).toThrow(/checksum/);
    const unsupported = Buffer.concat([health.subarray(0, 28), Buffer.from([0x30, 0])]);
    unsupported[4] = 30;
    unsupported[29] = [...unsupported.subarray(4, 29)].reduce(
      (sum, value) => (sum + value) & 0xff,
      0,
    );
    expect(() => decodeIfB2Frame(unsupported)).toThrow();
    const end = Buffer.from(health);
    end[7] = 0xff;
    end[28] = end.subarray(4, 28).reduce((sum, value) => (sum + value) & 0xff, 0);
    expect(() => decodeIfB2Frame(end, profile)).toThrow(/end marker/);
    const declaredMismatch = Buffer.from(live);
    declaredMismatch[4] = 15;
    declaredMismatch[13] = declaredMismatch
      .subarray(4, 13)
      .reduce((sum, value) => (sum + value) & 0xff, 0);
    expect(() => decodeIfB2Frame(declaredMismatch)).toThrow(/declared length/);
    expect(() => decodeIfB2Frame(health, { ...profile, height: 0 })).toThrow();
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
  it('rejects invalid cloud profile command inputs', () => {
    expect(() => buildCloudProfileCommand({ ...profile, height: 49 }, 72.6)).toThrow(
      /invalid IF_B2 cloud profile/,
    );
    expect(() => buildCloudProfileCommand({ ...profile, age: 121 }, 72.6)).toThrow(
      /invalid IF_B2 cloud profile/,
    );
    expect(() => buildCloudProfileCommand(profile, 0)).toThrow(/invalid IF_B2 cloud profile/);
  });
  it.each([
    [profileCreated, 'created'],
    [profileUpdated, 'updated'],
    [profileDeleted, 'deleted'],
    [profileFull, 'full'],
  ] as const)('decodes profile acknowledgement %s', (frame, status) => {
    expect(decodeIfB2Frame(frame)).toMatchObject({
      frameType: 'profile_ack',
      status,
    });
  });
  it('rejects a profile acknowledgement with an invalid checksum', () => {
    const malformed = Buffer.from(profileUpdated);
    malformed[8]++;
    expect(() => decodeIfB2Frame(malformed)).toThrow(/checksum/);
  });
  it('rejects a profile acknowledgement for a PIN other than 0001', () => {
    expect(() => decodeIfB2Frame(profileAcknowledgement(0, 2))).toThrow(/PIN 0001/);
  });
  it('maps impedance and verified BMR/body age into immutable composition', () => {
    const adapter = new SenssunIfB2Adapter();
    const reading = adapter.parseNotification(health, profile)!;
    const metrics = adapter.computeMetrics(reading, profile);
    expect(metrics).toMatchObject({
      weight: 72.6,
      impedance: 520,
      bodyFatPercent: 20.8,
      waterPercent: 54.4,
      muscleMass: 29.62,
      boneMass: 4.1,
      bmr: 1687,
      metabolicAge: 47,
    });
    expect(adapter.parseNotification(live, profile)).toMatchObject({ weight: 72.6 });
    expect(adapter.computeMetrics(reading, profile).bmr).toBe(1687);
  });
  it.each([
    { gender: 'male', age: 100, weight: 40, bmr: 452 },
    { gender: 'male', age: 21, weight: 42, bmr: 1017 },
    { gender: 'female', age: 52, weight: 146.5, bmr: 2016 },
  ] as const)(
    'exports float32 BMR $bmr for $gender at age $age and $weight kg',
    ({ gender, age, weight, bmr }) => {
      const frame = Buffer.from(health);
      frame.writeUInt16BE(weight * 10, 10);
      frame[28] = frame.subarray(4, 28).reduce((sum, value) => (sum + value) & 0xff, 0);
      const selectedProfile: UserProfile = { height: 100, age, gender, isAthlete: false };
      const adapter = new SenssunIfB2Adapter();
      const reading = adapter.parseNotification(frame, selectedProfile)!;

      expect(adapter.computeMetrics(reading, selectedProfile).bmr).toBe(bmr);
    },
  );
});
describe('Senssun IF_B2 session state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const selected = { userSlug: 'alice', profile };
  function context(
    writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [],
    selectProfile: SessionProfileSelector = () => selected,
    transportProfile: UserProfile = profile,
  ) {
    return {
      write: vi.fn(async (uuid: string, data: Buffer | number[], withResponse: boolean) => {
        writes.push({ uuid, data: Buffer.from(data), withResponse });
      }),
      read: vi.fn(async () => Buffer.alloc(0)),
      subscribe: vi.fn(async () => {}),
      profile: transportProfile,
      selectProfile,
      deviceAddress: 'AA',
      availableChars: new Set([uuid16(0xfff1), uuid16(0xfff2)]),
    };
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
  async function selectedAdapter(
    ack?: Buffer,
    selectProfile: SessionProfileSelector = () => selected,
  ): Promise<SenssunIfB2Adapter> {
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context([], selectProfile));
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
    await adapter.onConnected(context(writes));
    expect(writes).toEqual([]);
  });

  it('rejects a connection without both active FFF1 and FFF2 characteristics', async () => {
    const adapter = new SenssunIfB2Adapter();
    await expect(adapter.onConnected({ ...context(), availableChars: new Set() })).rejects.toThrow(
      /discovery race/,
    );
  });

  it('starts profile writes after one unique weight remains unchanged for two seconds', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const select = vi.fn(() => selected);
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context(writes, select));

    adapter.parseNotification(quietLive);
    expect(select).toHaveBeenCalledWith(72.6);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([{ uuid: uuid16(0xfff2), data: profileCommand, withResponse: true }]);
  });

  it.each([null, { ...selected, userSlug: 'bob' }])(
    'does not write demographics when authorization changes during the quiet period (%j)',
    async (nextSelection) => {
      const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
      let choice: typeof selected | null = selected;
      const adapter = new SenssunIfB2Adapter();
      await adapter.onConnected(context(writes, () => choice));
      adapter.parseNotification(quietLive);
      await vi.advanceTimersByTimeAsync(1_000);
      choice = nextSelection;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writes).toEqual([]);
    },
  );

  it('uses fresh demographics for the same authorized user at quiet-period expiry', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    let choice = selected;
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context(writes, () => choice));
    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(1_000);
    choice = { ...selected, profile: { ...profile, height: 170, age: 43 } };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes[0].data[12]).toBe(170);
    expect(writes[0].data[13]).toBe(43);
  });

  it('writes and completes with a fractional-centimetre selected profile', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const fractional = { userSlug: 'alice', profile: { ...profile, height: 167.64 } };
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context(writes, () => fractional));
    await settleSelection(adapter);
    expect(writes[0]?.data).toEqual(Buffer.from('100000c51303010000000101a82a0000004833', 'hex'));
    adapter.parseNotification(profileUpdated);
    expect(adapter.parseNotification(health)).toMatchObject({
      weight: 72.6,
      impedance: 520,
      selectedUserSlug: 'alice',
    });
  });

  it('reports invalid profile construction through the session parser without writing', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(
      context(writes, () => ({ userSlug: 'alice', profile: { ...profile, age: 121 } })),
    );
    await settleSelection(adapter);
    expect(() => adapter.parseNotification(health)).toThrow(/invalid IF_B2 cloud profile/);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toEqual([]);
  });

  it('does not restart the quiet timer for a duplicate frame', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context(writes));

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
    await adapter.onConnected(context(writes));

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
    await adapter.onConnected(context(writes));

    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(1_000);
    const display = adapter.parseNotification(zeroLive);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).toEqual([]);
    expect(display && adapter.isComplete(display)).toBe(false);
  });

  it('reconsiders a later weight after selection returns no user', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const select = vi.fn((weightKg: number) => (weightKg === 72.6 ? null : selected));
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context(writes, select));

    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).toEqual([]);
    adapter.parseNotification(changedLive);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
  });

  it('does not let an AA frame bypass the quiet period', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context(writes));

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
    await adapter.onConnected(context(writes));
    await settleSelection(adapter);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(201);
    expect(writes).toHaveLength(3);
    expect(adapter.parseNotification(profileUpdated)).toBeNull();
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
      expect(adapter.parseNotification(health)).toMatchObject({
        selectedUserSlug: 'alice',
        impedance: 520,
      });
    },
  );

  it('rejects a final record received before safe profile selection', async () => {
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context());
    expect(() => adapter.parseNotification(health)).toThrow(
      /final record arrived before safe profile selection/,
    );
  });

  it('buffers a valid current record until the profile acknowledgement arrives', async () => {
    const adapter = await selectedAdapter();
    expect(adapter.parseNotification(health)).toBeNull();
    expect(adapter.parseNotification(profileCreated)).toMatchObject({
      selectedUserSlug: 'alice',
      impedance: 520,
    });
    expect(adapter.parseNotification(profileCreated)).toBeNull();
    expect(adapter.parseNotification(health)).toBeNull();
  });

  it('processes a concatenated current record and acknowledgement in order', async () => {
    const adapter = await selectedAdapter();
    expect(adapter.parseNotification(Buffer.concat([health, profileUpdated]))).toMatchObject({
      selectedUserSlug: 'alice',
      impedance: 520,
    });
  });

  it.each([
    [0, false],
    [300, false],
    [301, true],
    [600, true],
  ] as const)(
    'preserves measurement age %s for history classification',
    async (age, historical) => {
      const adapter = await acknowledgedAdapter();
      const receivedAt = Date.now();
      const reading = adapter.parseNotification(
        currentRecord((frame) => frame.writeUInt32BE(age, 24)),
      )!;
      expect(reading.timestamp?.getTime()).toBe(receivedAt - age * 1_000);
      expect(isHistoricalReading(reading)).toBe(historical);
    },
  );

  it('does not shift measurement time by the acknowledgement delay', async () => {
    const adapter = await selectedAdapter();
    const receivedAt = Date.now();
    adapter.parseNotification(currentRecord((frame) => frame.writeUInt32BE(301, 24)));
    await vi.advanceTimersByTimeAsync(1_500);
    const reading = adapter.parseNotification(profileUpdated)!;
    expect(reading.timestamp?.getTime()).toBe(receivedAt - 301_000);
  });

  it.each([100, 1_300])(
    'uses the BMI estimate after the processor rejects %s ohm impedance',
    async (impedance) => {
      const adapter = await acknowledgedAdapter();
      const reading = adapter.parseNotification(
        currentRecord((frame) => frame.writeUInt16BE(impedance, 14)),
      )!;
      adapter.onSessionEnd();
      reading.impedance = 0;
      const weightOnlyEstimate = new SenssunIfB2Adapter().computeMetrics(
        { weight: 72.6, impedance: 0 },
        profile,
      );
      expect(adapter.computeMetrics(reading, profile)).toEqual(weightOnlyEstimate);
    },
  );

  it('recomputes historical composition for the independently attributed user', async () => {
    const adapter = await acknowledgedAdapter();
    const frame = currentRecord((record) => record.writeUInt32BE(301, 24));
    const reading = adapter.parseNotification(frame)!;
    adapter.onSessionEnd();
    const recipient: UserProfile = { ...profile, height: 165, age: 62, gender: 'female' };
    const reference = new SenssunIfB2Adapter();
    const attributedReading = reference.parseNotification(frame, recipient)!;
    expect(adapter.computeMetrics(reading, recipient)).toEqual(
      reference.computeMetrics(attributedReading, recipient),
    );
  });

  it('emits the final record instead of an earlier live frame in the same notification', async () => {
    const adapter = await selectedAdapter();
    expect(
      adapter.parseNotification(Buffer.concat([quietLive, health, profileUpdated])),
    ).toMatchObject({
      selectedUserSlug: 'alice',
      impedance: 520,
    });
  });

  it.each([
    [profileDeleted, /unexpected profile-delete acknowledgement/],
    [profileFull, /profile storage is full; PIN 0001 is unavailable/],
    [profileUnsupported, /unsupported profile acknowledgement 0x04/],
  ] as const)('rejects unsuccessful profile acknowledgement', async (ack, message) => {
    vi.useFakeTimers();
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context());
    await settleSelection(adapter);
    expect(() => adapter.parseNotification(ack)).toThrow(message);
    vi.useRealTimers();
  });

  it('surfaces a bounded profile acknowledgement timeout on the next notification', async () => {
    vi.useFakeTimers();
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context());
    await settleSelection(adapter);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(() => adapter.parseNotification(alternateLive)).toThrow(
      /profile acknowledgement timed out/,
    );
    vi.useRealTimers();
  });

  it('stops retries and surfaces a rejected profile write on the next notification', async () => {
    vi.useFakeTimers();
    const adapter = new SenssunIfB2Adapter();
    const rejected = {
      ...context(),
      write: vi.fn(async () => {
        throw new Error('gone');
      }),
    };
    await adapter.onConnected(rejected);
    await settleSelection(adapter);
    await Promise.resolve();
    await Promise.resolve();
    expect(() => adapter.parseNotification(alternateLive)).toThrow(/profile write failed: gone/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rejected.write).toHaveBeenCalledOnce();
    vi.useRealTimers();
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

    expect(adapter.parseNotification(health)).toMatchObject({
      selectedUserSlug: 'alice',
      impedance: 520,
    });
  });

  it('processes a concatenated acknowledgement and current record in order', async () => {
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(context());
    await settleSelection(adapter);
    expect(adapter.parseNotification(Buffer.concat([profileUpdated, health]))).toMatchObject({
      selectedUserSlug: 'alice',
      impedance: 520,
    });
  });

  it('completes a buffered record when its acknowledgement follows a truncated longer frame', async () => {
    const adapter = await selectedAdapter();
    expect(adapter.parseNotification(health)).toBeNull();
    const reading = adapter.parseNotification(
      Buffer.concat([health.subarray(0, 5), profileUpdated]),
    );
    expect(reading).toMatchObject({ weight: 72.6, impedance: 520, selectedUserSlug: 'alice' });
    expect(adapter.parseNotification(profileUpdated)).toBeNull();
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

  it('rejects a final record that no longer selects the provisional user', async () => {
    let choice = selected;
    const adapter = await selectedAdapter(profileUpdated, () => choice);
    choice = { userSlug: 'bob', profile: { ...profile, age: 30 } };

    expect(() => adapter.parseNotification(health)).toThrow(
      /final record matched bob instead of provisional user alice/,
    );
  });

  it('rejects a final record that no longer matches any user', async () => {
    let choice: typeof selected | null = selected;
    const adapter = await selectedAdapter(profileUpdated, () => choice);
    choice = null;

    expect(() => adapter.parseNotification(health)).toThrow(
      /final record no longer matches provisional user alice/,
    );
  });

  it('accepts the elapsed and weight boundaries and rejects values beyond them', async () => {
    const elapsedAccepted = await acknowledgedAdapter();
    expect(
      elapsedAccepted.parseNotification(
        currentRecord((frame) => {
          frame.writeUInt32BE(600, 24);
        }),
      ),
    ).toMatchObject({ selectedUserSlug: 'alice' });
    const elapsedRejected = await acknowledgedAdapter();
    expect(
      elapsedRejected.parseNotification(
        currentRecord((frame) => {
          frame.writeUInt32BE(601, 24);
        }),
      ),
    ).toBeNull();

    const divided = (rawWeight: number) => {
      const frame = Buffer.concat([health.subarray(0, 28), Buffer.from([0x10, 0])]);
      frame[4] = 30;
      frame.writeUInt16BE(rawWeight, 10);
      frame[29] = frame.subarray(4, 29).reduce((sum, value) => (sum + value) & 0xff, 0);
      return frame;
    };
    for (const [rawWeight, weight] of [
      [7250, 72.5],
      [7270, 72.7],
    ]) {
      const accepted = await acknowledgedAdapter();
      expect(accepted.parseNotification(divided(rawWeight))).toMatchObject({
        weight,
        selectedUserSlug: 'alice',
      });
    }
    for (const rawWeight of [7249, 7271]) {
      const rejected = await acknowledgedAdapter();
      expect(() => rejected.parseNotification(divided(rawWeight))).toThrow();
    }
  });

  it('emits one fragmented current record and keeps its composition pinned across sessions', async () => {
    const adapter = await acknowledgedAdapter();
    expect(adapter.parseNotification(health.subarray(0, 20))).toBeNull();
    const reading = adapter.parseNotification(health.subarray(20))!;
    expect(reading).toMatchObject({ weight: 72.6, impedance: 520, selectedUserSlug: 'alice' });
    expect(adapter.isComplete(reading)).toBe(true);
    expect(adapter.parseNotification(health)).toBeNull();
    const metrics = adapter.computeMetrics(reading, profile);

    adapter.onSessionStart();
    await adapter.onConnected(
      context([], () => ({ userSlug: 'bob', profile: { ...profile, age: 30 } })),
    );
    await settleSelection(adapter);
    adapter.parseNotification(profileUpdated);
    expect(adapter.computeMetrics(reading, profile)).toEqual(metrics);
  });

  it('derives composition despite invalid transmitted composition fields', async () => {
    const adapter = await acknowledgedAdapter();
    const invalidComposition = currentRecord((frame) => {
      frame.writeUInt16BE(0xffff, 12);
      frame.writeUInt16BE(0xffff, 16);
      frame.writeUInt16BE(0xffff, 18);
      frame.writeUInt16BE(0xffff, 20);
      frame.writeUInt16BE(0xffff, 22);
    });
    const expected = decodeIfB2Frame(invalidComposition, profile);
    const reading = adapter.parseNotification(invalidComposition)!;

    expect(adapter.computeMetrics(reading, profile)).toMatchObject({
      bodyFatPercent: expected.fatPercent,
      waterPercent: expected.waterPercent,
      bmr: expected.bmr,
      metabolicAge: expected.bodyAge,
    });
  });

  it('uses the selected profile rather than the transport startup profile', async () => {
    const selectedProfile: UserProfile = { ...profile, age: 62, gender: 'female' };
    const transportProfile: UserProfile = { ...profile, age: 20 };
    const expected = decodeIfB2Frame(health, selectedProfile);
    const adapter = new SenssunIfB2Adapter();
    await adapter.onConnected(
      context([], () => ({ userSlug: 'alice', profile: selectedProfile }), transportProfile),
    );
    await settleSelection(adapter);
    adapter.parseNotification(profileUpdated);

    const reading = adapter.parseNotification(health)!;
    expect(adapter.computeMetrics(reading, transportProfile)).toMatchObject({
      bodyFatPercent: expected.fatPercent,
      waterPercent: expected.waterPercent,
      bmr: expected.bmr,
      metabolicAge: expected.bodyAge,
    });
  });

  describe.each([
    ['onSessionStart', (adapter: SenssunIfB2Adapter) => adapter.onSessionStart()],
    ['onSessionEnd', (adapter: SenssunIfB2Adapter) => adapter.onSessionEnd()],
  ] as const)('%s lifecycle boundary', (_name, lifecycle) => {
    it('cancels a pending quiet-period candidate', async () => {
      const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
      const adapter = new SenssunIfB2Adapter();
      await adapter.onConnected(context(writes));
      adapter.parseNotification(quietLive);
      await vi.advanceTimersByTimeAsync(1_000);

      lifecycle(adapter);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(writes).toEqual([]);
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

      const nextSelect = vi.fn(() => ({
        userSlug: 'next',
        profile: { ...profile, age: 28 },
      }));
      const nextWrites: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
      await adapter.onConnected(context(nextWrites, nextSelect));
      expect(() => adapter.parseNotification(health)).toThrow(
        /final record arrived before safe profile selection/,
      );
      await settleSelection(adapter);
      expect(nextWrites[0]?.data).toEqual(buildCloudProfileCommand({ ...profile, age: 28 }, 72.6));
      adapter.parseNotification(profileCreated);
      expect(adapter.parseNotification(health)).toMatchObject({ selectedUserSlug: 'next' });
      vi.useRealTimers();
    });

    it('clears partial reassembly bytes and pending command errors', async () => {
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
