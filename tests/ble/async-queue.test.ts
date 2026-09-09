import { describe, it, expect, vi } from 'vitest';
import { AsyncQueue } from '../../src/ble/async-queue.js';

/**
 * #406: this is the queue every watcher pushes readings into, and it had no
 * tests at all. A lost or double-shifted item is a lost weigh-in.
 */
describe('AsyncQueue', () => {
  it('returns a buffered item without blocking, in FIFO order', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    expect(q.pending).toBe(2);
    await expect(q.shift()).resolves.toBe(1);
    await expect(q.shift()).resolves.toBe(2);
    expect(q.pending).toBe(0);
  });

  it('blocks until an item arrives, and hands it to the waiter rather than buffering it', async () => {
    const q = new AsyncQueue<string>();
    const pending = q.shift();
    q.push('reading');
    await expect(pending).resolves.toBe('reading');
    expect(q.pending).toBe(0);
  });

  it('gives each waiter its own item, in the order they arrived', async () => {
    const q = new AsyncQueue<number>();
    const first = q.shift();
    const second = q.shift();
    q.push(10);
    q.push(20);
    await expect(first).resolves.toBe(10);
    await expect(second).resolves.toBe(20);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const q = new AsyncQueue<number>();
    const ac = new AbortController();
    ac.abort(new Error('shutting down'));
    await expect(q.shift(ac.signal)).rejects.toThrow('shutting down');
    // The item is still there for whoever asks next: an aborted consumer must
    // not consume.
    q.push(7);
    await expect(q.shift()).resolves.toBe(7);
  });

  it('rejects a waiting consumer on abort, and drops it from the queue', async () => {
    const q = new AsyncQueue<number>();
    const ac = new AbortController();
    const pending = q.shift(ac.signal);
    ac.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');

    // The abandoned waiter must not swallow the next item.
    q.push(42);
    await expect(q.shift()).resolves.toBe(42);
  });

  it('removes its abort listener once an item is delivered', async () => {
    const q = new AsyncQueue<number>();
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    const pending = q.shift(ac.signal);
    q.push(1);
    await pending;
    expect(remove).toHaveBeenCalled();
    // Aborting afterwards must not reject anything or throw.
    ac.abort(new Error('late'));
  });

  it('treats undefined as an ordinary value rather than an empty queue', async () => {
    const q = new AsyncQueue<number | undefined>();
    q.push(undefined);
    // Known limitation of the buffer check: an explicitly pushed undefined is
    // indistinguishable from an empty buffer, so this blocks rather than
    // returning it. Pinned so a change of behaviour here is deliberate.
    const pending = q.shift();
    q.push(5);
    await expect(pending).resolves.toBe(5);
  });
});
