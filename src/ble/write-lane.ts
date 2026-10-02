import type { BleChar } from './shared.js';

/**
 * Per-characteristic write lanes for one GATT session (#211).
 *
 * BlueZ keeps one pending write per characteristic and refuses EVERY other
 * write to that characteristic while it is open, a write-without-response
 * included: `characteristic_write_value()` checks `chrc->write_op` before it
 * even parses the write type (src/gatt-client.c, master ae69dcd, lines
 * 1045-1046) and answers `org.bluez.Error.InProgress`. The per-frame ACK, the
 * legacy unlock interval and an adapter's own `ctx.write` used to fire at the
 * same characteristic without waiting for each other, so on a slow link most
 * Beurer/Sanitas ACKs were refused and the scale never advanced its 0x59
 * composition stream.
 *
 * Every write of a session goes through here instead, one FIFO per
 * characteristic. Writes to different characteristics still run side by side,
 * exactly as before.
 *
 * Rules:
 *
 * 1. An idle lane starts the write synchronously inside `write()`. QN acks from
 *    inside its parse and the session can be torn down in the same tick (#370);
 *    the write has to be on the wire before that, as it was before lanes.
 * 2. At most one write runs per characteristic. The next one starts in the same
 *    callback that releases the previous one, so a new write can never overtake
 *    a waiting one.
 * 3. `releaseAfterMs` only releases the lane; the caller's promise still follows
 *    the transport. A write the stack never answers cannot block the lane for
 *    the rest of the session. The timer is unref'd and cleared on settle, so it
 *    never keeps a single-shot run alive.
 * 4. An ACK byte-identical to the ACK at the tail of the queue, still waiting,
 *    joins it instead of queueing a second physical write. Nothing is ever
 *    replaced by a different ACK, a running ACK is never joined, and adapter
 *    writes are never joined.
 * 5. `close()` drops only waiting unlock writes and refuses new ones. ACKs and
 *    adapter writes, waiting or new, still run: the last frame's ACK and the QN
 *    FFE3 fallback after teardown (#370) both depend on it.
 * 6. A rejected or synchronously throwing write never stalls the lane.
 * 7. The only promise that can reject is the one handed to the caller.
 */

export type WriteKind = 'adapter' | 'unlock' | 'ack';

export interface WriteTiming {
  /** From queueing to start. */
  waitedMs: number;
  /** From start to the transport settling. */
  tookMs: number;
  /** True when this write joined an identical ACK that was still waiting. */
  coalesced: boolean;
}

/** Rejection for an unlock write that the end of the session made pointless. */
export class WriteLaneClosed extends Error {
  constructor() {
    super('Write lane closed: the session is over');
    this.name = 'WriteLaneClosed';
  }
}

export interface WriteLanes {
  write(
    char: WritableChar,
    data: Buffer,
    withResponse: boolean,
    kind: WriteKind,
  ): Promise<WriteTiming>;
  close(): void;
}

/** The only part of a characteristic a lane needs. */
export type WritableChar = Pick<BleChar, 'write'>;

interface Settler {
  queuedAt: number;
  coalesced: boolean;
  resolve: (t: WriteTiming) => void;
  reject: (e: unknown) => void;
}

interface Entry {
  data: Buffer;
  withResponse: boolean;
  kind: WriteKind;
  /** The original caller first, then every caller that joined it. */
  settlers: Settler[];
}

interface Lane {
  running: Entry | null;
  waiting: Entry[];
}

const DEFAULT_RELEASE_AFTER_MS = 5000;

export function createWriteLanes(opts: { releaseAfterMs?: number } = {}): WriteLanes {
  const releaseAfterMs = opts.releaseAfterMs ?? DEFAULT_RELEASE_AFTER_MS;
  const lanes = new Map<WritableChar, Lane>();
  let closed = false;

  const start = (char: WritableChar, lane: Lane, entry: Entry): void => {
    lane.running = entry;
    const startedAt = Date.now();
    let released = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Idempotent per entry: a late settle of an entry the timer already let go
    // must not release whichever entry is running by then.
    const release = (): void => {
      if (released) return;
      released = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (lane.running !== entry) return;
      lane.running = null;
      const next = lane.waiting.shift();
      if (next) {
        start(char, lane, next);
      } else {
        lanes.delete(char);
      }
    };

    let pending: Promise<void>;
    try {
      pending = Promise.resolve(char.write(entry.data, entry.withResponse));
    } catch (e: unknown) {
      pending = Promise.reject(e);
    }

    timer = setTimeout(release, releaseAfterMs);
    timer.unref?.();

    // Both handlers, never `.finally()`: that returns a new promise which
    // rejects with the transport error and nobody catches it (#138).
    pending.then(
      () => {
        release();
        const tookMs = Date.now() - startedAt;
        for (const s of entry.settlers) {
          s.resolve({ waitedMs: startedAt - s.queuedAt, tookMs, coalesced: s.coalesced });
        }
      },
      (e: unknown) => {
        release();
        for (const s of entry.settlers) s.reject(e);
      },
    );
  };

  const write = (
    char: WritableChar,
    data: Buffer,
    withResponse: boolean,
    kind: WriteKind,
  ): Promise<WriteTiming> => {
    if (closed && kind === 'unlock') return Promise.reject(new WriteLaneClosed());

    return new Promise<WriteTiming>((resolve, reject) => {
      const queuedAt = Date.now();
      let lane = lanes.get(char);

      if (lane && kind === 'ack') {
        const tail = lane.waiting.at(-1);
        if (
          tail &&
          tail.kind === 'ack' &&
          tail.withResponse === withResponse &&
          tail.data.equals(data)
        ) {
          tail.settlers.push({ queuedAt, coalesced: true, resolve, reject });
          return;
        }
      }

      const entry: Entry = {
        data,
        withResponse,
        kind,
        settlers: [{ queuedAt, coalesced: false, resolve, reject }],
      };

      if (!lane) {
        lane = { running: null, waiting: [] };
        lanes.set(char, lane);
      }
      if (lane.running === null) {
        start(char, lane, entry);
      } else {
        lane.waiting.push(entry);
      }
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const lane of lanes.values()) {
      const kept: Entry[] = [];
      for (const entry of lane.waiting) {
        if (entry.kind === 'unlock') {
          for (const s of entry.settlers) s.reject(new WriteLaneClosed());
        } else {
          kept.push(entry);
        }
      }
      lane.waiting = kept;
    }
  };

  return { write, close };
}
