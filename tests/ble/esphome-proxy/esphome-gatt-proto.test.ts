import { describe, it, expect } from 'vitest';
import { esphomeUuidToString } from '../../../src/ble/handler-esphome-proxy/esphome-gatt-proto.js';
import { normalizeUuid } from '../../../src/ble/types.js';

describe('esphomeUuidToString', () => {
  it('converts a [high, low] uint64 pair to the normalized 128-bit form', () => {
    // 0x2A9D Weight Measurement -> 00002a9d-0000-1000-8000-00805f9b34fb
    const high = 0x00002a9d00001000n;
    const low = 0x800000805f9b34fbn;
    expect(esphomeUuidToString([high.toString(), low.toString()])).toBe(normalizeUuid('2a9d'));
  });

  it('passes an already-stringified uuid through normalizeUuid', () => {
    expect(esphomeUuidToString(['0000181d-0000-1000-8000-00805f9b34fb'])).toBe(
      normalizeUuid('181d'),
    );
  });

  it('accepts bigint high/low halves (jspb int64 precision-safe path)', () => {
    expect(esphomeUuidToString([0x00002a9d00001000n, 0x800000805f9b34fbn])).toBe(
      normalizeUuid('2a9d'),
    );
  });

  it('hex-decodes a single numeric 16-bit UUID (not decimal stringify)', () => {
    // 0x181d -> must be the Weight Scale service, not normalizeUuid("6157")
    expect(esphomeUuidToString([0x181d])).toBe(normalizeUuid('181d'));
  });

  it('hex-decodes a single bigint 128-bit UUID', () => {
    const full = 0x00002a9d00001000800000805f9b34fbn;
    expect(esphomeUuidToString([full])).toBe(normalizeUuid('2a9d'));
  });
});
