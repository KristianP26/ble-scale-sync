import { describe, it, expect } from 'vitest';
import {
  MAX_SCAN_ENTRIES,
  parseConnectedPayload,
  parseScanResults,
} from '../../src/ble/handler-mqtt-proxy/payloads.js';

const entry = (over: Record<string, unknown> = {}) => ({
  address: 'AA:BB:CC:DD:EE:FF',
  name: 'Scale',
  rssi: -60,
  services: ['0000181b-0000-1000-8000-00805f9b34fb'],
  ...over,
});

describe('parseScanResults', () => {
  it('keeps a well-formed entry and fills the optional fields', () => {
    const parsed = parseScanResults(JSON.stringify([entry({ addr_type: 1 })]));
    expect(parsed).toEqual({
      ok: true,
      total: 1,
      dropped: 0,
      entries: [
        {
          address: 'AA:BB:CC:DD:EE:FF',
          name: 'Scale',
          rssi: -60,
          services: ['0000181b-0000-1000-8000-00805f9b34fb'],
          addr_type: 1,
          manufacturer_id: null,
          manufacturer_data: null,
          service_data: null,
        },
      ],
    });
  });

  it.each([
    ['null', 'null'],
    ['an object', '{}'],
    ['broken JSON', '[{'],
  ])('rejects %s as a whole', (_label, raw) => {
    expect(parseScanResults(raw).ok).toBe(false);
  });

  it('rejects a batch over the entry limit', () => {
    const many = JSON.stringify(Array.from({ length: MAX_SCAN_ENTRIES + 1 }, () => entry()));
    expect(parseScanResults(many)).toEqual({
      ok: false,
      why: `too many entries (${MAX_SCAN_ENTRIES + 1})`,
    });
  });

  it('drops entries without a valid MAC and counts them', () => {
    const parsed = parseScanResults(
      JSON.stringify([
        null,
        5,
        'x',
        {},
        entry({ address: 'AA:BB' }),
        entry({ address: 5 }),
        entry(),
      ]),
    );
    expect(parsed).toMatchObject({ ok: true, total: 7, dropped: 6 });
  });

  it('accepts lower-case MACs', () => {
    expect(
      parseScanResults(JSON.stringify([entry({ address: 'aa:bb:cc:dd:ee:ff' })])),
    ).toMatchObject({
      dropped: 0,
    });
  });

  it('normalises the soft fields instead of dropping the entry', () => {
    const parsed = parseScanResults(
      JSON.stringify([
        entry({
          name: 5,
          rssi: 'loud',
          services: 'nope',
          addr_type: 300,
          manufacturer_id: 'x',
          manufacturer_data: 7,
          service_data: 'x',
        }),
      ]),
    );
    expect(parsed).toMatchObject({
      ok: true,
      dropped: 0,
      entries: [
        {
          name: '',
          rssi: 0,
          services: [],
          manufacturer_id: null,
          manufacturer_data: null,
          service_data: null,
        },
      ],
    });
    if (parsed.ok) expect(parsed.entries[0].addr_type).toBeUndefined();
  });

  it('keeps service uuids that look like uuids and drops the rest', () => {
    const parsed = parseScanResults(
      JSON.stringify([entry({ services: ['0x181b', 'FFF0', 'a/b', 5, null, 'x'.repeat(50)] })]),
    );
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.entries[0].services).toEqual(['0x181b', 'FFF0']);
  });

  it('cuts a long name and keeps only well-formed service data', () => {
    const parsed = parseScanResults(
      JSON.stringify([
        entry({
          name: 'n'.repeat(1000),
          service_data: [{ uuid: 'fe95', data: '0102' }, null, { uuid: 5, data: 'x' }],
        }),
      ]),
    );
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.entries[0].name).toHaveLength(256);
    expect(parsed.entries[0].service_data).toEqual([{ uuid: 'fe95', data: '0102' }]);
  });
});

describe('parseConnectedPayload', () => {
  const chars = [{ uuid: 'fff4', properties: ['notify'] }];

  it('accepts a host-initiated response and an autonomous connect', () => {
    expect(parseConnectedPayload(JSON.stringify({ chars }))).toEqual({
      ok: true,
      value: { autonomous: false, chars },
    });
    expect(
      parseConnectedPayload(
        JSON.stringify({ autonomous: true, address: 'AA:BB:CC:DD:EE:FF', chars }),
      ),
    ).toEqual({ ok: true, value: { autonomous: true, address: 'AA:BB:CC:DD:EE:FF', chars } });
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['no chars', '{}'],
    ['chars that is not an array', '{"chars":"x"}'],
    ['an autonomous connect without address', '{"autonomous":true,"chars":[]}'],
    ['an autonomous connect with a numeric address', '{"autonomous":true,"address":5,"chars":[]}'],
    ['too many chars', JSON.stringify({ chars: Array.from({ length: 257 }, () => chars[0]) })],
  ])('rejects %s', (_label, raw) => {
    expect(parseConnectedPayload(raw).ok).toBe(false);
  });

  it('drops a char that is not an object or whose uuid is not topic-safe', () => {
    const parsed = parseConnectedPayload(
      JSON.stringify({
        chars: [
          null,
          { uuid: '#' },
          { uuid: 'a/b' },
          { uuid: '+' },
          { uuid: 5 },
          { uuid: 'abc' },
          { uuid: '0000fff4-0000-1000-8000-00805f9b34fb', properties: ['notify', 5] },
        ],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        autonomous: false,
        chars: [{ uuid: '0000fff4-0000-1000-8000-00805f9b34fb', properties: ['notify'] }],
      },
    });
  });
});
