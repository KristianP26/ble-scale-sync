import {
  AppConfigSchema,
  BleSchema,
  DockerSchema,
  EsphomeEndpointSchema,
  EsphomeProxySchema,
  MqttProxySchema,
  RuntimeSchema,
  ScaleSchema,
  UserSchema,
} from './schema.js';

/**
 * Report config keys that no schema declares.
 *
 * Zod object schemas strip unknown keys silently, which is the right parsing
 * behaviour and the wrong user experience: a key copied from newer docs into an
 * older build looks accepted and does nothing. #318 is exactly that shape, and
 * the reporter had no way to tell an ignored option from a broken one.
 *
 * This walks the raw parsed YAML before validation and names every key that
 * will be dropped. It only warns: erroring would brick a downgrade, and Home
 * Assistant add-on users share one config file across versions.
 */

/** A schema whose declared keys are known. Refined schemas keep `.shape`. */
interface Shaped {
  shape: Record<string, unknown>;
}

/** Sections addressed by a fixed path from the config root. */
const SECTIONS: { path: string[]; schema: Shaped }[] = [
  { path: [], schema: AppConfigSchema as unknown as Shaped },
  { path: ['ble'], schema: BleSchema as unknown as Shaped },
  { path: ['ble', 'mqtt_proxy'], schema: MqttProxySchema as unknown as Shaped },
  { path: ['ble', 'esphome_proxy'], schema: EsphomeProxySchema as unknown as Shaped },
  { path: ['scale'], schema: ScaleSchema as unknown as Shaped },
  { path: ['runtime'], schema: RuntimeSchema as unknown as Shaped },
  { path: ['docker'], schema: DockerSchema as unknown as Shaped },
];

/**
 * Arrays of objects whose entries have a closed schema. Exporter entries are
 * deliberately absent: ExporterEntrySchema is `.passthrough()` by design, since
 * every exporter type carries its own options. `users[].weight_range` is absent
 * too, as a two-key object nobody typos into a footgun.
 */
const OBJECT_ARRAYS: { path: string[]; schema: Shaped }[] = [
  { path: ['users'], schema: UserSchema as unknown as Shaped },
  {
    path: ['ble', 'esphome_proxy', 'additional_proxies'],
    schema: EsphomeEndpointSchema as unknown as Shaped,
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Follow a path of object keys, stopping at anything that is not an object. */
function descend(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function unknownIn(value: unknown, schema: Shaped, prefix: string): string[] {
  if (!isPlainObject(value)) return [];
  const allowed = new Set(Object.keys(schema.shape));
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${prefix}${key}`);
}

/**
 * Return the dotted paths of every config key no schema declares.
 *
 * Never throws: it runs on raw YAML that may be any shape at all, including a
 * scalar where an object belongs.
 */
export function collectUnknownKeys(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const found: string[] = [];

  for (const section of SECTIONS) {
    const value = descend(raw, section.path);
    const prefix = section.path.length > 0 ? `${section.path.join('.')}.` : '';
    found.push(...unknownIn(value, section.schema, prefix));
  }

  for (const array of OBJECT_ARRAYS) {
    const value = descend(raw, array.path);
    if (!Array.isArray(value)) continue;
    value.forEach((entry, index) => {
      found.push(...unknownIn(entry, array.schema, `${array.path.join('.')}.${index}.`));
    });
  }

  return found;
}
