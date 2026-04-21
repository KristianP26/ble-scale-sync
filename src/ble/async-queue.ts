/**
 * Simple async queue: push items, shift blocks until one is available.
 *
 * Producers call `push(item)` to enqueue or hand off to a waiting consumer.
 * Consumers call `shift(signal?)` to take the next item, optionally abortable.
 */
export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiting: Array<{ resolve: (item: T) => void; reject: (err: Error) => void }> = [];

  /** Enqueue an item, or resolve a waiting consumer. */
  push(item: T): void {
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter.resolve(item);
    } else {
      this.buffer.push(item);
    }
  }

  /** Return next item, or block until one arrives. Supports AbortSignal. */
  shift(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);

    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const entry = {
        resolve: (item: T) => {
          if (onAbort) signal!.removeEventListener('abort', onAbort);
          resolve(item);
        },
        reject,
      };
      this.waiting.push(entry);

      if (signal) {
        onAbort = () => {
          const idx = this.waiting.indexOf(entry);
          if (idx >= 0) this.waiting.splice(idx, 1);
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** Number of buffered items not yet consumed. */
  get pending(): number {
    return this.buffer.length;
  }
}
