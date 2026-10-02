import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import type { MqttConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

/**
 * Who owns the MQTT client, and what finishes an export.
 *
 * The exporter used to wrap only `connectAsync` in a timeout. That left three
 * separate holes, all of them about lifetime rather than about timeouts as
 * such, which is why they are fixed and tested together.
 */

const { fakeMqtt } = await vi.hoisted(async () => {
  const { createFakeMqtt } = await import('../helpers/fake-mqtt.js');
  return { fakeMqtt: createFakeMqtt() };
});

vi.mock('mqtt', () => ({
  connect: fakeMqtt.connect,
}));

const payload = { weight: 80, impedance: 500 } as unknown as BodyComposition;

const config: MqttConfig = {
  brokerUrl: 'mqtt://localhost:1883',
  topic: 'scale/body-composition',
  qos: 1,
  retain: true,
  clientId: 'ble-scale-sync',
  haDiscovery: false,
  haDeviceName: 'BLE Scale',
};

beforeEach(() => {
  fakeMqtt.reset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MQTT export finishes even when the broker does not', () => {
  it('gives up on a publish that never settles', async () => {
    // A broker that accepts the TCP connection and then stops acknowledging
    // QoS 1 left this pending forever. Promise.allSettled in the orchestrator
    // waits for every exporter to SETTLE, so the whole cycle stopped behind it
    // and nothing asked the scale for another reading.
    vi.useFakeTimers();
    fakeMqtt.publishAsync.mockReturnValue(new Promise(() => {}));

    const exporter = new MqttExporter(config);
    const pending = exporter.export(payload);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('closes a connection that comes up after its own deadline', async () => {
    // connectAsync handed the client back only once it had connected, so a
    // timeout racing that promise left nothing to close - and the connection
    // could still come up afterwards, with no owner. connect() returns the
    // client synchronously, so even a timed-out attempt has a handle.
    vi.useFakeTimers();
    fakeMqtt.setBehaviour({ kind: 'late', delayMs: 60_000 });

    const exporter = new MqttExporter(config);
    const pending = exporter.export(payload);
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(fakeMqtt.clients.length).toBeGreaterThan(0);
    // Every client it created was shut down, not abandoned.
    expect(fakeMqtt.endAsync).toHaveBeenCalledTimes(fakeMqtt.clients.length);
  });

  it('removes its connect listeners once the attempt is over', async () => {
    const exporter = new MqttExporter(config);
    await exporter.export(payload);

    const client = fakeMqtt.clients.at(-1)!;
    expect(client.listenerCount('connect')).toBe(0);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('leaves no timer armed after a successful export', async () => {
    vi.useFakeTimers();
    const exporter = new MqttExporter(config);
    await exporter.export(payload);

    // The inline `setTimeout` the timeouts used to be written with kept an
    // armed timer for its full duration after a fast success, holding the
    // event loop open. withTimeout clears it.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a failed disconnect is not a failed export', () => {
  it('reports success and publishes once when only the close fails', async () => {
    // `finally { await client.endAsync(); }` sat INSIDE withRetry, so a
    // rejecting disconnect replaced an already-successful publish with a
    // failure and the retry published the same reading again - up to three
    // copies of one weigh-in.
    fakeMqtt.endAsync.mockRejectedValue(new Error('ECONNRESET on disconnect'));

    const exporter = new MqttExporter(config);
    const result = await exporter.export(payload);

    expect(result.success).toBe(true);
    expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(1);
  });

  it('forces the client down when the graceful close is refused', async () => {
    fakeMqtt.endAsync.mockRejectedValue(new Error('ECONNRESET on disconnect'));

    await new MqttExporter(config).export(payload);

    expect(fakeMqtt.end).toHaveBeenCalledWith(true);
  });

  it('still reports the publish failure, not the close failure', async () => {
    // Guards the other direction: cleanup must not mask the real cause.
    fakeMqtt.publishAsync.mockRejectedValue(new Error('publish refused'));
    fakeMqtt.endAsync.mockRejectedValue(new Error('ECONNRESET on disconnect'));

    const result = await new MqttExporter(config).export(payload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('publish refused');
  });
});
