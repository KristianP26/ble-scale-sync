import { resolveForSingleUser, resolveExportersForUser } from '../config/resolve.js';
import { createExporterFromEntry } from '../exporters/registry.js';
import type { Exporter } from '../interfaces/exporter.js';
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

/** Deduped union across all user-level + global exporters, for multi-user healthchecks. */
export function buildAllUniqueExporters(ctx: AppContext): Exporter[] {
  const seen = new Set<string>();
  const all: Exporter[] = [];
  for (const user of ctx.config.users) {
    const entries = resolveExportersForUser(ctx.config, user);
    for (const entry of entries) {
      if (!seen.has(entry.type)) {
        seen.add(entry.type);
        all.push(createExporterFromEntry(entry));
      }
    }
  }
  return all;
}
