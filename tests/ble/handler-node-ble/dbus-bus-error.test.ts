import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

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

/**
 * A socket the daemon closes reaches dbus-next as `end`, not `error` (A-03).
 *
 * The bus here is dbus-next's REAL MessageBus, so a parked call behaves exactly
 * as it does in production: its resolver sits in `_methodReturnHandlers` until a
 * reply arrives. Only the connection object underneath is a stand-in, and it
 * reproduces what `dbus-next/lib/connection.js` does on `stream.on('end')`:
 * emit `end`, then replace `message()` with one that emits `error` on the next
 * write. The plain-EventEmitter bus above cannot show this, because it has no
 * calls to park and nothing that ever emits `end`.
 */
describe('D-Bus socket closed by the bus (A-03)', () => {
  const nodeRequire = createRequire(import.meta.url);
  const MessageBus = nodeRequire('dbus-next/lib/bus.js') as new (conn: unknown) => EventEmitter & {
    call(msg: unknown): Promise<unknown>;
  };
  const { Message } = nodeRequire('dbus-next') as {
    Message: new (opts: Record<string, unknown>) => unknown;
  };

  interface FakeDbusNextConnection extends EventEmitter {
    message: (msg: unknown) => void;
    stream: { end: () => void; writable: boolean };
  }

  function makeRealBusSession() {
    const conn = new EventEmitter() as FakeDbusNextConnection;
    conn.stream = { end: () => {}, writable: true };
    conn.message = () => {};
    const bus = new MessageBus(conn);
    // Answer the Hello the constructor sends, as the daemon does on connect.
    // Left pending, it would be one more parked call in every assertion below.
    conn.emit('message', {
      type: 2,
      replySerial: 1,
      body: [':1.42'],
      sender: 'org.freedesktop.DBus',
    });
    const fakeAdapter = { isPowered: async () => true };
    const session = {
      bluetooth: {
        dbus: bus,
        defaultAdapter: async () => fakeAdapter,
        getAdapter: async () => fakeAdapter,
      },
      destroy: vi.fn(),
    };
    /** What connection.js does when the daemon closes the socket. */
    const closeFromBus = (): void => {
      conn.emit('end');
      conn.message = () => {
        conn.emit('error', new Error('Tried to write a message to a closed stream'));
      };
    };
    return { session, bus, closeFromBus };
  }

  function powered(): unknown {
    return new Message({
      destination: 'org.bluez',
      path: '/org/bluez/hci0',
      interface: 'org.freedesktop.DBus.Properties',
      member: 'Get',
      signature: 'ss',
      body: ['org.bluez.Adapter1', 'Powered'],
    });
  }

  /** 'resolved' / 'rejected' with the error, or 'pending' if it never settled. */
  async function settle(p: Promise<unknown>): Promise<{ state: string; err?: unknown }> {
    return Promise.race([
      p.then(
        () => ({ state: 'resolved' }),
        (err: unknown) => ({ state: 'rejected', err }),
      ),
      new Promise<{ state: string }>((r) => setTimeout(() => r({ state: 'pending' }), 50)),
    ]);
  }

  beforeEach(() => {
    resetConnection();
    createBluetooth.mockClear();
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConnection();
  });

  it('fails a call that was waiting when the socket closed, as a stale-connection error', async () => {
    const real = makeRealBusSession();
    createBluetooth.mockImplementationOnce(() => real.session as never);
    getConnection();

    const inFlight = real.bus.call(powered());
    real.closeFromBus();

    const outcome = await settle(inFlight);
    expect(outcome.state).toBe('rejected');
    expect(isStaleConnectionError(outcome.err)).toBe(true);
  });

  it('fails a call written after the close instead of parking it', async () => {
    const real = makeRealBusSession();
    createBluetooth.mockImplementationOnce(() => real.session as never);
    getConnection();
    real.closeFromBus();

    const outcome = await settle(real.bus.call(powered()));
    expect(outcome.state).toBe('rejected');
  });

  it('rebuilds on the next getAdapter without touching the dead bus first', async () => {
    const real = makeRealBusSession();
    createBluetooth.mockImplementationOnce(() => real.session as never);
    getConnection();
    real.closeFromBus();

    // Without the latch, getAdapter keeps the dead bus and its first call
    // (the pairing agent's introspection) parks forever.
    const outcome = await settle(getAdapter());
    expect(outcome.state).toBe('resolved');
    expect(createBluetooth).toHaveBeenCalledTimes(2);
    expect(real.session.destroy).toHaveBeenCalledTimes(1);
  });

  it('ignores the close of a connection it already reset itself', async () => {
    const real = makeRealBusSession();
    createBluetooth.mockImplementationOnce(() => real.session as never);
    getConnection();
    resetConnection();
    await getAdapter();
    expect(createBluetooth).toHaveBeenCalledTimes(2);

    // Our own destroy() ends the old stream, and the daemon's close of it
    // arrives later. It must not condemn the healthy replacement.
    real.closeFromBus();
    await getAdapter();
    expect(createBluetooth).toHaveBeenCalledTimes(2);
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
