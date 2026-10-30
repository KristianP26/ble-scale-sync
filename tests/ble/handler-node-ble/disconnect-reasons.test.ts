import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const { noteConnected, noteConnecting, watchDisconnectReasons, _resetDisconnectReasonsForTests } =
  await import('../../../src/ble/handler-node-ble/disconnect-reasons.js');
const { bleLog } = await import('../../../src/ble/types.js');
const { setLogLevel, LogLevel } = await import('../../../src/logger.js');

const MAC = 'AA:BB:CC:DD:EE:FF';
const PATH = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';
const RULE = "type='signal',sender='org.bluez',interface='org.bluez.Device1',member='Disconnected'";
const REMOTE = ['org.bluez.Reason.Remote', 'Connection terminated by remote user'];

/** dbus-next's MessageBus as far as the module reads it: `message` events and `_addMatch`. */
function fakeBus(addMatch: (rule: string) => Promise<unknown> = async () => undefined) {
  const bus = new EventEmitter() as EventEmitter & { _addMatch: ReturnType<typeof vi.fn> };
  bus._addMatch = vi.fn(addMatch);
  return bus;
}

/** A signal as dbus-next hands it to `message` listeners. */
function signal(fields: Record<string, unknown> = {}) {
  return {
    type: 4,
    sender: ':1.0',
    path: PATH,
    interface: 'org.bluez.Device1',
    member: 'Disconnected',
    signature: 'ss',
    body: REMOTE,
    ...fields,
  };
}

let now = 0;
let debug: MockInstance<(msg: string) => void>;

/** The lines this module wrote, without the ones about the watch itself. */
const reasonLines = (): string[] =>
  debug.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('BlueZ: '));

beforeEach(() => {
  now = 1_000;
  _resetDisconnectReasonsForTests(() => now);
  setLogLevel(LogLevel.DEBUG);
  debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  _resetDisconnectReasonsForTests();
  setLogLevel(LogLevel.INFO);
  vi.restoreAllMocks();
});

