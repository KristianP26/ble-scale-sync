import { describe, it, expect } from 'vitest';
import {
  iterateMiBeaconObjects,
  macFrameOrderFromAddress,
  macFrameOrderFromFrame,
  miBeaconPayloadOffset,
  miBeaconProductId,
  normUuid,
} from '../../src/scales/mibeacon.js';

describe('iterateMiBeaconObjects', () => {
  it('splits consecutive objects', () => {
    const payload = Buffer.from([0x16, 0x6e, 0x02, 0xaa, 0xbb, 0x01, 0x52, 0x01, 0x00]);
    expect(iterateMiBeaconObjects(payload)).toEqual([
      { id: 0x6e16, value: Buffer.from([0xaa, 0xbb]) },
      { id: 0x5201, value: Buffer.from([0x00]) },
    ]);
  });

  it('stops at an object whose length overruns the buffer', () => {
    const payload = Buffer.from([0x01, 0x52, 0x01, 0x00, 0x16, 0x6e, 0x09, 0x01, 0x02]);
    expect(iterateMiBeaconObjects(payload)).toEqual([{ id: 0x5201, value: Buffer.from([0x00]) }]);
  });

  it('returns nothing for an empty or header-only payload', () => {
    expect(iterateMiBeaconObjects(Buffer.alloc(0))).toEqual([]);
    expect(iterateMiBeaconObjects(Buffer.from([0x16, 0x6e]))).toEqual([]);
  });
});

describe('macFrameOrderFromAddress', () => {
  it('reverses a colon, dash or bare address into frame order', () => {
    expect(macFrameOrderFromAddress('8C:D0:B2:F6:BE:EF')?.toString('hex')).toBe('efbef6b2d08c');
    expect(macFrameOrderFromAddress('8c-d0-b2-f6-be-ef')?.toString('hex')).toBe('efbef6b2d08c');
    expect(macFrameOrderFromAddress('8CD0B2F6BEEF')?.toString('hex')).toBe('efbef6b2d08c');
  });

  it('rejects anything that is not 12 hex digits (e.g. a CoreBluetooth UUID)', () => {
    expect(macFrameOrderFromAddress('4C8A6E2F-1B3D-4E5F-8A9B-0C1D2E3F4A5B')).toBeNull();
    expect(macFrameOrderFromAddress('')).toBeNull();
    expect(macFrameOrderFromAddress('8C:D0:B2:F6:BE')).toBeNull();
  });
});

describe('miBeaconPayloadOffset', () => {
  it('is 5 for the bare header', () => {
    expect(miBeaconPayloadOffset(Buffer.from([0x48, 0x59, 0xd5, 0x3b, 0x0a, 0xff]))).toBe(5);
  });

  it('skips the MAC and the capability byte', () => {
    // S400 idle beacon: FC 0x5a30 = MAC + capability, no object.
    const idle = Buffer.from('305ad53b00530870aceA1c08'.toLowerCase(), 'hex');
    expect(miBeaconPayloadOffset(idle)).toBe(12);
    expect(macFrameOrderFromFrame(idle)?.toString('hex')).toBe('530870acea1c');
    expect(miBeaconProductId(idle)).toBe(0x3bd5);
  });

  it('skips the extra I/O capability byte when bit 0x20 of the capability is set', () => {
    const frame = Buffer.concat([
      Buffer.from([0x30, 0x5a, 0xd5, 0x3b, 0x00]),
      Buffer.alloc(6, 0x11),
      Buffer.from([0x28, 0x03, 0xee]),
    ]);
    expect(miBeaconPayloadOffset(frame)).toBe(13);
  });

  it('returns null when the frame is shorter than its header', () => {
    expect(miBeaconPayloadOffset(Buffer.from([0x30, 0x5a, 0xd5, 0x3b]))).toBeNull();
    expect(miBeaconPayloadOffset(Buffer.from([0x30, 0x5a, 0xd5, 0x3b, 0x00, 0x11]))).toBeNull();
  });
});

describe('normUuid', () => {
  it('expands short and 32-bit UUIDs and strips dashes', () => {
    expect(normUuid('FE95')).toBe('0000fe9500001000800000805f9b34fb');
    expect(normUuid('0000fe95')).toBe('0000fe9500001000800000805f9b34fb');
    expect(normUuid('0000fe95-0000-1000-8000-00805f9b34fb')).toBe(
      '0000fe9500001000800000805f9b34fb',
    );
  });
});
