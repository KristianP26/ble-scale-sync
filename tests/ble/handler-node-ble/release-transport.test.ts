import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * A-02 / E-12: the persistent D-Bus connection was only ever destroyed after a
 * GATT attempt. A broadcast reading (Mi Scale 2, Silvergear 108, S400, IF_B7)
 * or a scan that found nothing left the dbus-next socket open, and nothing in
 * dbus-next unrefs it, so a single run exported its reading and then never
 * exited. releaseTransport() is what the runtime calls once it is done with
 * BLE, and this pins that it really closes the bus underneath.
 */

const destroy = vi.fn();
const createBluetooth = vi.fn(() => ({
  bluetooth: { dbus: new EventEmitter() },
  destroy,
}));

vi.mock('node-ble', () => {
  const mod = { createBluetooth };
  return { default: mod, ...mod };
});

const { getConnection } = await import('../../../src/ble/handler-node-ble/connection.js');
const { releaseTransport } = await import('../../../src/ble/index.js');
const { bleLog } = await import('../../../src/ble/types.js');

const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

describe('releaseTransport (A-02 / E-12)', () => {
  beforeEach(() => {
    destroy.mockClear();
    createBluetooth.mockClear();
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    vi.stubEnv('NOBLE_DRIVER', '');
  });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('destroys the persistent D-Bus connection on node-ble', async () => {
    setPlatform('linux');
    getConnection();
    expect(createBluetooth).toHaveBeenCalledTimes(1);

    await releaseTransport(undefined);

    expect(destroy).toHaveBeenCalledTimes(1);
    // The next cycle (or a later run in the same process) gets a fresh bus
    // instead of reusing the closed one.
    getConnection();
    expect(createBluetooth).toHaveBeenCalledTimes(2);
  });

  it('leaves the D-Bus connection alone on a proxy transport', async () => {
    setPlatform('linux');
    getConnection();
    destroy.mockClear();

    await releaseTransport('esphome-proxy');

    expect(destroy).not.toHaveBeenCalled();
  });
});
