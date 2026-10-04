import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportersStep } from '../../src/wizard/steps/exporters.js';
import type { WizardContext } from '../../src/wizard/types.js';
import type { AppConfig, ExporterEntry, UserConfig } from '../../src/config/schema.js';
import { scriptedPrompts, type ScriptedAnswer } from '../helpers/scripted-prompts.js';

const mqtt: ExporterEntry = {
  type: 'mqtt',
  broker_url: 'mqtt://broker.lan:1883',
  topic: 'home/scale',
  qos: 0,
  retain: false,
  username: 'scale',
  password: '${MQTT_PASSWORD}',
  client_id: 'ble-scale-sync',
  ha_discovery: true,
  ha_device_name: 'Bathroom scale',
} as ExporterEntry;

const webhook: ExporterEntry = {
  type: 'webhook',
  url: 'https://hooks.example/scale',
  method: 'POST',
  timeout: 10000,
} as ExporterEntry;

const garmin: ExporterEntry = {
  type: 'garmin',
  email: 'alice@example.com',
  password: '${GARMIN_PASSWORD}',
  token_dir: './garmin-tokens/alice',
} as ExporterEntry;

// A per-user webhook is not something this step creates (webhook is a shared
// type), so the step must leave it alone.
const handMadeUserWebhook: ExporterEntry = {
  type: 'webhook',
  url: 'https://hooks.example/alice',
} as ExporterEntry;

const alice: UserConfig = {
  name: 'Alice',
  slug: 'alice',
  height: 168,
  birth_date: '1990-06-15',
  gender: 'female',
  is_athlete: false,
  weight_range: { min: 50, max: 70 },
  last_known_weight: 61.3,
  exporters: [garmin, handMadeUserWebhook],
};

function editContext(answers: Array<[RegExp, ScriptedAnswer]>) {
  const scripted = scriptedPrompts(answers);
  const config: Partial<AppConfig> = structuredClone({
    global_exporters: [mqtt, webhook],
    users: [alice],
  });
  const ctx: WizardContext = {
    config,
    configPath: '/tmp/config.yaml',
    isEditMode: true,
    nonInteractive: false,
    platform: { os: 'linux', arch: 'x64', hasDocker: false, hasPython: false, pythonCommand: null },
    stepHistory: [],
    prompts: scripted.prompts,
  };
  return { ctx, ...scripted };
}

describe('exportersStep in edit mode', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The checkbox used to start empty and every field was asked from scratch,
  // so an edit either looped on "no exporters selected" or replaced each
  // ${VAR} reference with whatever was typed.
  it('changes nothing when every prompt is answered with Enter', async () => {
    const { ctx, rejected } = editContext([]);

    await exportersStep.run(ctx);

    expect(rejected).toEqual([]);
    expect(ctx.config.global_exporters).toEqual([mqtt, webhook]);
    expect(ctx.config.users).toEqual([alice]);
  });

  it('removes an exporter that is unticked', async () => {
    const { ctx } = editContext([[/^Exporters/, ['mqtt', 'garmin']]]);

    await exportersStep.run(ctx);

    expect(ctx.config.global_exporters).toEqual([mqtt]);
    expect(ctx.config.users![0].exporters).toEqual([garmin, handMadeUserWebhook]);
  });

  it('removes an unticked per-user exporter and leaves hand-made entries alone', async () => {
    const { ctx } = editContext([[/^Exporters/, ['mqtt', 'webhook']]]);

    await exportersStep.run(ctx);

    expect(ctx.config.global_exporters).toEqual([mqtt, webhook]);
    expect(ctx.config.users![0].exporters).toEqual([handMadeUserWebhook]);
  });

  it('keeps a ${VAR} password when Enter is pressed while reconfiguring', async () => {
    const { ctx, rejected } = editContext([
      [/MQTT/, true], // "Change the MQTT settings?"
      [/^Topic/, 'home/scale2'],
    ]);

    await exportersStep.run(ctx);

    expect(rejected).toEqual([]);
    expect(ctx.config.global_exporters).toEqual([{ ...mqtt, topic: 'home/scale2' }, webhook]);
  });

  it('removes every managed exporter when the user continues with none', async () => {
    const { ctx } = editContext([
      [/^Exporters/, []],
      [/Continue without exporters/, true],
    ]);

    await exportersStep.run(ctx);

    expect(ctx.config.global_exporters).toBeUndefined();
    expect(ctx.config.users![0].exporters).toEqual([handMadeUserWebhook]);
  });
});
