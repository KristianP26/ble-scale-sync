import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeController, fakeExecFile, type FakeController } from '../helpers/fake-btmgmt.js';

/**
 * resetAdapterBtmgmt reported every power-cycle as done, because btmgmt exits 0
 * when the kernel refuses the command (setting_rsp in bluez client/mgmt.c). On
 * a host without CAP_NET_ADMIN, the maintainer's Pi among them, the btmgmt
 * recovery tier then counted as a success and reset the D-Bus connection for
 * nothing, and the preemptive reset after each session logged a power-cycle
 * that never happened.
 */

let ctl: FakeController = makeController();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (fakeExecFile(() => ctl) as (...a: unknown[]) => void)(...args),
}));

const { resetAdapterBtmgmt, _resetBtmgmtResetStateForTests, bleLog } =
  await import('../../src/ble/types.js');

const ORIG_PLATFORM = process.platform;
const setPlatform = (p: string): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
};

const logged: string[] = [];

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; !done && i < 100; i++) await vi.advanceTimersByTimeAsync(250);
  return p;
}

const commands = (): string[] => ctl.calls.map((a) => a.slice(2).join(' '));

beforeEach(() => {
  ctl = makeController();
  logged.length = 0;
  _resetBtmgmtResetStateForTests();
  setPlatform('linux');
  vi.useFakeTimers();
  for (const level of ['debug', 'info', 'warn'] as const) {
    vi.spyOn(bleLog, level).mockImplementation((msg: string) => {
      logged.push(`${level}: ${msg}`);
    });
  }
});

afterEach(() => {
  setPlatform(ORIG_PLATFORM);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resetAdapterBtmgmt', () => {
  it('reports false when the kernel refuses the power-off', async () => {
    ctl.powerOffFails = true;

    await expect(settle(resetAdapterBtmgmt(0))).resolves.toBe(false);

    expect(ctl.powered).toBe(true);
    // Nothing to undo, so no power on either.
    expect(commands()).not.toContain('power on');
    expect(logged.some((l) => l.startsWith('info: ') && /Permission Denied/.test(l))).toBe(true);
  });

  it('says so at info once per process, then at debug', async () => {
    ctl.powerOffFails = true;
    await settle(resetAdapterBtmgmt(0));
    await settle(resetAdapterBtmgmt(0));

    expect(logged.filter((l) => l.startsWith('info: '))).toHaveLength(1);
    expect(
      logged.filter((l) => l.startsWith('debug: ') && /could not power-cycle/.test(l)),
    ).toHaveLength(1);
  });

  it('reports true when the adapter really went down and came back', async () => {
    await expect(settle(resetAdapterBtmgmt(1))).resolves.toBe(true);

    expect(commands()).toEqual(['power off', 'info', 'power on', 'info']);
    expect(ctl.calls.every((a) => a[0] === '--index' && a[1] === '1')).toBe(true);
    expect(ctl.powered).toBe(true);
  });

  it('reports false and warns when the adapter does not come back on', async () => {
    ctl.powerOnFails = true;

    await expect(settle(resetAdapterBtmgmt(0))).resolves.toBe(false);

    expect(ctl.powered).toBe(false);
    expect(
      logged.some((l) => l.startsWith('warn: ') && /power on for hci0 did not take/.test(l)),
    ).toBe(true);
  });

  it('goes on to the power-on when info cannot be read after a clean power-off', async () => {
    // Only the printed result is left as evidence then, and it says the
    // power-off went through. Stopping there would leave the adapter off.
    ctl.infoFails = true;

    await expect(settle(resetAdapterBtmgmt(0))).resolves.toBe(true);

    expect(commands()).toEqual(['power off', 'info', 'power on', 'info']);
    expect(ctl.powered).toBe(true);
  });

  it('powers on an adapter that was already off', async () => {
    // The noble path calls this for an adapter that is not powered on.
    ctl.powered = false;

    await expect(settle(resetAdapterBtmgmt(0))).resolves.toBe(true);

    expect(ctl.powered).toBe(true);
  });
});
