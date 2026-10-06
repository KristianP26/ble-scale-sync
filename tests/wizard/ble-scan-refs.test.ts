import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scanCalls: unknown[][] = [];
vi.mock('../../src/ble/index.js', () => ({
  scanDevices: async (...args: unknown[]) => {
    scanCalls.push(args);
    return [];
  },
}));
vi.mock('../../src/scales/index.js', () => ({ adapters: [] }));

const { bleStep } = await import('../../src/wizard/steps/ble.js');
import type { WizardContext } from '../../src/wizard/types.js';
import { scriptedPrompts } from '../helpers/scripted-prompts.js';

describe('bleStep scan resolves ${VAR} references', () => {
  beforeEach(() => {
    scanCalls.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('BSS_TEST_HA_TOKEN', 'real-token');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // The HA token prompt itself suggests ${HA_TOKEN}, but the scan was started
  // with the literal reference, which Home Assistant rejects.
  it('scans with the referenced token and stores the reference', async () => {
    const { prompts } = scriptedPrompts([
      [/How does this device connect/, 'ha-bluetooth'],
      [/Home Assistant URL/, 'http://ha.local:8123'],
      [/access token/, '${BSS_TEST_HA_TOKEN}'],
      [/How do you want to identify/, 'scan'],
      [/What would you like to do/, 'skip'],
    ]);
    const ctx: WizardContext = {
      config: {},
      configPath: '/tmp/config.yaml',
      isEditMode: false,
      nonInteractive: false,
      platform: {
        os: 'linux',
        arch: 'x64',
        hasDocker: false,
        hasPython: false,
        pythonCommand: null,
      },
      prompts,
    };

    await bleStep.run(ctx);

    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0][6]).toEqual({ url: 'http://ha.local:8123', token: 'real-token' });
    expect(ctx.config.ble?.ha_bluetooth?.token).toBe('${BSS_TEST_HA_TOKEN}');
  });
});
