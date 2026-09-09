import { resolveForSingleUser, resolveExportersForUser } from '../config/resolve.js';
import { createExporterFromEntry } from '../exporters/registry.js';
import type { Exporter } from '../interfaces/exporter.js';
import type { ExporterEntry } from '../config/schema.js';
import type { AppContext } from './context.js';

export function buildSingleUserExporters(ctx: AppContext): Exporter[] {
  const { exporterEntries } = resolveForSingleUser(ctx.config);
  return exporterEntries.map((e) => createExporterFromEntry(e));
}

/**
 * Per-user lookup that hits `ctx.exporterCache`. Cache is cleared on every
 * config reload via `AppContext.setConfig` so reload-time exporter changes
 * land on the next call.
 */
/**
 * Every exporter any configured user has, deduped by name.
 *
 * The retry queue stores an exporter NAME, so draining it needs the set of
 * exporters that exist right now rather than the ones for one user: the entry
 * may have been queued for a user who has since been removed, and it carries
 * the user's name and slug in its own context anyway (#412).
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

export function getExportersForUser(ctx: AppContext, slug: string): Exporter[] {
  let exporters = ctx.exporterCache.get(slug);
  if (!exporters) {
    const user = ctx.config.users.find((u) => u.slug === slug);
    if (!user) return [];
    const entries = resolveExportersForUser(ctx.config, user);
    exporters = entries.map((e) => createExporterFromEntry(e));
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
