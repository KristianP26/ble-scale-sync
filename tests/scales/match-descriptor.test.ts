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
