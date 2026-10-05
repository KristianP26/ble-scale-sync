import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeController, fakeExecFile, type FakeController } from '../../helpers/fake-btmgmt.js';

/**
 * `ble.adapter_privacy` (#417): LE privacy on the host adapter with an IRK
 * derived from its address, so pairing distributes a host IdKey and a Beurer
 * BF915 keeps the bond.
 *
 * btmgmt is faked behind node:child_process, modelled on bluez client/mgmt.c:
 * a rejected setting prints an ANSI-red line on stdout and still exits 0.
 */

let ctl: FakeController = makeController();
const execFileMock = vi.fn(fakeExecFile(() => ctl));
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => void)(...args),
}));

const {
  deriveAdapterIrk,
  irkFingerprint,
  parseBtmgmtSettings,
  adapterIndexOf,
  ensureAdapterPrivacy,
  reensureAdapterPrivacy,
  requireAdapterPrivacy,
  PRIVACY_RETRY_INTERVAL_MS,
  _resetAdapterPrivacyStateForTests,
} = await import('../../../src/ble/handler-node-ble/privacy.js');
const { bleLog } = await import('../../../src/ble/types.js');
const { bleFailureKind } = await import('../../../src/ble/failure-kind.js');
type Adapter = Parameters<typeof ensureAdapterPrivacy>[0];

const ORIG_PLATFORM = process.platform;
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function adapterFor(c: FakeController, address = c.address): Adapter {
  return {
    helper: { object: `/org/bluez/hci${c.index}` },
    getAddress: async () => address,
  } as unknown as Adapter;
}

/**
 * Run with fake timers: the apply waits for bluetoothd to settle after
 * power-on. The main.conf read is real I/O, so a timer can appear only after a
 * real turn of the event loop; setImmediate stays real for that.
 */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) {
    await vi.advanceTimersByTimeAsync(250);
    await new Promise((r) => setImmediate(r));
  }
  return p;
}

/**
 * The calls so far, with the derived IRK shown as `<irk>`: an exact match on
 * `privacy on <irk>` still proves that key was passed, and a failing
 * assertion does not print it.
 */
const argv = (): string[] => {
  const irk = deriveAdapterIrk(ctl.address)!;
  return ctl.calls.map((a) => a.join(' ').split(irk).join('<irk>'));
};

let logged: string[] = [];

/** The reporter's `btmgmt --index 0 info`, verbatim except the address (#417). */
const REPORTER_INFO =
  'hci0:   Primary controller\n' +
  '        addr DC:A6:32:00:11:22 version 9 manufacturer 305 class 0x6c0000\n' +
  '        supported settings: powered connectable fast-connectable discoverable bondable link-security ssp br/edr le advertising secure-conn debug-keys privacy configuration static-addr phy-configuration\n' +
  '        current settings: powered ssp br/edr le secure-conn\n';

beforeEach(() => {
  setPlatform('linux');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  ctl = makeController({ index: 1 });
  execFileMock.mockClear();
  _resetAdapterPrivacyStateForTests();
  logged = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(bleLog, level).mockImplementation((msg: string) => {
      logged.push(msg);
    });
  }
});

afterEach(() => {
  setPlatform(ORIG_PLATFORM);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parseBtmgmtSettings', () => {
  it("reads the reporter's adapter as supporting privacy with it off", () => {
    const s = parseBtmgmtSettings(REPORTER_INFO);
    expect(s?.supported).toContain('privacy');
    expect(s?.current).not.toContain('privacy');
    expect(s?.current).toContain('powered');
  });

  it('does not take ll-privacy for privacy', () => {
    const s = parseBtmgmtSettings(
      'supported settings: powered ll-privacy\ncurrent settings: powered ll-privacy\n',
    );
    expect(s?.supported).not.toContain('privacy');
    expect(s?.current).not.toContain('privacy');
  });

  it('has nothing to report for a failed read printed in red', () => {
    expect(
      parseBtmgmtSettings(
        '\x1b[0;91mReading hci0 info failed with status 0x11 (Invalid Index)\x1b[0m\n',
      ),
    ).toBeUndefined();
  });
});

describe('deriveAdapterIrk', () => {
  it('is 32 lowercase hex, the same every time for one address', () => {
    const a = deriveAdapterIrk('DC:A6:32:00:11:22');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveAdapterIrk('DC:A6:32:00:11:22')).toBe(a);
    // Spelling of the address does not change the key.
    expect(deriveAdapterIrk('dca632001122')).toBe(a);
    expect(deriveAdapterIrk('dc-a6-32-00-11-22')).toBe(a);
  });

  it('differs between adapters', () => {
    expect(deriveAdapterIrk('DC:A6:32:00:11:22')).not.toBe(deriveAdapterIrk('DC:A6:32:00:11:23'));
  });

  it('refuses an address that is not one', () => {
    expect(deriveAdapterIrk('00:00:00:00:00:00')).toBeUndefined();
    expect(deriveAdapterIrk('not an address')).toBeUndefined();
    expect(deriveAdapterIrk('')).toBeUndefined();
  });

  it('has a fingerprint that is not a piece of the key', () => {
    const irk = deriveAdapterIrk('DC:A6:32:00:11:22')!;
    const fp = irkFingerprint(irk);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(irk).not.toContain(fp);
  });
});

