import { describe, it, expect } from 'vitest';
import { EsphomeProxySchema } from '../../../src/config/schema.js';

describe('EsphomeProxySchema additional_proxies (#116)', () => {
  it('defaults additional_proxies to [] for an existing single-host config', () => {
    const r = EsphomeProxySchema.safeParse({ host: 'proxy1.home' });
    expect(r.success && r.data.additional_proxies).toEqual([]);
  });

  it('accepts a list of extra proxies with independent auth', () => {
    const r = EsphomeProxySchema.safeParse({
      host: 'proxy1.home',
      encryption_key: 'k1',
      additional_proxies: [
        { host: 'proxy2.home', encryption_key: 'k2' },
        { host: 'proxy3.home', password: 'p3' },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.additional_proxies[1].host).toBe('proxy3.home');
    expect(r.success && r.data.additional_proxies[0].port).toBe(6053);
  });

  it('rejects an extra proxy with both encryption_key and password', () => {
    const r = EsphomeProxySchema.safeParse({
      host: 'p1',
      additional_proxies: [{ host: 'p2', encryption_key: 'k', password: 'x' }],
    });
    expect(r.success).toBe(false);
  });
});
