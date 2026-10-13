import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { wrapChar, wrapDevice } from '../../../src/ble/handler-node-ble/gatt.js';
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

/**
 * #408: a deferred binding is turned off before the disconnect. Only StopNotify
 * can do that on BlueZ, which refuses a direct write to the CCC descriptor.
 */
describe('wrapChar() stop', () => {
  it('node-ble sends StopNotify from stopNotifications()', () => {
    const require = createRequire(import.meta.url);
    const source = require('node:fs').readFileSync(
      require.resolve('node-ble/src/GattCharacteristic.js'),
      'utf8',
    ) as string;
    const body = source.slice(source.indexOf('async stopNotifications ('));
    expect(body.slice(0, 200)).toMatch(/callMethod\('StopNotify'\)/);
  });

  it('stop() goes through stopNotifications(), not through the unsubscribe', async () => {
    const char = Object.assign(new EventEmitter(), {
      startNotifications: vi.fn(async () => {}),
      stopNotifications: vi.fn(async () => {}),
    });
    const wrapped = wrapChar(char as never);
    const unsubscribe = await wrapped.subscribe(() => {});
    unsubscribe();
    expect(char.stopNotifications).not.toHaveBeenCalled();
    await wrapped.stop?.();
    expect(char.stopNotifications).toHaveBeenCalledTimes(1);
  });
});
