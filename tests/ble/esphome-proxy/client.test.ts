import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { EsphomeProxyConfig } from '../../../src/config/schema.js';

// Mock the esphome-native-api library: its Client is an EventEmitter, so the
// real createEsphomeClient() runs against a controllable stand-in.
class MockClient extends EventEmitter {
  options: Record<string, unknown>;
  connect = vi.fn();
  disconnect = vi.fn();
  connected = false;
  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
  }
}

vi.mock('@2colors/esphome-native-api', () => ({ Client: MockClient }));

import { createEsphomeClient } from '../../../src/ble/handler-esphome-proxy/client.js';
import { bleLog } from '../../../src/ble/types.js';

const config = {
  host: '192.168.1.50',
  port: 6053,
  client_info: 'ble-scale-sync',
} as EsphomeProxyConfig;

describe('createEsphomeClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attaches a permanent error listener so a library error never crashes the process', async () => {
    const client = (await createEsphomeClient(config)) as unknown as EventEmitter;

    expect(client.listenerCount('error')).toBeGreaterThan(0);

    // An 'error' emit with no listener throws an uncaught exception in Node and
    // kills the process (#210). With the permanent listener it must not throw.
    expect(() =>
      client.emit('error', new Error('Failed find or parsed message type for Id: 137')),
    ).not.toThrow();
  });

  it('logs the library error via bleLog.warn with the proxy endpoint', async () => {
    const warnSpy = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const client = (await createEsphomeClient(config)) as unknown as EventEmitter;

    client.emit('error', new Error('boom'));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('192.168.1.50:6053'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    warnSpy.mockRestore();
  });
});
