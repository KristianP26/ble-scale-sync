import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

interface Session {
  bluetooth: {
    dbus: EventEmitter;
    defaultAdapter: () => Promise<unknown>;
    getAdapter: () => Promise<unknown>;
  };
  destroy: ReturnType<typeof vi.fn>;
}

const sessions: Session[] = [];

function makeSession(): Session {
  const adapter = {
    isPowered: async () => true,
    devices: async () => [],
    stopDiscovery: async () => undefined,
  };
  const session: Session = {
    bluetooth: {
      dbus: new EventEmitter(),
      defaultAdapter: async () => adapter,
      getAdapter: async () => adapter,
    },
    destroy: vi.fn(),
  };
  sessions.push(session);
  return session;
}

vi.mock('node-ble', () => {
  const mod = { createBluetooth: () => makeSession() };
  return { default: mod, ...mod };
});

// Tiers 4 to 6 of the real startDiscoverySafe, reduced to what they do to the
// connection: reset it, then take the adapter from a fresh PERSISTENT one.
vi.mock('../../../src/ble/handler-node-ble/discovery.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/discovery.js')>();
  const conn = await import('../../../src/ble/handler-node-ble/connection.js');
  return {
    ...actual,
    startDiscoverySafe: async () => {
      conn.resetConnection();
      return await conn.getAdapter();
    },
  };
});

const { scanDevices } = await import('../../../src/ble/handler-node-ble/scan.js');
const { resetConnection } = await import('../../../src/ble/handler-node-ble/connection.js');

/**
 * A-08. `scanDevices` runs on its own throwaway bus, but when discovery only
 * comes up after a btmgmt/rfkill/bluetoothd reset, the recovery tier hands back
 * an adapter from the PERSISTENT connection instead. The finally destroyed only
 * the throwaway bus, so the persistent socket stayed open and `npm run scan`
 * printed its results and never exited.
 */
describe('node-ble scanDevices connection ownership (A-08)', () => {
  afterEach(() => {
    resetConnection();
    sessions.length = 0;
  });

  it('closes the persistent connection a recovery tier opened for it', async () => {
    await scanDevices([], 0);

    expect(sessions).toHaveLength(2);
    // The throwaway bus scanDevices built for itself.
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
    // The persistent one the recovery tier opened. Left open, it pins the
    // event loop of a one-shot CLI.
    expect(sessions[1].destroy).toHaveBeenCalledTimes(1);
  });
});
