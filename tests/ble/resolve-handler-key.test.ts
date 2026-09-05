import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveHandlerKey } from '../../src/ble/index.js';

const ORIG_NOBLE_DRIVER = process.env.NOBLE_DRIVER;
const ORIG_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function setNobleDriver(value: string | undefined): void {
  if (value === undefined) delete process.env.NOBLE_DRIVER;
  else process.env.NOBLE_DRIVER = value;
}

describe('resolveHandlerKey (#130)', () => {
  beforeEach(() => {
    setNobleDriver(undefined);
  });

  afterEach(() => {
    if (ORIG_NOBLE_DRIVER === undefined) delete process.env.NOBLE_DRIVER;
    else process.env.NOBLE_DRIVER = ORIG_NOBLE_DRIVER;
    Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true });
  });

  describe('explicit bleHandler wins over everything', () => {
    it('returns mqtt-proxy regardless of platform / NOBLE_DRIVER', () => {
      setPlatform('linux');
      setNobleDriver('stoprocent');
      expect(resolveHandlerKey('mqtt-proxy')).toBe('mqtt-proxy');
    });

    it('returns esphome-proxy regardless of platform / NOBLE_DRIVER', () => {
      setPlatform('darwin');
      setNobleDriver('abandonware');
      expect(resolveHandlerKey('esphome-proxy')).toBe('esphome-proxy');
    });
  });

  describe('NOBLE_DRIVER overrides platform default', () => {
    it('NOBLE_DRIVER=abandonware on Linux returns noble-legacy (not node-ble)', () => {
      setPlatform('linux');
      setNobleDriver('abandonware');
      expect(resolveHandlerKey()).toBe('noble-legacy');
    });

    it('NOBLE_DRIVER=stoprocent on Linux returns noble (not node-ble)', () => {
      setPlatform('linux');
      setNobleDriver('stoprocent');
      expect(resolveHandlerKey()).toBe('noble');
    });

    it('NOBLE_DRIVER=stoprocent on Windows returns noble (not noble-legacy default)', () => {
      setPlatform('win32');
      setNobleDriver('stoprocent');
      expect(resolveHandlerKey()).toBe('noble');
    });

    it('NOBLE_DRIVER=abandonware on macOS returns noble-legacy (not noble default)', () => {
      setPlatform('darwin');
      setNobleDriver('abandonware');
      expect(resolveHandlerKey()).toBe('noble-legacy');
    });

    it('unrecognised NOBLE_DRIVER value falls through to platform default', () => {
      setPlatform('linux');
      setNobleDriver('garbage');
      expect(resolveHandlerKey()).toBe('node-ble');
    });

    it('NOBLE_DRIVER is case-insensitive', () => {
      setPlatform('linux');
      setNobleDriver('STOPROCENT');
      expect(resolveHandlerKey()).toBe('noble');
    });
  });

  describe('OS platform defaults (no override)', () => {
    it('Linux defaults to node-ble', () => {
      setPlatform('linux');
      expect(resolveHandlerKey()).toBe('node-ble');
    });

    it('Windows defaults to noble-legacy (@abandonware/noble)', () => {
      setPlatform('win32');
      expect(resolveHandlerKey()).toBe('noble-legacy');
    });

    it('macOS defaults to noble (@stoprocent/noble)', () => {
      setPlatform('darwin');
      expect(resolveHandlerKey()).toBe('noble');
    });

    it('FreeBSD and other Unix-likes default to noble (catch-all)', () => {
      setPlatform('freebsd');
      expect(resolveHandlerKey()).toBe('noble');
    });
  });
});
