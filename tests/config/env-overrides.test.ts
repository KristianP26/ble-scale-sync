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

    it('ignores BLE_HANDLER=mqtt-proxy when mqtt_proxy is not configured', () => {
      vi.stubEnv('BLE_HANDLER', 'mqtt-proxy');
      const out = applyEnvOverrides(baseConfig());
      expect(out.ble?.handler).toBe('auto');
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
