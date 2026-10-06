// LE privacy on the host adapter, for scales that keep a bond only from a peer
// that handed over an identity key (`ble.adapter_privacy`, #417).
//
// A BF915 drops the bond BlueZ made the moment the link goes down, and keeps
// the one an iPhone made across any number of sleeps. The one difference in the
// two pairings is identity distribution: the phone sends its IRK and identity
// address, Linux sends nothing. The kernel adds IdKey to its own key
// distribution only while the adapter has privacy enabled (HCI_PRIVACY in
// net/bluetooth/smp.c), and that is off by default. With privacy on, the
// reporter's next reconnects all reused the stored LTK, also after the scale had
// slept, and none ended in `PIN or Key Missing`.
//
// Privacy needs an IRK, and a scale that stored one IRK cannot resolve an
// address made from another, so the key must be the same on every start. It is
// derived from the adapter's own address rather than stored: a file next to the
// config is lost with a re-created container or a reinstalled add-on, and the
// result would be a silent re-pair. The cost is that anyone who knows the
// adapter address can resolve its random addresses, so this is bond
// compatibility, not privacy. An IRK cannot be used to impersonate the host;
// that needs the LTK.
//
// The IRK is passed to btmgmt on its command line and is therefore in argv. It
// must never reach a log line or an error: Node's execFile errors carry the full
// command in `.message` and `.cmd`, so those are never read, let alone
// rethrown. Only a fingerprint is ever printed.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bleLog, sleep } from '../types.js';
import { stripAnsi, parseBtmgmtSettings, btmgmtErrorLine, type BtmgmtSettings } from '../btmgmt.js';
import { tagBleFailure } from '../failure-kind.js';
import { helperOf, type Adapter } from './dbus.js';

/** Bumping the version changes every derived IRK and breaks every bond made with one. */
const IRK_DERIVATION_PREFIX = 'ble-scale-sync adapter IRK v1:';

const BTMGMT_TIMEOUT_MS = 5_000;

/** Same settle time resetAdapterBtmgmt gives bluetoothd after a power-on. */
const POST_POWER_ON_SETTLE_MS = 2_000;

/** A failed apply power-cycles the adapter, so it is not repeated every cycle. */
export const PRIVACY_RETRY_INTERVAL_MS = 10 * 60_000;

const MAIN_CONF = '/etc/bluetooth/main.conf';

interface PrivacyTarget {
  index: number;
  irk: string;
  fingerprint: string;
}

export interface PrivacyOutcome {
  /** Privacy is in the adapter's current settings after this call. */
  active: boolean;
  /** btmgmt powered the adapter off and on, so BlueZ state taken before is stale. */
  powerCycled: boolean;
}

/** Last adapter the cycle resolved, for the recovery tier that restarts bluetoothd. */
let target: PrivacyTarget | undefined;
/** `index:fingerprint` pairs this process has set itself. */
const appliedThisProcess = new Set<string>();
const unsupportedIndexes = new Set<number>();
const lastApplyFailureAt = new Map<number, number>();
const warned = new Set<string>();
let mainConfChecked = false;

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) {
    bleLog.debug(message);
    return;
  }
  warned.add(key);
  bleLog.warn(message);
}

/** Test seam: the module keeps per-process state on purpose. */
export function _resetAdapterPrivacyStateForTests(): void {
  target = undefined;
  appliedThisProcess.clear();
  unsupportedIndexes.clear();
  lastApplyFailureAt.clear();
  warned.clear();
  mainConfChecked = false;
}

const IRK_RE = /^[0-9a-f]{32}$/;

function isUsableIrk(irk: string): boolean {
  return IRK_RE.test(irk) && !/^0+$/.test(irk);
}

/**
 * The IRK for one adapter: the first 16 bytes of
 * sha256(prefix + address as uppercase with colons), as 32 lowercase hex.
 *
 * Returns undefined for anything that is not a usable BD_ADDR, including the
 * all-zero address of a controller that has none.
 */
export function deriveAdapterIrk(address: string): string | undefined {
  const hex = address.replace(/[:-]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(hex) || /^0+$/.test(hex)) return undefined;
  const normalized = hex.toUpperCase().match(/.{2}/g)!.join(':');
  return createHash('sha256')
    .update(IRK_DERIVATION_PREFIX + normalized)
    .digest()
    .subarray(0, 16)
    .toString('hex');
}

