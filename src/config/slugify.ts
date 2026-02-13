/**
 * Generate a URL/topic-safe slug from a display name.
 *
 * Normalizes NFD → strips diacritics → lowercase → hyphens for spaces/underscores
 * → removes non-alphanumeric → collapses/trims hyphens.
 *
 * Examples: "Mama Janka" → "mama-janka", "José María" → "jose-maria"
 */
export function generateSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces/underscores → hyphens
    .replace(/[^a-z0-9-]/g, '') // remove non-alphanumeric (except hyphens)
    .replace(/-+/g, '-') // collapse consecutive hyphens
    .replace(/^-|-$/g, ''); // trim leading/trailing hyphens
}

/**
 * Check an array of slugs for duplicates.
 * Returns array of duplicate slug values (empty if all unique).
 */
export function validateSlugUniqueness(slugs: string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const slug of slugs) {
    if (seen.has(slug)) {
      if (!duplicates.includes(slug)) {
        duplicates.push(slug);
      }
    } else {
      seen.add(slug);
    }
  }

  return duplicates;
}
