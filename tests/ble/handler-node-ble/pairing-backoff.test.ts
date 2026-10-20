import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ScaleAdapter, BleDeviceInfo } from '../../../src/interfaces/scale-adapter.js';
import type { Adapter, Device } from '../../../src/ble/handler-node-ble/dbus.js';
import { bleLog, PairingDeferredError } from '../../../src/ble/types.js';
import {
  PairingBackoff,
  pairingBackoff,
  _resetPairingBackoffForTests,
  holdUntilPairingAllowed,
  parseServiceDataProp,
  type PairingHoldOptions,
} from '../../../src/ble/handler-node-ble/pairing-backoff.js';

/**
 * The memory of a pairing nobody confirmed, and the stage that holds the next
 * connect back (#471, D063).
 *
 * The 0x181D payloads are the two #418 logged on a BF915, verbatim:
 *   serviceData={0000181d-0000-1000-8000-00805f9b34fb: 01}    reading waiting
 *   serviceData={0000181d-0000-1000-8000-00805f9b34fb: }      nothing waiting
 * `00` never occurred there. It is the `01` frame with its one byte changed,
 * used only to show that any other value says nothing.
 */

const MAC = 'D8:0B:CB:5B:B6:58';
const SVC_181D = '0000181d-0000-1000-8000-00805f9b34fb';
const WAITING = Buffer.from([0x01]); // #418 "reading waiting"
const NOTHING = Buffer.alloc(0); // #418 "nothing waiting"
const CHANGED = Buffer.from([0x00]); // #418 `01` with its byte changed, not a capture

const MIN = 60_000;

/** A hook shaped like the BF720 one, so this file does not depend on that adapter. */
function hook(device: BleDeviceInfo): boolean | undefined {
  const sd = device.serviceData?.find((e) => e.uuid.toLowerCase().startsWith('0000181d'));
  if (!sd) return undefined;
  if (sd.data.length === 0) return false;
  if (sd.data.length === 1 && sd.data[0] === 0x01) return true;
  return undefined;
}

function bondingAdapter(): ScaleAdapter {
  return {
    name: 'Beurer BF720/BF105',
    requiresBonding: true,
    advertisesPendingReading: hook,
  } as unknown as ScaleAdapter;
}

