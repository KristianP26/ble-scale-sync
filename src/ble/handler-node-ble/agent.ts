// BlueZ pairing agent (org.bluez.Agent1) for scales that mandate an encrypted
// link before their CCCDs can be enabled (#168, Beurer BF720).
//
// node-ble's device.pair() drives BlueZ's pairing, but BlueZ needs a registered
// agent to complete it: with no agent it cannot finish even a Just-Works pairing,
// and it cannot supply a passkey if the scale demands Passkey Entry. The reporter's
// HA add-on container has no system agent, so pairing failed with "Authentication
// Failed". We register our own runtime agent with capability KeyboardDisplay (the
// most flexible: covers Just Works, numeric comparison, and Passkey Entry).
//
// The BF720 HCI snoop showed the phone reusing a stored bond (LE Start Encryption
// with a stored LTK, no fresh SMP pairing in the capture), so the original pairing
// association model is unknown. Every callback logs which method BlueZ invoked so a
// real-hardware retest reveals whether the scale uses Just Works or Passkey Entry,
// and whether beurer_pin is the BLE passkey.

import * as dbusNext from 'dbus-next';
import { bleLog, errMsg } from '../types.js';
import type { MessageBus } from 'dbus-next';

/**
 * `AA:BB:CC:DD:EE:FF` from a BlueZ device path (/org/bluez/hciN/dev_AA_BB_...),
 * or the path itself when it does not look like one.
 */
function macOf(device: string): string {
  const m = /dev_([0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5})$/.exec(device);
  return m ? m[1].replace(/_/g, ':').toUpperCase() : device;
}

/** D-Bus object path our agent is exported at. */
export const AGENT_PATH = '/org/blescalesync/agent';

/**
 * Agent IO capability. KeyboardDisplay is the broadest: it lets BlueZ pick
 * Passkey Entry (we supply beurer_pin via RequestPasskey) or Just Works /
 * numeric comparison (we auto-accept), depending on what the scale negotiates.
 */
export const AGENT_CAPABILITY = 'KeyboardDisplay';

/** Provider for the current consent/pairing PIN (beurer_pin). May change on reload. */
type PinProvider = () => number | undefined;

/** The scale this cycle is pairing with, so unrelated peers cannot use its PIN. */
export interface PairingTarget {
  /** users[0].beurer_pin, or undefined when none is configured. */
  pin?: number;
  /** ble.scale_mac, or undefined in auto-discovery mode. */
  mac?: string;
}

export type PairingTargetProvider = () => PairingTarget;

/**
 * org.bluez.Agent1 implementation. Supplies the configured PIN for Passkey/PIN
 * entry and accepts the confirmation/authorization association models. A missing
 * PIN rejects the passkey request (rather than offering a bogus 0) so BlueZ fails
 * the bond cleanly and the adapter's "set beurer_pin" guard can surface instead.
 */
export class BlueZPairingAgent extends dbusNext.interface.Interface {
  private targetProvider: PairingTargetProvider = () => ({});

  constructor() {
    super('org.bluez.Agent1');
  }

  /** Back-compat shim: a target with no MAC means "no MAC gate". */
  setPinProvider(provider: PinProvider): void {
    this.targetProvider = () => ({ pin: provider() });
  }

  setTargetProvider(provider: PairingTargetProvider): void {
    this.targetProvider = provider;
  }

  /**
   * True when `device` is the configured scale, or when no scale_mac is set
   * (auto-discovery, where we cannot tell). BlueZ paths look like
   * /org/bluez/hciN/dev_AA_BB_CC_DD_EE_FF.
   */
  private isTarget(device: string): boolean {
    const mac = this.targetProvider().mac;
    if (!mac) return true;
    const want = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (want.length !== 12) return true;
    const m = /dev_([0-9A-Fa-f_]+)$/.exec(device);
    if (!m) return true;
    return m[1].replace(/_/g, '').toUpperCase() === want;
  }

  private decline(method: string, device: string): never {
    bleLog.warn(
      `BlueZ pairing agent: ${method} for ${device} is not the configured scale ` +
        '(ble.scale_mac); declining so an unrelated device cannot use the scale PIN.',
    );
    throw new dbusNext.DBusError('org.bluez.Error.Rejected', 'Not the configured scale');
  }

