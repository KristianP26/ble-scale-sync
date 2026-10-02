import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseBleAdapterEnv,
  applyEnvOverrides,
  filterValidExporters,
} from '../../src/config/env-overrides.js';
import type { AppConfig, ExporterEntry } from '../../src/config/schema.js';

// Minimal AppConfig — applyEnvOverrides only reads `runtime`, `ble`, and
// spreads the rest, so a cast skeleton is sufficient for unit testing the
// override logic in isolation.
function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    users: [],
    ...overrides,
  } as AppConfig;
}

describe('env-overrides (focused unit tests for #184 split)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('parseBleAdapterEnv', () => {
    it('returns undefined when BLE_ADAPTER is unset', () => {
      expect(parseBleAdapterEnv()).toBeUndefined();
    });

    it('returns null when BLE_ADAPTER is empty (clear override)', () => {
      vi.stubEnv('BLE_ADAPTER', '');
      expect(parseBleAdapterEnv()).toBeNull();
    });

    it('trims and lowercases a valid adapter', () => {
      vi.stubEnv('BLE_ADAPTER', '  HCI1  ');
      expect(parseBleAdapterEnv()).toBe('hci1');
    });

    it('returns undefined and warns on an invalid adapter', () => {
      vi.stubEnv('BLE_ADAPTER', 'eth0');
      expect(parseBleAdapterEnv()).toBeUndefined();
    });
  });

  describe('applyEnvOverrides', () => {
    it('defaults runtime/ble when config omits them', () => {
      const out = applyEnvOverrides(baseConfig());
      expect(out.runtime).toMatchObject({ continuous_mode: false, scan_cooldown: 30 });
      expect(out.ble).toMatchObject({ handler: 'auto' });
    });

    it('applies runtime env overrides', () => {
      vi.stubEnv('CONTINUOUS_MODE', 'yes');
      vi.stubEnv('SCAN_COOLDOWN', '120');
      const out = applyEnvOverrides(baseConfig());
      expect(out.runtime?.continuous_mode).toBe(true);
      expect(out.runtime?.scan_cooldown).toBe(120);
    });

    it('rejects an out-of-range SCAN_COOLDOWN', () => {
      vi.stubEnv('SCAN_COOLDOWN', '99999');
      const out = applyEnvOverrides(
        baseConfig({ runtime: { scan_cooldown: 45 } } as Partial<AppConfig>),
      );
      expect(out.runtime?.scan_cooldown).toBe(45);
    });

    it('clears the adapter when BLE_ADAPTER is empty', () => {
      vi.stubEnv('BLE_ADAPTER', '');
      const out = applyEnvOverrides(
        baseConfig({ ble: { handler: 'auto', adapter: 'hci0' } } as Partial<AppConfig>),
      );
      expect(out.ble?.adapter).toBeUndefined();
    });

    it('applies BLE_HANDLER=ha-bluetooth when ble.ha_bluetooth is configured', () => {
      vi.stubEnv('BLE_HANDLER', 'ha-bluetooth');
      const out = applyEnvOverrides(
        baseConfig({
          ble: { handler: 'auto', ha_bluetooth: { url: 'http://h:8123', token: 't' } },
        } as Partial<AppConfig>),
      );
      expect(out.ble?.handler).toBe('ha-bluetooth');
    });

    it('ignores BLE_HANDLER=ha-bluetooth when ha_bluetooth is not configured', () => {
      vi.stubEnv('BLE_HANDLER', 'ha-bluetooth');
      const out = applyEnvOverrides(baseConfig());
      expect(out.ble?.handler).toBe('auto');
    });

    it('ignores BLE_HANDLER=mqtt-proxy when mqtt_proxy is not configured', () => {
      vi.stubEnv('BLE_HANDLER', 'mqtt-proxy');
      const out = applyEnvOverrides(baseConfig());
      expect(out.ble?.handler).toBe('auto');
    });

    // #407: esphome-proxy is in the schema's own handler enum, so it validates
    // in config.yaml, but this function had no branch for it and dropped it in
    // silence - which looks exactly like a handler switch that worked.
    it('applies BLE_HANDLER=esphome-proxy when ble.esphome_proxy is configured', () => {
      vi.stubEnv('BLE_HANDLER', 'esphome-proxy');
      const out = applyEnvOverrides(
        baseConfig({
          ble: { handler: 'auto', esphome_proxy: { host: 'proxy.local' } },
        } as Partial<AppConfig>),
      );
      expect(out.ble?.handler).toBe('esphome-proxy');
    });

    it('ignores BLE_HANDLER=esphome-proxy when esphome_proxy is not configured', () => {
      vi.stubEnv('BLE_HANDLER', 'esphome-proxy');
      const out = applyEnvOverrides(baseConfig());
      expect(out.ble?.handler).toBe('auto');
    });

    it('says nothing about an empty BLE_HANDLER, which is how a variable is neutralised', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('BLE_HANDLER', '');
      const out = applyEnvOverrides(baseConfig());
      expect(out.ble?.handler).toBe('auto');
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/BLE_HANDLER/);
      warn.mockRestore();
    });

    it('warns about an unrecognised BLE_HANDLER instead of ignoring it silently', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('BLE_HANDLER', 'esphome');
      const out = applyEnvOverrides(baseConfig());
      expect(out.ble?.handler).toBe('auto');
      expect(warn.mock.calls.flat().join(' ')).toMatch(/esphome/);
      warn.mockRestore();
    });
  });

  describe('filterValidExporters', () => {
    it('returns undefined for undefined input', () => {
      expect(filterValidExporters(undefined)).toBeUndefined();
    });

    it('keeps known exporter types', () => {
      const entries = [{ type: 'mqtt' }] as ExporterEntry[];
      expect(filterValidExporters(entries)).toEqual(entries);
    });

    it('drops unknown types and returns undefined when none remain', () => {
      const entries = [{ type: 'definitely-not-real' }] as unknown as ExporterEntry[];
      expect(filterValidExporters(entries)).toBeUndefined();
    });
  });
});