describe('PairingBackoff (#471, D063)', () => {
  let t = 0;
  let b: PairingBackoff;
  beforeEach(() => {
    t = 1_000_000;
    b = new PairingBackoff(() => t);
  });

  /** Minutes until the next attempt after `n` unconfirmed pairings. */
  function waitsAfter(n: number, cap = 60): number {
    const fresh = new PairingBackoff(() => t);
    for (let i = 0; i < n; i++) fresh.recordFailure(MAC, 'X', undefined);
    return fresh.remainingMs(MAC, cap) / MIN;
  }

  it('waits 2, 2, 2, 4, 8, 16, 32 minutes, then holds at the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 30].map((n) => waitsAfter(n))).toEqual([
      2, 2, 2, 4, 8, 16, 32, 60, 60, 60,
    ]);
  });

  // The docs promise the doubling goes on past 32 minutes under a larger cap,
  // not a jump from 32 straight to the cap.
  it('keeps doubling past 32 minutes until it reaches a larger cap', () => {
    expect([7, 8, 9, 10, 11].map((n) => waitsAfter(n, 240))).toEqual([32, 64, 128, 240, 240]);
  });

  it('uses the current cap on every query', () => {
    for (let i = 0; i < 8; i++) b.recordFailure(MAC, 'X', undefined);
    expect(b.remainingMs(MAC, 60)).toBe(60 * MIN);
    expect(b.remainingMs(MAC, 15)).toBe(15 * MIN);
    expect(b.decide(MAC, 15)).toEqual({ go: false, waitMs: 15 * MIN, failures: 8 });
    t += 15 * MIN;
    expect(b.decide(MAC, 15)).toEqual({ go: true, why: 'due' });
    expect(b.decide(MAC, 60).go).toBe(false);
  });

  it('never holds back with a cap of 0', () => {
    b.recordFailure(MAC, 'X', undefined);
    expect(b.decide(MAC, 0)).toEqual({ go: true, why: 'off' });
    expect(b.remainingMs(MAC, 0)).toBe(0);
  });

  it('reset forgets the failures', () => {
    b.recordFailure(MAC, 'X', undefined);
    b.recordFailure(MAC, 'X', undefined);
    expect(b.reset(MAC)).toBe(true);
    expect(b.decide(MAC, 60)).toEqual({ go: true, why: 'no-record' });
    expect(b.recordFailure(MAC, 'X', undefined)).toBe(1);
    expect(b.reset('11:22:33:44:55:66')).toBe(false);
  });

  it('opens on 0x181D going from an empty payload to 01 (#418)', () => {
    b.recordFailure(
      MAC,
      'X',
      hook({ localName: '', serviceData: [{ uuid: SVC_181D, data: NOTHING }] }),
    );
    expect(
      b.observeHint(MAC, hook({ localName: '', serviceData: [{ uuid: SVC_181D, data: WAITING }] })),
    ).toBe(true);
    // The step is taken once; the flag staying up opens nothing more.
    expect(b.observeHint(MAC, true)).toBe(false);
  });

  it('does not open while 0x181D stays 01', () => {
    b.recordFailure(MAC, 'X', true);
    expect(b.observeHint(MAC, true)).toBe(false);
    expect(b.observeHint(MAC, true)).toBe(false);
    // Fetched by somebody, then a new weigh-in: that opens.
    expect(b.observeHint(MAC, false)).toBe(false);
    expect(b.observeHint(MAC, true)).toBe(true);
  });

  it('ignores 00 (the #418 frame with its byte changed) and an absent 0x181D', () => {
    expect(hook({ localName: '', serviceData: [{ uuid: SVC_181D, data: CHANGED }] })).toBe(
      undefined,
    );
    expect(hook({ localName: '' })).toBe(undefined);
    b.recordFailure(MAC, 'X', false);
    expect(b.observeHint(MAC, undefined)).toBe(false);
    // undefined changed nothing: the empty payload is still the last word.
    expect(b.observeHint(MAC, true)).toBe(true);
  });

  it('does not open on a 01 first seen after a failure recorded without a hint', () => {
    // A snapshot without 0x181D (#418: 1 of 12) says nothing; only a payload
    // seen empty later makes the next 01 a new weigh-in.
    b.recordFailure(MAC, 'X', undefined);
    expect(b.observeHint(MAC, true)).toBe(false);
    expect(b.observeHint(MAC, false)).toBe(false);
    expect(b.observeHint(MAC, true)).toBe(true);
  });

  it('keeps the hint the failure was recorded with', () => {
    b.recordFailure(MAC, 'X', true);
    b.recordFailure(MAC, 'X', false);
    expect(b.observeHint(MAC, true)).toBe(true);
  });

  it('opens once for a scale that was missed by a cycle since the failure', () => {
    b.recordFailure(MAC, 'X', undefined);
    b.noteMissed(MAC);
    expect(b.decide(MAC, 60)).toEqual({ go: true, why: 'returned' });
    expect(b.decide(MAC, 60).go).toBe(false);
    b.noteMissedAll();
    expect(b.decide(MAC, 60)).toEqual({ go: true, why: 'returned' });
    // A new failure starts without the absence.
    b.noteMissed(MAC);
    b.recordFailure(MAC, 'X', undefined);
    expect(b.decide(MAC, 60).go).toBe(false);
  });

  it('parses ServiceData as PropertiesChanged carries it, keeping an empty payload', () => {
    const variant = (value: unknown) => ({ signature: 'v', value });
    expect(parseServiceDataProp(variant({ [SVC_181D]: variant(Buffer.from([0x01])) }))).toEqual([
      { uuid: SVC_181D, data: WAITING },
    ]);
    expect(parseServiceDataProp(variant(new Map([[SVC_181D, variant([])]])))).toEqual([
      { uuid: SVC_181D, data: NOTHING },
    ]);
    expect(parseServiceDataProp(variant({}))).toBe(undefined);
    expect(parseServiceDataProp(undefined)).toBe(undefined);
  });
});

