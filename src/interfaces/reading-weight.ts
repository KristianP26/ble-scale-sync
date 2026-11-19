/**
 * The weight band a reading must lie in to be a body weight at all, in kg
 * (ADR D108).
 *
 * The lower edge equals the lightest gate any adapter has (0.5 kg, renpho-msc04
 * and es-cs20m); the upper edge is more than twice the widest gate an adapter
 * has (300 kg), so it leaves room for bariatric scales and only catches values
 * that cannot be a person: a mis-scaled field, an unset sentinel, a corrupt
 * frame. Not a user setting on purpose, a per-user `weight_range` is the
 * place for a tighter bound.
 *
 * Kg is the internal unit: lbs is display only, so the band applies after the
 * adapter's own conversion.
 */
export const PLAUSIBLE_WEIGHT_MIN_KG = 0.5;
export const PLAUSIBLE_WEIGHT_MAX_KG = 700;

/** True for a finite weight inside the band, edges included. */
export function isPlausibleWeight(kg: number): boolean {
  return (
    typeof kg === 'number' &&
    Number.isFinite(kg) &&
    kg >= PLAUSIBLE_WEIGHT_MIN_KG &&
    kg <= PLAUSIBLE_WEIGHT_MAX_KG
  );
}
