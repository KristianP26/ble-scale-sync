import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BlueZPairingAgent,
  registerPairingAgent,
  ensurePairingAgent,
  setPairingTarget,
  forgetPairingAgent,
  AGENT_PATH,
  AGENT_CAPABILITY,
} from '../../src/ble/handler-node-ble/agent.js';
import { bleLog } from '../../src/ble/types.js';

beforeEach(() => {
  forgetPairingAgent();
  setPairingTarget(() => ({}));
  vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
  vi.spyOn(bleLog, 'info').mockImplementation(() => {});
});

describe('BlueZPairingAgent callbacks', () => {
  it('RequestPasskey returns the configured PIN as a number', () => {
    const agent = new BlueZPairingAgent();
    agent.setPinProvider(() => 3752);
    expect(agent.RequestPasskey('/org/bluez/hci0/dev_X')).toBe(3752);
  });

  it('RequestPinCode returns the PIN as a string', () => {
    const agent = new BlueZPairingAgent();
    agent.setPinProvider(() => 3752);
    expect(agent.RequestPinCode('/org/bluez/hci0/dev_X')).toBe('3752');
  });

  it('reflects a refreshed PIN provider (config reload)', () => {
    const agent = new BlueZPairingAgent();
    agent.setPinProvider(() => 1111);
    expect(agent.RequestPasskey('/d')).toBe(1111);
    agent.setPinProvider(() => 2222);
    expect(agent.RequestPasskey('/d')).toBe(2222);
  });

  it('rejects passkey/pin requests when no PIN is configured', () => {
    const agent = new BlueZPairingAgent();
    agent.setPinProvider(() => undefined);
    expect(() => agent.RequestPasskey('/d')).toThrow(/beurer_pin/);
    expect(() => agent.RequestPinCode('/d')).toThrow(/beurer_pin/);
  });

  describe('log lines (#430)', () => {
    const DEV = '/org/bluez/hci0/dev_D8_0B_CB_5B_B6_58';

    it('RequestPasskey without a PIN points at a manual pairing, not at beurer_pin', () => {
      const agent = new BlueZPairingAgent();
      agent.setPinProvider(() => undefined);
      expect(() => agent.RequestPasskey(DEV)).toThrow();

      const msg = String(vi.mocked(bleLog.warn).mock.calls.at(-1)?.[0]);
      expect(msg).toContain('bluetoothctl');
      expect(msg).toContain('new on every attempt');
      expect(msg).toContain('pair D8:0B:CB:5B:B6:58');
      expect(msg).not.toContain('the code the scale was paired with');
    });

    it('RequestPinCode without a PIN names the PIN code and the manual pairing', () => {
      const agent = new BlueZPairingAgent();
      agent.setPinProvider(() => undefined);
      expect(() => agent.RequestPinCode(DEV)).toThrow();

      const msg = String(vi.mocked(bleLog.warn).mock.calls.at(-1)?.[0]);
      expect(msg).toContain('PIN code');
      expect(msg).toContain('bluetoothctl');
    });

    it('says at info that it answered with beurer_pin, without logging the PIN', () => {
      const agent = new BlueZPairingAgent();
      agent.setPinProvider(() => 3752);
      expect(agent.RequestPasskey(DEV)).toBe(3752);

      const lines = vi.mocked(bleLog.info).mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.includes('beurer_pin'));
      expect(line).toBeDefined();
      expect(line).toContain('RequestPasskey');
      const everything = [
        ...lines,
        ...vi.mocked(bleLog.debug).mock.calls.map((c) => String(c[0])),
        ...vi.mocked(bleLog.warn).mock.calls.map((c) => String(c[0])),
      ];
      expect(everything.some((l) => l.includes('3752'))).toBe(false);
    });
  });

  it('accepts the confirmation/authorization models without throwing', () => {
    const agent = new BlueZPairingAgent();
    expect(() => agent.RequestConfirmation('/d', 123456)).not.toThrow();
    expect(() => agent.RequestAuthorization('/d')).not.toThrow();
    expect(() =>
      agent.AuthorizeService('/d', '0000181d-0000-1000-8000-00805f9b34fb'),
    ).not.toThrow();
  });

  it('display/lifecycle callbacks do not throw', () => {
    const agent = new BlueZPairingAgent();
    expect(() => agent.DisplayPasskey('/d', 123456, 0)).not.toThrow();
    expect(() => agent.DisplayPinCode('/d', '123456')).not.toThrow();
    expect(() => agent.Release()).not.toThrow();
    expect(() => agent.Cancel()).not.toThrow();
  });
});

interface FakeManager {
  RegisterAgent: ReturnType<typeof vi.fn>;
  RequestDefaultAgent: ReturnType<typeof vi.fn>;
}

function fakeBus(manager: Partial<FakeManager> = {}, getProxyImpl?: () => Promise<unknown>) {
  const mgr: FakeManager = {
    RegisterAgent: vi.fn(async () => {}),
    RequestDefaultAgent: vi.fn(async () => {}),
    ...manager,
  };
  return {
    bus: {
      export: vi.fn(),
      unexport: vi.fn(),
      getProxyObject: getProxyImpl ?? vi.fn(async () => ({ getInterface: () => mgr })),
    },
    mgr,
  };
}