describe('watchDisconnectReasons (#434)', () => {
  it('adds the one match rule and writes one line with the time, reason, message and gloss', () => {
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    expect(bus._addMatch).toHaveBeenCalledTimes(1);
    expect(bus._addMatch).toHaveBeenCalledWith(RULE);

    noteConnected(MAC);
    now += 5_437;
    bus.emit('message', signal());
    expect(reasonLines()).toEqual([
      `BlueZ: ${MAC} disconnected 5.44 s after connect: org.bluez.Reason.Remote ` +
        '(Connection terminated by remote user) - the scale ended it',
    ]);
  });

  it('stays silent for an address this process did not connect', () => {
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    noteConnected('11:22:33:44:55:66');
    bus.emit('message', signal());
    expect(reasonLines()).toEqual([]);
  });

  it.each([
    ['another member', { member: 'PropertiesChanged' }],
    ['another interface', { interface: 'org.bluez.Adapter1' }],
    ['a method call', { type: 1 }],
    ['an object under the device', { path: `${PATH}/service0010` }],
    ['an adapter path', { path: '/org/bluez/hci0' }],
    ['no body', { body: undefined }],
    ['a reason that is not a string', { body: [7, 'x'] }],
    ['no message', { body: ['org.bluez.Reason.Remote'] }],
  ])('ignores %s', (_n, fields) => {
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    noteConnected(MAC);
    bus.emit('message', signal(fields));
    expect(reasonLines()).toEqual([]);
  });

  it('reads the address from the object path, on any adapter', () => {
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    noteConnected('A4:C1:38:00:00:01');
    noteConnected(MAC);
    bus.emit('message', signal({ path: '/org/bluez/hci1/dev_A4_C1_38_00_00_01' }));
    expect(reasonLines()).toHaveLength(1);
    expect(reasonLines()[0]).toContain('BlueZ: A4:C1:38:00:00:01 disconnected');
  });

  it.each([
    ['org.bluez.Reason.Remote', 'the scale ended it'],
    ['org.bluez.Reason.Timeout', 'link lost (supervision timeout)'],
    ['org.bluez.Reason.Local', 'this host ended it (this app, BlueZ or the kernel)'],
    ['org.bluez.Reason.Authentication', 'the scale refused the key'],
    ['org.bluez.Reason.Suspend', 'the host suspended'],
    ['org.bluez.Reason.Unknown', 'other reason; btmon shows the code'],
    ['org.bluez.Reason.SomethingNew', 'other reason; btmon shows the code'],
  ])('glosses %s', (reason, gloss) => {
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    noteConnected(MAC);
    bus.emit('message', signal({ body: [reason, 'text'] }));
    expect(reasonLines()).toEqual([
      `BlueZ: ${MAC} disconnected 0.00 s after connect: ${reason} (text) - ${gloss}`,
    ]);
  });

  it('leaves out an empty message', () => {
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    noteConnected(MAC);
    bus.emit('message', signal({ body: ['org.bluez.Reason.Local', ''] }));
    expect(reasonLines()[0]).toBe(
      `BlueZ: ${MAC} disconnected 0.00 s after connect: org.bluez.Reason.Local - this host ended it (this app, BlueZ or the kernel)`,
    );
  });

  it('times a reconnect from the reconnect', () => {
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    noteConnected(MAC);
    now += 60_000;
    noteConnected(MAC);
    now += 1_250;
    bus.emit('message', signal());
    expect(reasonLines()[0]).toContain('disconnected 1.25 s after connect');
  });

  it('writes one line per connection: a later end without a new connect is not timed from it', () => {
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    noteConnected(MAC);
    bus.emit('message', signal());
    now += 300_000;
    // A failed connect attempt of a later cycle: D066 reports that one.
    bus.emit('message', signal({ body: ['org.bluez.Reason.Local', 'x'] }));
    expect(reasonLines()).toHaveLength(1);
  });

  it('forgets a connection whose end went unheard once the next connect starts', () => {
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    noteConnected(MAC);
    // The teardown reset the D-Bus connection before BlueZ sent the signal.
    now += 75_000;
    noteConnecting(MAC);
    // That attempt fails after the link came up: D066 reports it.
    bus.emit('message', signal({ body: ['org.bluez.Reason.Local', 'x'] }));
    expect(reasonLines()).toEqual([]);
  });

  it('without DEBUG: no match rule and no listener', () => {
    setLogLevel(LogLevel.INFO);
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    expect(bus._addMatch).not.toHaveBeenCalled();
    expect(bus.listenerCount('message')).toBe(0);
  });

  it('a refused AddMatch costs only a debug line', async () => {
    const bus = fakeBus(async () => {
      throw new Error('not allowed to add more match rules');
    });
    expect(() => watchDisconnectReasons(bus)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(debug).toHaveBeenCalledWith(
      'Disconnect reasons not watched: not allowed to add more match rules',
    );
  });

  it('never throws: no bus, a bus without the internals, an AddMatch that throws at once', () => {
    expect(() => watchDisconnectReasons(undefined)).not.toThrow();
    expect(() => watchDisconnectReasons({})).not.toThrow();
    const bus = fakeBus();
    bus._addMatch = vi.fn(() => {
      throw new Error('stream is closed');
    });
    expect(() => watchDisconnectReasons(bus)).not.toThrow();
  });

  // dbus-next calls `message` listeners inside the try that also dispatches
  // the message: a throw would skip the dispatch.
  it('its listener never throws, whatever the message', () => {
    const bus = fakeBus();
    watchDisconnectReasons(bus);
    noteConnected(MAC);
    const hostile = signal();
    Object.defineProperty(hostile, 'body', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => bus.emit('message', hostile)).not.toThrow();
    expect(() => bus.emit('message', null)).not.toThrow();
    expect(reasonLines()).toEqual([]);
  });
});

const nodeRequire = createRequire(import.meta.url);

type RealBus = EventEmitter & { _addMatch: (rule: string) => Promise<unknown> };

let wire:
  | {
      MessageBus: new (conn: unknown) => RealBus;
      Message: new (fields: Record<string, unknown>) => unknown;
    }
  | undefined;
try {
  wire = {
    MessageBus: nodeRequire('dbus-next/lib/bus.js') as new (conn: unknown) => RealBus,
    Message: (nodeRequire('dbus-next') as { Message: new (f: Record<string, unknown>) => unknown })
      .Message,
  };
} catch {
  // dbus-next is an optionalDependency; a noble-only install skips the guard.
  wire = undefined;
}

/**
 * The module rests on dbus-next 0.10.2 emitting `message` on the MessageBus for
 * every incoming message, signals included (`lib/bus.js`, listed as low-level
 * API in the class comment). An upgrade that drops it fails here, not silently
 * on a reporter's host.
 */
describe.skipIf(!wire)('dbus-next MessageBus guard (#434)', () => {
  /** The socket side: what the bus wrote, and a way to hand it a message. */
  function realBus() {
    const conn = new EventEmitter() as EventEmitter & {
      stream: { writable: boolean };
      message: (msg: { member?: string; body?: unknown[] }) => void;
    };
    const written: Array<{ member?: string; body?: unknown[] }> = [];
    conn.stream = { writable: true };
    conn.message = (msg) => written.push(msg);
    const bus = new wire!.MessageBus(conn);
    return { bus, conn, written };
  }

  it('emits message for an incoming signal', () => {
    const { bus, conn } = realBus();
    const heard: unknown[] = [];
    bus.on('message', (m: unknown) => heard.push(m));
    const msg = new wire!.Message({
      type: 4,
      sender: ':1.0',
      path: PATH,
      interface: 'org.bluez.Device1',
      member: 'Disconnected',
      signature: 'ss',
      body: REMOTE,
    });
    conn.emit('message', msg);
    expect(heard).toEqual([msg]);
  });

  it('carries the rule to the daemon and the reason to the line, on the real bus', () => {
    const { bus, conn, written } = realBus();
    watchDisconnectReasons(bus);
    expect(written.map((m) => m.member)).toEqual(['Hello', 'AddMatch']);
    expect(written[1].body).toEqual([RULE]);

    noteConnected(MAC);
    now += 2_000;
    conn.emit(
      'message',
      new wire!.Message({
        type: 4,
        sender: ':1.0',
        path: PATH,
        interface: 'org.bluez.Device1',
        member: 'Disconnected',
        signature: 'ss',
        body: ['org.bluez.Reason.Timeout', 'Connection timeout'],
      }),
    );
    expect(reasonLines()).toEqual([
      `BlueZ: ${MAC} disconnected 2.00 s after connect: org.bluez.Reason.Timeout ` +
        '(Connection timeout) - link lost (supervision timeout)',
    ]);
  });
});
