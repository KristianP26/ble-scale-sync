/**
 * Generate a URL/topic-safe slug from a display name.
 *
 * Normalizes NFD → strips diacritics → lowercase → hyphens for spaces/underscores
 * → removes non-alphanumeric → collapses/trims hyphens.
 *
 * Examples: "Mama Janka" → "mama-janka", "José María" → "jose-maria"
 *
 * A name with no Latin letters or digits at all ("Иван", "王芳") leaves nothing,
 * and an empty slug only failed later as an unexplained schema regex error
 * (G-25). Such a name gets `user-<n>` instead, the first one not in `taken`.
 */
export function generateSlug(name: string, taken: readonly string[] = []): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces/underscores → hyphens
    .replace(/[^a-z0-9-]/g, '') // remove non-alphanumeric (except hyphens)
    .replace(/-+/g, '-') // collapse consecutive hyphens
    .replace(/^-|-$/g, ''); // trim leading/trailing hyphens
  if (slug) return slug;
  for (let n = 1; ; n++) {
    if (!taken.includes(`user-${n}`)) return `user-${n}`;
  }
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
