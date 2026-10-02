import { vi } from 'vitest';

/**
 * A stand-in for `mqtt.connect()`.
 *
 * `connect()` returns the client SYNCHRONOUSLY and signals readiness through a
 * 'connect' event, which is the whole point of the exporter using it instead of
 * `connectAsync`: the client exists, and can therefore be closed, before it is
 * usable. A fake that resolves a client only once it is ready would hide that
 * distinction and let a regression through - the old tests stubbed
 * `connectAsync` and so could not see a connection that came up after its own
 * timeout with nobody left holding it.
 *
 * Events fire on a microtask, as the real client's do, so a caller that
 * attaches its listeners after `connect()` returns still receives them.
 */
export interface FakeMqtt {
  connect: ReturnType<typeof vi.fn>;
  publishAsync: ReturnType<typeof vi.fn>;
  endAsync: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  /** Clients handed out so far, newest last. */
  clients: FakeMqttClient[];
  /** What the next connection does. Default: connects. */
  setBehaviour(b: FakeMqttBehaviour): void;
  reset(): void;
}

export type FakeMqttBehaviour =
  | { kind: 'connect' }
  /** Emits 'error' instead of 'connect'. */
  | { kind: 'error'; error: Error }
  /** Never emits anything: the caller's own deadline has to end it. */
  | { kind: 'hang' }
  /** Emits 'connect' only after `delayMs`, so a deadline can expire first. */
  | { kind: 'late'; delayMs: number };

export interface FakeMqttClient {
  publishAsync: ReturnType<typeof vi.fn>;
  endAsync: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on(event: string, listener: (...args: unknown[]) => void): FakeMqttClient;
  removeListener(event: string, listener: (...args: unknown[]) => void): FakeMqttClient;
  emit(event: string, ...args: unknown[]): void;
  /** Listeners still attached, so a test can prove they were cleaned up. */
  listenerCount(event: string): number;
}

export function createFakeMqtt(): FakeMqtt {
  const publishAsync = vi.fn().mockResolvedValue(undefined);
  const endAsync = vi.fn().mockResolvedValue(undefined);
  const end = vi.fn();
  const clients: FakeMqttClient[] = [];
  let behaviour: FakeMqttBehaviour = { kind: 'connect' };

  const connect = vi.fn(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const client: FakeMqttClient = {
      publishAsync,
      endAsync,
      end,
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
        return client;
      },
      removeListener(event, listener) {
        listeners.get(event)?.delete(listener);
        return client;
      },
      emit(event, ...args) {
        for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
      },
      listenerCount(event) {
        return listeners.get(event)?.size ?? 0;
      },
    };
    clients.push(client);

    const current = behaviour;
    if (current.kind === 'connect') {
      queueMicrotask(() => client.emit('connect'));
    } else if (current.kind === 'error') {
      queueMicrotask(() => client.emit('error', current.error));
    } else if (current.kind === 'late') {
      setTimeout(() => client.emit('connect'), current.delayMs);
    }
    return client;
  });

  return {
    connect,
    publishAsync,
    endAsync,
    end,
    clients,
    setBehaviour(b) {
      behaviour = b;
    },
    reset() {
      behaviour = { kind: 'connect' };
      clients.length = 0;
      publishAsync.mockReset().mockResolvedValue(undefined);
      endAsync.mockReset().mockResolvedValue(undefined);
      end.mockReset();
      connect.mockClear();
    },
  };
}
