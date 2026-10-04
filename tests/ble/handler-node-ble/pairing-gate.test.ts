import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Device } from '../../../src/ble/handler-node-ble/dbus.js';
import type { BlueZPairingAgent } from '../../../src/ble/handler-node-ble/agent.js';
import { bleLog } from '../../../src/ble/types.js';

/**
 * The agent's MAC gate (#83) keeps an unrelated peer from being handed the
 * scale's consent PIN or having its pairing auto-accepted. These tests use the
 * REAL agent module: ensureBonded used to call registerPairingAgent(), which
 * swapped the agent's target for a PIN-only one without a MAC, and a mocked
 * agent module could never have shown that.
 */

const exported: unknown[] = [];
const bus = {
  export: vi.fn((_path: string, obj: unknown) => exported.push(obj)),
  unexport: vi.fn(),
  getProxyObject: vi.fn(async () => ({
    getInterface: () => ({
      RegisterAgent: vi.fn(async () => {}),
      RequestDefaultAgent: vi.fn(async () => {}),
    }),
  })),
};

vi.mock('../../../src/ble/handler-node-ble/connection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/connection.js')>();
  return { ...actual, getBus: () => bus };
});

const agentModule = await import('../../../src/ble/handler-node-ble/agent.js');
const { ensureBonded } = await import('../../../src/ble/handler-node-ble/scan.js');

const SCALE = 'D8:0B:CB:5B:B6:58';
const SCALE_PATH = '/org/bluez/hci0/dev_D8_0B_CB_5B_B6_58';
const OTHER_PATH = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF';

function unpairedDevice(): Device {
  return {
    isPaired: async () => false,
    pair: async () => {},
    helper: { set: async () => {}, callMethod: async () => {} },
  } as unknown as Device;
}

function agent(): BlueZPairingAgent {
  expect(exported.length).toBeGreaterThan(0);
  return exported[exported.length - 1] as BlueZPairingAgent;
}

beforeEach(() => {
  exported.length = 0;
  agentModule.forgetPairingAgent();
  vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  vi.spyOn(bleLog, 'info').mockImplementation(() => {});
  vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
});

describe('pairing agent MAC gate', () => {
  it('still declines an unrelated device after ensureBonded ran (A-01)', async () => {
    agentModule.setPairingTarget(() => ({ pin: 1894, mac: SCALE }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await agentModule.ensurePairingAgent(bus as any);
    expect(() => agent().RequestPasskey(OTHER_PATH)).toThrow();

    await ensureBonded(unpairedDevice(), 1894);

    expect(() => agent().RequestPasskey(OTHER_PATH)).toThrow();
    expect(() => agent().RequestConfirmation(OTHER_PATH, 123456)).toThrow();
    expect(() => agent().RequestAuthorization(OTHER_PATH)).toThrow();
    // The configured scale itself is still served.
    expect(agent().RequestPasskey(SCALE_PATH)).toBe(1894);
  });
});
