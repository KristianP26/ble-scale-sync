import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { wrapDevice } from '../../../src/ble/handler-node-ble/gatt.js';
import type { Device } from '../../../src/ble/handler-node-ble/dbus.js';

/**
 * #404. On this transport the 'disconnect' event cannot arrive for a
 * disconnect we initiate, so the session cleanup has to be driven directly.
 */
describe('wrapDevice() disconnect handling', () => {
  it('node-ble removes the listener that emits disconnect, inside disconnect()', () => {
    // Read the library's own source rather than asserting a belief about it: if
    // a future version stops doing this, the reasoning above is stale and this
    // test says so instead of quietly passing.
    const require = createRequire(import.meta.url);
    const source = require('node:fs').readFileSync(
      require.resolve('node-ble/src/Device.js'),
      'utf8',
    ) as string;

    const disconnectBody = source.slice(source.indexOf('async disconnect ('));
    expect(disconnectBody).toMatch(/callMethod\('Disconnect'\)/);
    expect(disconnectBody.slice(0, 200)).toMatch(/removeListeners\(\)/);
  });

  it('fireDisconnect runs the callback once, and a later event is ignored', () => {
    const emitter = new EventEmitter();
    const device = wrapDevice(emitter as unknown as Device);
    const cb = vi.fn();
    device.onDisconnect(cb);

    device.fireDisconnect();
    device.fireDisconnect();
    emitter.emit('disconnect');

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a real disconnect event still runs the callback once', () => {
    const emitter = new EventEmitter();
    const device = wrapDevice(emitter as unknown as Device);
    const cb = vi.fn();
    device.onDisconnect(cb);

    emitter.emit('disconnect');
    emitter.emit('disconnect');
    device.fireDisconnect();

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fireDisconnect before any callback is registered does not swallow the real one', () => {
    const emitter = new EventEmitter();
    const device = wrapDevice(emitter as unknown as Device);
    device.fireDisconnect();

    const cb = vi.fn();
    device.onDisconnect(cb);
    emitter.emit('disconnect');

    expect(cb).toHaveBeenCalledTimes(1);
  });
});
