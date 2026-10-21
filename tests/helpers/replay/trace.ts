import type { BleDeviceInfo } from '../../../src/interfaces/scale-adapter.js';

/**
 * One BLE session as the scale played it, the input of replaySession().
 *
 * `provenance` says what the bytes can prove (D074):
 *  - `captured`: bytes and spacing as a real scale sent them (HCI capture,
 *    vendor-app log, our DEBUG log). Only these back a protocol claim.
 *  - `derived`: a captured trace with something changed on purpose; the fixture
 *    says what and why.
 *  - `characterization`: synthetic frames that pin today's behavior so a
 *    refactor can be checked against it, and nothing more.
 */
export interface Trace {
  provenance: 'captured' | 'derived' | 'characterization';
  /** Where the bytes come from: issue and comment id, capture file, log date. */
  source: string;
  /** What the transport saw before connecting; its address, name and manufacturer data reach the session. */
  advert?: BleDeviceInfo;
  steps: TraceStep[];
  /** When the link drops, in ms from the session start. Default: the harness drops it once nothing is left to wait for. */
  disconnectAtMs?: number;
}

export interface TraceStep {
  /** Milliseconds from the start of the session. */
  atMs: number;
  /** `rx` is replayed as a notification; `tx` is what the vendor app wrote, kept for reference and never replayed. */
  dir: 'rx' | 'tx';
  /** Characteristic of an `rx`; default the adapter's notify characteristic. */
  uuid?: string;
  hex: string;
}

export const hex = (h: string): Buffer => Buffer.from(h.replace(/ /g, ''), 'hex');

/** `[hh:mm:ss.mmm, direction, hex]` as decoded from a capture or a log. */
export type SnoopLine = readonly [string, 'rx' | 'tx', string];

export interface TimedFrame {
  /** Milliseconds since the first line of the excerpt. */
  atMs: number;
  dir: 'rx' | 'tx';
  frame: Buffer;
}

export function timed(lines: readonly SnoopLine[]): TimedFrame[] {
  const ms = (t: string): number => {
    const [h, m, s] = t.split(':');
    return Math.round(((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000);
  };
  const t0 = ms(lines[0][0]);
  return lines.map(([t, dir, h]) => ({ atMs: ms(t) - t0, dir, frame: hex(h) }));
}

/** Trace steps from snoop lines, timed from the first line. */
export const fromSnoop = (lines: readonly SnoopLine[]): TraceStep[] =>
  timed(lines).map((f) => ({ atMs: f.atMs, dir: f.dir, hex: f.frame.toString('hex') }));

/**
 * The `Notification <uuid>: [..]` lines of a DEBUG log (shared.ts), timed from
 * the first one by the logger's millisecond timestamp. A frame the log cut at
 * 32 bytes is refused rather than replayed short.
 */
export function fromDebugLog(text: string): TraceStep[] {
  const re =
    /(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) .*?Notification ([0-9a-f]+): \[([0-9a-f ]*)\]( \(\+\d+ bytes\))?/g;
  const steps = [...text.matchAll(re)].map(([line, ts, uuid, bytes, cut]) => {
    if (cut) throw new Error(`frame truncated in the log: ${line}`);
    return { at: Date.parse(ts.replace(' ', 'T') + 'Z'), uuid, hex: bytes.replace(/ /g, '') };
  });
  return steps.map((s) => ({ atMs: s.at - steps[0].at, dir: 'rx', uuid: s.uuid, hex: s.hex }));
}
