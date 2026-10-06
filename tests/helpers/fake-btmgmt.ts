/**
 * A stand-in for the `btmgmt` binary behind a mocked node:child_process
 * execFile, modelled on bluez client/mgmt.c and the kernel's set_privacy:
 *
 * - `info` prints the supported and current settings lines, as the #417
 *   reporter's adapter did.
 * - `privacy on <irk>` is REJECTED while the adapter is powered, and the
 *   rejection is printed in ANSI red on stdout with exit status 0, because
 *   setting_rsp quits with EXIT_SUCCESS either way.
 *
 * Every call is recorded as its argv joined with spaces.
 */

export const RED = '\x1b[0;91m';
export const COLOR_OFF = '\x1b[0m';

export interface FakeController {
  index: number;
  address: string;
  powered: boolean;
  privacy: boolean;
  irk: string | undefined;
  supportsPrivacy: boolean;
  /**
   * `ll-privacy` in the current settings, independent of `privacy`: a token
   * that a substring match would mistake for privacy being on.
   */
  llPrivacy: boolean;
  /** `power off` prints an error and changes nothing (no CAP_NET_ADMIN, say). */
  powerOffFails: boolean;
  /** `power on` prints an error and changes nothing. */
  powerOnFails: boolean;
  /** `info` prints an error and no settings, whatever the adapter is doing. */
  infoFails: boolean;
  /** Make execFile itself fail the privacy command, the way Node reports it. */
  privacyExecError: boolean;
  /** Exit 0 with a red error line that repeats the key, which real btmgmt does not do. */
  privacyEchoesIrk: boolean;
  calls: string[][];
}

export function makeController(overrides: Partial<FakeController> = {}): FakeController {
  return {
    index: 0,
    address: 'DC:A6:32:00:11:22',
    powered: true,
    privacy: false,
    irk: undefined,
    supportsPrivacy: true,
    llPrivacy: false,
    powerOffFails: false,
    powerOnFails: false,
    infoFails: false,
    privacyExecError: false,
    privacyEchoesIrk: false,
    calls: [],
    ...overrides,
  };
}

function settings(c: FakeController): string {
  return [
    c.powered ? 'powered' : '',
    'ssp br/edr le secure-conn',
    c.privacy ? 'privacy' : '',
    c.llPrivacy ? 'll-privacy' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

interface Result {
  err: (Error & Record<string, unknown>) | null;
  stdout: string;
}

export function runFakeBtmgmt(c: FakeController, args: string[]): Result {
  c.calls.push(args);
  const idx = args[1];
  const cmd = args[2];
  const ok = (stdout: string): Result => ({ err: null, stdout });
  if (cmd === 'info') {
    if (c.infoFails) {
      return ok(`${RED}Reading hci${idx} info failed with status 0x03 (Failed)${COLOR_OFF}\n`);
    }
    const supported = `powered connectable bondable ssp br/edr le advertising secure-conn${
      c.supportsPrivacy ? ' privacy' : ''
    } ll-privacy configuration static-addr`;
    return ok(
      `hci${idx}:\tPrimary controller\n` +
        `\taddr ${c.address} version 9 manufacturer 305 class 0x6c0000\n` +
        `\tsupported settings: ${supported} \n` +
        `\tcurrent settings: ${settings(c)} \n` +
        `\tname host\n\tshort name \n`,
    );
  }
  if (cmd === 'power') {
    if (args[3] === 'off' && c.powerOffFails) {
      return ok(
        `${RED}Set Powered for hci${idx} failed with status 0x14 (Permission Denied)${COLOR_OFF}\n`,
      );
    }
    if (args[3] === 'on' && c.powerOnFails) {
      return ok(`${RED}Set Powered for hci${idx} failed with status 0x03 (Failed)${COLOR_OFF}\n`);
    }
    c.powered = args[3] === 'on';
    return ok(`hci${idx} Set Powered complete, settings: ${settings(c)} \n`);
  }
  if (cmd === 'privacy') {
    const irk = args[4];
    if (c.privacyExecError) {
      // What Node hands back for a failing command: the whole argv, IRK
      // included, in .message and .cmd.
      const line = `btmgmt ${args.join(' ')}`;
      const err = Object.assign(new Error(`Command failed: ${line}\n`), { code: 1, cmd: line });
      return { err, stdout: `echo ${irk}\n` };
    }
    if (c.privacyEchoesIrk) {
      return ok(`${RED}Set Privacy for hci${idx} failed: key ${irk.toUpperCase()}${COLOR_OFF}\n`);
    }
    if (c.powered) {
      return ok(`${RED}Set Privacy for hci${idx} failed with status 0x0b (Rejected)${COLOR_OFF}\n`);
    }
    c.privacy = args[3] === 'on';
    c.irk = c.privacy ? irk : undefined;
    return ok(`hci${idx} Set Privacy complete, settings: ${settings(c)} \n`);
  }
  return ok('');
}

/** An execFile replacement that answers from the fake controller on a microtask. */
export function fakeExecFile(c: () => FakeController) {
  return (
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    const r = runFakeBtmgmt(c(), args);
    queueMicrotask(() => cb(r.err, r.stdout, ''));
  };
}
