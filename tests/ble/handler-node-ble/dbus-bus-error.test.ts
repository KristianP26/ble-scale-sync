import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * A D-Bus socket failure used to kill the process (#290): dbus-next forwards
 * raw socket errors onto the MessageBus, which is an EventEmitter, and with no
 * listener Node turns the first one into an uncaught exception. A reporter's
 * container died on `write EPIPE` and restart-looped.
 */

const destroySpies: Array<() => void> = [];

function makeSession() {
  const destroy = vi.fn();
  destroySpies.push(destroy);
  const fakeAdapter = { isPowered: async () => true };
  return {
    bluetooth: {
      dbus: new EventEmitter(),
      defaultAdapter: async () => fakeAdapter,
      getAdapter: async () => fakeAdapter,
    },
    destroy,
  };
}

const createBluetooth = vi.fn(() => makeSession());

// connection.ts does `import NodeBle from 'node-ble'` and calls
// NodeBle.createBluetooth(), so the mock must satisfy the default import.
vi.mock('node-ble', () => {
  const mod = { createBluetooth };
  return { default: mod, ...mod };
});

const { getConnection, getAdapter, resetConnection, isStaleConnectionError } =
  await import('../../../src/ble/handler-node-ble/connection.js');
const { bleLog } = await import('../../../src/ble/types.js');

function busOf(session: { bluetooth: { dbus: EventEmitter } }): EventEmitter {
  return session.bluetooth.dbus;
}

describe('D-Bus transport error handling (#290)', () => {
  beforeEach(() => {
    resetConnection();
    createBluetooth.mockClear();
    destroySpies.length = 0;
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConnection();
  });

  it('proves the hazard: an EventEmitter with no error listener throws', () => {
    expect(() => new EventEmitter().emit('error', new Error('write EPIPE'))).toThrow('write EPIPE');
  });

  it('does not throw when the bus emits an error', () => {
    const conn = getConnection() as unknown as { bluetooth: { dbus: EventEmitter } };
    expect(() => busOf(conn).emit('error', new Error('write EPIPE'))).not.toThrow();
  });

  it('logs the transport error at warn', () => {
    const warnSpy = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const conn = getConnection() as unknown as { bluetooth: { dbus: EventEmitter } };
    busOf(conn).emit('error', new Error('write EPIPE'));

    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('EPIPE');
  });

  it('rebuilds the connection on the next getAdapter, then stops rebuilding', async () => {
    const conn = getConnection() as unknown as { bluetooth: { dbus: EventEmitter } };
    expect(createBluetooth).toHaveBeenCalledTimes(1);

    busOf(conn).emit('error', new Error('write EPIPE'));
    await getAdapter();

    expect(createBluetooth).toHaveBeenCalledTimes(2);
    expect(destroySpies[0]).toHaveBeenCalledTimes(1);

    // Latch cleared: a healthy cycle must not rebuild again.
    await getAdapter();
    expect(createBluetooth).toHaveBeenCalledTimes(2);
  });

  it('attaches a fresh handler to the rebuilt session', async () => {
    const first = getConnection() as unknown as { bluetooth: { dbus: EventEmitter } };
    busOf(first).emit('error', new Error('write EPIPE'));
    await getAdapter();

    const second = getConnection() as unknown as { bluetooth: { dbus: EventEmitter } };
    expect(busOf(second)).not.toBe(busOf(first));
    expect(() => busOf(second).emit('error', new Error('write EPIPE'))).not.toThrow();
  });
});

describe('isStaleConnectionError', () => {
  it.each([
    'interface not found in proxy object',
    'not found in proxy',
    'connection closed',
    'The name is not activatable',
    'was not provided',
    'stream is closed',
    'Cannot write to a closed stream',
    'write EPIPE',
  ])('treats %s as stale', (msg) => {
    expect(isStaleConnectionError(new Error(msg))).toBe(true);
  });

  it.each(['Connection timed out', 'le-connection-abort-by-local', 'Operation is not supported'])(
    'does not treat %s as stale',
    (msg) => {
      expect(isStaleConnectionError(new Error(msg))).toBe(false);
    },
  );

  it('keeps Device not found off the stale path so the bond guard is unaffected', () => {
    expect(isStaleConnectionError(new Error('Device not found'))).toBe(false);
  });

  // The match-rule ceiling is per connection and only a new connection clears
  // it, so it has to route into reset-and-retry rather than kill the process
  // (#396). The catch is that dbus-next keeps the error NAME in `.type` and puts
  // only the human sentence in `.message`, so matching the message text alone
  // for "LimitsExceeded" would never fire.
  it('treats the D-Bus match-rule ceiling as stale, from the error type', () => {
    const err = Object.assign(
      new Error(
        'Connection ":1.1164" is not allowed to add more match rules ' +
          '(increase limits in configuration file if required; max_match_rules_per_connection=2048)',
      ),
      { type: 'org.freedesktop.DBus.Error.LimitsExceeded' },
    );
    expect(err.message).not.toContain('LimitsExceeded');
    expect(isStaleConnectionError(err)).toBe(true);
  });

  it('treats the match-rule ceiling as stale from the message alone too', () => {
    expect(
      isStaleConnectionError(new Error('Connection is not allowed to add more match rules')),
    ).toBe(true);
  });

  it('does not treat an unrelated error carrying a type field as stale', () => {
    const err = Object.assign(new Error('Operation is not supported'), {
      type: 'org.bluez.Error.NotSupported',
    });
    expect(isStaleConnectionError(err)).toBe(false);
  });
});
