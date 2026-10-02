import { describe, it, expect } from 'vitest';

import { createExporterFromEntry } from '../../src/exporters/registry.js';
import { parseHeaderString, normaliseHeaders } from '../../src/exporters/headers.js';
import type { ExporterEntry } from '../../src/config/schema.js';

/**
 * The factories used `as` casts where they needed conversion. A cast checks
 * nothing and converts nothing, so a value that config.yaml happily carries
 * arrived at the exporter in the wrong shape - and, in the webhook headers
 * case, in a shape this project's own field description had asked the user to
 * write.
 */

function build(entry: Record<string, unknown>): unknown {
  return createExporterFromEntry(entry as unknown as ExporterEntry);
}

/** The config an exporter actually kept, whatever it is called internally. */
function configOf(exporter: unknown): Record<string, unknown> {
  return (exporter as { config: Record<string, unknown> }).config;
}

describe('webhook headers survive the trip from config to the request', () => {
  it('parses the "Key: Value" string the field description asks for', () => {
    // Spreading a STRING spreads it by index: the old cast produced
    // { 0: 'A', 1: 'u', 2: 't', ... } and no Authorization header at all.
    const exporter = build({
      type: 'webhook',
      url: 'https://example.test/hook',
      headers: 'Authorization: Bearer TEST, X-Source: scale',
    });

    expect(configOf(exporter).headers).toEqual({
      Authorization: 'Bearer TEST',
      'X-Source': 'scale',
    });
  });

  it('keeps a value that itself contains a colon', () => {
    expect(parseHeaderString('X-Target: https://example.test:8443/x').headers).toEqual({
      'X-Target': 'https://example.test:8443/x',
    });
  });

  it('accepts a YAML mapping too, stringifying numeric values', () => {
    const exporter = build({
      type: 'webhook',
      url: 'https://example.test/hook',
      headers: { 'X-Retry': 3, 'X-Source': 'scale' },
    });

    expect(configOf(exporter).headers).toEqual({ 'X-Retry': '3', 'X-Source': 'scale' });
  });

  it('skips a malformed pair instead of failing the whole exporter', () => {
    const result = normaliseHeaders('Authorization: Bearer TEST, oops');
    expect(result.headers).toEqual({ Authorization: 'Bearer TEST' });
    expect(result.invalid).toEqual(['oops']);
  });

  it('treats an absent headers field as no headers', () => {
    const exporter = build({ type: 'webhook', url: 'https://example.test/hook' });
    expect(configOf(exporter).headers).toEqual({});
  });
});

describe('values that are only valid as one of a fixed set', () => {
  it('converts a string qos to the number the MQTT client needs', () => {
    const exporter = build({ type: 'mqtt', broker_url: 'mqtt://localhost:1883', qos: '2' });
    expect(configOf(exporter).qos).toBe(2);
  });

  it('rejects a qos outside 0/1/2 at config time', () => {
    expect(() => build({ type: 'mqtt', broker_url: 'mqtt://localhost:1883', qos: 99 })).toThrow(
      /qos/,
    );
  });

  it('rejects an unknown file format instead of silently writing CSV', () => {
    expect(() => build({ type: 'file', file_path: './out.csv', format: 'JSONL' })).toThrow(
      /format/,
    );
  });

  it('still accepts the formats it supports', () => {
    expect(
      configOf(build({ type: 'file', file_path: './out.jsonl', format: 'jsonl' })).format,
    ).toBe('jsonl');
  });

  it('rejects an ntfy priority outside 1-5', () => {
    expect(() => build({ type: 'ntfy', topic: 'scale', priority: 9 })).toThrow(/priority/);
  });
});

describe('webhook timeout is bounded by what AbortSignal.timeout accepts', () => {
  it('still converts a numeric string', () => {
    expect(
      configOf(build({ type: 'webhook', url: 'https://e.test', timeout: '10000' })).timeout,
    ).toBe(10_000);
  });

  it.each([-1, 1.5])('rejects %s at config time rather than mid-export', (value) => {
    // AbortSignal.timeout() throws ERR_OUT_OF_RANGE on both, which surfaced as
    // a confusing failure inside the first export instead of a config error.
    expect(() => build({ type: 'webhook', url: 'https://e.test', timeout: value })).toThrow(
      /timeout/,
    );
  });

  it('keeps accepting a small but legal timeout', () => {
    // The field has always taken any number; narrowing it must not turn
    // somebody's working `timeout: 50` into a startup crash.
    expect(configOf(build({ type: 'webhook', url: 'https://e.test', timeout: 50 })).timeout).toBe(
      50,
    );
  });
});
