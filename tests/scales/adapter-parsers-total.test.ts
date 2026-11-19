import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';

// A parser sees bytes a device chose (an advertisement, a notification), and it
// runs inside a transport callback where an exception ends the process (ADR
// D108). The BLE layer catches one anyway, but a parser that throws on short or
// odd input is still a defect, and a new adapter is the likeliest place for it.
// A pin: it passes today and fails for an adapter that starts to throw.

const LENGTHS = [0, 1, 2, 3, 5, 8, 13, 20, 24];
const SERVICE_UUID = '0000181b-0000-1000-8000-00805f9b34fb';
const CHAR_UUID = '0000ffe100001000800000805f9b34fb';

function frames(): Buffer[] {
  const out: Buffer[] = [];
  for (let first = 0; first < 256; first += 1) {
    for (const len of LENGTHS) {
      const a = Buffer.alloc(len);
      if (len > 0) a[0] = first;
      for (let i = 1; i < len; i++) a[i] = (first * 31 + i * 97 + len * 13) & 0xff;
      out.push(a, Buffer.alloc(len, 0xff));
    }
  }
  return out;
}

describe('adapter parsers are total', () => {
  it('no parser throws on short or odd input', () => {
    const inputs = frames();
    const thrown: string[] = [];
    for (const adapter of adapters) {
      const a = adapter as unknown as Record<string, unknown>;
      const call = (method: string, run: (f: Buffer) => void): void => {
        if (typeof a[method] !== 'function') return;
        for (const f of inputs) {
          try {
            run(f);
          } catch (err) {
            thrown.push(`${adapter.name}.${method} len=${f.length}: ${(err as Error).message}`);
            return;
          }
        }
      };
      const m = (name: string) => a[name] as (...args: unknown[]) => unknown;
      call('parseBroadcast', (f) => m('parseBroadcast').call(a, f));
      call('parseServiceData', (f) => m('parseServiceData').call(a, SERVICE_UUID, f));
      call('parseNotification', (f) => m('parseNotification').call(a, f));
      call('parseCharNotification', (f) => m('parseCharNotification').call(a, CHAR_UUID, f));
      call('parseLiveBroadcast', (f) => m('parseLiveBroadcast').call(a, f));
    }
    expect(thrown).toEqual([]);
  });
});
