import {
  resolveExportersForUser,
  resolveExporterSlotsForUser,
  type ResolvedExporterEntry,
} from '../config/resolve.js';
import { createExporterFromEntry } from '../exporters/registry.js';
import type { Exporter } from '../interfaces/exporter.js';
import type { ExporterEntry } from '../config/schema.js';
import type { AppContext } from './context.js';
import { exporterSlot, setExporterSlot } from './exporter-slot.js';

/** Build the instances for resolved entries, remembering which slot each came from. */
function buildFromSlots(resolved: ResolvedExporterEntry[]): Exporter[] {
  return resolved.map((r) => {
    const exporter = createExporterFromEntry(r.entry);
    setExporterSlot(exporter, r);
    return exporter;
  });
}

export function buildSingleUserExporters(ctx: AppContext): Exporter[] {
  return buildFromSlots(resolveExporterSlotsForUser(ctx.config, ctx.config.users[0]));
}

/**
 * Every exporter any configured user has, deduped by name.
 *
 * Only the fallback for a queued entry WITHOUT a `userSlug` (queued before the
 * field existed, #412): every other entry is resolved through its own user by
 * `resolveQueuedExporter` (D015), because the name is the exporter type and the
 * union would hand one user's entry to another user's account.
 */
export function collectConfiguredExporters(ctx: AppContext): Exporter[] {
  const byName = new Map<string, Exporter>();
  for (const user of ctx.config.users) {
    for (const exporter of getExportersForUser(ctx, user.slug)) {
      if (!byName.has(exporter.name)) byName.set(exporter.name, exporter);
    }
  }
  return [...byName.values()];
}

/**
 * The exporter one queued entry must be redelivered through.
 *
 * Resolves via the entry's OWN `userSlug` first. `Exporter.name` is the
 * exporter TYPE ('garmin'), a class constant, so two users who each configure
 * a Garmin account produce two instances sharing one name; picking by name
 * across the deduped union therefore delivered user B's queued weigh-in
 * through user A's instance - with A's `token_dir`, i.e. into A's account.
 *
 * Within the user, the entry's slot (list + index, D029) picks the instance,
 * because one list may hold two entries of the same type and the name cannot
 * tell them apart. When the slot no longer holds that type (the config was
 * edited while the entry waited), the type decides, but only when the user has
 * exactly one exporter of it: with two, guessing would deliver to a target the
 * reading was never meant for, so the entry resolves to nothing and is dropped.
 * An entry from before slots existed has none and takes the first of its type,
 * which is where the version that queued it would have delivered it.
 *
 * A user who no longer exists resolves to nothing and the caller drops the
 * entry, which is the point: falling back to the union is how the wrong
 * account got written in the first place. Only an entry with NO slug - queued
 * before the field existed - falls back, and the union is what it was queued
 * against anyway.
 */
export function resolveQueuedExporter(
  ctx: AppContext,
  entry: {
    exporter: string;
    userSlug?: string;
    exporterList?: 'user' | 'global';
    exporterIndex?: number;
  },
): Exporter | undefined {
  if (!entry.userSlug) {
    return collectConfiguredExporters(ctx).find((e) => e.name === entry.exporter);
  }
  const ofType = getExportersForUser(ctx, entry.userSlug).filter((e) => e.name === entry.exporter);
  if (entry.exporterList === undefined || entry.exporterIndex === undefined) return ofType[0];
  const exact = ofType.find((e) => {
    const slot = exporterSlot(e);
    return slot?.list === entry.exporterList && slot?.index === entry.exporterIndex;
  });
  if (exact) return exact;
  return ofType.length === 1 ? ofType[0] : undefined;
}

/**
 * Per-user lookup that hits `ctx.exporterCache`. Cache is cleared on every
 * config reload via `AppContext.setConfig` so reload-time exporter changes
 * land on the next call.
 */
export function getExportersForUser(ctx: AppContext, slug: string): Exporter[] {
  let exporters = ctx.exporterCache.get(slug);
  if (!exporters) {
    const user = ctx.config.users.find((u) => u.slug === slug);
    if (!user) return [];
    exporters = buildFromSlots(resolveExporterSlotsForUser(ctx.config, user));
    ctx.exporterCache.set(slug, exporters);
  }
  return exporters;
}

/**
 * Stable JSON serialization with recursively sorted object keys, so two
 * semantically identical ExporterEntry objects with different key insertion
 * order produce the same string. Arrays preserve order (intentional: `headers`
 * order may matter to some HTTP backends).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Deduped union across all user-level + global exporters, for multi-user
 * healthchecks. Dedup key is the full serialized entry (not just `type`) so
 * two users with the same exporter type but distinct configs (e.g. different
 * webhook URLs, distinct InfluxDB buckets) both get health-checked at boot.
 * Identical configs across users still collapse to one healthcheck call.
 */
export function buildAllUniqueExporters(ctx: AppContext): Exporter[] {
  const seen = new Set<string>();
  const all: Exporter[] = [];
  for (const user of ctx.config.users) {
    const entries = resolveExportersForUser(ctx.config, user);
    for (const entry of entries) {
      const key = stableStringify(entry as ExporterEntry);
      if (!seen.has(key)) {
        seen.add(key);
        all.push(createExporterFromEntry(entry));
      }
    }
  }
  return all;
}
