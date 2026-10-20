import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Device } from '../../../src/ble/handler-node-ble/dbus.js';

const { observeConnectAttempt, _resetLinkObserverForTests, REASON_PROBE_TIMEOUT_MS } =
  await import('../../../src/ble/handler-node-ble/link-observer.js');
const { bleLog } = await import('../../../src/ble/types.js');

const DISCONNECTED = [{ name: 'Disconnected', signature: 'ss' }];

type Iface = EventEmitter & { $signals: { name: string; signature: string }[] };

function makeIface(signals: { name: string; signature: string }[]): Iface {
  const iface = new EventEmitter() as Iface;
  iface.$signals = signals;
  return iface;
}

/**
 * A node-ble device whose helper forwards PropertiesChanged with Variants, as
 * BusHelper does, and whose bus introspects to `iface`.
 */
function makeDevice(
  opts: {
    iface?: Iface;
    getProxyObject?: (name: string, path: string) => Promise<unknown>;
    noBus?: boolean;
  } = {},
) {
  const helper = new EventEmitter() as EventEmitter & {
    object: string;
    dbus?: { getProxyObject: ReturnType<typeof vi.fn> };
  };
  helper.object = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';
  const iface = opts.iface ?? makeIface(DISCONNECTED);
  const getProxyObject = vi.fn(
    opts.getProxyObject ?? (async () => ({ getInterface: () => iface })),
  );
  if (!opts.noBus) helper.dbus = { getProxyObject };
  const device = { helper } as unknown as Device;
  return { device, helper, iface, getProxyObject };
}

const connected = (value: boolean) => ({ Connected: { signature: 'b', value } });