  /**
   * Answer a Passkey Entry / PIN request with the configured beurer_pin.
   *
   * beurer_pin is the four-digit consent code of the scale's user slot. That it
   * is ever the BLE passkey is unproven. A scale that runs Passkey Entry the
   * standard way shows a fresh six-digit code on every attempt (Beurer BF700,
   * #430), which no config value can match, so the messages point at a manual
   * pairing instead of at the config. The PIN itself is never logged.
   */
  private requirePin(method: 'RequestPasskey' | 'RequestPinCode', device: string): number {
    if (!this.isTarget(device)) this.decline(method, device);
    const mac = macOf(device);
    const pin = this.targetProvider().pin;
    if (pin == null) {
      const what = method === 'RequestPasskey' ? 'passkey' : 'PIN code';
      bleLog.warn(
        `BlueZ pairing agent: ${mac} asked for a ${what} and no users[].beurer_pin is set, ` +
          'so pairing was rejected. If the scale shows a code on its display, it is new on ' +
          'every attempt and cannot go in the config: pair once by hand (bluetoothctl, ' +
          `"pair ${mac}", type the code), then restart this app.`,
      );
      throw new dbusNext.DBusError('org.bluez.Error.Rejected', 'No beurer_pin configured');
    }
    bleLog.info(
      `BlueZ pairing agent: answering ${method} for ${mac} with users[].beurer_pin ` +
        '(value not logged). If the scale shows a different code, pairing will fail; ' +
        'pair by hand with bluetoothctl instead.',
    );
    return pin;
  }

  Release(): void {
    bleLog.debug('BlueZ agent: Release');
  }

  RequestPinCode(device: string): string {
    bleLog.debug(`BlueZ agent: RequestPinCode for ${device}`);
    return String(this.requirePin('RequestPinCode', device));
  }

  DisplayPinCode(device: string, pincode: string): void {
    bleLog.debug(`BlueZ agent: DisplayPinCode ${pincode} for ${device}`);
  }

  RequestPasskey(device: string): number {
    bleLog.debug(`BlueZ agent: RequestPasskey for ${device}`);
    return this.requirePin('RequestPasskey', device);
  }

  DisplayPasskey(device: string, passkey: number, entered: number): void {
    // BlueZ-generated, not the user's secret, so safe to log at info.
    bleLog.info(`BlueZ agent: DisplayPasskey ${passkey} (entered ${entered}) for ${device}`);
  }

  /**
   * Logged at info deliberately. This single line is the smoking gun for #83:
   * its presence proves the whole chain fired, its absence proves BlueZ never
   * asked us and the scale stalled for some other reason.
   */
  RequestConfirmation(device: string, passkey: number): void {
    if (!this.isTarget(device)) this.decline('RequestConfirmation', device);
    bleLog.info(`BlueZ agent: RequestConfirmation ${passkey} for ${device} -> accepted`);
  }

  RequestAuthorization(device: string): void {
    if (!this.isTarget(device)) this.decline('RequestAuthorization', device);
    bleLog.debug(`BlueZ agent: RequestAuthorization for ${device} -> accept`);
  }

  AuthorizeService(device: string, uuid: string): void {
    if (!this.isTarget(device)) this.decline('AuthorizeService', device);
    bleLog.debug(`BlueZ agent: AuthorizeService ${uuid} for ${device} -> accept`);
  }

  Cancel(): void {
    bleLog.debug('BlueZ agent: Cancel');
  }
}

BlueZPairingAgent.configureMembers({
  methods: {
    Release: { inSignature: '', outSignature: '' },
    RequestPinCode: { inSignature: 'o', outSignature: 's' },
    DisplayPinCode: { inSignature: 'os', outSignature: '' },
    RequestPasskey: { inSignature: 'o', outSignature: 'u' },
    DisplayPasskey: { inSignature: 'ouq', outSignature: '' },
    RequestConfirmation: { inSignature: 'ou', outSignature: '' },
    RequestAuthorization: { inSignature: 'o', outSignature: '' },
    AuthorizeService: { inSignature: 'os', outSignature: '' },
    Cancel: { inSignature: '', outSignature: '' },
  },
});

// Module-level state: the agent is registered once per D-Bus connection and torn
// down on resetConnection. The instance is reused so its pin provider can be
// refreshed across scan cycles / config reloads.
let agentInstance: BlueZPairingAgent | null = null;
let registered = false;
let defaultAgentClaimed = false;
let defaultAgentUnavailable = false;
/**
 * Application state, not connection state, so forgetPairingAgent() must NOT
 * clear it: resetConnection() also runs mid-cycle and the very next
 * getAdapter() still has to know which scale it is pairing with.
 */
let targetProvider: PairingTargetProvider = () => ({});

/** Publish the current cycle's pairing target. Called once per scan cycle. */
export function setPairingTarget(provider: PairingTargetProvider): void {
  targetProvider = provider;
  agentInstance?.setTargetProvider(provider);
}