/** First 8 hex of sha256 over the IRK bytes. Safe to log, says nothing about the key. */
export function irkFingerprint(irk: string): string {
  return createHash('sha256').update(Buffer.from(irk, 'hex')).digest('hex').slice(0, 8);
}

/**
 * Controller index of a resolved node-ble adapter ('/org/bluez/hci1' -> 1).
 *
 * Taken from the adapter BlueZ actually handed back, not from `ble.adapter`:
 * with that unset node-ble picks the first adapter under /org/bluez, which is
 * not necessarily hci0.
 */
export function adapterIndexOf(adapter: Adapter): number | undefined {
  let path: unknown;
  try {
    path = helperOf(adapter)?.object;
  } catch {
    return undefined;
  }
  if (typeof path !== 'string') return undefined;
  const m = /\/hci(\d+)$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

export { stripAnsi, parseBtmgmtSettings, type BtmgmtSettings };

interface BtmgmtRun {
  /** stdout + stderr, ANSI stripped, IRK redacted. */
  out: string;
  /** Why the process itself failed (spawn error, non-zero exit, timeout), never its argv. */
  failure?: string;
}

function redact(s: string, irk: string | undefined): string {
  if (!irk) return s;
  return s.split(irk).join('<irk>').split(irk.toUpperCase()).join('<irk>');
}

/**
 * Run btmgmt and never throw. The exit status means little: btmgmt exits 0 when
 * the kernel rejects a setting (setting_rsp in bluez client/mgmt.c), so callers
 * check the result with a separate `info`.
 */
function runBtmgmt(args: string[], irk?: string): Promise<BtmgmtRun> {
  return new Promise((resolve) => {
    try {
      execFile(
        'btmgmt',
        args,
        { timeout: BTMGMT_TIMEOUT_MS, encoding: 'utf8' },
        (err, stdout, stderr) => {
          const out = redact(stripAnsi(`${stdout ?? ''}${stderr ?? ''}`), irk);
          if (!err) {
            resolve({ out });
            return;
          }
          // NOT err.message or err.cmd: both carry the whole command line.
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          const failure =
            e.code === 'ENOENT'
              ? 'btmgmt not found'
              : e.killed
                ? 'btmgmt timed out'
                : `btmgmt exited with ${String(e.code ?? e.signal ?? 'an error')}`;
          resolve({ out, failure });
        },
      );
    } catch {
      resolve({ out: '', failure: 'btmgmt could not be started' });
    }
  });
}

async function readSettings(index: number): Promise<BtmgmtSettings | undefined> {
  const res = await runBtmgmt(['--index', String(index), 'info']);
  const settings = parseBtmgmtSettings(res.out);
  if (!settings) {
    bleLog.debug(
      `btmgmt info for hci${index} had no settings: ${res.failure ?? btmgmtErrorLine(res.out) ?? 'empty output'}`,
    );
  }
  return settings;
}

/**
 * bluetoothd sets its own privacy from main.conf whenever it starts, with its
 * own IRK, and ours replaces it on our first cycle. Running both means the key
 * the scale stored depends on which one ran last.
 */
async function warnIfMainConfPrivacy(): Promise<void> {
  if (mainConfChecked) return;
  mainConfChecked = true;
  let text: string;
  try {
    text = await readFile(MAIN_CONF, 'utf8');
  } catch {
    return;
  }
  const m = /^\s*Privacy\s*=\s*(\S+)/m.exec(text);
  if (m && m[1].toLowerCase() !== 'off') {
    bleLog.warn(
      `${MAIN_CONF} sets Privacy = ${m[1]}, and ble.adapter_privacy replaces bluetoothd's ` +
        'IRK with its own. Use one or the other: a scale bonded under one key cannot resolve ' +
        'the address the other produces.',
    );
  }
}

async function resolveTarget(adapter: Adapter): Promise<PrivacyTarget | undefined> {
  const index = adapterIndexOf(adapter);
  if (index === undefined) {
    warnOnce(
      'no-index',
      'ble.adapter_privacy: could not tell which hciN the BlueZ adapter is, so every connect ' +
        'to the scale is skipped until LE privacy can be checked.',
    );
    return undefined;
  }
  let address: unknown;
  try {
    address = await adapter.getAddress();
  } catch {
    address = undefined;
  }
  const irk = typeof address === 'string' ? deriveAdapterIrk(address) : undefined;
  if (!irk || !isUsableIrk(irk)) {
    warnOnce(
      `no-address:${index}`,
      `ble.adapter_privacy: hci${index} reported no usable Bluetooth address; LE privacy not applied.`,
    );
    return undefined;
  }
  const fingerprint = irkFingerprint(irk);
  if (!warned.has(`identity:${index}:${fingerprint}`)) {
    warned.add(`identity:${index}:${fingerprint}`);
    bleLog.info(
      `ble.adapter_privacy: hci${index} uses an IRK derived from its address (fingerprint ${fingerprint}).`,
    );
  }
  return { index, irk, fingerprint };
}

/** power off, `privacy on <irk>`, power on (always), then read back what took. */
async function applyPrivacy(t: PrivacyTarget): Promise<PrivacyOutcome> {
  // Never handed to btmgmt unchecked: with no IRK argument btmgmt reads a random
  // one from /dev/urandom, and a short one is zero-padded by its hex parser.
  if (!isUsableIrk(t.irk)) return { active: false, powerCycled: false };
  const idx = String(t.index);
  bleLog.info(`Enabling LE privacy on hci${idx} (power off, privacy on, power on)...`);
  let privacyError: string | undefined;
  const off = await runBtmgmt(['--index', idx, 'power', 'off']);
  try {
    const priv = await runBtmgmt(['--index', idx, 'privacy', 'on', t.irk], t.irk);
    privacyError = priv.failure ?? btmgmtErrorLine(priv.out);
  } finally {
    // Unconditionally, even if the steps above went wrong: an adapter left
    // powered off takes the scale and every other BLE device on it down too.
    const on = await runBtmgmt(['--index', idx, 'power', 'on']);
    const onError = on.failure ?? btmgmtErrorLine(on.out);
    if (onError) bleLog.warn(`btmgmt power on for hci${idx} reported: ${onError}`);
  }
  await sleep(POST_POWER_ON_SETTLE_MS);
  const after = await readSettings(t.index);
  const active = after?.current.includes('privacy') === true;
  if (after && !after.current.includes('powered')) {
    bleLog.warn(`hci${idx} is not powered on after enabling LE privacy.`);
  }
  if (!active) {
    // A failed power-off first: the privacy command is then only rejected
    // because the adapter is still powered, and that "Rejected" hides the cause.
    const why =
      off.failure ?? btmgmtErrorLine(off.out) ?? privacyError ?? 'privacy is not in the settings';
    bleLog.warn(
      `Could not enable LE privacy on hci${idx}: ${why}. btmgmt needs root or CAP_NET_ADMIN. ` +
        `Next attempt in ${PRIVACY_RETRY_INTERVAL_MS / 60_000} min.`,
    );
  }
  return { active, powerCycled: true };
}

async function ensureFor(t: PrivacyTarget, abortSignal?: AbortSignal): Promise<PrivacyOutcome> {
  const idle: PrivacyOutcome = { active: false, powerCycled: false };
  if (unsupportedIndexes.has(t.index)) return idle;
  const settings = await readSettings(t.index);
  if (!settings) {
    warnOnce(
      `no-info:${t.index}`,
      `ble.adapter_privacy: btmgmt could not read hci${t.index}, so every connect to the ` +
        'scale is skipped until LE privacy can be checked. Is btmgmt installed, and does the ' +
        'process have CAP_NET_ADMIN?',
    );
    return idle;
  }
  if (!settings.supported.includes('privacy')) {
    unsupportedIndexes.add(t.index);
    // Not "ignored": requireAdapterPrivacy still refuses every connect, which
    // is the point of the option, so the user has to make the choice.
    bleLog.warn(
      `ble.adapter_privacy: hci${t.index} does not support LE privacy, so every connect to ` +
        'the scale is skipped while the option is on. Turn ble.adapter_privacy off, or pick ' +
        'an adapter that supports it with ble.adapter.',
    );
    return idle;
  }
  const key = `${t.index}:${t.fingerprint}`;
  const on = settings.current.includes('privacy');
  // The first cycle of the process applies even when privacy is already on:
  // whoever turned it on may have used another IRK, and the kernel cannot be
  // asked which one it holds.
  if (on && appliedThisProcess.has(key)) return { active: true, powerCycled: false };
  const failedAt = lastApplyFailureAt.get(t.index);
  if (failedAt !== undefined && Date.now() - failedAt < PRIVACY_RETRY_INTERVAL_MS) {
    bleLog.debug(`LE privacy on hci${t.index} failed recently; not retrying yet`);
    return { active: on, powerCycled: false };
  }
  if (abortSignal?.aborted) return { active: on, powerCycled: false };
  const outcome = await applyPrivacy(t);
  if (outcome.active) {
    appliedThisProcess.add(key);
    lastApplyFailureAt.delete(t.index);
    bleLog.info(`LE privacy is on for hci${t.index} (IRK fingerprint ${t.fingerprint}).`);
  } else {
    lastApplyFailureAt.set(t.index, Date.now());
  }
  return outcome;
}

/**
 * Make sure LE privacy is on with the derived IRK, at the start of a cycle.
 *
 * Applies on the first call of the process and whenever privacy is missing from
 * the current settings; otherwise it is one `btmgmt info`. The flag and the IRK
 * survive a btmgmt or rfkill power-cycle (HCI_PRIVACY is not a volatile flag),
 * so the reset paths do not need to re-apply it.
 */
export async function ensureAdapterPrivacy(
  adapter: Adapter,
  abortSignal?: AbortSignal,
): Promise<PrivacyOutcome> {
  if (process.platform !== 'linux') return { active: false, powerCycled: false };
  const t = await resolveTarget(adapter);
  if (!t) return { active: false, powerCycled: false };
  target = t;
  await warnIfMainConfPrivacy();
  return ensureFor(t, abortSignal);
}

/**
 * After the recovery tier restarts bluetoothd. bluetoothd applies main.conf's
 * Privacy (off by default) when it starts, which clears ours if the adapter is
 * unpowered at that moment; when it is powered the kernel rejects the change
 * and ours stays. Either way one `info` tells. No-op unless a cycle with
 * `ble.adapter_privacy` has run in this process.
 */
export async function reensureAdapterPrivacy(): Promise<void> {
  if (process.platform !== 'linux' || !target) return;
  await ensureFor(target);
}

/**
 * The last check before a connect, never throttled. A pairing made without
 * privacy carries no host IdKey, which is exactly the bond the scale throws
 * away, and with `auto_clear_stale_bond` the next failure would replace a good
 * bond with such a one. So the connect is skipped instead.
 *
 * Tagged 'blocked', not 'idle': the scale was found, the radio is fine, and
 * the full discovery timeout has not necessarily elapsed, so the poll loop
 * must back off rather than rescan after idle_rescan_delay.
 */
export async function requireAdapterPrivacy(adapter: Adapter): Promise<void> {
  if (process.platform !== 'linux') return;
  const index = adapterIndexOf(adapter) ?? target?.index;
  const settings = index === undefined ? undefined : await readSettings(index);
  if (settings?.current.includes('privacy')) return;
  const where = index === undefined ? 'the adapter' : `hci${index}`;
  if (!settings) {
    // Unknown, not off: saying "not active" would send the user after the
    // wrong problem when btmgmt is missing or lacks CAP_NET_ADMIN.
    bleLog.warn(
      `ble.adapter_privacy is on, but the LE privacy state of ${where} could not be read ` +
        '(btmgmt missing or failed). Skipping the connect so the scale is not paired without ' +
        'the host identity key (#417).',
    );
    throw tagBleFailure(
      new Error(
        `could not read the LE privacy state of ${where} (btmgmt missing or failed); ` +
          'connect skipped (ble.adapter_privacy)',
      ),
      'blocked',
    );
  }
  bleLog.warn(
    `ble.adapter_privacy is on, but LE privacy is not active on ${where}. ` +
      'Skipping the connect so the scale is not paired without the host identity key (#417).',
  );
  throw tagBleFailure(
    new Error(`LE privacy is not active on ${where}; connect skipped (ble.adapter_privacy)`),
    'blocked',
  );
}
