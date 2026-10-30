import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { AppConfigSchema, UserSchema } from '../src/config/schema.js';
import { EXPORTER_REGISTRY } from '../src/exporters/registry.js';
import {
  GARMIN_UPLOAD_TIMEOUT_MAX_SEC,
  GARMIN_UPLOAD_TIMEOUT_MIN_SEC,
} from '../src/exporters/garmin.js';

/**
 * The add-on manifest declares its own default, range and choices for every
 * option it maps onto a config key (architecture audit 2026-10-21, C-01 and
 * C-08). Nothing derives one from the other, so this compares them: a range
 * or a default changed in the schema and not in ble-scale-sync-addon/config.yaml
 * (or the other way round) fails here instead of in a user's add-on log.
 *
 * Compared only where both sides say something: a default only when the
 * schema has one (`.default()`), a range for `int(lo,hi)` and `port`, choices
 * for `list(...)`.
 */

const MANIFEST = parse(
  readFileSync('ble-scale-sync-addon/config.yaml', 'utf8').replace(/\r\n/g, '\n'),
) as { options: Record<string, unknown>; schema: Record<string, string> };

/** Manifest option -> config key it is written to by run.sh. */
const CONFIG_KEYS: Record<string, string> = {
  pairing_retry_max_min: 'ble.pairing_retry_max_min',
  proxy_liveness_timeout_min: 'ble.proxy_liveness_timeout_min',
  esphome_proxy_port: 'ble.esphome_proxy.port',
  mqtt_proxy_device_id: 'ble.mqtt_proxy.device_id',
  mqtt_proxy_topic_prefix: 'ble.mqtt_proxy.topic_prefix',
  mqtt_proxy_embedded_broker_port: 'ble.mqtt_proxy.embedded_broker_port',
  weight_unit: 'scale.weight_unit',
  height_unit: 'scale.height_unit',
  display_unit: 'scale.display_unit',
  out_of_range: 'out_of_range',
  user_gender: 'users.gender',
  user_estimate_body_composition: 'users.estimate_body_composition',
  scan_cooldown: 'runtime.scan_cooldown',
  idle_rescan_delay: 'runtime.idle_rescan_delay',
  no_reading_rescan_delay: 'runtime.no_reading_rescan_delay',
  retry_failed_exports: 'runtime.retry_failed_exports',
  debug: 'runtime.debug',
  update_check: 'update_check',
};

/** Manifest option -> exporter field it is written to. */
const EXPORTER_FIELDS: Record<string, [exporter: string, field: string]> = {
  mqtt_topic: ['mqtt', 'topic'],
  mqtt_ha_discovery: ['mqtt', 'ha_discovery'],
  mqtt_ha_device_name: ['mqtt', 'ha_device_name'],
  garmin_weight_only: ['garmin', 'weight_only'],
  garmin_upload_timeout_sec: ['garmin', 'upload_timeout_sec'],
};

interface Declared {
  default?: unknown;
  min?: number;
  max?: number;
  choices?: string[];
}

function schemaAt(path: string): z.ZodType {
  let at: z.ZodType = AppConfigSchema;
  for (const key of path.split('.')) {
    at = key === 'users' ? UserSchema : (unwrap(at).schema as z.ZodObject).shape[key];
  }
  return at;
}

/** The leaf without optional/nullable/default wrappers, and the default if one was set. */
function unwrap(schema: z.ZodType): { schema: z.ZodType; default?: unknown } {
  let at = schema;
  let fallback: unknown;
  for (;;) {
    if (at instanceof z.ZodDefault) fallback = at.def.defaultValue;
    if (at instanceof z.ZodDefault || at instanceof z.ZodOptional || at instanceof z.ZodNullable) {
      at = at.unwrap() as z.ZodType;
      continue;
    }
    return { schema: at, default: fallback };
  }
}

function fromSchema(path: string): Declared {
  const { schema, default: fallback } = unwrap(schemaAt(path));
  const out: Declared = fallback === undefined ? {} : { default: fallback };
  if (schema instanceof z.ZodNumber) {
    out.min = schema.minValue ?? undefined;
    out.max = schema.maxValue ?? undefined;
  }
  if (schema instanceof z.ZodEnum) out.choices = schema.options.map(String);
  return out;
}

function fromManifest(option: string, compare: Declared): Declared {
  const type = MANIFEST.schema[option];
  const out: Declared = {};
  if (compare.default !== undefined) out.default = MANIFEST.options[option];
  const int = /^int\((\d+),(\d+)\)/.exec(type);
  if (int) [out.min, out.max] = [Number(int[1]), Number(int[2])];
  if (type.startsWith('port')) [out.min, out.max] = [1, 65535];
  const list = /^list\((.*)\)/.exec(type);
  if (list) out.choices = list[1].split('|');
  return out;
}

function fromExporter(exporter: string, key: string): Declared {
  const schema = EXPORTER_REGISTRY.find((e) => e.schema.name === exporter)!.schema;
  const field = schema.fields.find((f) => f.key === key)!;
  const out: Declared = { default: field.default };
  if (exporter === 'garmin' && key === 'upload_timeout_sec') {
    [out.min, out.max] = [GARMIN_UPLOAD_TIMEOUT_MIN_SEC, GARMIN_UPLOAD_TIMEOUT_MAX_SEC];
  }
  return out;
}

describe('add-on manifest agrees with the schema', () => {
  it('every mapped option exists in the manifest', () => {
    const mapped = [...Object.keys(CONFIG_KEYS), ...Object.keys(EXPORTER_FIELDS)];
    expect(mapped.filter((o) => !(o in MANIFEST.schema))).toEqual([]);
  });

  it.each(Object.entries(CONFIG_KEYS))('%s -> %s', (option, path) => {
    const schema = fromSchema(path);
    expect(fromManifest(option, schema)).toEqual(schema);
  });

  it.each(Object.entries(EXPORTER_FIELDS))('%s -> exporter field', (option, [exporter, key]) => {
    const exporterSide = fromExporter(exporter, key);
    expect(fromManifest(option, exporterSide)).toEqual(exporterSide);
  });
});
