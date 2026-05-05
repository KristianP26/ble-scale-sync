import { describe, it, expect, vi } from 'vitest';
import {
  AdeA2Adapter,
  buildAdeA2TimeSyncCommand,
  buildAdeA2ChallengeResponse,
} from '../../src/scales/ade-a2.js';
import { adapters } from '../../src/scales/index.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';

const EPOCH_2010 = 1262304000;

function makeCtx(): { ctx: ConnectionContext; writeFn: ReturnType<typeof vi.fn> } {
  const writeFn = vi.fn().mockResolvedValue(undefined);
  const ctx: ConnectionContext = {
    write: writeFn,
    read: vi.fn(),
    subscribe: vi.fn(),
    profile: defaultProfile(),
    deviceAddress: '',
    availableChars: new Set<string>(),
  };
  return { ctx, writeFn };
}

describe('buildAdeA2TimeSyncCommand', () => {
  it('emits opcode 0x02 followed by 4-byte LE seconds-since-2010', () => {
    const reference = new Date('2026-04-23T12:00:00Z');
    const expected = Math.floor(reference.getTime() / 1000) - EPOCH_2010;

    const cmd = buildAdeA2TimeSyncCommand(reference);

    expect(cmd.length).toBe(5);
    expect(cmd[0]).toBe(0x02);
    expect(cmd.readUInt32LE(1)).toBe(expected);
  });

  it('uses the current time when called without an argument', () => {
    const before = Math.floor(Date.now() / 1000) - EPOCH_2010;
    const cmd = buildAdeA2TimeSyncCommand();
    const after = Math.floor(Date.now() / 1000) - EPOCH_2010;

    const ts = cmd.readUInt32LE(1);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });
});

describe('buildAdeA2ChallengeResponse', () => {
  it('produces [OP_CHALLENGE, XOR(challenge, password)] for matching lengths', () => {
    const challenge = Buffer.from([0xaa, 0xbb, 0xcc]);
    const password = Buffer.from([0x11, 0x22, 0x33]);

    const response = buildAdeA2ChallengeResponse(challenge, password);

    expect(response.length).toBe(4);
    expect(response[0]).toBe(0xa1);
    expect(response[1]).toBe(0xaa ^ 0x11);
    expect(response[2]).toBe(0xbb ^ 0x22);
    expect(response[3]).toBe(0xcc ^ 0x33);
  });

  it('cycles the password when the challenge is longer', () => {
    const challenge = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50]);
    const password = Buffer.from([0x01, 0x02]);

    const response = buildAdeA2ChallengeResponse(challenge, password);

    expect(Array.from(response)).toEqual([
      0xa1,
      0x10 ^ 0x01,
      0x20 ^ 0x02,
      0x30 ^ 0x01,
      0x40 ^ 0x02,
      0x50 ^ 0x01,
    ]);
  });

  it('throws when the password buffer is empty', () => {
    const challenge = Buffer.from([0x10, 0x20]);
    expect(() => buildAdeA2ChallengeResponse(challenge, Buffer.alloc(0))).toThrow(
      /password buffer is empty/,
    );
  });
});

describe('AdeA2Adapter (inert scaffolding)', () => {
  it('is NOT registered in scales/index.ts (safety guard until #159 lands)', () => {
    // CI-level safeguard: prevent anyone from wiring the half-finished
    // adapter into the live registry before the BLE name prefix and
    // characteristic UUIDs have been confirmed against real hardware.
    const registered = adapters.some((a) => a instanceof AdeA2Adapter);
    expect(registered).toBe(false);
  });

  it('exposes empty-string sentinels for every characteristic UUID', () => {
    // Empty string is intentional: handler lookups fail-fast instead of
    // accidentally subscribing to a wrong but valid-looking UUID.
    const adapter = new AdeA2Adapter();
    expect(adapter.charNotifyUuid).toBe('');
    expect(adapter.charWriteUuid).toBe('');
  });

  it('onConnected is a no-op and does not write to the scale', async () => {
    const adapter = new AdeA2Adapter();
    const { ctx, writeFn } = makeCtx();

    await adapter.onConnected(ctx);

    expect(writeFn).not.toHaveBeenCalled();
  });
});
