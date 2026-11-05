import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  SenssunIfB2Adapter,
  IfB2Reassembler,
  buildCloudProfileCommand,
  decodeIfB2Frame,
  IF_B2_MAX_PROFILE_WRITES,
  IF_B2_RECORD_WAIT_MS,
} from '../../src/scales/senssun-if-b2.js';
import { buildPayload, r2, uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { ScaleReading, UserProfile } from '../../src/interfaces/scale-adapter.js';
import { buildAdapterRuntimeConfig, resolveUserProfile } from '../../src/config/resolve.js';
import type { AppConfig, UserConfig } from '../../src/config/schema.js';
import { bleLog } from '../../src/ble/types.js';
import { freshAdapter, replaySession } from '../helpers/replay/session.js';
import { session as LOGGED } from '../fixtures/senssun/if-b2.js';

// Frames come from the DEBUG logs of tests/fixtures/senssun/if-b2.ts. A derived
// frame says what changed; its checksum (the last byte, the sum of bytes 4 to
// the one before it) is recomputed. Expected weights are read from the frames.
const frames = (trace: string): Buffer[] =>
  LOGGED.traces[trace].steps.map((step) => Buffer.from(step.hex, 'hex'));
const BAREFOOT = frames('if-b2-473-barefoot');
const SECOND = frames('if-b2-473-barefoot-second');
const SOCKS = frames('if-b2-473-socks');

function derive(base: Buffer, change: (frame: Buffer) => void): Buffer {
  const frame = Buffer.from(base);
  change(frame);
  frame[frame.length - 1] = frame
    .subarray(4, frame.length - 1)
    .reduce((sum, value) => (sum + value) & 0xff, 0);
  return frame;
}

/** The last live weight before the ack; the record repeats it. */
const live = BAREFOOT[22];
const W = live.readUInt16BE(7) / 10;
/** The logged ack: status 0x00, PIN 0001. */
const ack = BAREFOOT[23];
/** The barefoot record, logged in two notifications of 20 and 9 bytes. */
const health = Buffer.concat([BAREFOOT[24], BAREFOOT[25]]);
const alternateLive = SECOND[2];
const W2 = alternateLive.readUInt16BE(7) / 10;
/** The second barefoot record, also 20 + 9 bytes. */
const alternateHealth = Buffer.concat([SECOND[4], SECOND[5]]);
/** Derived from health: slot 0x0f and 120 in bytes 24-27. */
const historicalHealth = derive(health, (frame) => {
  frame[7] = 0x0f;
  frame.writeUInt32BE(120, 24);
});
/** Derived from the logged ack: byte 7 (status) and byte 9 (PIN low byte) set. */
function profileAcknowledgement(status: number, pin = 1): Buffer {
  return derive(ack, (frame) => {
    frame[7] = status;
    frame[9] = pin;
  });
}

/** The made-up profile the reporter used, as in the fixture. */
const profile = { height: 176, age: 42, gender: 'male' as const, isAthlete: false };
const profileCommand = buildCloudProfileCommand(profile, W);
/** That profile as the pin carries it once the scale acked it. */
const SENT = { ...profile, birthDate: null, clamped: false };
/** The body fat of a record, bytes 12-13 / 10. */
const fatOf = (rec: Buffer): number => rec.readUInt16BE(12) / 10;

/** Derived from live: bytes 7-8 (kg x 10) and byte 12 set. */
function liveFrame(weightTenths: number, control = 0xa0): Buffer {
  return derive(live, (frame) => {
    frame.writeUInt16BE(weightTenths, 7);
    frame[12] = control;
  });
}

const LIVE_TENTHS = live.readUInt16BE(7);
const quietLive = live;
const changedLive = liveFrame(LIVE_TENTHS - 1);
const W_CHANGED = (LIVE_TENTHS - 1) / 10;
const zeroLive = liveFrame(0);

const USED = "Senssun IF_B2: using the scale's body fat, computed for the profile sent to it";
const REASON = {
  noFat: 'the scale reported no body fat',
  fatOut: "the scale's body fat is out of range",
  otherOut: 'another value in the record is out of range',
  notConfirmed: 'the scale did not confirm the profile sent to it before the record',
  clamped:
    'the profile sent to the scale had its height or age clamped to the range of the profile command',
  otherProfile:
    'the weigh-in was matched to a user whose height, sex, birth date, age or athlete setting is not the profile sent to the scale',
  switched:
    'with more than one user, the scale did not confirm this same profile before this weigh-in in this run, and it may have used the one it had',
};
const NO_ESTIMATE = 'exporting no body composition (estimate_body_composition is off)';
const MATCHED = 'Senssun IF_B2: writing the profile of the user this weight matches';
const NO_MATCH = "Senssun IF_B2: no user matches this weight, writing the first user's profile";
const notUsed = (why: string, note = 'using the estimate'): string =>
  `Senssun IF_B2: the scale's body fat is not used for this weigh-in: ${why}; ${note}`;

describe('Senssun IF_B2 protocol', () => {
  it.each([
    ['barefoot', BAREFOOT.slice(0, 23)],
    ['socks', SOCKS.slice(0, 10)],
    ['second barefoot', SECOND.slice(0, 3)],
  ])('decodes every %s live frame: kg and lb, byte 11 0x01, byte 12 0xa0', (_, lives) => {
    for (const frame of lives) {
      const decoded = decodeIfB2Frame(frame);
      expect(decoded).toMatchObject({
        frameType: 'live_weight',
        weightKg: frame.readUInt16BE(7) / 10,
        weightLb: frame.readUInt16BE(9) / 10,
        unitCode: 0x01,
        control: 0xa0,
      });
      const ratio = frame.readUInt16BE(9) / frame.readUInt16BE(7);
      expect(ratio).toBeGreaterThan(2.2);
      expect(ratio).toBeLessThan(2.21);
    }
  });
  it('decodes zero live weight so it can clear a provisional candidate', () => {
    expect(decodeIfB2Frame(zeroLive)).toMatchObject({
      frameType: 'live_weight',
      weightKg: 0,
      control: 0xa0,
    });
  });
  it.each([
    ['barefoot', health, W],
    ['second barefoot', alternateHealth, W2],
  ])('decodes the %s record: slot 0, PIN 0001, the live weight, 0 in bytes 24-27', (_, rec, w) => {
    expect(decodeIfB2Frame(rec)).toMatchObject({
      frameType: 'health_record',
      recordSlot: 0,
      profilePin: '0001',
      weightKg: w,
      elapsedSeconds: 0,
    });
  });
  it.each([
    ['barefoot', health],
    ['second barefoot', alternateHealth],
  ])('decodes bytes 12-23 of the %s record', (_, rec) => {
    expect(decodeIfB2Frame(rec)).toMatchObject({
      fatPercent: rec.readUInt16BE(12) / 10,
      impedanceOhms: rec.readUInt16BE(14),
      field16: rec.readUInt16BE(16) / 10,
      field18: rec.readUInt16BE(18) / 10,
      field20: rec.readUInt16BE(20) / 10,
      field22: rec.readUInt16BE(22),
    });
  });
  it('decodes the logged ack', () => {
    expect(decodeIfB2Frame(ack)).toMatchObject({
      frameType: 'profile_ack',
      status: 0,
      profilePin: '0001',
    });
    expect(decodeIfB2Frame(SOCKS[10])).toEqual(decodeIfB2Frame(ack));
  });
  it('reassembles split and concatenated health frames', () => {
    const r = new IfB2Reassembler();
    expect(r.push(health.subarray(0, 20))).toEqual([]);
    expect(r.push(health.subarray(20))).toEqual([health]);
    const r2 = new IfB2Reassembler();
    expect(r2.push(Buffer.concat([live, health]))).toEqual([live, health]);
    // Derived from live: byte 4 (length) set to 0x7f, cut after byte 5.
    const malformed = derive(live, (frame) => {
      frame[4] = 0x7f;
    }).subarray(0, 6);
    expect(new IfB2Reassembler().push(Buffer.concat([malformed, live]))).toEqual([live]);
  });
  it('reassembles a profile acknowledgement followed by a live frame', () => {
    const r = new IfB2Reassembler();
    expect(r.push(Buffer.concat([ack, live]))).toEqual([ack, live]);
  });
  it('resynchronizes after a truncated acknowledgement prefix', () => {
    const reassembler = new IfB2Reassembler();
    expect(reassembler.push(Buffer.concat([ack.subarray(0, 5), ack]))).toEqual([ack]);
  });
  it('drops a record cut short when the next notification is a whole frame', () => {
    // Derived from health: its first 7 bytes, then the logged ack on its own.
    const reassembler = new IfB2Reassembler();
    expect(reassembler.push(health.subarray(0, 7))).toEqual([]);
    expect(reassembler.push(ack)).toEqual([ack]);
    expect(reassembler.push(health.subarray(0, 20))).toEqual([]);
    expect(reassembler.push(health.subarray(20))).toEqual([health]);
  });
  it('recovers a complete acknowledgement behind an incomplete health-record prefix', () => {
    const reassembler = new IfB2Reassembler();
    expect(reassembler.push(Buffer.concat([health.subarray(0, 5), ack]))).toEqual([ack]);
  });
  it('keeps a complete checksum-valid outer frame containing an acknowledgement header', () => {
    const frame = Buffer.from(health);
    ack.copy(frame, 12);
    frame[28] = frame.subarray(4, 28).reduce((sum, value) => (sum + value) & 0xff, 0);
    expect(new IfB2Reassembler().push(frame)).toEqual([frame]);
  });
  it('preserves a fragmented outer record containing a complete acknowledgement in its payload', () => {
    const frame = Buffer.from(health);
    ack.copy(frame, 12);
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
  // The command layout is the pull request's code; no log shows a write. The
  // weight here is invented.
  it('builds the exact reusable cloud profile command', () => {
    expect(buildCloudProfileCommand(profile, 72.6)).toEqual(
      Buffer.from('100000c51303010000000101b02a000000483b', 'hex'),
    );
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
    const malformed = Buffer.from(ack);
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
  async function selectedAdapter(answer?: Buffer, lookup?: Lookup): Promise<SenssunIfB2Adapter> {
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, [], lookup);
    await settleSelection(adapter);
    if (answer) adapter.parseNotification(answer);
    return adapter;
  }
  async function acknowledgedAdapter(): Promise<SenssunIfB2Adapter> {
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
    expect(lookup).toHaveBeenCalledExactlyOnceWith(W);
  });

  it('looks the profile up once per weigh-in, on the settled weight', async () => {
    const lookup = vi.fn(() => profile);
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, [], lookup);
    for (let tenths = 100; tenths <= LIVE_TENTHS; tenths += 50)
      adapter.parseNotification(liveFrame(tenths));
    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(2_000);
    for (let i = 0; i < 5; i++) adapter.parseNotification(quietLive);
    adapter.parseNotification(ack);
    adapter.parseNotification(health);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(W);
  });

  it('writes the sex, height, age and athlete flag of the profile the lookup returns', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const other: UserProfile = { height: 158, age: 35, gender: 'female', isAthlete: true };
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes, () => other);
    await settleSelection(adapter);
    expect(writes[0]?.data).toEqual(buildCloudProfileCommand(other, W));
    expect(writes[0]?.data.subarray(11, 15)).toEqual(Buffer.from([0, 158, 35, 5]));
  });

  it('writes the transport profile when the lookup matches nobody', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes, () => undefined);
    await settleSelection(adapter);
    expect(writes[0]?.data).toEqual(profileCommand);
  });

  it.each([
    ['a user matches', (): UserProfile | undefined => profile, MATCHED],
    ['nobody matches', (): UserProfile | undefined => undefined, NO_MATCH],
    ['no lookup is configured', undefined, NO_MATCH],
  ])('logs one debug line on the profile choice when %s', async (_, lookup, expected) => {
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, [], lookup);
    await settleSelection(adapter);
    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(2_000);
    const lines = debug.mock.calls
      .map(([msg]) => String(msg))
      .filter((msg) => msg === MATCHED || msg === NO_MATCH);
    expect(lines).toEqual([expected]);
    debug.mockRestore();
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
    for (let tenths = 100; tenths <= LIVE_TENTHS; tenths += 2)
      adapter.parseNotification(liveFrame(tenths));
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
    expect(writes[0]?.data).toEqual(buildCloudProfileCommand(fractional, W));
    expect(writes[0]?.data[12]).toBe(168);
    adapter.parseNotification(ack);
    expect(adapter.parseNotification(health)).toMatchObject({
      weight: W,
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
    const lookup = vi.fn(() => profile);
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes, lookup);

    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(1_500);
    adapter.parseNotification(changedLive);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes[0]?.data).toEqual(buildCloudProfileCommand(profile, W_CHANGED));
    expect(lookup).toHaveBeenCalledExactlyOnceWith(W_CHANGED);
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

  it('retries every 200 ms until the ack', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);
    await settleSelection(adapter);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(201);
    expect(writes).toHaveLength(3);
    expect(adapter.parseNotification(ack)).toMatchObject({ weight: W });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toHaveLength(3);
    expect(
      writes.every(({ data, withResponse }) => data.equals(profileCommand) && withResponse),
    ).toBe(true);
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

  it('accepts a current record after the ack', async () => {
    const adapter = await acknowledgedAdapter();
    expect(adapter.parseNotification(health)).toMatchObject({ weight: W, impedance: 0 });
  });

  it('emits a record that arrives before any profile write, and writes nothing', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);
    expect(adapter.parseNotification(health)).toMatchObject({ weight: W, impedance: 0 });
    adapter.parseNotification(quietLive);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toEqual([]);
  });
  it('emits a record that arrives before the profile ack, once', async () => {
    const adapter = await selectedAdapter();
    expect(adapter.parseNotification(health)).toMatchObject({ weight: W, impedance: 0 });
    expect(adapter.parseNotification(ack)).toBeNull();
    expect(adapter.parseNotification(health)).toBeNull();
  });
  it('processes a concatenated current record and acknowledgement in order', async () => {
    const adapter = await selectedAdapter();
    const reading = adapter.parseNotification(Buffer.concat([health, ack]))!;
    expect(reading).toEqual({
      weight: health.readUInt16BE(10) / 10,
      impedance: 0,
      scaleComposition: { fat: fatOf(health), recordInRange: false, sent: null, multiUser: null },
    });
    expect(adapter.isFinal(reading)).toBe(true);
  });

  it('emits a record with no age without a timestamp', async () => {
    const adapter = await acknowledgedAdapter();
    const reading = adapter.parseNotification(health)!;
    expect(reading).toMatchObject({ weight: W });
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
      adapter.isFinal(adapter.parseNotification(Buffer.concat([quietLive, health, ack]))!),
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
    expect(adapter.parseNotification(ack)).toMatchObject({ weight: W });
    expect(adapter.parseNotification(health)).toMatchObject({ weight: W });
  });
  it('returns the settled weight on the ack as a held, not final, reading', async () => {
    const writes: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, writes);
    await settleSelection(adapter);
    const display = adapter.parseNotification(quietLive)!;
    expect(adapter.isComplete(display)).toBe(false);

    const held = adapter.parseNotification(ack)!;
    expect(held).toEqual({ weight: W, impedance: 0 });
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
    adapter.parseNotification(ack);
    rejectWrite(new Error('late'));
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.parseNotification(health)).toMatchObject({ impedance: 0 });
  });

  it('processes a concatenated acknowledgement and current record in order', async () => {
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter);
    await settleSelection(adapter);
    const reading = adapter.parseNotification(Buffer.concat([ack, health]))!;
    expect(reading).toEqual({
      weight: health.readUInt16BE(10) / 10,
      impedance: 0,
      scaleComposition: { fat: fatOf(health), recordInRange: false, sent: SENT, multiUser: null },
    });
    expect(adapter.isFinal(reading)).toBe(true);
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
    expect(adapter.parseNotification(health)).toMatchObject({ weight: W });
  });

  it('emits a record split over two notifications once', async () => {
    const adapter = await acknowledgedAdapter();
    expect(adapter.parseNotification(health.subarray(0, 20))).toBeNull();
    const reading = adapter.parseNotification(health.subarray(20))!;
    expect(reading).toMatchObject({ weight: W, impedance: 0 });
    expect(adapter.isComplete(reading)).toBe(true);
    expect(adapter.parseNotification(health)).toBeNull();
  });

  it('estimates from BMI for the profile computeMetrics gets, not the one written', async () => {
    const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    const written: UserProfile = { ...profile, age: 62, gender: 'female' };
    const other: UserProfile = { height: 160, age: 25, gender: 'female', isAthlete: true };
    const adapter = new SenssunIfB2Adapter();
    await connect(adapter, [], () => written);
    await settleSelection(adapter);
    adapter.parseNotification(ack);
    const reading = adapter.parseNotification(alternateHealth)!;

    expect(reading).toEqual({
      weight: W2,
      impedance: 0,
      scaleComposition: {
        fat: fatOf(alternateHealth),
        recordInRange: true,
        sent: { ...written, birthDate: null, clamped: false },
        multiUser: null,
      },
    });
    for (const p of [profile, other])
      expect(adapter.computeMetrics(reading, p)).toEqual(buildPayload(W2, 0, {}, p));
    const off = { ...profile, estimateBodyComposition: false };
    expect(adapter.computeMetrics(reading, off)).toEqual(buildPayload(W2, 0, {}, off));
    expect(adapter.computeMetrics(reading, off).bodyFatPercent).toBeNull();
    const lines = info.mock.calls.map(([msg]) => String(msg));
    expect(lines).toEqual([
      notUsed(REASON.otherProfile),
      notUsed(REASON.otherProfile),
      notUsed(REASON.otherProfile, NO_ESTIMATE),
      notUsed(REASON.otherProfile, NO_ESTIMATE),
    ]);
    info.mockRestore();
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
      const oldWrites: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
      const adapter = new SenssunIfB2Adapter();
      await adapter.onConnected(context(oldWrites));
      await settleSelection(adapter);
      adapter.parseNotification(ack);
      const count = oldWrites.length;
      lifecycle(adapter);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(oldWrites).toHaveLength(count);

      const nextWrites: Array<{ uuid: string; data: Buffer; withResponse: boolean }> = [];
      await connect(adapter, nextWrites, () => ({ ...profile, age: 28 }));
      await settleSelection(adapter);
      expect(nextWrites[0]?.data).toEqual(buildCloudProfileCommand({ ...profile, age: 28 }, W));
      adapter.parseNotification(ack);
      expect(adapter.parseNotification(health)).toMatchObject({ weight: W });
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

  describe('Senssun IF_B2 scale body fat (D091)', () => {
    let info: MockInstance<typeof bleLog.info>;
    beforeEach(() => {
      info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    /** The info lines of the gate since the last call. */
    function gateLines(): string[] {
      const lines = info.mock.calls
        .map(([msg]) => String(msg))
        .filter((msg) => msg.includes("the scale's body fat"));
      info.mockClear();
      return lines;
    }
    /** computeMetrics, and the gate lines it logged. */
    function gate(adapter: SenssunIfB2Adapter, reading: ScaleReading, p: UserProfile) {
      gateLines();
      const payload = adapter.computeMetrics(reading, p);
      return { payload, lines: gateLines() };
    }
    /** Derived from the second barefoot record (bytes 12-23 in range), checksum recomputed. */
    const record = (change: (frame: Buffer) => void): Buffer => derive(alternateHealth, change);
    const usedPayload = (p: UserProfile = profile, rec: Buffer = alternateHealth) =>
      buildPayload(rec.readUInt16BE(10) / 10, 0, { fat: fatOf(rec) }, p);
    const estimate = (p: UserProfile = profile, rec: Buffer = alternateHealth) =>
      buildPayload(rec.readUInt16BE(10) / 10, 0, {}, p);
    /** One weigh-in on a fresh adapter: profile written, `answer` (the logged ack), `rec`. */
    async function weighed(
      rec: Buffer,
      answer: Buffer | null = ack,
      lookup?: Lookup,
    ): Promise<{ adapter: SenssunIfB2Adapter; reading: ScaleReading }> {
      const adapter = await selectedAdapter(answer ?? undefined, lookup);
      const reading = adapter.parseNotification(rec)!;
      return { adapter, reading };
    }

    it('uses the body fat of the second barefoot weigh-in, replayed from its log', async () => {
      const trace = LOGGED.traces['if-b2-473-barefoot-second'];
      const r = await replaySession(freshAdapter(LOGGED), trace, LOGGED);
      const fat = fatOf(alternateHealth);
      expect(r.reading).toEqual({
        weight: W2,
        impedance: 0,
        scaleComposition: { fat, recordInRange: true, sent: SENT, multiUser: null },
      });
      // The harness computes the payload after onSessionEnd: only the pin is left.
      expect(r.payload).toEqual(buildPayload(W2, 0, { fat }, profile));
      expect(r.payload?.bodyFatPercent).toBe(r2(fat));
      expect(gateLines()).toEqual([USED]);
    });

    it('estimates the first barefoot weigh-in, replayed from its log: body fat out of range', async () => {
      const trace = LOGGED.traces['if-b2-473-barefoot'];
      const r = await replaySession(freshAdapter(LOGGED), trace, LOGGED);
      expect(r.reading).toEqual({
        weight: W,
        impedance: 0,
        scaleComposition: { fat: fatOf(health), recordInRange: false, sent: SENT, multiUser: null },
      });
      expect(r.payload).toEqual(buildPayload(W, 0, {}, profile));
      expect(gateLines()).toEqual([notUsed(REASON.fatOut)]);
    });

    it.each([
      ['0x0000', 0x0000, REASON.noFat],
      ['0x0fff', 0x0fff, REASON.fatOut],
    ])('estimates a record with body fat %s in bytes 12-13', async (_, raw, why) => {
      const rec = record((f) => f.writeUInt16BE(raw, 12));
      const { adapter, reading } = await weighed(rec);
      const { payload, lines } = gate(adapter, reading, profile);
      expect(payload).toEqual(estimate(profile, rec));
      expect(lines).toEqual([notUsed(why)]);
    });

    it.each([
      [true, 'the second barefoot record', alternateHealth],
      [false, 'the first barefoot record', health],
      [false, 'a record with bytes 16-17 0x0000', record((f) => f.writeUInt16BE(0x0000, 16))],
      [false, 'a record with bytes 16-17 0xffff', record((f) => f.writeUInt16BE(0xffff, 16))],
      [false, 'a record with bytes 18-19 0x0000', record((f) => f.writeUInt16BE(0x0000, 18))],
      [false, 'a record with bytes 18-19 0xffff', record((f) => f.writeUInt16BE(0xffff, 18))],
      // 90.0: outside a water percentage, inside 0-100.
      [true, 'a record with bytes 16-17 0x0384', record((f) => f.writeUInt16BE(0x0384, 16))],
      // Not part of the check: the processor decides about an impedance.
      [true, 'a record with bytes 14-15 0x0000', record((f) => f.writeUInt16BE(0x0000, 14))],
      [true, 'a record with bytes 14-15 0x1000', record((f) => f.writeUInt16BE(0x1000, 14))],
      [true, 'a record with bytes 20-21 0x0000', record((f) => f.writeUInt16BE(0x0000, 20))],
      [true, 'a record with bytes 22-23 0x0000', record((f) => f.writeUInt16BE(0x0000, 22))],
    ])('pins recordInRange %s for %s', async (inRange, _, rec) => {
      const { adapter, reading } = await weighed(rec);
      expect(reading.scaleComposition).toMatchObject({ recordInRange: inRange });
      if (rec === health) return;
      const { payload, lines } = gate(adapter, reading, profile);
      expect(payload).toEqual(inRange ? usedPayload(profile, rec) : estimate(profile, rec));
      expect(lines).toEqual([inRange ? USED : notUsed(REASON.otherOut)]);
    });

    it('checks the rest of the record before the ack', async () => {
      // Derived: bytes 16-17 0xffff, and the scale acks nothing.
      const rec = record((f) => f.writeUInt16BE(0xffff, 16));
      const { adapter, reading } = await weighed(rec, null);
      expect(gate(adapter, reading, profile).lines).toEqual([notUsed(REASON.otherOut)]);
    });

    it('estimates a record after a profile write the scale did not ack', async () => {
      const { adapter, reading } = await weighed(alternateHealth, null);
      expect(reading.scaleComposition).toMatchObject({ sent: null });
      const { payload, lines } = gate(adapter, reading, profile);
      expect(payload).toEqual(estimate());
      expect(lines).toEqual([notUsed(REASON.notConfirmed)]);
    });

    it.each([1, 2, 3])('estimates a record after an ack with status 0x0%i', async (status) => {
      const { adapter, reading } = await weighed(alternateHealth, profileAcknowledgement(status));
      const { payload, lines } = gate(adapter, reading, profile);
      expect(payload).toEqual(estimate());
      expect(lines).toEqual([notUsed(REASON.notConfirmed)]);
    });

    it('uses the body fat only when the ack comes before the record in one notification', async () => {
      const first = await selectedAdapter();
      const recordFirst = first.parseNotification(Buffer.concat([alternateHealth, ack]))!;
      expect(gate(first, recordFirst, profile).lines).toEqual([notUsed(REASON.notConfirmed)]);
      const second = await selectedAdapter();
      const ackFirst = second.parseNotification(Buffer.concat([ack, alternateHealth]))!;
      expect(gate(second, ackFirst, profile)).toEqual({ payload: usedPayload(), lines: [USED] });
    });

    it('estimates a record that comes before any profile write', async () => {
      const adapter = new SenssunIfB2Adapter();
      await connect(adapter);
      const reading = adapter.parseNotification(alternateHealth)!;
      const { payload, lines } = gate(adapter, reading, profile);
      expect(payload).toEqual(estimate());
      expect(lines).toEqual([notUsed(REASON.notConfirmed)]);
    });

    it('uses the body fat after a late ack, once the writes gave up', async () => {
      const adapter = await selectedAdapter();
      await vi.advanceTimersByTimeAsync(6_000);
      adapter.parseNotification(ack);
      const reading = adapter.parseNotification(alternateHealth)!;
      expect(gate(adapter, reading, profile)).toEqual({ payload: usedPayload(), lines: [USED] });
    });

    describe('the weigh-in user against the profile written', () => {
      const written: UserProfile = { ...profile, birthDate: '1984-05-10' };
      it.each([
        ['a height 1 cm more', { ...written, height: written.height + 1 }],
        ['the other sex', { ...written, gender: 'female' as const }],
        ['an age 1 year more', { ...written, age: written.age + 1 }],
        ['the athlete setting on', { ...written, isAthlete: true }],
        ['a birth date a day later, at the same age', { ...written, birthDate: '1984-05-11' }],
      ])('estimates for a user with %s', async (_, user) => {
        const { adapter, reading } = await weighed(alternateHealth, ack, () => written);
        const { payload, lines } = gate(adapter, reading, user);
        expect(payload).toEqual(estimate(user));
        expect(lines).toEqual([notUsed(REASON.otherProfile)]);
      });
      it('uses the body fat for a height 0.4 cm more: the same whole cm', async () => {
        const { adapter, reading } = await weighed(alternateHealth, ack, () => written);
        const user = { ...written, height: written.height + 0.4 };
        expect(gate(adapter, reading, user)).toEqual({ payload: usedPayload(user), lines: [USED] });
      });
      it('uses the body fat for a height in inches, written and matched alike', async () => {
        const scale = { weight_unit: 'kg', height_unit: 'in', display_unit: 'weight_unit' };
        const inches = resolveUserProfile(
          {
            name: 'Inch',
            slug: 'inch',
            height: 69,
            birth_date: '1984-01-01',
            gender: 'male',
            is_athlete: false,
            weight_range: { min: 40, max: 150 },
            last_known_weight: null,
          } as UserConfig,
          scale as AppConfig['scale'],
        );
        expect(Number.isInteger(inches.height)).toBe(false);
        const { adapter, reading } = await weighed(alternateHealth, ack, () => inches);
        expect(gate(adapter, reading, inches)).toEqual({
          payload: usedPayload(inches),
          lines: [USED],
        });
      });
    });

    it.each([
      ['age', 0],
      ['age', 121],
      ['height', 49],
      ['height', 260],
    ] as const)(
      'estimates when the %s %i had to be clamped for the command',
      async (key, value) => {
        const user: UserProfile = { ...profile, [key]: value };
        const { adapter, reading } = await weighed(alternateHealth, ack, () => user);
        const { payload, lines } = gate(adapter, reading, user);
        expect(payload).toEqual(estimate(user));
        expect(lines).toEqual([notUsed(REASON.clamped)]);
      },
    );

    it('checks the transport profile written when the lookup matches nobody', async () => {
      const transport: UserProfile = { height: 181, age: 35, gender: 'female', isAthlete: false };
      const adapter = new SenssunIfB2Adapter();
      await connect(adapter, [], () => undefined, transport);
      await settleSelection(adapter);
      adapter.parseNotification(ack);
      const reading = adapter.parseNotification(alternateHealth)!;
      expect(gate(adapter, reading, transport)).toEqual({
        payload: usedPayload(transport),
        lines: [USED],
      });
      expect(gate(adapter, reading, profile).lines).toEqual([notUsed(REASON.otherProfile)]);
    });

    describe('keeps everything the gate reads pinned to the reading', () => {
      const other: UserProfile = { height: 160, age: 25, gender: 'female', isAthlete: true };
      it('through another weigh-in with its own profile and ack', async () => {
        const { adapter, reading } = await weighed(alternateHealth);
        adapter.onSessionEnd();
        adapter.onSessionStart();
        await connect(adapter, [], () => other);
        await settleSelection(adapter);
        adapter.parseNotification(ack);
        expect(gate(adapter, reading, profile)).toEqual({ payload: usedPayload(), lines: [USED] });
      });
      it('through a reload with another lookup', async () => {
        const { adapter, reading } = await weighed(alternateHealth);
        adapter.configure({ profileForWeight: () => other });
        expect(gate(adapter, reading, profile)).toEqual({ payload: usedPayload(), lines: [USED] });
      });
      it('through a next session that writes and gets no ack', async () => {
        const { adapter, reading } = await weighed(alternateHealth);
        adapter.onSessionEnd();
        adapter.onSessionStart();
        await connect(adapter);
        await settleSelection(adapter);
        expect(gate(adapter, reading, profile)).toEqual({ payload: usedPayload(), lines: [USED] });
      });
    });

    it('keeps the estimate for the weight held from the ack, without a line', async () => {
      const adapter = await selectedAdapter();
      const held = adapter.parseNotification(ack)!;
      expect(held).toEqual({ weight: W, impedance: 0 });
      expect(gate(adapter, held, profile)).toEqual({
        payload: buildPayload(W, 0, {}, profile),
        lines: [],
      });
    });

    it('exports the accepted body fat and nothing for a rejected one with the estimate off', async () => {
      const off: UserProfile = { ...profile, estimateBodyComposition: false };
      const used = await weighed(alternateHealth);
      const accepted = gate(used.adapter, used.reading, off);
      expect(accepted.payload.bodyFatPercent).toBe(r2(fatOf(alternateHealth)));
      expect(accepted.lines).toEqual([USED]);
      const unconfirmed = await weighed(alternateHealth, null);
      const rejected = gate(unconfirmed.adapter, unconfirmed.reading, off);
      expect(rejected.payload.bodyFatPercent).toBeNull();
      expect(rejected.lines).toEqual([notUsed(REASON.notConfirmed, NO_ESTIMATE)]);
    });

    it('logs no profile value and no command byte', async () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const madeUp: UserProfile = { height: 187, age: 63, gender: 'female', isAthlete: false };
      const fixture = { ...LOGGED, profile: madeUp, config: { profileForWeight: () => madeUp } };
      const trace = LOGGED.traces['if-b2-473-barefoot-second'];
      const r = await replaySession(freshAdapter(fixture), trace, fixture);
      expect(r.writes.length).toBeGreaterThan(0);
      const lines = [...debug.mock.calls, ...info.mock.calls]
        .map(([msg]) => String(msg))
        .filter((msg) => msg.startsWith('Senssun IF_B2:'));
      const allowed = [
        /^Senssun IF_B2: record \d+\.\d kg, fat \d+(\.\d)? %, impedance \d+ ohm, bytes 16-19 (in|out of) range$/,
        /^Senssun IF_B2: profile confirmed after \d+ write\(s\), \d+ ms after the first$/,
      ];
      expect(lines).toContain(USED);
      expect(lines).toContain(MATCHED);
      for (const line of lines) {
        expect(line === USED || line === MATCHED || allowed.some((re) => re.test(line)), line).toBe(
          true,
        );
        for (const w of r.writes) expect(line).not.toContain(w.hex);
      }
    });

    it.each([
      ['second barefoot', alternateHealth, 'in'],
      ['first barefoot', health, 'out of'],
    ])('logs the decoded %s record once, in a debug line', async (_, rec, range) => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const adapter = await selectedAdapter(ack);
      adapter.parseNotification(rec);
      adapter.parseNotification(rec);
      const expected =
        `Senssun IF_B2: record ${(rec.readUInt16BE(10) / 10).toFixed(1)} kg, ` +
        `fat ${rec.readUInt16BE(12) / 10} %, impedance ${rec.readUInt16BE(14)} ohm, ` +
        `bytes 16-19 ${range} range`;
      const lines = debug.mock.calls
        .map(([msg]) => String(msg))
        .filter((msg) => msg.startsWith('Senssun IF_B2: record'));
      expect(lines).toEqual([expected]);
    });

    describe('with more than one user', () => {
      const user = (name: string, height: number, min: number, max: number): UserConfig => ({
        name,
        slug: name.toLowerCase(),
        height,
        birth_date: '1984-01-01',
        gender: 'male',
        is_athlete: false,
        weight_range: { min, max },
        last_known_weight: null,
      });
      // A's range holds the logged weight, B's a made-up one far below it.
      const alice = user('Alice', 176, Math.floor(W2) - 5, Math.ceil(W2) + 5);
      const bob = user('Bob', 168, 20, 40);
      const liveA = alternateLive;
      const liveB = liveFrame(300);
      const configOf = (users: UserConfig[]): AppConfig =>
        ({
          scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' },
          unknown_user: 'nearest',
          users,
        }) as unknown as AppConfig;
      const TWO = configOf([alice, bob]);
      // Made up, locally administered.
      const SCALE_X = '02:00:00:00:00:0a';
      const SCALE_Y = '02:00:00:00:00:0b';
      const A = (): UserProfile => resolveUserProfile(alice, TWO.scale);
      const B = (): UserProfile => resolveUserProfile(bob, TWO.scale);

      function adapterFor(config: AppConfig): SenssunIfB2Adapter {
        const adapter = new SenssunIfB2Adapter();
        adapter.configure(buildAdapterRuntimeConfig(config, undefined));
        return adapter;
      }
      /**
       * A whole session on `adapter` with the scale at `address` (null: the
       * transport gave none): live weight and profile write (none without
       * `liveWeight`), `answer`, `rec`.
       */
      async function weighIn(
        adapter: SenssunIfB2Adapter,
        liveWeight: Buffer | null,
        answer: Buffer | null = ack,
        rec: Buffer | null = alternateHealth,
        address: string | null = SCALE_X,
      ): Promise<ScaleReading | null> {
        adapter.onSessionStart(address ?? undefined);
        await adapter.onConnected(context());
        if (liveWeight) await settleSelection(adapter, liveWeight);
        if (answer) adapter.parseNotification(answer);
        const reading = rec ? adapter.parseNotification(rec) : null;
        adapter.onSessionEnd();
        return reading;
      }

      it('uses the first weigh-in of a fresh adapter with one user', async () => {
        const adapter = adapterFor(configOf([alice]));
        const reading = (await weighIn(adapter, liveA))!;
        expect(reading.scaleComposition).toMatchObject({ multiUser: null });
        expect(gate(adapter, reading, A())).toEqual({ payload: usedPayload(A()), lines: [USED] });
      });
      it('estimates the first weigh-in of a run', async () => {
        const adapter = adapterFor(TWO);
        const reading = (await weighIn(adapter, liveA))!;
        expect(reading.scaleComposition).toMatchObject({ multiUser: { previous: null } });
        expect(gate(adapter, reading, A())).toEqual({
          payload: estimate(A()),
          lines: [notUsed(REASON.switched)],
        });
      });
      it('uses the second weigh-in of the same user', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA);
        const second = (await weighIn(adapter, liveA))!;
        expect(gate(adapter, second, A())).toEqual({ payload: usedPayload(A()), lines: [USED] });
      });
      it('estimates the first weigh-in after another user', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA);
        const reading = (await weighIn(adapter, liveB))!;
        expect(gate(adapter, reading, B())).toEqual({
          payload: estimate(B()),
          lines: [notUsed(REASON.switched)],
        });
      });
      it('uses the second weigh-in of the other user', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA);
        await weighIn(adapter, liveB);
        const third = (await weighIn(adapter, liveB))!;
        expect(gate(adapter, third, B())).toEqual({ payload: usedPayload(B()), lines: [USED] });
      });
      it('estimates after a weigh-in whose ack had another status', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA);
        await weighIn(adapter, liveA, profileAcknowledgement(1), null);
        const third = (await weighIn(adapter, liveA))!;
        expect(gate(adapter, third, A()).lines).toEqual([notUsed(REASON.switched)]);
      });
      it('estimates after a weigh-in that wrote the profile and got no ack', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA);
        await weighIn(adapter, liveA, null, null);
        const third = (await weighIn(adapter, liveA))!;
        expect(gate(adapter, third, A()).lines).toEqual([notUsed(REASON.switched)]);
      });
      it('keeps the confirmed profile through a session with a record and no profile write', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA);
        const recordOnly = (await weighIn(adapter, null, null))!;
        expect(recordOnly.scaleComposition).toMatchObject({ sent: null, multiUser: null });
        const third = (await weighIn(adapter, liveA))!;
        expect(gate(adapter, third, A())).toEqual({ payload: usedPayload(A()), lines: [USED] });
      });
      it('names the profile mismatch, not the switch, for a weigh-in matched to the other user', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA);
        const reading = (await weighIn(adapter, liveB))!;
        expect(gate(adapter, reading, A())).toEqual({
          payload: estimate(A()),
          lines: [notUsed(REASON.otherProfile)],
        });
      });
      it('counts the users at the profile choice, not at the record', async () => {
        const adapter = adapterFor(configOf([alice]));
        adapter.onSessionStart(SCALE_X);
        await adapter.onConnected(context());
        await settleSelection(adapter, liveA);
        adapter.configure(buildAdapterRuntimeConfig(TWO, undefined));
        adapter.parseNotification(ack);
        const reading = adapter.parseNotification(alternateHealth)!;
        expect(reading.scaleComposition).toMatchObject({ multiUser: null });
      });
      it('estimates the first weigh-in on another scale', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA, ack, alternateHealth, SCALE_X);
        const other = (await weighIn(adapter, liveA, ack, alternateHealth, SCALE_Y))!;
        expect(other.scaleComposition).toMatchObject({ multiUser: { previous: null } });
        expect(gate(adapter, other, A()).lines).toEqual([notUsed(REASON.switched)]);
      });
      it('takes the address of the same scale in either spelling', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA, ack, alternateHealth, SCALE_X);
        const spelt = SCALE_X.replace(/:/g, '').toUpperCase();
        const second = (await weighIn(adapter, liveA, ack, alternateHealth, spelt))!;
        expect(gate(adapter, second, A())).toEqual({ payload: usedPayload(A()), lines: [USED] });
      });
      it.each([
        ['no address', null],
        ['an empty address', ''],
      ])('estimates every weigh-in of a scale with %s', async (_, address) => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA, ack, alternateHealth, address);
        const second = (await weighIn(adapter, liveA, ack, alternateHealth, address))!;
        expect(gate(adapter, second, A()).lines).toEqual([notUsed(REASON.switched)]);
      });
      it('keeps the confirmed profile through a reload', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA);
        adapter.configure(buildAdapterRuntimeConfig(TWO, undefined));
        const second = (await weighIn(adapter, liveA))!;
        expect(gate(adapter, second, A())).toEqual({ payload: usedPayload(A()), lines: [USED] });
      });
      it('reads only the pin: a later weigh-in of another user changes nothing', async () => {
        const adapter = adapterFor(TWO);
        await weighIn(adapter, liveA);
        const second = (await weighIn(adapter, liveA))!;
        await weighIn(adapter, liveB);
        expect(gate(adapter, second, A())).toEqual({ payload: usedPayload(A()), lines: [USED] });
      });
    });
  });
});
