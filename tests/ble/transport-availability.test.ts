import { describe, it, expect } from 'vitest';
import {
  availableTransports,
  buildMissingTransportMessage,
  canResolvePackage,
  MissingTransportModuleError,
  missingPackagesFor,
  rethrowAsTransportError,
  type PackageProbe,
} from '../../src/ble/transport-availability.js';

/** A probe where exactly `names` are absent and everything else resolves. */
const absent =
  (...names: string[]): PackageProbe =>
  (specifier) =>
    !names.includes(specifier);

const notFound = (message: string): Error =>
  Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' });

describe('missingPackagesFor', () => {
  it('names the package behind the selected transport', () => {
    expect(missingPackagesFor('noble-legacy', absent('@abandonware/noble'))).toEqual([
      '@abandonware/noble',
    ]);
  });

  it('ignores a package that backs a different transport', () => {
    expect(missingPackagesFor('noble-legacy', absent('node-ble'))).toEqual([]);
  });

  it('reports dbus-next as a node-ble problem, alone or together', () => {
    expect(missingPackagesFor('node-ble', absent('node-ble', 'dbus-next'))).toEqual([
      'node-ble',
      'dbus-next',
    ]);
    // npm drops a skipped optional package's whole subtree, so Node may name
    // dbus-next rather than node-ble in the resolution error.
    expect(missingPackagesFor('node-ble', absent('dbus-next'))).toEqual(['dbus-next']);
  });

  it('needs no npm package of its own for the proxy transports', () => {
    expect(missingPackagesFor('mqtt-proxy', () => false)).toEqual([]);
    expect(missingPackagesFor('esphome-proxy', () => false)).toEqual([]);
    expect(missingPackagesFor('ha-bluetooth', () => false)).toEqual([]);
  });
});

describe('availableTransports', () => {
  it('lists every other transport whose packages resolve', () => {
    const others = availableTransports('noble-legacy', absent('@abandonware/noble'), 'linux');
    expect(others).toContain('noble');
    expect(others).toContain('node-ble');
    expect(others).toContain('mqtt-proxy');
    expect(others).toContain('esphome-proxy');
    expect(others).toContain('ha-bluetooth');
    expect(others).not.toContain('noble-legacy');
  });

  it('does not offer node-ble off Linux', () => {
    // resolveHandlerKey returns node-ble only on linux, and BlueZ D-Bus does
    // not exist elsewhere, so offering it sends a stuck user nowhere.
    for (const platform of ['win32', 'darwin'] as const) {
      const others = availableTransports('noble-legacy', absent('@abandonware/noble'), platform);
      expect(others).not.toContain('node-ble');
      expect(others).toContain('noble');
    }
  });
});

describe('buildMissingTransportMessage', () => {
  it('names the package, the install command and the way into each alternative', () => {
    const msg = buildMissingTransportMessage(
      'noble-legacy',
      ['@abandonware/noble'],
      absent('@abandonware/noble'),
    );
    expect(msg).toContain('@abandonware/noble');
    expect(msg).toContain('npm install @abandonware/noble');
    expect(msg).toContain('NOBLE_DRIVER=stoprocent');
    expect(msg).toContain('mqtt_proxy config block');
    expect(msg).toContain('esphome_proxy config block');
  });

  it('keeps the project style rule on a string a user reads', () => {
    const msg = buildMissingTransportMessage(
      'noble-legacy',
      ['@abandonware/noble'],
      absent('@abandonware/noble'),
    );
    expect(msg).not.toMatch(/—| -- /);
  });

  it('tells a Windows user to install where the app lives, not into cwd', () => {
    // A plain `npm install` in the working directory creates a node_modules
    // Node never consults for a global install, and nothing at all under npx.
    const msg = buildMissingTransportMessage(
      'noble-legacy',
      ['@abandonware/noble'],
      absent('@abandonware/noble'),
      'win32',
    );
    expect(msg).not.toContain('node-ble (BlueZ D-Bus)');
    expect(msg).toContain('@stoprocent/noble');
  });

  it('still offers the proxy transports when no npm package resolves at all', () => {
    // The proxy transports are backed by regular dependencies, so they survive
    // a probe that resolves nothing. This is why the "no other transport"
    // fallback line cannot be reached with today's package map.
    const msg = buildMissingTransportMessage(
      'node-ble',
      ['node-ble', 'dbus-next'],
      () => false,
      'linux',
    );
    expect(msg).toContain('Transports still available on this host:');
    expect(msg).toContain('mqtt-proxy (ESP32)');
    expect(msg).toContain('esphome-proxy');
    expect(msg).not.toContain('No other BLE transport is available on this host.');
  });
});

describe('rethrowAsTransportError', () => {
  it('rethrows our own broken relative import untouched', () => {
    // Same error code as a missing package. Rewriting this one would hide a
    // bug of ours behind an install hint.
    const err = notFound("Cannot find module 'C:/app/src/ble/handler-node-ble/gatt.js'");
    expect(() => rethrowAsTransportError('node-ble', err, () => true)).toThrow(err);
  });

  it('rethrows any error that is not a resolution failure', () => {
    const err = new Error('boom');
    expect(() => rethrowAsTransportError('node-ble', err, () => false)).toThrow(err);
  });

  it('keeps the original error as the cause', () => {
    const err = notFound("Cannot find package '@abandonware/noble' imported from ...");
    try {
      rethrowAsTransportError('noble-legacy', err, absent('@abandonware/noble'));
      expect.unreachable('should have thrown');
    } catch (caught) {
      expect((caught as Error).cause).toBe(err);
    }
  });

  it('replaces a genuinely missing package with a named, actionable error', () => {
    const err = notFound("Cannot find package '@abandonware/noble' imported from ...");
    try {
      rethrowAsTransportError('noble-legacy', err, absent('@abandonware/noble'));
      expect.unreachable('should have thrown');
    } catch (caught) {
      expect(caught).toBeInstanceOf(MissingTransportModuleError);
      const e = caught as MissingTransportModuleError;
      expect(e.handler).toBe('noble-legacy');
      expect(e.missingPackages).toEqual(['@abandonware/noble']);
      expect(e.message).toContain('npm install @abandonware/noble');
    }
  });
});

describe('canResolvePackage', () => {
  it('answers from the real module resolver', () => {
    expect(canResolvePackage('yaml')).toBe(true);
    expect(canResolvePackage('definitely-not-installed-pkg-xyz')).toBe(false);
  });
});