describe('holdUntilPairingAllowed (#471, D063)', () => {
  let paired: boolean | Error = false;
  let helper: EventEmitter & { removeListeners: () => void };
  let device: Device;
  const btAdapter = {} as Adapter;
  /** The scan activity watchdog: here it only runs the wait. */
  const watch = (async (_a: unknown, _s: unknown, wait: () => Promise<unknown>) =>
    wait()) as unknown as NonNullable<PairingHoldOptions['watch']>;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetPairingBackoffForTests(() => Date.now());
    paired = false;
    helper = Object.assign(new EventEmitter(), { removeListeners: () => {} });
    device = {
      helper,
      isPaired: async () => {
        if (paired instanceof Error) throw paired;
        return paired;
      },
    } as unknown as Device;
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Starts the stage and lets it reach its wait, where the listener is on. */
  async function hold(over: Partial<PairingHoldOptions> = {}) {
    let state: 'pending' | 'resolved' | 'rejected' = 'pending';
    let error: unknown;
    const promise = holdUntilPairingAllowed({
      device,
      btAdapter,
      mac: MAC,
      adapter: bondingAdapter(),
      adapters: [bondingAdapter()],
      capMin: 60,
      hint: undefined,
      budgetMs: 120_000,
      watch,
      ...over,
    });
    promise.then(
      () => (state = 'resolved'),
      (e: unknown) => {
        state = 'rejected';
        error = e;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    return { state: () => state, error: () => error };
  }

  const report = (props: Record<string, unknown> = { RSSI: { value: -70 } }): void => {
    helper.emit('PropertiesChanged', props);
  };
  const serviceData = (data: Buffer) => ({
    ServiceData: { signature: 'a{sv}', value: { [SVC_181D]: { signature: 'ay', value: data } } },
  });

  it('returns at once without a record, and reads nothing', async () => {
    let reads = 0;
    device = { helper, isPaired: async () => (reads++, false) } as unknown as Device;
    const h = await hold();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('resolved');
    expect(reads).toBe(0);
  });

  it('goes on at once when the scale is paired, and resets the entry', async () => {
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    paired = true;
    const h = await hold();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('resolved');
    expect(pairingBackoff().has(MAC)).toBe(false);
  });

  it('goes on when isPaired() throws', async () => {
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    paired = new Error('org.freedesktop.DBus.Error.NoReply');
    const h = await hold();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('resolved');
    expect(pairingBackoff().has(MAC)).toBe(true);
  });

  it('goes on at once when the wait is over on entry', async () => {
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    vi.setSystemTime(Date.now() + 2 * MIN);
    const h = await hold();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('resolved');
  });

  it('goes on at once on an edge in the snapshot this cycle took', async () => {
    pairingBackoff().recordFailure(MAC, 'X', false);
    const h = await hold({ hint: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('resolved');
  });

  it('listens until the budget ends and throws an untagged PairingDeferredError', async () => {
    // Five unconfirmed pairings: 8 minutes, well past this cycle's budget.
    for (let i = 0; i < 5; i++) pairingBackoff().recordFailure(MAC, 'X', undefined);
    const h = await hold();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(h.state()).toBe('pending');
    report();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.state()).toBe('rejected');
    expect(h.error()).toBeInstanceOf(PairingDeferredError);
    expect((h.error() as Error).message).toBe(
      `${MAC} is not paired; next pairing attempt in 6 min, or sooner if it reappears or advertises a new weigh-in`,
    );
    const { bleFailureKind } = await import('../../../src/ble/failure-kind.js');
    expect(bleFailureKind(h.error())).toBe(undefined);
    expect(helper.listenerCount('PropertiesChanged')).toBe(0);
  });

  it('goes on mid-wait when ServiceData 0x181D turns from empty to 01', async () => {
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    const h = await hold();
    report(serviceData(NOTHING));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state()).toBe('pending');
    report(serviceData(WAITING));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('resolved');
    expect(helper.listenerCount('PropertiesChanged')).toBe(0);
  });

  it('stays while ServiceData 0x181D only ever says 01 or 00', async () => {
    pairingBackoff().recordFailure(MAC, 'X', true);
    const h = await hold();
    report(serviceData(WAITING));
    report(serviceData(CHANGED));
    report(serviceData(WAITING));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state()).toBe('pending');
  });

  it('goes on mid-wait when Paired turns true', async () => {
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    const h = await hold();
    report({ Paired: { signature: 'b', value: false } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.state()).toBe('pending');
    report({ Paired: { signature: 'b', value: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('resolved');
    expect(pairingBackoff().has(MAC)).toBe(false);
  });

  it('goes on at the due time only after a fresh report', async () => {
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    vi.setSystemTime(Date.now() + 90_000);
    const h = await hold();
    report();
    // Due 30 s in; the last report is 30 s old by then.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.state()).toBe('pending');
    // Another property changing is not a report.
    report({ Connected: { signature: 'b', value: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('pending');
    report();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('resolved');
  });

  it('goes on at the due time when a report came just before it', async () => {
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    vi.setSystemTime(Date.now() + 90_000);
    const h = await hold();
    await vi.advanceTimersByTimeAsync(28_000);
    report();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.state()).toBe('resolved');
  });

  it('says when the wait is over but the scale was not heard since', async () => {
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    const h = await hold({ budgetMs: 150_000 });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(h.state()).toBe('rejected');
    expect((h.error() as Error).message).toBe(
      `${MAC} is not paired; next pairing attempt as soon as it is heard again`,
    );
  });

  it('does not name a wait that is already over when a weigh-in opens it', async () => {
    pairingBackoff().recordFailure(MAC, 'X', false);
    vi.setSystemTime(Date.now() + 3 * MIN);
    const h = await hold({ hint: true });
    expect(h.state()).toBe('resolved');
    const lines = vi.mocked(bleLog.info).mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes('advertises a stored weigh-in'));
    expect(line).toBeDefined();
    expect(line).not.toContain('rather than');
  });

  it('never waits past the discovery budget left in the cycle', async () => {
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    const h = await hold({ budgetMs: 30_000 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state()).toBe('rejected');
    expect(h.error()).toBeInstanceOf(PairingDeferredError);
  });

  it('rejects with the abort reason and removes its listener', async () => {
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    const ctrl = new AbortController();
    const h = await hold({ abortSignal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(helper.listenerCount('PropertiesChanged')).toBe(1);
    const reason = new Error('shutdown');
    ctrl.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('rejected');
    expect(h.error()).toBe(reason);
    expect(helper.listenerCount('PropertiesChanged')).toBe(0);
  });

  it('takes its abort listener off the cycle signal when it goes on', async () => {
    // Continuous mode hands every cycle the same signal, so a listener left on
    // it per held cycle would pile up for the life of the process.
    pairingBackoff().recordFailure(MAC, 'X', undefined);
    const ctrl = new AbortController();
    const added = vi.spyOn(ctrl.signal, 'addEventListener');
    const removed = vi.spyOn(ctrl.signal, 'removeEventListener');
    const h = await hold({ abortSignal: ctrl.signal });
    report({ Paired: { signature: 'b', value: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('resolved');
    const listeners = added.mock.calls.filter((c) => c[0] === 'abort').map((c) => c[1]);
    expect(listeners.length).toBeGreaterThan(0);
    for (const l of listeners) expect(removed).toHaveBeenCalledWith('abort', l);
  });

  it('reads the hint through the adapter the record was written with', async () => {
    pairingBackoff().recordFailure(MAC, 'Beurer BF720/BF105', false);
    const h = await hold({ adapter: undefined, adapters: [bondingAdapter()] });
    report(serviceData(WAITING));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toBe('resolved');
  });
});