describe('observeConnectAttempt (#471, D066)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetLinkObserverForTests(() => Date.now());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetLinkObserverForTests();
  });

  it('measures when the connection came up and how long it outlived the error', async () => {
    const { device, helper } = makeDevice();
    const obs = await observeConnectAttempt(device, { probeReasons: false });
    obs.markConnectStart();
    vi.advanceTimersByTime(400);
    helper.emit('PropertiesChanged', connected(true));
    vi.advanceTimersByTime(600);
    obs.markError();
    vi.advanceTimersByTime(95);
    helper.emit('PropertiesChanged', connected(false));
    expect(obs.view()).toEqual({
      linkUp: true,
      linkUpAfterMs: 400,
      downAfterErrorMs: 95,
      reasonSupported: false,
      reason: undefined,
    });
  });

  it('unwraps a Variant and takes a bare boolean too', async () => {
    const { device, helper } = makeDevice();
    const obs = await observeConnectAttempt(device, { probeReasons: false });
    obs.markConnectStart();
    helper.emit('PropertiesChanged', { Connected: true });
    expect(obs.view().linkUp).toBe(true);
  });

  it('ignores the other properties BlueZ sends', async () => {
    const { device, helper } = makeDevice();
    const obs = await observeConnectAttempt(device, { probeReasons: false });
    obs.markConnectStart();
    helper.emit('PropertiesChanged', { RSSI: { signature: 'n', value: -60 } });
    helper.emit('PropertiesChanged', { ServicesResolved: { signature: 'b', value: true } });
    expect(obs.view().linkUp).toBe(false);
  });

  it('reads nothing into a Connected=false that comes before any true', async () => {
    const { device, helper } = makeDevice();
    const obs = await observeConnectAttempt(device, { probeReasons: false });
    obs.markConnectStart();
    helper.emit('PropertiesChanged', connected(false));
    obs.markError();
    expect(obs.view()).toMatchObject({ linkUp: false, downAfterErrorMs: undefined });
  });

  it('does not take a Connected=true from before the Connect call as this attempt (#472)', async () => {
    const { device, helper } = makeDevice();
    const obs = await observeConnectAttempt(device, { probeReasons: false });
    helper.emit('PropertiesChanged', connected(true));
    obs.markConnectStart();
    obs.markError();
    expect(obs.view().linkUp).toBe(false);
  });

  it('says the link never came up when Connect is answered from BlueZ state alone (#472)', async () => {
    // A stuck link: BlueZ answers Connect at once from its own state
    // (dev_connect()) and sends no Connected change at all.
    const { device } = makeDevice();
    const obs = await observeConnectAttempt(device, { probeReasons: false });
    obs.markConnectStart();
    expect(obs.view().linkUp).toBe(false);
  });

  it('measures the connection from the Connect call, not from the probe', async () => {
    let answer: ((v: unknown) => void) | undefined;
    const iface = makeIface(DISCONNECTED);
    const { device, helper } = makeDevice({
      iface,
      getProxyObject: () => new Promise((r) => (answer = r)),
    });
    const pending = observeConnectAttempt(device, { probeReasons: true });
    await vi.advanceTimersByTimeAsync(1500);
    answer?.({ getInterface: () => iface });
    const obs = await pending;
    obs.markConnectStart();
    vi.advanceTimersByTime(300);
    helper.emit('PropertiesChanged', connected(true));
    expect(obs.view().linkUpAfterMs).toBe(300);
  });

  it('keeps the first error time', async () => {
    const { device, helper } = makeDevice();
    const obs = await observeConnectAttempt(device, { probeReasons: false });
    obs.markConnectStart();
    helper.emit('PropertiesChanged', connected(true));
    obs.markError();
    vi.advanceTimersByTime(50);
    obs.markError();
    vi.advanceTimersByTime(45);
    helper.emit('PropertiesChanged', connected(false));
    expect(obs.view().downAfterErrorMs).toBe(95);
  });

  it('takes the reason from Device1.Disconnected, and the end of the connection from it too', async () => {
    const { device, helper, iface } = makeDevice();
    const obs = await observeConnectAttempt(device, { probeReasons: true });
    obs.markConnectStart();
    helper.emit('PropertiesChanged', connected(true));
    obs.markError();
    vi.advanceTimersByTime(90);
    // BlueZ sends the signal before Connected goes false.
    iface.emit(
      'Disconnected',
      'org.bluez.Reason.Authentication',
      'Connection terminated due to authentication failure',
    );
    vi.advanceTimersByTime(5);
    helper.emit('PropertiesChanged', connected(false));
    expect(obs.view()).toMatchObject({
      reasonSupported: true,
      reason: 'org.bluez.Reason.Authentication',
      downAfterErrorMs: 90,
    });
  });

  it('keeps the first reason of the attempt', async () => {
    const { device, helper, iface } = makeDevice();
    const obs = await observeConnectAttempt(device, { probeReasons: true });
    obs.markConnectStart();
    helper.emit('PropertiesChanged', connected(true));
    iface.emit('Disconnected', 'org.bluez.Reason.Authentication', 'x');
    iface.emit('Disconnected', 'org.bluez.Reason.Local', 'y');
    expect(obs.view().reason).toBe('org.bluez.Reason.Authentication');
  });

  it('records a negative gap when the connection went down before the error', async () => {
    const { device, helper } = makeDevice();
    const obs = await observeConnectAttempt(device, { probeReasons: false });
    obs.markConnectStart();
    helper.emit('PropertiesChanged', connected(true));
    vi.advanceTimersByTime(10);
    helper.emit('PropertiesChanged', connected(false));
    vi.advanceTimersByTime(3);
    obs.markError();
    expect(obs.view().downAfterErrorMs).toBe(-3);
  });

  describe('reason probe', () => {
    it('asks the bus nothing without probeReasons', async () => {
      const { device, getProxyObject } = makeDevice();
      const obs = await observeConnectAttempt(device, { probeReasons: false });
      expect(getProxyObject).not.toHaveBeenCalled();
      expect(obs.view().reasonSupported).toBe(false);
    });

    it('introspects the device object on org.bluez', async () => {
      const { device, getProxyObject } = makeDevice();
      await observeConnectAttempt(device, { probeReasons: true });
      expect(getProxyObject).toHaveBeenCalledWith(
        'org.bluez',
        '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF',
      );
    });

    it('subscribes only where BlueZ declares Device1.Disconnected (5.83 and later)', async () => {
      const iface = makeIface([]);
      const on = vi.spyOn(iface, 'on');
      const { device } = makeDevice({ iface });
      const obs = await observeConnectAttempt(device, { probeReasons: true });
      expect(on).not.toHaveBeenCalled();
      expect(obs.view().reasonSupported).toBe(false);
    });

    it('says once per process whether this BlueZ gives reasons', async () => {
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      await observeConnectAttempt(makeDevice({ iface: makeIface([]) }).device, {
        probeReasons: true,
      });
      await observeConnectAttempt(makeDevice({ iface: makeIface([]) }).device, {
        probeReasons: true,
      });
      const lines = debug.mock.calls.filter((c) => String(c[0]).includes('Device1.Disconnected'));
      expect(lines).toHaveLength(1);
      expect(String(lines[0][0])).toContain('needs BlueZ 5.83');
    });

    it('goes ahead without reasons when introspection does not answer in time', async () => {
      const iface = makeIface(DISCONNECTED);
      let answer: ((v: unknown) => void) | undefined;
      const on = vi.spyOn(iface, 'on');
      const { device } = makeDevice({
        iface,
        getProxyObject: () => new Promise((r) => (answer = r)),
      });
      const pending = observeConnectAttempt(device, { probeReasons: true });
      await vi.advanceTimersByTimeAsync(REASON_PROBE_TIMEOUT_MS);
      const obs = await pending;
      expect(obs.view().reasonSupported).toBe(false);
      // A late answer must not add a listener, which is what holds a match rule.
      answer?.({ getInterface: () => iface });
      await vi.advanceTimersByTimeAsync(0);
      expect(on).not.toHaveBeenCalled();
    });

    it('goes ahead at once when the probe fails, as on a replaced D-Bus connection', async () => {
      const { device } = makeDevice({
        getProxyObject: async () => {
          throw Object.assign(new Error('The D-Bus connection closed'), {
            type: 'org.freedesktop.DBus.Error.Disconnected',
          });
        },
      });
      const obs = await observeConnectAttempt(device, { probeReasons: true });
      expect(obs.view().reasonSupported).toBe(false);
    });

    it('goes ahead when the object does not export Device1 (#297)', async () => {
      const { device } = makeDevice({
        getProxyObject: async () => ({
          getInterface: () => {
            throw new Error('interface not found in proxy object: org.bluez.Device1');
          },
        }),
      });
      const obs = await observeConnectAttempt(device, { probeReasons: true });
      expect(obs.view().reasonSupported).toBe(false);
    });

    it('stops waiting for the probe on a shutdown', async () => {
      const { device } = makeDevice({ getProxyObject: () => new Promise(() => {}) });
      const ac = new AbortController();
      const pending = observeConnectAttempt(device, {
        probeReasons: true,
        abortSignal: ac.signal,
      });
      ac.abort();
      const obs = await pending;
      expect(obs.view().reasonSupported).toBe(false);
      // No deadline timer left to hold the event loop open after the shutdown.
      expect(vi.getTimerCount()).toBe(0);
    });

    it('works on a device with no bus or no helper at all', async () => {
      const a = await observeConnectAttempt(makeDevice({ noBus: true }).device, {
        probeReasons: true,
      });
      const b = await observeConnectAttempt({} as Device, { probeReasons: true });
      expect(a.view().linkUp).toBe(false);
      expect(b.view().linkUp).toBe(false);
      expect(() => b.stop()).not.toThrow();
    });
  });

  describe('settle', () => {
    it('resolves at once when the connection never came up', async () => {
      const { device } = makeDevice();
      const obs = await observeConnectAttempt(device, { probeReasons: false });
      obs.markConnectStart();
      let done = false;
      void obs.settle(1500).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
    });

    it('resolves when the connection goes down', async () => {
      const { device, helper } = makeDevice();
      const obs = await observeConnectAttempt(device, { probeReasons: false });
      obs.markConnectStart();
      helper.emit('PropertiesChanged', connected(true));
      obs.markError();
      let done = false;
      void obs.settle(1500).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(95);
      expect(done).toBe(false);
      helper.emit('PropertiesChanged', connected(false));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(obs.view().downAfterErrorMs).toBe(95);
    });

    it('gives up after maxMs', async () => {
      const { device, helper } = makeDevice();
      const obs = await observeConnectAttempt(device, { probeReasons: false });
      obs.markConnectStart();
      helper.emit('PropertiesChanged', connected(true));
      let done = false;
      void obs.settle(1500).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(1499);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    });

    it('ends on a shutdown', async () => {
      const { device, helper } = makeDevice();
      const obs = await observeConnectAttempt(device, { probeReasons: false });
      obs.markConnectStart();
      helper.emit('PropertiesChanged', connected(true));
      const ac = new AbortController();
      let done = false;
      void obs.settle(1500, ac.signal).then(() => (done = true));
      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
    });
  });

  describe('stop', () => {
    it('takes both listeners off, and a second stop is harmless', async () => {
      const { device, helper, iface } = makeDevice();
      const obs = await observeConnectAttempt(device, { probeReasons: true });
      expect(helper.listenerCount('PropertiesChanged')).toBe(1);
      expect(iface.listenerCount('Disconnected')).toBe(1);
      obs.stop();
      obs.stop();
      expect(helper.listenerCount('PropertiesChanged')).toBe(0);
      expect(iface.listenerCount('Disconnected')).toBe(0);
    });
  });
});