describe('adapterIndexOf', () => {
  it('takes the index from the D-Bus path of the resolved adapter', () => {
    expect(adapterIndexOf(adapterFor(makeController({ index: 1 })))).toBe(1);
    expect(adapterIndexOf({ helper: { object: '/org/bluez/hci12' } } as unknown as Adapter)).toBe(
      12,
    );
    expect(adapterIndexOf({} as unknown as Adapter)).toBeUndefined();
  });
});

describe('ensureAdapterPrivacy', () => {
  it('on the first cycle powers off, sets privacy with the derived IRK, powers on and reads it back', async () => {
    const irk = deriveAdapterIrk(ctl.address)!;
    const out = await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(argv()).toEqual([
      '--index 1 info',
      '--index 1 power off',
      '--index 1 privacy on <irk>',
      '--index 1 power on',
      '--index 1 info',
    ]);
    expect(out).toEqual({ active: true, powerCycled: true });
    expect(ctl.irk === irk).toBe(true);
    expect(ctl.powered).toBe(true);
  });

  it('applies on the first cycle even when privacy is already on, since the IRK may be someone else', async () => {
    ctl.privacy = true;
    ctl.irk = '0123456789abcdef0123456789abcdef';
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(ctl.irk === deriveAdapterIrk(ctl.address)).toBe(true);
  });

  it('only reads the settings on later cycles while privacy holds', async () => {
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    ctl.calls = [];
    const out = await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(argv()).toEqual(['--index 1 info']);
    expect(out).toEqual({ active: true, powerCycled: false });
  });

  it('applies again when privacy went missing between cycles', async () => {
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    ctl.privacy = false;
    ctl.calls = [];
    const out = await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(argv()).toContain('--index 1 power off');
    expect(out.active).toBe(true);
  });

  it('treats a red error with exit status 0 as a failure, and still powers the adapter on', async () => {
    ctl.powerOffFails = true;
    const out = await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(out).toEqual({ active: false, powerCycled: true });
    expect(argv()).toContain('--index 1 power on');
    expect(ctl.privacy).toBe(false);
    expect(logged.some((l) => /Could not enable LE privacy on hci1/.test(l))).toBe(true);
  });

  it('names the failed power-off as the reason, not the Rejected it causes', async () => {
    // With the adapter still powered the privacy command is rejected too, but
    // that is a symptom; the permission error is what the user can fix.
    ctl.powerOffFails = true;
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    const warning = logged.find((l) => /Could not enable LE privacy on hci1/.test(l)) ?? '';
    expect(warning).toMatch(/Set Powered for hci1 failed .*Permission Denied/);
    expect(warning).not.toMatch(/Rejected/);
    // btmgmt printed it in red; the colour codes stay out of the log line.
    expect(warning).not.toContain('\x1b');
  });

  it('does not power-cycle again for ten minutes after a failed apply', async () => {
    ctl.powerOffFails = true;
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    ctl.calls = [];
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(argv()).toEqual(['--index 1 info']);

    vi.advanceTimersByTime(PRIVACY_RETRY_INTERVAL_MS);
    ctl.calls = [];
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(argv()).toContain('--index 1 power off');
  });

  it('never runs btmgmt privacy without a usable IRK', async () => {
    const out = await settle(ensureAdapterPrivacy(adapterFor(ctl, '00:00:00:00:00:00')));
    expect(out.active).toBe(false);
    expect(ctl.calls.some((a) => a[2] === 'privacy')).toBe(false);
    expect(ctl.calls.some((a) => a[2] === 'power')).toBe(false);
  });

  it('leaves an adapter without LE privacy support alone', async () => {
    ctl.supportsPrivacy = false;
    const out = await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(out).toEqual({ active: false, powerCycled: false });
    expect(argv()).toEqual(['--index 1 info']);
  });

  it('says every connect is skipped on such an adapter, since requireAdapterPrivacy still refuses', async () => {
    ctl.supportsPrivacy = false;
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    const warning = logged.find((l) => /does not support LE privacy/.test(l)) ?? '';
    expect(warning).toMatch(/every connect to the scale is skipped/);
    expect(warning).toMatch(/with ble\.adapter\b/);
    expect(warning).not.toMatch(/ignored/);
    await expect(settle(requireAdapterPrivacy(adapterFor(ctl)))).rejects.toThrow(/not active/);
  });

  it('applies again when only ll-privacy is left in the current settings', async () => {
    // ll-privacy is address resolution in the controller, a different setting:
    // a substring match would read it as privacy still on and skip the apply.
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    ctl.privacy = false;
    ctl.llPrivacy = true;
    ctl.calls = [];
    const out = await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(argv()).toContain('--index 1 power off');
    expect(out).toEqual({ active: true, powerCycled: true });
  });

  it('runs nothing off Linux', async () => {
    setPlatform('win32');
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('never logs the IRK, not even when execFile fails with it in .message and .cmd', async () => {
    const irk = deriveAdapterIrk(ctl.address)!;
    ctl.privacyExecError = true;
    const out = await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(out.active).toBe(false);
    // The fake did put it in the error, so this is not vacuous.
    expect(ctl.calls.some((a) => a.includes(irk))).toBe(true);
    expect(logged.length).toBeGreaterThan(0);
    // Booleans, not toContain: a failing assertion would print the key.
    expect(logged.some((l) => l.toLowerCase().includes(irk))).toBe(false);
    expect(logged.join('\n')).toContain(irkFingerprint(irk));
  });

  it('redacts the IRK from btmgmt output that repeats it', async () => {
    const irk = deriveAdapterIrk(ctl.address)!;
    ctl.privacyEchoesIrk = true;
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    expect(logged.some((l) => /Could not enable LE privacy on hci1: .*<irk>/.test(l))).toBe(true);
    expect(logged.some((l) => l.toLowerCase().includes(irk))).toBe(false);
  });
});

describe('requireAdapterPrivacy (right before connect)', () => {
  it('lets the connect go ahead when privacy is on', async () => {
    ctl.privacy = true;
    await expect(settle(requireAdapterPrivacy(adapterFor(ctl)))).resolves.toBeUndefined();
    expect(argv()).toEqual(['--index 1 info']);
  });

  it('refuses the connect when privacy is off, as a blocked cycle, without the IRK in the error', async () => {
    const irk = deriveAdapterIrk(ctl.address)!;
    const err = await settle(requireAdapterPrivacy(adapterFor(ctl))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/LE privacy is not active on hci1/);
    expect((err as Error).message.toLowerCase().includes(irk)).toBe(false);
    expect(String((err as { cmd?: string }).cmd ?? '').includes(irk)).toBe(false);
    expect(
      String((err as Error).stack)
        .toLowerCase()
        .includes(irk),
    ).toBe(false);
    // Not 'idle': that kind promises the full discovery timeout elapsed, and
    // gets the short idle rescan delay for it.
    expect(bleFailureKind(err)).toBe('blocked');
    expect(logged.some((l) => /Skipping the connect/.test(l))).toBe(true);
  });

  it('says the state is unknown, not off, when btmgmt cannot be run', async () => {
    execFileMock.mockImplementationOnce(((
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const err = Object.assign(new Error('spawn btmgmt ENOENT'), { code: 'ENOENT' });
      queueMicrotask(() => cb(err, '', ''));
    }) as never);
    const err = await settle(requireAdapterPrivacy(adapterFor(ctl))).catch((e: unknown) => e);
    expect(bleFailureKind(err)).toBe('blocked');
    expect((err as Error).message).toBe(
      'could not read the LE privacy state of hci1 (btmgmt missing or failed); ' +
        'connect skipped (ble.adapter_privacy)',
    );
    expect(logged.some((l) => /not active/.test(l))).toBe(false);
    expect(logged.some((l) => /could not be read .*Skipping the connect/.test(l))).toBe(true);
  });

  it('refuses the connect when only ll-privacy is on', async () => {
    ctl.llPrivacy = true;
    await expect(settle(requireAdapterPrivacy(adapterFor(ctl)))).rejects.toThrow(/not active/);
  });

  it('is not throttled by an earlier failed apply', async () => {
    ctl.powerOffFails = true;
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    ctl.calls = [];
    await expect(settle(requireAdapterPrivacy(adapterFor(ctl)))).rejects.toThrow(/not active/);
    expect(argv()).toEqual(['--index 1 info']);
  });
});

describe('reensureAdapterPrivacy (after the bluetoothd restart tier)', () => {
  it('does nothing before a cycle with the option has run', async () => {
    await settle(reensureAdapterPrivacy());
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('puts privacy back when bluetoothd cleared it', async () => {
    await settle(ensureAdapterPrivacy(adapterFor(ctl)));
    // bluetoothd starting on an unpowered adapter applies main.conf's default
    // Privacy=off, which clears the flag and the IRK.
    ctl.privacy = false;
    ctl.irk = undefined;
    await settle(reensureAdapterPrivacy());
    expect(ctl.privacy).toBe(true);
    expect(ctl.irk === deriveAdapterIrk(ctl.address)).toBe(true);
  });
});