describe('registerPairingAgent', () => {
  it('exports the agent and registers it with KeyboardDisplay capability', async () => {
    const { bus, mgr } = fakeBus();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerPairingAgent(bus as any, () => 3752);
    expect(bus.export).toHaveBeenCalledWith(AGENT_PATH, expect.anything());
    expect(mgr.RegisterAgent).toHaveBeenCalledWith(AGENT_PATH, AGENT_CAPABILITY);
    expect(mgr.RequestDefaultAgent).toHaveBeenCalledWith(AGENT_PATH);
  });

  it('is idempotent: a second call does not re-export', async () => {
    const { bus } = fakeBus();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerPairingAgent(bus as any, () => 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerPairingAgent(bus as any, () => 2);
    expect(bus.export).toHaveBeenCalledTimes(1);
  });

  it('re-exports after forgetPairingAgent', async () => {
    const { bus } = fakeBus();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerPairingAgent(bus as any, () => 1);
    forgetPairingAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerPairingAgent(bus as any, () => 1);
    expect(bus.export).toHaveBeenCalledTimes(2);
  });

  it('tolerates AlreadyExists from RegisterAgent', async () => {
    const { bus, mgr } = fakeBus({
      RegisterAgent: vi.fn(async () => {
        throw new Error('org.bluez.Error.AlreadyExists: Already Exists');
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(registerPairingAgent(bus as any, () => 1)).resolves.toBeUndefined();
    expect(mgr.RequestDefaultAgent).toHaveBeenCalled();
  });

  it('swallows a missing AgentManager1 and unexports (best-effort)', async () => {
    const bus = {
      export: vi.fn(),
      unexport: vi.fn(),
      getProxyObject: vi.fn(async () => {
        throw new Error('org.bluez not available');
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(registerPairingAgent(bus as any, () => 1)).resolves.toBeUndefined();
    expect(bus.unexport).toHaveBeenCalledWith(AGENT_PATH, expect.anything());
  });
});

describe('ensurePairingAgent (#83)', () => {
  it('registers on a fresh bus regardless of bond state', async () => {
    const { bus, mgr } = fakeBus();
    setPairingTarget(() => ({ pin: 1894, mac: 'D8:0B:CB:5B:B6:58' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensurePairingAgent(bus as any);
    expect(bus.export).toHaveBeenCalledWith(AGENT_PATH, expect.anything());
    expect(mgr.RegisterAgent).toHaveBeenCalledWith(AGENT_PATH, AGENT_CAPABILITY);
  });

  it('claims the default-agent role only when a PIN is configured', async () => {
    const withPin = fakeBus();
    setPairingTarget(() => ({ pin: 1894 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensurePairingAgent(withPin.bus as any);
    expect(withPin.mgr.RequestDefaultAgent).toHaveBeenCalled();

    forgetPairingAgent();

    const noPin = fakeBus();
    setPairingTarget(() => ({}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensurePairingAgent(noPin.bus as any);
    expect(noPin.mgr.RegisterAgent).toHaveBeenCalled();
    // Never take the system-wide role we cannot honour without a PIN.
    expect(noPin.mgr.RequestDefaultAgent).not.toHaveBeenCalled();
  });

  it('claims the default-agent role later if a PIN appears after a reload', async () => {
    const { bus, mgr } = fakeBus();
    setPairingTarget(() => ({}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensurePairingAgent(bus as any);
    expect(mgr.RequestDefaultAgent).not.toHaveBeenCalled();

    setPairingTarget(() => ({ pin: 2520 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensurePairingAgent(bus as any);
    expect(mgr.RequestDefaultAgent).toHaveBeenCalledTimes(1);
    expect(bus.export).toHaveBeenCalledTimes(1);
  });
});

describe('pairing agent MAC scoping (#83)', () => {
  const TARGET = '/org/bluez/hci0/dev_D8_0B_CB_5B_B6_58';
  const OTHER = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';

  function agentFor(mac?: string) {
    const agent = new BlueZPairingAgent();
    agent.setTargetProvider(() => ({ pin: 1894, mac }));
    return agent;
  }

  it('serves the configured scale', () => {
    const agent = agentFor('D8:0B:CB:5B:B6:58');
    expect(agent.RequestPasskey(TARGET)).toBe(1894);
    expect(() => agent.RequestConfirmation(TARGET, 123456)).not.toThrow();
  });

  it('declines an unrelated device so it cannot use the scale PIN', () => {
    const agent = agentFor('D8:0B:CB:5B:B6:58');
    expect(() => agent.RequestPasskey(OTHER)).toThrow();
    expect(() => agent.RequestConfirmation(OTHER, 123456)).toThrow();
    expect(() => agent.AuthorizeService(OTHER, '0000180a-0000-1000-8000-00805f9b34fb')).toThrow();
  });

  it('serves any device when no scale_mac is configured (auto-discovery)', () => {
    const agent = agentFor(undefined);
    expect(agent.RequestPasskey(OTHER)).toBe(1894);
    expect(() => agent.RequestConfirmation(OTHER, 1)).not.toThrow();
  });
});