describe('a malformed env override must not be stronger than a good one', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps dry_run=true when DRY_RUN is a typo', () => {
    // The old parser asked "is this one of true/yes/1?", so every value that
    // was not a recognised TRUE word - including a typo - meant FALSE. A
    // mistyped DRY_RUN did not fail and did not leave the configured value
    // alone: it turned dry-run OFF and exported for real.
    vi.stubEnv('DRY_RUN', 'treu');
    const out = applyEnvOverrides(baseConfig({ runtime: { dry_run: true } } as Partial<AppConfig>));
    expect(out.runtime?.dry_run).toBe(true);
  });

  it('still honours an explicit false', () => {
    // Guards against "fixing" this by ignoring every falsy word too.
    vi.stubEnv('DRY_RUN', 'false');
    const out = applyEnvOverrides(baseConfig({ runtime: { dry_run: true } } as Partial<AppConfig>));
    expect(out.runtime?.dry_run).toBe(false);
  });

  it.each(['true', 'YES', 'on', '1'])('accepts %s as true', (word) => {
    vi.stubEnv('CONTINUOUS_MODE', word);
    expect(applyEnvOverrides(baseConfig()).runtime?.continuous_mode).toBe(true);
  });

  it.each(['false', 'NO', 'off', '0'])('accepts %s as false', (word) => {
    vi.stubEnv('CONTINUOUS_MODE', word);
    const out = applyEnvOverrides(
      baseConfig({ runtime: { continuous_mode: true } } as Partial<AppConfig>),
    );
    expect(out.runtime?.continuous_mode).toBe(false);
  });

  it('ignores an invalid SCALE_MAC instead of assigning it raw', () => {
    // config.yaml refines this with isValidScaleId; the env path assigned it
    // verbatim, so a typo became a scale id that can never match and a scan
    // that silently never finds anything.
    vi.stubEnv('SCALE_MAC', 'not-a-scale-id');
    const out = applyEnvOverrides(
      baseConfig({ ble: { scale_mac: 'aa:bb:cc:dd:ee:ff' } } as Partial<AppConfig>),
    );
    expect(out.ble?.scale_mac).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('still applies a valid SCALE_MAC', () => {
    vi.stubEnv('SCALE_MAC', 'AA:BB:CC:DD:EE:FF');
    expect(applyEnvOverrides(baseConfig()).ble?.scale_mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('rejects a fractional SCAN_COOLDOWN the schema would have refused', () => {
    vi.stubEnv('SCAN_COOLDOWN', '12.5');
    expect(applyEnvOverrides(baseConfig()).runtime?.scan_cooldown).toBe(30);
  });
});
