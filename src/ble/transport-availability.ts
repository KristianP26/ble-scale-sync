/**
 * Which npm package backs which BLE transport, whether it is installed here,
 * and the message shown when the selected one is not (#364).
 *
 * The three native BLE stacks are optional dependencies: @abandonware/noble
 * compiles from source, so an install on a host without a C++ toolchain
 * completes without it. Without this module the only symptom is Node's raw
 * "Cannot find package '@abandonware/noble'" thrown from a dynamic import()
 * several modules deep, naming neither the transport nor a way out.
 */

/**
 * Resolved BLE handler identifier.
 *
 * Declared here rather than in ./index.js so this module has no runtime edge
 * back to the transport switch that consumes it; ./index.js re-exports the
 * type unchanged.
 */
export type HandlerKey = 'mqtt-proxy' | 'esphome-proxy' | 'noble-legacy' | 'noble' | 'node-ble';

/** Human label per transport. Also used in the BLE debug log line. */
export const HANDLER_LABELS: Record<HandlerKey, string> = {
  'mqtt-proxy': 'mqtt-proxy (ESP32)',
  'esphome-proxy': 'esphome-proxy',
  'noble-legacy': 'noble-legacy (@abandonware/noble)',
  noble: 'noble (@stoprocent/noble)',
  'node-ble': 'node-ble (BlueZ D-Bus)',
};

/**
 * npm packages a transport needs at runtime. Empty for the two proxy
 * transports, which are backed by regular dependencies.
 *
 * dbus-next is node-ble's own dependency and is imported directly by
 * handler-node-ble/agent.ts. npm drops a skipped optional package's whole
 * subtree, so dbus-next goes with node-ble, and Node may name dbus-next rather
 * than node-ble in the resolution error. That is why the message below is
 * built from this map and never from the error's own specifier.
 */
const HANDLER_PACKAGES: Record<HandlerKey, readonly string[]> = {
  'mqtt-proxy': [],
  'esphome-proxy': [],
  'noble-legacy': ['@abandonware/noble'],
  noble: ['@stoprocent/noble'],
  'node-ble': ['node-ble', 'dbus-next'],
};

/**
 * How a user selects each transport once its package is present. The proxy
 * transports say what config they need, because listing them as "available"
 * without that would send a user into a second dead end: scanDevices throws
 * "mqtt_proxy config is required..." / "esphome_proxy config is required...".
 */
const HANDLER_SELECTORS: Record<HandlerKey, string> = {
  'mqtt-proxy':
    'set ble.handler: mqtt-proxy and add an mqtt_proxy config block (https://blescalesync.dev/guide/esp32-proxy)',
  'esphome-proxy':
    'set ble.handler: esphome-proxy and add an esphome_proxy config block (https://blescalesync.dev/guide/esphome-proxy)',
  'noble-legacy': 'set NOBLE_DRIVER=abandonware or ble.noble_driver: abandonware',
  noble: 'set NOBLE_DRIVER=stoprocent or ble.noble_driver: stoprocent',
  'node-ble': 'the default on Linux, no setting needed',
};

/** Answers "is this npm package installed here?" without importing it. */
export type PackageProbe = (specifier: string) => boolean;

/**
 * Default probe. import.meta.resolve is synchronous and throws
 * ERR_MODULE_NOT_FOUND for an absent package, which makes it a positive test:
 * it can never confuse a missing package with a broken relative import inside
 * our own files.
 */
export const canResolvePackage: PackageProbe = (specifier: string): boolean => {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
};

/** npm packages this transport needs that are not installed here. */
export function missingPackagesFor(
  key: HandlerKey,
  probe: PackageProbe = canResolvePackage,
): string[] {
  return HANDLER_PACKAGES[key].filter((pkg) => !probe(pkg));
}

/** Transports whose packages are all installed here, excluding `exclude`. */
export function availableTransports(
  exclude: HandlerKey,
  probe: PackageProbe = canResolvePackage,
): HandlerKey[] {
  return (Object.keys(HANDLER_PACKAGES) as HandlerKey[]).filter(
    (key) => key !== exclude && missingPackagesFor(key, probe).length === 0,
  );
}

/** Thrown in place of ERR_MODULE_NOT_FOUND when a transport package is absent. */
export class MissingTransportModuleError extends Error {
  readonly handler: HandlerKey;
  readonly missingPackages: readonly string[];

  constructor(handler: HandlerKey, missingPackages: readonly string[], message: string) {
    super(message);
    this.name = 'MissingTransportModuleError';
    this.handler = handler;
    this.missingPackages = missingPackages;
  }
}

/** The whole user-facing text, kept separate so it can be asserted directly. */
export function buildMissingTransportMessage(
  key: HandlerKey,
  missing: readonly string[],
  probe: PackageProbe = canResolvePackage,
): string {
  const lines: string[] = [
    `BLE transport ${HANDLER_LABELS[key]} needs the npm package ${missing.join(' and ')}, ` +
      'which is not installed.',
    '',
    'The three native BLE stacks are optional dependencies, so an install on a host without ' +
      'a C++ build toolchain completes without the ones it cannot build.',
    '',
    `Install it here:  npm install ${missing.join(' ')}`,
    '',
  ];

  const others = availableTransports(key, probe);
  if (others.length === 0) {
    // Unreachable while the two proxy transports need no npm package of their
    // own, and kept for the day one of them does.
    lines.push('No other BLE transport is available on this host.');
  } else {
    lines.push('Transports still available on this host:');
    for (const other of others) {
      lines.push(`  - ${HANDLER_LABELS[other]}: ${HANDLER_SELECTORS[other]}`);
    }
  }

  return lines.join('\n');
}

function isModuleNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
  );
}

/**
 * Replace a module-resolution failure with a named, actionable error, but only
 * when the npm package this transport needs really is absent.
 *
 * Two guards on purpose. err.code alone would also rewrite a genuine broken
 * relative import inside src/ble/handler-node-ble/*, hiding one of our own bugs
 * behind an install hint. The probe alone would rewrite any failure at all once
 * a package happens to be missing. Anything failing either guard is rethrown
 * untouched.
 */
export function rethrowAsTransportError(
  key: HandlerKey,
  err: unknown,
  probe: PackageProbe = canResolvePackage,
): never {
  if (!isModuleNotFound(err)) throw err;
  const missing = missingPackagesFor(key, probe);
  if (missing.length === 0) throw err;
  throw new MissingTransportModuleError(
    key,
    missing,
    buildMissingTransportMessage(key, missing, probe),
  );
}