/**
 * Register the pairing agent on this bus using the ambient target (idempotent).
 *
 * Called for every fresh D-Bus connection, regardless of bond state. The old
 * code only reached registerPairingAgent() from inside ensureBonded(), which
 * returns early when the device is already paired, so a bonded scale that
 * re-negotiates security on reconnect had no agent to answer
 * RequestConfirmation. BlueZ then never resolved services and gatt() timed out
 * after 30s, which is exactly #83: a background bluetoothctl agent confirming
 * the passkey made the very next attempt succeed end to end.
 *
 * The default-agent role is claimed ONLY when a consent PIN is configured.
 * Claiming it unconditionally would take the system-wide role away from
 * whatever agent the host already runs, and our requirePin() rejects a passkey
 * request it cannot answer, so a PIN-less install could end up worse off than
 * with no agent at all.
 */
export async function ensurePairingAgent(bus: MessageBus): Promise<void> {
  if (!agentInstance) agentInstance = new BlueZPairingAgent();
  agentInstance.setTargetProvider(targetProvider);
  const wantDefault = targetProvider().pin !== undefined && !defaultAgentUnavailable;
  if (registered && (defaultAgentClaimed || !wantDefault)) return;

  try {
    if (!registered) {
      bus.export(AGENT_PATH, agentInstance);
    }
    const bluez = await bus.getProxyObject('org.bluez', '/org/bluez');
    const manager = bluez.getInterface('org.bluez.AgentManager1');
    if (!registered) {
      try {
        await manager.RegisterAgent(AGENT_PATH, AGENT_CAPABILITY);
      } catch (err) {
        // Re-registering the same path returns AlreadyExists; treat as success.
        if (!errMsg(err).includes('AlreadyExists')) throw err;
      }
      registered = true;
      bleLog.debug(`BlueZ pairing agent registered (${AGENT_CAPABILITY})`);
    }
    if (wantDefault && !defaultAgentClaimed) {
      try {
        await manager.RequestDefaultAgent(AGENT_PATH);
        defaultAgentClaimed = true;
        bleLog.debug('BlueZ default-agent role claimed (a consent PIN is configured)');
      } catch (err) {
        // Latch after the first failure. Another agent already holding the role
        // is a persistent host state, not a transient one, so retrying every
        // scan cycle would warn forever in continuous mode without ever
        // succeeding. Registration itself stands, so pairings we initiate are
        // still answered.
        defaultAgentUnavailable = true;
        bleLog.warn(
          `BlueZ RequestDefaultAgent failed: ${errMsg(err)}. A bonded scale that ` +
            're-requests pairing confirmation may still stall in service discovery (#83).',
        );
      }
    } else if (!wantDefault) {
      bleLog.debug('Not claiming the BlueZ default-agent role (no users[].beurer_pin configured)');
    }
  } catch (err) {
    bleLog.warn(
      `Could not register BlueZ pairing agent: ${errMsg(err)}. ` +
        'Pairing will rely on any system agent that is present.',
    );
    if (!registered && agentInstance) {
      try {
        bus.unexport(AGENT_PATH, agentInstance);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Register our pairing agent on the given bus (idempotent). Always refreshes the
 * pin provider so a reload-changed beurer_pin is honored even though registration
 * itself runs only once. Best-effort: any failure (e.g. no AgentManager1, another
 * default agent) is logged and pairing falls back to whatever system agent exists.
 */
export async function registerPairingAgent(
  bus: MessageBus,
  pinProvider: PinProvider,
): Promise<void> {
  if (!agentInstance) agentInstance = new BlueZPairingAgent();
  agentInstance.setPinProvider(pinProvider);
  if (registered) return;

  try {
    bus.export(AGENT_PATH, agentInstance);
    const bluez = await bus.getProxyObject('org.bluez', '/org/bluez');
    const manager = bluez.getInterface('org.bluez.AgentManager1');
    try {
      await manager.RegisterAgent(AGENT_PATH, AGENT_CAPABILITY);
    } catch (err) {
      // Re-registering the same path returns AlreadyExists; treat as success.
      if (!errMsg(err).includes('AlreadyExists')) throw err;
    }
    try {
      await manager.RequestDefaultAgent(AGENT_PATH);
    } catch (err) {
      bleLog.debug(`BlueZ RequestDefaultAgent failed (non-fatal): ${errMsg(err)}`);
    }
    registered = true;
    bleLog.debug(`BlueZ pairing agent registered (${AGENT_CAPABILITY})`);
  } catch (err) {
    bleLog.warn(
      `Could not register BlueZ pairing agent: ${errMsg(err)}. ` +
        'Pairing will rely on any system agent that is present.',
    );
    try {
      bus.unexport(AGENT_PATH, agentInstance);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Forget the registered agent so the next registerPairingAgent re-exports it.
 * Called from resetConnection: destroying the D-Bus connection makes BlueZ drop
 * the agent automatically (the owner disconnected), so an explicit UnregisterAgent
 * is unnecessary and would race the connection teardown. Also used to reset state
 * between tests.
 */
export function forgetPairingAgent(): void {
  agentInstance = null;
  registered = false;
  defaultAgentClaimed = false;
  defaultAgentUnavailable = false;
}
