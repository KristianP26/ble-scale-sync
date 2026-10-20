import { describe, it, expect } from 'vitest';
import {
  matchesDescriptor,
  uuidClaimHits,
  descriptorNameTokens,
  ownAddressBytes,
  type MatchDescriptor,
} from '../../src/scales/match-descriptor.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';
import { M1690_ADVERT, M1690_FE95, M1690_FE95_PID_018E } from '../helpers/yunmai-m1690.js';

const dev = (p: Partial<BleDeviceInfo>): BleDeviceInfo => ({
  localName: '',
  serviceUuids: [],
  ...p,
});

describe('matchesDescriptor', () => {
  it('matches exact name case-insensitively', () => {
    const d: MatchDescriptor = { priority: 100, names: { exact: ['senssun fat'] } };
    expect(matchesDescriptor(dev({ localName: 'Senssun Fat' }), d)).toBe(true);
    expect(matchesDescriptor(dev({ localName: 'senssun fat scale' }), d)).toBe(false);
  });

  it('matches name substring (includes) but never on empty name', () => {
    const d: MatchDescriptor = { priority: 100, names: { includes: ['yunmai'] } };
    expect(matchesDescriptor(dev({ localName: 'MY Yunmai X' }), d)).toBe(true);
    expect(matchesDescriptor(dev({ localName: '' }), d)).toBe(false);
  });

  it('matches name prefix (startsWith)', () => {
    const d: MatchDescriptor = { priority: 100, names: { startsWith: ['01257b'] } };
    expect(matchesDescriptor(dev({ localName: '01257B1234' }), d)).toBe(true);
    expect(matchesDescriptor(dev({ localName: 'X01257B' }), d)).toBe(false);
  });

  it('matches advertised service uuid in short or full form', () => {
    const d: MatchDescriptor = { priority: 100, serviceUuids: ['ffb0'] };
    expect(matchesDescriptor(dev({ serviceUuids: ['ffb0'] }), d)).toBe(true);
    expect(matchesDescriptor(dev({ serviceUuids: [uuid16(0xffb0)] }), d)).toBe(true);
    expect(matchesDescriptor(dev({ serviceUuids: ['FFB0'] }), d)).toBe(true);
  });

  it('matches a full 128-bit custom service uuid ignoring dashes', () => {
    const d: MatchDescriptor = {
      priority: 100,
      serviceUuids: ['f433bd8075b811e297d90002a5d5c51b'],
    };
    expect(
      matchesDescriptor(dev({ serviceUuids: ['f433bd80-75b8-11e2-97d9-0002a5d5c51b'] }), d),
    ).toBe(true);
  });

  it('matches a post-discovery characteristic uuid', () => {
    const d: MatchDescriptor = { priority: 100, charUuids: ['fff4'] };
    expect(matchesDescriptor(dev({ characteristicUuids: [uuid16(0xfff4)] }), d)).toBe(true);
    expect(matchesDescriptor(dev({ characteristicUuids: [] }), d)).toBe(false);
  });

  it('does not match when no claim hits', () => {
    const d: MatchDescriptor = {
      priority: 100,
      names: { exact: ['nope'] },
      serviceUuids: ['1234'],
    };
    expect(matchesDescriptor(dev({ localName: 'other', serviceUuids: ['abcd'] }), d)).toBe(false);
  });

  it('descriptorNameTokens unions all name buckets', () => {
    const d: MatchDescriptor = {
      priority: 100,
      names: { exact: ['a'], includes: ['b'], startsWith: ['c'] },
    };
    expect(descriptorNameTokens(d).sort()).toEqual(['a', 'b', 'c']);
  });

  it('uuidClaimHits handles undefined device uuids', () => {
    expect(uuidClaimHits(['fff0'], undefined)).toBe(false);
    expect(uuidClaimHits(['fff0'], ['fff0'])).toBe(true);
  });
});

// #474: a claimed MiBeacon product id identifies the device like a name.
describe('matchesDescriptor: MiBeacon product id', () => {
  const d: MatchDescriptor = { priority: 100, miBeaconProductIds: [0x018d] };

  it('matches the claimed id in 0xFE95 service data, short or full uuid', () => {
    expect(matchesDescriptor(M1690_ADVERT, d)).toBe(true);
    const full = dev({ serviceData: [{ uuid: uuid16(0xfe95), data: M1690_FE95 }] });
    expect(matchesDescriptor(full, d)).toBe(true);
  });

  // A device can carry more than one service data entry; the 0xFE95 one need
  // not be first. The 0x181D entry is the Mi Scale 2 one of registry-collision.
  it('finds the claimed id when the 0xFE95 entry is not the first one', () => {
    const two = dev({
      serviceData: [
        { uuid: '181d', data: Buffer.from('238e4eea070818103913', 'hex') },
        { uuid: 'fe95', data: M1690_FE95 },
      ],
    });
    expect(matchesDescriptor(two, d)).toBe(true);
  });

  // The three below hold on the code before #474 too: they guard the new claim
  // against another product id, another service's data and a frame without an id.
  it('ignores a product id it does not claim', () => {
    const other = dev({ serviceData: [{ uuid: 'fe95', data: M1690_FE95_PID_018E }] });
    expect(matchesDescriptor(other, d)).toBe(false);
  });

  it('ignores the same bytes under another service uuid', () => {
    expect(matchesDescriptor(dev({ serviceData: [{ uuid: 'fe9f', data: M1690_FE95 }] }), d)).toBe(
      false,
    );
  });

  it('ignores a frame too short to carry a product id', () => {
    const short = dev({ serviceData: [{ uuid: 'fe95', data: M1690_FE95.subarray(0, 3) }] });
    expect(matchesDescriptor(short, d)).toBe(false);
  });
});

describe('ownAddressBytes', () => {
  it('strips colons or dashes and uppercases', () => {
    expect(ownAddressBytes('08:b8:d0:de:b5:3a')).toBe('08B8D0DEB53A');
    expect(ownAddressBytes('08-B8-D0-DE-B5-3A')).toBe('08B8D0DEB53A');
  });

  it('is null when the transport has no usable address', () => {
    expect(ownAddressBytes(undefined)).toBeNull();
    expect(ownAddressBytes('')).toBeNull();
    // What noble hands over on macOS: formatMac('<unknown>').
    expect(ownAddressBytes('<U:NK:NO:WN')).toBeNull();
    expect(ownAddressBytes('08:B8:D0:DE:B5')).toBeNull();
  });
});
