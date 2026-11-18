import { describe, it, expect } from 'vitest';
import {
  haAccessToken,
  isSupervisorUrl,
} from '../../../src/ble/handler-ha-bluetooth/supervisor.js';
import { toWebSocketUrl } from '../../../src/ble/handler-ha-bluetooth/index.js';

const ACCEPTED = [
  'ws://supervisor/core/websocket',
  'http://supervisor/core/websocket',
  'ws://supervisor/core/api/websocket',
  'WS://SUPERVISOR/core/websocket',
  'ws://supervisor:80/core/websocket',
  'ws://supervisor/x/../core/websocket',
  'ws://supervisor/core/websocket?',
];

const REFUSED = [
  'wss://supervisor/core/websocket',
  'https://supervisor/core/websocket',
  'ws://supervisor:8123/core/websocket',
  'ws://supervisor/core/websocket/',
  'ws://supervisor/core/api/websocket/',
  'ws://supervisor/core',
  'ws://supervisor/core/api',
  'ws://supervisor/homeassistant/websocket',
  'ws://supervisor./core/websocket',
  'ws://supervisor.evil.example/core/websocket',
  'ws://u:p@supervisor/core/websocket',
  'ws://u@supervisor/core/websocket',
  'ws://supervisor@evil.example/core/websocket',
  'ws://supervisor/core/websocket?x=1',
  'ws://supervisor/core/websocket#x',
  'ws://supervisor/%2e/core/websocket/',
  'ws://ha.local:8123/api/websocket',
  'garbage',
  '',
];

describe('isSupervisorUrl', () => {
  it.each(ACCEPTED)('accepts %s', (url) => {
    expect(isSupervisorUrl(url)).toBe(true);
  });

  it.each(REFUSED)('refuses %s', (url) => {
    expect(isSupervisorUrl(url)).toBe(false);
  });

  it('only accepts what the client then dials: Supervisor host, default port, proxy path', () => {
    for (const url of [...ACCEPTED, ...REFUSED]) {
      if (!isSupervisorUrl(url)) continue;
      const dialed = new URL(toWebSocketUrl(url));
      expect(dialed.hostname).toBe('supervisor');
      expect(dialed.port).toBe('');
      expect(dialed.username + dialed.password).toBe('');
      expect(['/core/websocket', '/core/api/websocket']).toContain(dialed.pathname);
    }
  });
});

describe('haAccessToken', () => {
  const SV = 'ws://supervisor/core/websocket';
  const env = { SUPERVISOR_TOKEN: 'sv-token' };

  it('prefers the configured token', () => {
    expect(haAccessToken({ url: SV, token: 'own' }, env)).toBe('own');
  });

  it('falls back to SUPERVISOR_TOKEN for the Supervisor URL', () => {
    expect(haAccessToken({ url: SV }, env)).toBe('sv-token');
    expect(haAccessToken({ url: SV, token: null }, env)).toBe('sv-token');
    expect(haAccessToken({ url: SV, token: '' }, env)).toBe('sv-token');
  });

  it('never hands SUPERVISOR_TOKEN to another URL', () => {
    expect(haAccessToken({ url: 'ws://ha.example:8123/api/websocket' }, env)).toBeUndefined();
    expect(haAccessToken({ url: 'ws://supervisor.evil.example/core/websocket' }, env)).toBe(
      undefined,
    );
  });

  it('returns undefined when the variable is missing or empty', () => {
    expect(haAccessToken({ url: SV }, {})).toBeUndefined();
    expect(haAccessToken({ url: SV }, { SUPERVISOR_TOKEN: '' })).toBeUndefined();
  });
});
