import { z } from 'zod';

// --- Regex patterns ---

const MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const CB_UUID_REGEX =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

// --- Sub-schemas ---

export const BleSchema = z.object({
  scale_mac: z
    .string()
    .refine((v) => MAC_REGEX.test(v) || CB_UUID_REGEX.test(v), {
      message: 'Must be a MAC address (XX:XX:XX:XX:XX:XX) or CoreBluetooth UUID',
    })
    .optional()
    .nullable(),
  noble_driver: z.enum(['abandonware', 'stoprocent']).optional().nullable(),
});

export const ScaleSchema = z.object({
  weight_unit: z.enum(['kg', 'lbs']).default('kg'),
  height_unit: z.enum(['cm', 'in']).default('cm'),
});

export const ExporterEntrySchema = z
  .object({
    type: z.string().min(1, 'Exporter type is required'),
  })
  .passthrough();

const WeightRangeSchema = z
  .object({
    min: z.number().positive('Must be a positive number'),
    max: z.number().positive('Must be a positive number'),
  })
  .refine((range) => range.max > range.min, {
    message: 'max must be greater than min',
  });

export const UserSchema = z.object({
  name: z.string().min(1, 'User name is required'),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  height: z.number().positive('Must be a positive number (e.g., 183)'),
  birth_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format (e.g., "1990-06-15")'),
  gender: z.enum(['male', 'female']),
  is_athlete: z.boolean(),
  weight_range: WeightRangeSchema,
  last_known_weight: z.number().nullable().default(null),
  exporters: z.array(ExporterEntrySchema).optional(),
});

export const RuntimeSchema = z.object({
  continuous_mode: z.boolean().default(false),
  scan_cooldown: z.number().int().min(5).max(3600).default(30),
  dry_run: z.boolean().default(false),
  debug: z.boolean().default(false),
});

export const DockerSchema = z.object({
  mode: z.enum(['pull', 'build']).default('pull'),
});

export const AppConfigSchema = z.object({
  version: z.literal(1),
  ble: BleSchema.optional(),
  scale: ScaleSchema.default({ weight_unit: 'kg', height_unit: 'cm' }),
  unknown_user: z.enum(['nearest', 'log', 'ignore']).default('nearest'),
  users: z.array(UserSchema).min(1, 'At least one user is required'),
  global_exporters: z.array(ExporterEntrySchema).optional(),
  runtime: RuntimeSchema.optional(),
  docker: DockerSchema.optional(),
});

// --- Standalone types ---

export type WeightUnit = 'kg' | 'lbs';

// --- Inferred types ---

export type BleConfig = z.infer<typeof BleSchema>;
export type ScaleConfig = z.infer<typeof ScaleSchema>;
export type ExporterEntry = z.infer<typeof ExporterEntrySchema>;
export type UserConfig = z.infer<typeof UserSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeSchema>;
export type DockerConfig = z.infer<typeof DockerSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type UnknownUserStrategy = AppConfig['unknown_user'];

// --- Error formatting ---

export function formatConfigError(error: z.ZodError): string {
  const lines = ['Configuration error in config.yaml:', ''];

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    lines.push(`  ${path}`);
    lines.push(`    ${issue.message}`);
    lines.push('');
  }

  lines.push("Run 'npm run validate' to check your config, or 'npm run setup' to reconfigure.");

  return lines.join('\n');
}
